import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canonicalOAuthIssuer, createOAuthProvider, revokeUserOAuthGrants } from "../src/http/oauth.js";
import { startHttpServer, type RunningHttpServer } from "../src/http/server.js";
import { currentUser, ownerContext } from "../src/users/context.js";
import { createUserRegistry, hashToken, writeUsers } from "../src/users/registry.js";

const ISSUER = "https://garmin.example.org";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const OWNER_TOKEN = "oauth-owner-test-" + "a".repeat(40);
const ALICE_TOKEN = "oauth-alice-test-" + "b".repeat(40);
const BOB_TOKEN = "oauth-bob-test-" + "c".repeat(40);
const VERIFIER = "a".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const bearer = (token: string) => ["Bearer", token].join(" ");

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}
function request(url: string, method = "GET", body?: string, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const parsed = (res: Response) => JSON.parse(res.text);
const form = (values: Record<string, string>) => new URLSearchParams(values).toString();

async function fixture(t: test.TestContext, registry = false, oauth = true, redirectUris: string[] = []) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "garmin-oauth-"));
  const users = [
    { id: "alice", tokenSha256: hashToken(ALICE_TOKEN), createdAt: new Date().toISOString() },
    { id: "bob", tokenSha256: hashToken(BOB_TOKEN), createdAt: new Date().toISOString() },
  ];
  if (registry) writeUsers(stateDir, users);
  const userRegistry = registry ? createUserRegistry({ stateDir, owner: ownerContext(), ownerToken: OWNER_TOKEN }) : undefined;
  let seenUser = "";
  let configuredRedirects = redirectUris;
  let server: RunningHttpServer;
  async function start() {
    server = await startHttpServer({
      host: "127.0.0.1", port: 0, authToken: OWNER_TOKEN, users: userRegistry,
      allowedHosts: ["garmin.example.org"],
      ...(oauth ? { oauth: { issuerUrl: ISSUER, stateDir, redirectUris: configuredRedirects } } : {}),
      createMcpServer: () => {
        seenUser = currentUser().id;
        return new McpServer({ name: "oauth-test", version: "1" });
      },
    });
  }
  await start();
  t.after(async () => { await server.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const req = (route: string, method = "GET", body?: string, headers: Record<string, string> = {}) =>
    request(server.url + route, method, body, headers);
  const post = (route: string, values: Record<string, string>, headers: Record<string, string> = {}) =>
    req(route, "POST", form(values), { "content-type": "application/x-www-form-urlencoded", ...headers });
  async function register(redirectUris = [REDIRECT]) {
    const response = await req("/register", "POST", JSON.stringify({
      redirect_uris: redirectUris, client_name: "Test client", token_endpoint_auth_method: "none",
    }), { "content-type": "application/json", origin: "https://claude.ai" });
    assert.equal(response.status, 201, response.text);
    return parsed(response).client_id as string;
  }
  async function login(clientId: string, overrides: Record<string, string> = {}, headers: Record<string, string> = {}) {
    const response = await req("/authorize?" + form({
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: CHALLENGE, code_challenge_method: "S256", resource: ISSUER + "/mcp",
      state: "browser-state", ...overrides,
    }), "GET", undefined, headers);
    assert.equal(response.status, 200, response.text);
    const transaction = /name="transaction" value="([^"]+)"/.exec(response.text)![1];
    const csrf = /name="csrf" value="([^"]+)"/.exec(response.text)![1];
    const cookie = response.headers["set-cookie"]![0].split(";")[0];
    return { response, cookie, fields: { transaction, csrf, token: OWNER_TOKEN, consent: "yes" } };
  }
  async function authorize(clientId: string, token = OWNER_TOKEN) {
    const page = await login(clientId);
    const response = await post("/authorize", { ...page.fields, token }, { cookie: page.cookie });
    assert.equal(response.status, 302, response.text);
    const redirect = new URL(response.headers.location!);
    assert.equal(redirect.origin + redirect.pathname, REDIRECT);
    assert.equal(redirect.searchParams.get("state"), "browser-state");
    return redirect.searchParams.get("code")!;
  }
  const exchange = (clientId: string, code: string, verifier = VERIFIER) => post("/token", {
    grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier,
  });
  const refresh = (clientId: string, token: string) => post("/token", {
    grant_type: "refresh_token", client_id: clientId, refresh_token: token,
  });
  async function grant(clientId: string, token = OWNER_TOKEN) {
    const response = await exchange(clientId, await authorize(clientId, token));
    assert.equal(response.status, 200, response.text);
    return parsed(response) as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
  }
  const mcp = (token?: string) => req("/mcp", "POST", JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  }), {
    "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(token ? { authorization: bearer(token) } : {}),
  });
  return {
    stateDir, users, req, post, register, login, authorize, exchange, refresh, grant, mcp,
    seenUser: () => seenUser,
    restart: async (nextRedirects = configuredRedirects) => {
      await server.close();
      configuredRedirects = nextRedirects;
      await start();
    },
  };
}

