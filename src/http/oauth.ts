import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { UserContext } from "../users/context.js";
import { hashToken } from "../users/registry.js";
import { FailedAuthLimiter, extractBearerToken } from "./security.js";

export interface OAuthOptions {
  issuerUrl: string;
  stateDir: string;
  redirectUris?: string[];
}

interface Client {
  redirectUris: string[];
  name: string;
}
interface Grant {
  userId: string;
  credentialHash: string;
  clientId: string;
  family: string;
  expiresAt: number;
}
interface Code extends Grant {
  redirectUri: string;
  challenge: string;
  used?: boolean;
}
interface Refresh extends Grant {
  used?: boolean;
}
interface Store {
  version: 1;
  issuer?: string;
  resource?: string;
  clients: Record<string, Client>;
  codes: Record<string, Code>;
  access: Record<string, Grant>;
  refresh: Record<string, Refresh>;
}
interface Authorization {
  clientId: string;
  clientName: string;
  redirectUri: string;
  challenge: string;
  state?: string;
}
interface Transaction {
  authorization: Authorization;
  browserHash: string;
  csrfHash: string;
  expiresAt: number;
}

const MINUTE = 60_000;
const CODE_LIFETIME = 5 * MINUTE;
const ACCESS_LIFETIME = 15 * MINUTE;
const REFRESH_LIFETIME = 30 * 24 * 60 * MINUTE;
const DEFAULT_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const MAX_BODY = 16 * 1024;
const MAX_CLIENTS = 10_000;
const MAX_GRANTS = 10_000;
const MAX_TRANSACTIONS = 10_000;
const activeStoreLocks = new Set<string>();
const random = () => randomBytes(32).toString("base64url");
const has = (object: object, key: string) => Object.hasOwn(object, key);
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hashToken(a)), Buffer.from(hashToken(b)));

function emptyStore(): Store {
  return { version: 1, clients: {}, codes: {}, access: {}, refresh: {} };
}

function ensureGrantCapacity(store: Store, extra: number): void {
  const total = Object.keys(store.codes).length + Object.keys(store.access).length + Object.keys(store.refresh).length;
  if (total + extra > MAX_GRANTS) throw new Error("OAuth grant capacity reached");
}

