import fs from "node:fs";
import path from "node:path";

export const OAUTH1_FILE = "oauth1_token.json";
export const OAUTH2_FILE = "oauth2_token.json";
const MAX_FIELD_LENGTH = 8192;

export interface GarminTokenBundle {
  oauth1: Record<string, unknown>;
  oauth2: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStrings(object: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of keys) {
    const value = object[key];
    if (typeof value !== "string" || !value || value.length > MAX_FIELD_LENGTH) {
      throw new Error(`${label}.${key} must be a non-empty string`);
    }
  }
}

/** Validates the shape written by @gooin/garmin-connect's exportTokenToFile. */
export function parseTokenBundle(body: unknown): GarminTokenBundle {
  if (!isPlainObject(body)) throw new Error("Body must be a JSON object with oauth1 and oauth2");
  const { oauth1, oauth2 } = body;
  if (!isPlainObject(oauth1)) throw new Error("oauth1 must be an object");
  if (!isPlainObject(oauth2)) throw new Error("oauth2 must be an object");
  requireStrings(oauth1, ["oauth_token", "oauth_token_secret"], "oauth1");
  requireStrings(oauth2, ["access_token", "refresh_token"], "oauth2");
  return { oauth1, oauth2 };
}

export function readTokenBundle(dir: string): GarminTokenBundle {
  return parseTokenBundle({
    oauth1: JSON.parse(fs.readFileSync(path.join(dir, OAUTH1_FILE), "utf8")),
    oauth2: JSON.parse(fs.readFileSync(path.join(dir, OAUTH2_FILE), "utf8")),
  });
}

/** Atomically replaces both token files, readable only by the server user. */
export function writeTokenBundle(dir: string, bundle: GarminTokenBundle): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, data] of [[OAUTH1_FILE, bundle.oauth1], [OAUTH2_FILE, bundle.oauth2]] as const) {
    const target = path.join(dir, name);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, target);
  }
}

/** https://host, https://host/ and https://host/mcp all resolve to https://host/garmin-tokens. */
export function tokenUploadUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Refusing to send tokens over plain HTTP; use the https:// server URL");
  }
  url.pathname = url.pathname.replace(/\/(mcp)?\/?$/, "") + "/garmin-tokens";
  url.search = "";
  url.hash = "";
  return url.toString();
}