test("OAuth issuer only permits HTTPS origins or genuine loopback HTTP", () => {
  for (const issuer of [ISSUER, ISSUER + "/", "http://127.0.0.1:1234", "http://[::1]:1234", "http://localhost:1234"]) {
    assert.equal(canonicalOAuthIssuer(issuer), new URL(issuer).origin);
  }
  for (const issuer of [
    "http://example.org", "http://localhost.example.org", "http://127.0.0.1.example.org",
    ISSUER + "/mcp", ISSUER + "?x=1", ISSUER + "?", ISSUER + "#", ISSUER + "#x",
    "https://" + "user@" + "example.org", "https://@example.org", "file:///root",
  ]) assert.throws(() => canonicalOAuthIssuer(issuer));
});

test("metadata, CORS discovery, challenge, and legacy compatibility", async (t) => {
  const f = await fixture(t);
  for (const route of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/mcp/.well-known/oauth-protected-resource"]) {
    const response = await f.req(route, "GET", undefined, { origin: "https://claude.ai" });
    assert.equal(response.status, 200);
    assert.equal(response.headers["access-control-allow-origin"], "*");
    assert.equal(parsed(response).resource, ISSUER + "/mcp");
    assert.deepEqual(parsed(response).authorization_servers, [ISSUER]);
  }
  const metadata = parsed(await f.req("/.well-known/oauth-authorization-server"));
  assert.equal(metadata.issuer, ISSUER);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal((await f.req("/register", "OPTIONS", undefined, { origin: "https://claude.ai" })).status, 204);
  for (const token of [undefined, "invalid"]) {
    const response = await f.mcp(token);
    assert.equal(response.status, 401);
    assert.equal(response.headers["www-authenticate"], ["Bearer", `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`].join(" "));
  }
  assert.equal((await f.mcp(OWNER_TOKEN)).status, 200);
  assert.equal((await f.req("/mcp", "GET", undefined, { authorization: bearer(OWNER_TOKEN), origin: "https://claude.ai" })).status, 403);
  assert.equal((await f.req("/.well-known/oauth-authorization-server", "GET", undefined, { host: "evil.example.org" })).status, 403);

  const legacy = await fixture(t, false, false);
  assert.equal((await legacy.req("/.well-known/oauth-authorization-server")).status, 404);
  const challenge = (await legacy.mcp()).headers["www-authenticate"];
  assert.equal(challenge, ["Bearer", 'realm="garmin-mcp"'].join(" "));
  assert.equal((await legacy.mcp(OWNER_TOKEN)).status, 200);
});

test("issuer discovery works before any persistent OAuth state exists", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.stateDir, "oauth.json");
  assert.equal(fs.existsSync(file), false);
  for (const route of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
    assert.equal((await f.req(route)).status, 200);
  }
  assert.equal(fs.existsSync(file), false);
  await f.register();
  assert.equal(fs.existsSync(file), true);
});