function acquireStoreLock(stateDir: string): () => void {
  const lock = path.resolve(stateDir, "oauth.lock");
  if (activeStoreLocks.has(lock)) throw new Error("OAuth storage operation is not reentrant");
  const nonce = random();
  const candidate = path.join(stateDir, `oauth.lock.pending.${nonce}`);
  fs.mkdirSync(candidate, { mode: 0o700 });
  fs.writeFileSync(path.join(candidate, "owner.json"), JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
  const deadline = Date.now() + 2_000;
  try {
    for (;;) {
      try {
        // The candidate is already nonempty: publication is atomic and no writer can
        // acquire a lock directory whose owner metadata has not yet been written.
        fs.renameSync(candidate, lock);
        break;
      } catch (err) {
        if (!["EEXIST", "ENOTEMPTY"].includes((err as NodeJS.ErrnoException).code ?? "") || Date.now() >= deadline) {
          throw new Error("OAuth storage unavailable");
        }
        try {
          const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")) as { pid: number; nonce: string };
          if (Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.nonce === "string" && OPAQUE.test(owner.nonce)) {
            // All store operations are synchronous and non-reentrant. An on-disk lock
            // claiming our PID cannot be active here (e.g. a restarted container's PID 1).
            let dead = owner.pid === process.pid;
            if (!dead) {
              try { process.kill(owner.pid, 0); } catch (error) {
                dead = (error as NodeJS.ErrnoException).code === "ESRCH";
              }
            }
            if (dead) {
              // Retain this nonempty tombstone. A second, delayed reaper then cannot
              // rename a newer live lock over it (rename returns ENOTEMPTY).
              fs.renameSync(lock, path.join(stateDir, `oauth.lock.stale.${owner.nonce}`));
              continue;
            }
          }
        } catch { /* Another contender may have acquired or recovered the lock. */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  } catch (err) {
    fs.rmSync(candidate, { recursive: true, force: true });
    throw err;
  }
  activeStoreLocks.add(lock);
  return () => {
    // Release atomically, without exposing an empty lock that another writer could replace.
    try {
      fs.renameSync(lock, candidate);
      fs.rmSync(candidate, { recursive: true, force: true });
    } finally {
      activeStoreLocks.delete(lock);
    }
  };
}

// Synchronous read/modify/rename under a cross-process lock also serializes CLI revocation.
function withStore<T>(stateDir: string, operation: (store: Store) => T): T {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const release = acquireStoreLock(stateDir);
  const file = path.join(stateDir, "oauth.json");
  const temporary = `${file}.${process.pid}.${random()}.tmp`;
  try {
    let store = emptyStore();
    try {
      store = JSON.parse(fs.readFileSync(file, "utf8")) as Store;
      if (store.version !== 1 || !store.clients || !store.codes || !store.access || !store.refresh) {
        throw new Error("Invalid OAuth storage");
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("OAuth storage unavailable");
    }
    const now = Date.now();
    for (const collection of [store.codes, store.access, store.refresh]) {
      for (const [key, grant] of Object.entries(collection)) {
        if (grant.expiresAt <= now) delete collection[key];
      }
    }
    const result = operation(store);
    fs.writeFileSync(temporary, `${JSON.stringify(store)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    return result;
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* No temporary file after a successful rename. */ }
    release();
  }
}

function removeFamily(store: Store, family: string): void {
  for (const collection of [store.codes, store.access, store.refresh]) {
    for (const [key, grant] of Object.entries(collection)) {
      if (grant.family === family) delete collection[key];
    }
  }
}

/** Immediately revoke a user's authorization codes and access/refresh tokens, including in running servers. */
export function revokeUserOAuthGrants(stateDir: string, userId: string): void {
  withStore(stateDir, (store) => {
    for (const collection of [store.codes, store.access, store.refresh]) {
      for (const [key, grant] of Object.entries(collection)) {
        if (grant.userId === userId) delete collection[key];
      }
    }
  });
}

export function canonicalOAuthIssuer(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid OAuth issuer URL"); }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || /[?#]/.test(value) ||
      /^[a-z]+:\/\/[^/]*@/i.test(value) || url.pathname !== "/") {
    throw new Error("OAuth issuer must be an HTTPS origin (HTTP is allowed only on loopback)");
  }
  return url.origin;
}

function json(res: ServerResponse, status: number, body: unknown, cors = false): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    ...(cors ? { "access-control-allow-origin": "*" } : {}),
  });
  res.end(JSON.stringify(body));
}

function error(res: ServerResponse, status = 400, code = "invalid_request", cors = false): void {
  json(res, status, { error: code }, cors);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

async function body(req: IncomingMessage, format: "json" | "form"): Promise<Record<string, unknown>> {
  const contentType = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== (format === "json" ? "application/json" : "application/x-www-form-urlencoded")) {
    throw new Error("Invalid request");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY) throw new Error("Invalid request");
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (format === "json") {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid request");
    return parsed as Record<string, unknown>;
  }
  const params = new URLSearchParams(text);
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of params) {
    if (has(result, key)) throw new Error("Invalid request");
    result[key] = value;
  }
  return result;
}

function only(input: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(input).every((key) => keys.includes(key));
}

export function createOAuthProvider(
  options: OAuthOptions,
  authenticateStatic: (token: string) => UserContext | null,
  resolveGrant: (userId: string, credentialHash: string) => UserContext | null,
) {
  const issuer = canonicalOAuthIssuer(options.issuerUrl);
  const resource = `${issuer}/mcp`;
  const redirects = [...new Set([DEFAULT_REDIRECT, ...(options.redirectUris ?? [])])];
  if (redirects.some((value) => {
    try {
      const url = new URL(value);
      return Boolean(url.hash || url.username || url.password ||
        (url.protocol !== "https:" && !(url.protocol === "http:" &&
          (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"))));
    } catch { return true; }
  })) throw new Error("OAuth redirect URIs must be explicit HTTPS URLs or loopback HTTP URLs");

  let initialized = false;
  function withIssuerState<T>(operation: (store: Store) => T): T {
    const result = withStore(options.stateDir, (store) => {
      // Discovery does not need storage. On first actual use, changing issuer/resource
      // invalidates old clients/grants; already-initialized providers then fail closed.
      if (store.issuer !== issuer || store.resource !== resource) {
        if (initialized) throw new Error("OAuth issuer changed");
        Object.assign(store, emptyStore(), { issuer, resource });
      }
      return operation(store);
    });
    initialized = true;
    return result;
  }

  const transactions = new Map<string, Transaction>();
  const rate = new FailedAuthLimiter(60, MINUTE);
  const registrationRate = new FailedAuthLimiter(10, MINUTE);
  const routes = new Set([
    "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp",
    "/mcp/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server",
    "/register", "/authorize", "/token", "/revoke",
  ]);
  const publicCors = new Set([
    "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp",
    "/mcp/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server",
    "/register", "/token", "/revoke",
  ]);

  function authorization(params: URLSearchParams): Authorization | null {
    const allowed = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "resource", "scope"];
    for (const key of params.keys()) {
      if (!allowed.includes(key) || params.getAll(key).length !== 1) return null;
    }
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const challenge = params.get("code_challenge") ?? "";
    const state = params.get("state");
    if (!OPAQUE.test(clientId) || !redirects.includes(redirectUri) || params.get("response_type") !== "code" ||
        params.get("code_challenge_method") !== "S256" || !OPAQUE.test(challenge) ||
        (state !== null && (state.length > 1024 || /[\x00-\x1f\x7f]/.test(state))) ||
        (params.has("resource") && params.get("resource") !== resource) ||
        (params.has("scope") && params.get("scope") !== "" && params.get("scope") !== "mcp")) return null;
    return withIssuerState((store) => {
      const client = has(store.clients, clientId) ? store.clients[clientId] : undefined;
      return client?.redirectUris.includes(redirectUri)
        ? { clientId, clientName: client.name, redirectUri, challenge, ...(state !== null ? { state } : {}) }
        : null;
    });
  }

  function issue(store: Store, grant: Grant): Record<string, unknown> {
    ensureGrantCapacity(store, 2);
    const access = random();
    const refresh = random();
    store.access[hashToken(access)] = { ...grant, expiresAt: Date.now() + ACCESS_LIFETIME };
    store.refresh[hashToken(refresh)] = { ...grant };
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_LIFETIME / 1000, refresh_token: refresh, scope: "mcp" };
  }

  async function handle(req: IncomingMessage, res: ServerResponse, key: string): Promise<boolean> {
    const url = new URL(req.url ?? "/", issuer);
    if (!routes.has(url.pathname)) return false;
    const cors = publicCors.has(url.pathname);
    try {
      if (req.method === "OPTIONS" && cors) {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "cache-control": "no-store",
        });
        res.end();
        return true;
      }
      if (!cors && req.headers.origin && req.headers.origin !== issuer) {
        error(res, 403);
        return true;
      }
      if (url.pathname !== "/authorize" && url.search) {
        error(res, 400, "invalid_request", cors);
        return true;
      }
      if (url.pathname.startsWith("/.well-known/") || url.pathname.startsWith("/mcp/.well-known/")) {
        if (req.method !== "GET") { error(res, 405, "invalid_request", true); return true; }
        if (url.pathname === "/.well-known/oauth-authorization-server") {
          json(res, 200, {
            issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
            registration_endpoint: `${issuer}/register`, revocation_endpoint: `${issuer}/revoke`,
            response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"], scopes_supported: ["mcp"],
          }, true);
        } else {
          json(res, 200, { resource, authorization_servers: [issuer], bearer_methods_supported: ["header"], scopes_supported: ["mcp"] }, true);
        }
        return true;
      }
      const limiter = url.pathname === "/register" ? registrationRate : rate;
      const rateKey = `${url.pathname}:${key}`;
      if (limiter.isBlocked(rateKey)) {
        res.setHeader("retry-after", "60");
        error(res, 429, "temporarily_unavailable", cors);
        return true;
      }
      limiter.recordFailure(rateKey);
      if (url.pathname === "/register") {
        if (req.method !== "POST") { error(res, 405, "invalid_request", true); return true; }
        const input = await body(req, "json");
        const uris = input.redirect_uris;
        if (!Array.isArray(uris) || !uris.length || uris.length > 10 ||
            !uris.every((uri) => typeof uri === "string" && redirects.includes(uri)) ||
            (input.client_name !== undefined && (typeof input.client_name !== "string" || input.client_name.length > 100)) ||
            (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none") ||
            (input.application_type !== undefined && input.application_type !== "web" && input.application_type !== "native") ||
            (input.grant_types !== undefined && (!Array.isArray(input.grant_types) || !input.grant_types.length ||
              !input.grant_types.every((grant) => grant === "authorization_code" || grant === "refresh_token"))) ||
            (input.response_types !== undefined && (!Array.isArray(input.response_types) ||
              input.response_types.length !== 1 || input.response_types[0] !== "code"))) {
          error(res, 400, "invalid_client_metadata", true); return true;
        }
        const clientId = random();
        withIssuerState((store) => {
          if (Object.keys(store.clients).length >= MAX_CLIENTS) throw new Error("Registration capacity reached");
          store.clients[clientId] = { redirectUris: uris as string[], name: (input.client_name as string | undefined) ?? "MCP client" };
        });
        json(res, 201, {
          client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: uris, token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
        }, true);
        return true;
      }
      if (url.pathname === "/authorize") {
        for (const [id, transaction] of transactions) {
          if (transaction.expiresAt <= Date.now()) transactions.delete(id);
        }
        if (req.method === "GET") {
          if ((req.url?.length ?? 0) > 8192) { error(res); return true; }
          const auth = authorization(url.searchParams);
          if (!auth || transactions.size >= MAX_TRANSACTIONS) { error(res); return true; }
          const transactionId = random();
          const csrf = random();
          const browser = random();
          transactions.set(hashToken(transactionId), {
            authorization: auth, browserHash: hashToken(browser), csrfHash: hashToken(csrf), expiresAt: Date.now() + CODE_LIFETIME,
          });
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
            "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
            "set-cookie": `oauth_browser=${browser}; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=300`,
          });
          res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Authorize MCP access</title></head><body><h1>Authorize MCP access</h1><p>Client: ${escapeHtml(auth.clientName)}</p><p>Allow this client to use your Garmin MCP account? Only continue if you initiated this connection.</p><p>Redirect: ${escapeHtml(auth.redirectUri)}</p><form method="post" action="/authorize"><input type="hidden" name="transaction" value="${transactionId}"><input type="hidden" name="csrf" value="${csrf}"><label>Your MCP access token <input type="password" name="token" required autocomplete="off"></label><label><input type="checkbox" name="consent" value="yes" required> I explicitly authorize this client to access my MCP account.</label><button type="submit">Authorize</button></form></body></html>`);
          return true;
        }
        if (req.method !== "POST") { error(res, 405); return true; }
        if (url.search) { error(res); return true; }
        const input = await body(req, "form");
        if (!only(input, ["transaction", "csrf", "token", "consent"]) ||
            typeof input.transaction !== "string" || !OPAQUE.test(input.transaction)) { error(res); return true; }
        const id = hashToken(input.transaction);
        const transaction = transactions.get(id);
        transactions.delete(id);
        const cookie = req.headers.cookie?.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("oauth_browser="))?.slice("oauth_browser=".length);
        if (!transaction || transaction.expiresAt <= Date.now() || !cookie || !OPAQUE.test(cookie) ||
            !equal(transaction.browserHash, hashToken(cookie)) || typeof input.csrf !== "string" ||
            !equal(transaction.csrfHash, hashToken(input.csrf)) || input.consent !== "yes" ||
            typeof input.token !== "string" || input.token.length > 4096) { error(res); return true; }
        const user = authenticateStatic(input.token);
        if (!user) { error(res, 401, "access_denied"); return true; }
        const code = random();
        const auth = transaction.authorization;
        withIssuerState((store) => {
          ensureGrantCapacity(store, 1);
          store.codes[hashToken(code)] = {
            userId: user.id, credentialHash: hashToken(input.token as string), clientId: auth.clientId,
            redirectUri: auth.redirectUri, challenge: auth.challenge, family: random(), expiresAt: Date.now() + CODE_LIFETIME,
          };
        });
        const location = new URL(auth.redirectUri);
        location.searchParams.set("code", code);
        if (auth.state !== undefined) location.searchParams.set("state", auth.state);
        res.writeHead(302, { location: location.href, "cache-control": "no-store", "referrer-policy": "no-referrer" });
        res.end();
        return true;
      }
      if (req.method !== "POST") { error(res, 405, "invalid_request", true); return true; }
      const input = await body(req, "form");
      if (req.headers.authorization || typeof input.client_id !== "string" || !OPAQUE.test(input.client_id)) {
        error(res, 400, "invalid_client", true); return true;
      }
      if (url.pathname === "/revoke") {
        if (!only(input, ["token", "client_id", "token_type_hint"]) || typeof input.token !== "string" ||
            input.token.length > 4096 || (input.token_type_hint !== undefined &&
            input.token_type_hint !== "access_token" && input.token_type_hint !== "refresh_token")) {
          error(res, 400, "invalid_request", true); return true;
        }
        const known = withIssuerState((store) => {
          if (!has(store.clients, input.client_id as string)) return false;
          const tokenHash = hashToken(input.token as string);
          const grant = store.refresh[tokenHash] ?? store.access[tokenHash];
          if (grant?.clientId === input.client_id) removeFamily(store, grant.family);
          return true;
        });
        if (!known) error(res, 400, "invalid_client", true);
        else json(res, 200, {}, true);
        return true;
      }
      if (!only(input, ["grant_type", "client_id", "code", "redirect_uri", "code_verifier", "refresh_token", "resource", "scope"]) ||
          (input.resource !== undefined && input.resource !== resource)) {
        error(res, 400, "invalid_request", true); return true;
      }
      if (input.scope !== undefined && input.scope !== "" && input.scope !== "mcp") {
        error(res, 400, "invalid_scope", true); return true;
      }
      if (input.grant_type !== "authorization_code" && input.grant_type !== "refresh_token") {
        error(res, 400, "unsupported_grant_type", true); return true;
      }
      const result = withIssuerState((store) => {
        const clientId = input.client_id as string;
        if (!has(store.clients, clientId)) return null;
        if (input.grant_type === "authorization_code") {
          if (input.refresh_token !== undefined || typeof input.code !== "string" || !OPAQUE.test(input.code) ||
              typeof input.redirect_uri !== "string" || !redirects.includes(input.redirect_uri) ||
              typeof input.code_verifier !== "string" ||
              !VERIFIER.test(input.code_verifier)) return null;
          const code = store.codes[hashToken(input.code)];
          if (!code || code.clientId !== clientId || code.redirectUri !== input.redirect_uri) return null;
          const challenge = createHash("sha256").update(input.code_verifier).digest("base64url");
          if (!equal(challenge, code.challenge)) return null;
          if (code.used) { removeFamily(store, code.family); return null; }
          code.used = true;
          if (!resolveGrant(code.userId, code.credentialHash)) { removeFamily(store, code.family); return null; }
          return issue(store, { userId: code.userId, credentialHash: code.credentialHash, clientId,
            family: code.family, expiresAt: Date.now() + REFRESH_LIFETIME });
        }
        if (input.code !== undefined || input.redirect_uri !== undefined || input.code_verifier !== undefined ||
            typeof input.refresh_token !== "string" || !OPAQUE.test(input.refresh_token)) return null;
        const refresh = store.refresh[hashToken(input.refresh_token)];
        if (!refresh || refresh.clientId !== clientId) return null;
        if (refresh.used) { removeFamily(store, refresh.family); return null; }
        refresh.used = true;
        if (!resolveGrant(refresh.userId, refresh.credentialHash)) { removeFamily(store, refresh.family); return null; }
        return issue(store, { userId: refresh.userId, credentialHash: refresh.credentialHash, clientId,
          family: refresh.family, expiresAt: refresh.expiresAt });
      });
      if (!result) error(res, 400, "invalid_grant", true);
      else json(res, 200, result, true);
      return true;
    } catch {
      // Request bodies and credentials must never become log messages.
      if (!res.headersSent) error(res, 400, "invalid_request", cors);
      else res.end();
      return true;
    }
  }

  return {
    issuer,
    handles: (pathname: string) => routes.has(pathname),
    challenge: ["Bearer", `resource_metadata="${issuer}/.well-known/oauth-protected-resource"`].join(" "),
    handle,
    authenticate(header: string | undefined): UserContext | null {
      const token = extractBearerToken(header);
      if (!token || !OPAQUE.test(token)) return null;
      try {
        return withIssuerState((store) => {
          const grant = store.access[hashToken(token)];
          return grant ? resolveGrant(grant.userId, grant.credentialHash) : null;
        });
      } catch {
        return null;
      }
    },
  };
}