test("public registration validates metadata and exact redirect allowlist", async (t) => {
  const f = await fixture(t);
  await f.register();
  for (const input of [
    { redirect_uris: ["https://evil.example.org/"] },
    { redirect_uris: [REDIRECT + "?changed=1"] },
    { redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" },
    { redirect_uris: [REDIRECT], grant_types: ["password"] },
    { redirect_uris: [REDIRECT], response_types: ["token"] },
    { redirect_uris: [] },
  ]) {
    const response = await f.req("/register", "POST", JSON.stringify(input), { "content-type": "application/json" });
    assert.equal(response.status, 400);
    assert.equal(parsed(response).error, "invalid_client_metadata");
  }
  assert.equal((await f.req("/register", "POST", "null", { "content-type": "application/json" })).status, 400);
  assert.equal((await f.req("/register", "POST", "{}", { "content-type": "text/plain" })).status, 400);
});

test("registration ignores unknown RFC7591 metadata and retains Claude alongside configured callbacks", async (t) => {
  const custom = "https://client.example.org/oauth/callback";
  const f = await fixture(t, false, true, [custom]);
  await f.register();
  await f.register([custom]);
  const response = await f.req("/register", "POST", JSON.stringify({
    redirect_uris: [REDIRECT], client_name: "<script>alert(1)</script>",
    client_uri: "https://client.example.org", logo_uri: "https://client.example.org/logo",
    scope: "mcp", future_metadata: { ignored: true },
  }), { "content-type": "application/json" });
  assert.equal(response.status, 201);
  const page = await f.login(parsed(response).client_id);
  assert.ok(page.response.text.includes("&lt;script&gt;"));
  assert.ok(!page.response.text.includes("<script>"));
  assert.match(page.response.headers["content-security-policy"] as string, /form-action 'self' https:\/\/claude\.ai;/);
  assert.ok(!(page.response.headers["content-security-policy"] as string).includes("https://client.example.org"));
});

test("removing an allowed callback blocks existing registrations and pending codes while Claude remains valid", async (t) => {
  const custom = "https://client.example.org/oauth/callback";
  const f = await fixture(t, false, true, [custom]);
  const client = await f.register([REDIRECT, custom]);
  const page = await f.login(client, { redirect_uri: custom });
  assert.match(page.response.headers["content-security-policy"] as string, /form-action 'self' https:\/\/client\.example\.org;/);
  const approved = await f.post("/authorize", page.fields, { cookie: page.cookie });
  assert.equal(approved.status, 302);
  const code = new URL(approved.headers.location!).searchParams.get("code")!;
  await f.restart([]);
  const blocked = await f.req("/authorize?" + form({
    response_type: "code", client_id: client, redirect_uri: custom,
    code_challenge: CHALLENGE, code_challenge_method: "S256",
  }));
  assert.equal(blocked.status, 400);
  assert.equal(blocked.headers.location, undefined);
  const exchange = await f.post("/token", {
    grant_type: "authorization_code", client_id: client, code, redirect_uri: custom, code_verifier: VERIFIER,
  });
  assert.equal(exchange.status, 400);
  const tokens = await f.grant(client);
  assert.equal((await f.mcp(tokens.access_token)).status, 200);
});

test("authorization requires login, explicit consent, browser cookie, CSRF and one-time transaction", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  for (const mode of ["consent", "csrf", "cookie", "token", "origin"]) {
    const page = await f.login(client);
    assert.match(page.response.headers["content-security-policy"] as string, /frame-ancestors 'none'/);
    assert.equal(page.response.headers["cache-control"], "no-store");
    assert.equal(page.response.headers["referrer-policy"], "no-referrer");
    assert.match(page.response.headers["set-cookie"]![0], /HttpOnly; Secure; SameSite=Lax/);
    assert.match(page.response.headers["set-cookie"]![0], /^__Host-garmin_oauth_browser=/);
    assert.match(page.response.headers["set-cookie"]![0], /; Path=\/; Max-Age=300$/);
    assert.ok(!page.response.headers["set-cookie"]![0].includes("Domain="));
    const values = { ...page.fields };
    if (mode === "consent") values.consent = "no";
    if (mode === "csrf") values.csrf = "bad";
    if (mode === "token") values.token = "wrong-static-token";
    const headers = mode === "cookie" ? {} : { cookie: page.cookie };
    const response = await f.post("/authorize", values, { ...headers, ...(mode === "origin" ? { origin: "https://evil.example.org" } : {}) });
    assert.ok([400, 401, 403].includes(response.status), response.text);
    assert.equal(response.headers.location, undefined);
  }
  const page = await f.login(client);
  const response = await f.post("/authorize", page.fields, { cookie: page.cookie, origin: ISSUER });
  assert.equal(response.status, 302);
  assert.equal((await f.post("/authorize", page.fields, { cookie: page.cookie })).status, 400);
  assert.ok(!response.headers.location!.includes(OWNER_TOKEN));
});

test("opening another consent page in the same browser does not invalidate an earlier form", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const first = await f.login(client, { state: "first-tab" });
  const second = await f.login(client, { state: "second-tab" }, { cookie: first.cookie });
  const firstApproval = await f.post("/authorize", first.fields, { cookie: second.cookie, origin: ISSUER });
  assert.equal(firstApproval.status, 302, firstApproval.text);
  assert.equal(new URL(firstApproval.headers.location!).searchParams.get("state"), "first-tab");
  const secondApproval = await f.post("/authorize", second.fields, { cookie: second.cookie, origin: ISSUER });
  assert.equal(secondApproval.status, 302, secondApproval.text);
  assert.equal(new URL(secondApproval.headers.location!).searchParams.get("state"), "second-tab");
  for (const approval of [firstApproval, secondApproval]) {
    const exchanged = await f.exchange(client, new URL(approval.headers.location!).searchParams.get("code")!);
    assert.equal(exchanged.status, 200, exchanged.text);
    assert.equal((await f.mcp(parsed(exchanged).access_token)).status, 200);
  }
});

test("failed token entry can be corrected without consuming the consent form", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const page = await f.login(client);
  const denied = await f.post("/authorize", { ...page.fields, token: "wrong-token" }, { cookie: page.cookie });
  assert.equal(denied.status, 401);
  const approved = await f.post("/authorize", page.fields, { cookie: page.cookie });
  assert.equal(approved.status, 302, approved.text);
  assert.equal((await f.post("/authorize", page.fields, { cookie: page.cookie })).status, 400);
});

test("consent errors explain missing cookies, browser mismatch, CSRF and token failures without logging secrets", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const f = await fixture(t);
  const client = await f.register();
  const page = await f.login(client);
  const otherBrowser = await f.login(client);
  assert.notEqual(otherBrowser.cookie, page.cookie);
  const cases = [
    { fields: page.fields, headers: { cookie: "" }, reason: "cookie_missing", description: /cookie is missing/, status: 400 },
    { fields: page.fields, headers: { cookie: otherBrowser.cookie }, reason: "browser_mismatch", description: /different browser session/, status: 400 },
    { fields: page.fields, headers: { cookie: `${page.cookie}; ${page.cookie}` }, reason: "cookie_missing", description: /cookie is missing/, status: 400 },
    { fields: { ...page.fields, csrf: "wrong-csrf" }, headers: { cookie: page.cookie }, reason: "csrf_mismatch", description: /could not be verified/, status: 400 },
    { fields: { ...page.fields, consent: "no" }, headers: { cookie: page.cookie }, reason: "consent_required", description: /consent is required/, status: 400 },
    { fields: { ...page.fields, token: "wrong-token" }, headers: { cookie: page.cookie }, reason: "invalid_token", description: /token was not accepted/, status: 401 },
  ];
  for (const entry of cases) {
    const response = await f.post("/authorize", entry.fields, entry.headers);
    assert.equal(response.status, entry.status, response.text);
    assert.match(parsed(response).error_description, entry.description);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers.location, undefined);
    assert.equal(log.mock.calls.at(-1)!.arguments[0], `OAuth /authorize rejected: ${entry.reason}`);
  }
  const logged = JSON.stringify(log.mock.calls.map((call) => call.arguments));
  for (const secret of [OWNER_TOKEN, page.fields.transaction, page.fields.csrf, page.cookie, client, "wrong-token", "wrong-csrf"]) {
    assert.ok(!logged.includes(secret), "authorization secret leaked into logs");
  }
  assert.equal((await f.post("/authorize", page.fields, { cookie: page.cookie })).status, 302);
});

test("expired or restarted consent sessions explain how to reconnect", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const expired = await f.login(client);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(5 * 60_000);
  const expiredResponse = await f.post("/authorize", expired.fields, { cookie: expired.cookie });
  assert.equal(expiredResponse.status, 400);
  assert.match(parsed(expiredResponse).error_description, /session expired.*5 minutes/);
  assert.equal(expiredResponse.headers.location, undefined);
  const restarted = await f.login(client);
  await f.restart();
  const restartedResponse = await f.post("/authorize", restarted.fields, { cookie: restarted.cookie });
  assert.equal(restartedResponse.status, 400);
  assert.match(parsed(restartedResponse).error_description, /server restarted/);
  assert.equal(restartedResponse.headers.location, undefined);
  await f.grant(client);
});

test("malformed forms and storage failures have distinct safe diagnostics", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const f = await fixture(t);
  const client = await f.register();
  const page = await f.login(client);
  const malformed = await f.req("/authorize", "POST", form(page.fields) + "&token=duplicate-secret", {
    "content-type": "application/x-www-form-urlencoded", cookie: page.cookie,
  });
  assert.equal(malformed.status, 400);
  assert.equal(parsed(malformed).error, "invalid_request");
  assert.match(parsed(malformed).error_description, /request body is invalid/);
  assert.equal(log.mock.calls.at(-1)!.arguments[0], "OAuth /authorize failed: invalid_request_body");
  const file = path.join(f.stateDir, "oauth.json");
  const before = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, OWNER_TOKEN, { mode: 0o600 });
  const failed = await f.post("/authorize", page.fields, { cookie: page.cookie });
  assert.equal(failed.status, 500);
  assert.equal(parsed(failed).error, "server_error");
  assert.match(parsed(failed).error_description, /app service logs/);
  assert.equal(failed.headers.location, undefined);
  assert.equal(log.mock.calls.at(-1)!.arguments[0], "OAuth /authorize failed: server_error");
  assert.ok(!failed.text.includes(OWNER_TOKEN));
  const logged = JSON.stringify(log.mock.calls.map((call) => call.arguments));
  for (const secret of [OWNER_TOKEN, page.fields.transaction, page.fields.csrf, "duplicate-secret"]) {
    assert.ok(!logged.includes(secret), "request or storage contents leaked into logs");
  }
  fs.writeFileSync(file, before, { mode: 0o600 });
  assert.equal((await f.post("/authorize", page.fields, { cookie: page.cookie })).status, 302);
});

test("authorization parameter validation never redirects untrusted input", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const base = {
    response_type: "code", client_id: client, redirect_uri: REDIRECT,
    code_challenge: CHALLENGE, code_challenge_method: "S256",
  };
  for (const changed of [
    { redirect_uri: "https://evil.example.org" }, { response_type: "token" },
    { code_challenge_method: "plain" }, { code_challenge: "invalid" },
    { resource: ISSUER + "/other" }, { scope: "admin" }, { token: OWNER_TOKEN },
    { client_id: "__proto__" },
  ]) {
    const response = await f.req("/authorize?" + form({ ...base, ...changed }));
    assert.equal(response.status, 400);
    assert.equal(parsed(response).error, "invalid_request");
    assert.equal(response.headers.location, undefined);
    assert.ok(!response.text.includes(OWNER_TOKEN));
  }
  assert.equal((await f.req("/authorize?" + form(base) + "&client_id=" + client)).status, 400);
});

test("PKCE code exchange, invalid verifier, replay and concurrent exchange", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const code = await f.authorize(client);
  for (const verifier of ["short", "b".repeat(43), "a".repeat(129), "!".repeat(43)]) {
    assert.equal((await f.exchange(client, code, verifier)).status, 400);
  }
  const responses = await Promise.all([f.exchange(client, code), f.exchange(client, code)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
  const tokens = parsed(responses.find((response) => response.status === 200)!);
  assert.equal(tokens.expires_in, 900);
  // Replaying a redeemed code also invalidates the family it issued.
  assert.equal((await f.mcp(tokens.access_token)).status, 401);
  assert.equal((await f.refresh(client, tokens.refresh_token)).status, 400);
});

test("rotating refresh tokens detect replay and revoke the entire family", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const original = await f.grant(client);
  assert.equal((await f.mcp(original.access_token)).status, 200);
  const response = await f.refresh(client, original.refresh_token);
  assert.equal(response.status, 200);
  const next = parsed(response);
  assert.notEqual(original.refresh_token, next.refresh_token);
  assert.notEqual(original.access_token, next.access_token);
  assert.equal((await f.mcp(next.access_token)).status, 200);
  assert.equal((await f.refresh(client, original.refresh_token)).status, 400);
  assert.equal((await f.mcp(original.access_token)).status, 401);
  assert.equal((await f.mcp(next.access_token)).status, 401);
  assert.equal((await f.refresh(client, next.refresh_token)).status, 400);
});

test("refresh permits the fixed MCP scope and rejects escalation without consuming the token", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const original = await f.grant(client);
  const values = { grant_type: "refresh_token", client_id: client, refresh_token: original.refresh_token };
  for (const scope of ["admin", "mcp admin", "MCP"]) {
    const invalid = await f.post("/token", { ...values, scope });
    assert.equal(invalid.status, 400);
    assert.equal(parsed(invalid).error, "invalid_scope");
  }
  const scoped = await f.post("/token", { ...values, scope: "mcp" });
  assert.equal(scoped.status, 200);
  assert.equal(parsed(scoped).scope, "mcp");
  const empty = await f.post("/token", { ...values, refresh_token: parsed(scoped).refresh_token, scope: "" });
  assert.equal(empty.status, 200);
  assert.equal(parsed(empty).scope, "mcp");
});

test("code exchange binds client, redirect and resource; concurrent refresh fails closed", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const otherClient = await f.register();
  const code = await f.authorize(client);
  assert.equal((await f.exchange(otherClient, code)).status, 400);
  const values = {
    grant_type: "authorization_code", client_id: client, code, redirect_uri: REDIRECT, code_verifier: VERIFIER,
  };
  for (const override of [{ redirect_uri: REDIRECT + "?changed" }, { resource: ISSUER + "/wrong" }]) {
    assert.equal((await f.post("/token", { ...values, ...override })).status, 400);
  }
  const tokens = parsed(await f.exchange(client, code));
  const responses = await Promise.all([
    f.refresh(client, tokens.refresh_token), f.refresh(client, tokens.refresh_token),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
  const next = parsed(responses.find((response) => response.status === 200)!);
  assert.equal((await f.mcp(next.access_token)).status, 401);
  assert.equal((await f.refresh(client, next.refresh_token)).status, 400);
});

test("revocation is client-bound, idempotent and excludes Garmin token uploads", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const otherClient = await f.register();
  const tokens = await f.grant(client);
  assert.equal((await f.req("/garmin-tokens", "PUT", "{}", {
    authorization: bearer(tokens.access_token), "content-type": "application/json",
  })).status, 401);
  assert.equal((await f.post("/revoke", { client_id: otherClient, token: tokens.refresh_token })).status, 200);
  assert.equal((await f.mcp(tokens.access_token)).status, 200);
  assert.equal((await f.post("/revoke", { client_id: client, token: tokens.access_token })).status, 200);
  assert.equal((await f.mcp(tokens.access_token)).status, 401);
  assert.equal((await f.refresh(client, tokens.refresh_token)).status, 400);
  assert.equal((await f.post("/revoke", { client_id: client, token: tokens.access_token })).status, 200);
});

test("persistent hash-only grants survive restart; CLI revocation is immediately visible", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const code = await f.authorize(client);
  await f.restart();
  const response = await f.exchange(client, code);
  assert.equal(response.status, 200);
  const tokens = parsed(response);
  await f.restart();
  assert.equal((await f.mcp(tokens.access_token)).status, 200);
  const file = path.join(f.stateDir, "oauth.json");
  const persisted = fs.readFileSync(file, "utf8");
  assert.equal(JSON.parse(persisted).issuer, ISSUER);
  assert.equal(JSON.parse(persisted).resource, ISSUER + "/mcp");
  for (const secret of [code, OWNER_TOKEN, tokens.access_token, tokens.refresh_token, VERIFIER]) {
    assert.ok(!persisted.includes(secret), "raw credential persisted");
  }
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e",
      'import { revokeUserOAuthGrants } from "./src/http/oauth.ts"; revokeUserOAuthGrants(process.argv[1], "owner");',
      f.stateDir,
    ], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  assert.equal((await f.mcp(tokens.access_token)).status, 401);
  assert.equal((await f.refresh(client, tokens.refresh_token)).status, 400);
  assert.equal((await f.mcp(OWNER_TOKEN)).status, 200);
});

test("changing issuer invalidates persisted clients and grants, including in an already-running server", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const tokens = await f.grant(client);
  const code = await f.authorize(client);
  const otherIssuer = "https://other.example.org";
  const alternate = createOAuthProvider(
    { issuerUrl: otherIssuer, stateDir: f.stateDir },
    (token) => token === OWNER_TOKEN ? ownerContext() : null,
    (userId, credentialHash) => userId === "owner" && credentialHash === hashToken(OWNER_TOKEN) ? ownerContext() : null,
  );
  assert.equal(alternate.authenticate(bearer(tokens.access_token)), null);
  assert.equal((await f.mcp(tokens.access_token)).status, 401);
  assert.equal((await f.mcp(OWNER_TOKEN)).status, 200);
  const store = JSON.parse(fs.readFileSync(path.join(f.stateDir, "oauth.json"), "utf8"));
  assert.equal(store.issuer, otherIssuer);
  assert.equal(store.resource, otherIssuer + "/mcp");
  for (const collection of [store.clients, store.codes, store.access, store.refresh]) {
    assert.equal(Object.keys(collection).length, 0);
  }
  await f.restart();
  assert.equal((await f.mcp(tokens.access_token)).status, 401);
  assert.equal((await f.refresh(client, tokens.refresh_token)).status, 400);
  assert.equal((await f.exchange(client, code)).status, 400);
});

test("dead-process locks recover safely under concurrent CLI revocation", async (t) => {
  const f = await fixture(t);
  await f.register();
  const dead = spawnSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e",
    `import fs from "node:fs";
     import { revokeUserOAuthGrants } from "./src/http/oauth.ts";
     const write = fs.writeFileSync;
     fs.writeFileSync = (file, ...args) => {
       if (String(file).endsWith(".tmp")) process.kill(process.pid, "SIGKILL");
       return write(file, ...args);
     };
     revokeUserOAuthGrants(process.argv[1], "owner");`,
    f.stateDir,
  ], { encoding: "utf8" });
  assert.equal(dead.signal, "SIGKILL", dead.stderr);
  const lock = path.join(f.stateDir, "oauth.lock");
  const { nonce } = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e",
      'import { revokeUserOAuthGrants } from "./src/http/oauth.ts"; revokeUserOAuthGrants(process.argv[1], "owner");',
      f.stateDir,
    ], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, `oauth.lock.stale.${nonce}`, "owner.json")), true);
  await f.register();
});

test("a live-process lock is never taken over", async (t) => {
  const f = await fixture(t);
  await f.register();
  const nonce = createHash("sha256").update(randomUUID()).digest("base64url");
  const lock = path.join(f.stateDir, "oauth.lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  process.kill(process.ppid, 0);
  const owner = JSON.stringify({ pid: process.ppid, nonce });
  fs.writeFileSync(path.join(lock, "owner.json"), owner, { mode: 0o600 });
  const before = fs.readFileSync(path.join(f.stateDir, "oauth.json"), "utf8");
  const response = await f.req("/register", "POST", JSON.stringify({ redirect_uris: [REDIRECT] }), {
    "content-type": "application/json",
  });
  assert.equal(response.status, 500);
  assert.equal(parsed(response).error, "server_error");
  assert.equal(fs.readFileSync(path.join(lock, "owner.json"), "utf8"), owner);
  assert.equal(fs.readFileSync(path.join(f.stateDir, "oauth.json"), "utf8"), before);
  fs.rmSync(lock, { recursive: true });
});

test("a stale lock with a reused server PID is recovered after container restart", async (t) => {
  const f = await fixture(t);
  await f.register();
  const nonce = createHash("sha256").update(randomUUID()).digest("base64url");
  const lock = path.join(f.stateDir, "oauth.lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
  await f.register();
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, `oauth.lock.stale.${nonce}`, "owner.json")), true);
});

test("total persistent grants and clients are bounded", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const page = await f.login(client);
  const file = path.join(f.stateDir, "oauth.json");
  const store = JSON.parse(fs.readFileSync(file, "utf8"));
  const grant = { userId: "owner", credentialHash: hashToken(OWNER_TOKEN), clientId: client,
    family: "capacity-test", expiresAt: Date.now() + 60_000 };
  for (let i = 0; i < 10_000; i++) store.access[hashToken(String(i))] = grant;
  fs.writeFileSync(file, JSON.stringify(store), { mode: 0o600 });
  assert.equal((await f.post("/authorize", page.fields, { cookie: page.cookie })).status, 500);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).codes).length, 0);
  store.access = {};
  for (let i = 0; i < 10_000; i++) {
    store.clients[hashToken(String(i))] = { redirectUris: [REDIRECT], name: "capacity-test" };
  }
  fs.writeFileSync(file, JSON.stringify(store), { mode: 0o600 });
  const registration = await f.req("/register", "POST", JSON.stringify({ redirect_uris: [REDIRECT] }), {
    "content-type": "application/json",
  });
  assert.equal(registration.status, 500);
});

test("multi-user grants preserve identity, isolate revocation and invalidate on removal/rotation", async (t) => {
  const f = await fixture(t, true);
  const client = await f.register();
  const alice = await f.grant(client, ALICE_TOKEN);
  const bob = await f.grant(client, BOB_TOKEN);
  assert.equal((await f.mcp(alice.access_token)).status, 200);
  assert.equal(f.seenUser(), "alice");
  assert.equal((await f.mcp(bob.access_token)).status, 200);
  assert.equal(f.seenUser(), "bob");
  revokeUserOAuthGrants(f.stateDir, "alice");
  assert.equal((await f.mcp(alice.access_token)).status, 401);
  assert.equal((await f.mcp(bob.access_token)).status, 200);
  const aliceAgain = await f.grant(client, ALICE_TOKEN);
  writeUsers(f.stateDir, f.users.filter((user) => user.id !== "alice"));
  assert.equal((await f.mcp(aliceAgain.access_token)).status, 401);
  assert.equal((await f.refresh(client, aliceAgain.refresh_token)).status, 400);
  writeUsers(f.stateDir, [{ ...f.users[1], tokenSha256: hashToken("rotated".repeat(10)) }]);
  assert.equal((await f.mcp(bob.access_token)).status, 401);
  assert.equal((await f.refresh(client, bob.refresh_token)).status, 400);
  assert.equal((await f.mcp(OWNER_TOKEN)).status, 200);
});

test("expired codes, access and refresh tokens are rejected", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const code = await f.authorize(client);
  const tokens = await f.grant(client);
  const file = path.join(f.stateDir, "oauth.json");
  const store = JSON.parse(fs.readFileSync(file, "utf8"));
  const now = Date.now();
  const freshCode = store.codes[hashToken(code)];
  assert.ok(freshCode.expiresAt > now + 4 * 60_000 && freshCode.expiresAt <= now + 5 * 60_000);
  const access = store.access[hashToken(tokens.access_token)];
  assert.ok(access.expiresAt > now + 14 * 60_000 && access.expiresAt <= now + 15 * 60_000);
  const refresh = store.refresh[hashToken(tokens.refresh_token)];
  assert.ok(refresh.expiresAt > now + 29 * 86_400_000 && refresh.expiresAt <= now + 30 * 86_400_000);
  for (const collection of [store.codes, store.access, store.refresh]) {
    for (const grant of Object.values(collection) as Array<{ expiresAt: number }>) grant.expiresAt = Date.now() - 1;
  }
  fs.writeFileSync(file, JSON.stringify(store), { mode: 0o600 });
  assert.equal((await f.exchange(client, code)).status, 400);
  assert.equal((await f.mcp(tokens.access_token)).status, 401);
  assert.equal((await f.refresh(client, tokens.refresh_token)).status, 400);
});

test("successful token refreshes count toward the endpoint rate limit", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  let tokens = await f.grant(client);
  for (let i = 0; i < 59; i++) {
    const response = await f.refresh(client, tokens.refresh_token);
    assert.equal(response.status, 200);
    tokens = parsed(response);
  }
  const limited = await f.refresh(client, tokens.refresh_token);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "60");
});

test("body validation and successful registration/authorization/token requests are rate limited", async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  assert.equal((await f.post("/token", { client_id: client, grant_type: "password" })).status, 400);
  assert.equal((await f.req("/token", "POST", "client_id=x&client_id=y", {
    "content-type": "application/x-www-form-urlencoded",
  })).status, 400);
  const oversized = await f.req("/register", "POST", JSON.stringify({ client_name: "x".repeat(17_000) }), {
    "content-type": "application/json",
  });
  assert.equal(oversized.status, 400);
  for (let i = 0; i < 61; i++) {
    const response = await f.req("/authorize?" + form({
      response_type: "code", client_id: client, redirect_uri: REDIRECT,
      code_challenge: CHALLENGE, code_challenge_method: "S256",
    }));
    assert.equal(response.status, i < 60 ? 200 : 429);
  }
  for (let i = 0; i < 61; i++) {
    const response = await f.post("/token", { client_id: client, grant_type: "refresh_token", refresh_token: "a".repeat(43) });
    assert.equal(response.status, i < 58 ? 400 : 429);
  }
  for (let i = 0; i < 9; i++) {
    const response = await f.req("/register", "POST", JSON.stringify({ redirect_uris: [REDIRECT] }), {
      "content-type": "application/json",
    });
    assert.equal(response.status, i < 8 ? 201 : 429);
  }
});
