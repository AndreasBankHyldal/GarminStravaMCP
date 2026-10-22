#!/usr/bin/env node
/**
 * Manage the people who may use a hosted server. Run on the server, e.g.:
 *   docker compose exec app node dist/users/cli.js add alice
 * Tokens are shown once and only their SHA-256 hash is stored in <state>/users.json.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { isValidUserId, userContextFor } from "./context.js";
import { generateToken, hashToken, readUsers, usersFilePath, writeUsers } from "./registry.js";
import { revokeUserOAuthGrants } from "../http/oauth.js";

const stateDir = config.paths.stateDir;

if (!process.env.GARMIN_STATE_DIR && !process.env.GARMIN_STRAVA_STATE_DIR) {
  console.error(
    `Note: GARMIN_STATE_DIR is not set, using ${stateDir}. On the Docker deployment run this ` +
    "inside the container instead: docker compose exec app node dist/users/cli.js <command>"
  );
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function requireId(id: string | undefined): string {
  if (!id) fail("missing user id");
  if (!isValidUserId(id)) {
    fail(`invalid user id "${id}": use 1-32 lowercase letters, digits, - or _, and not "owner"`);
  }
  return id;
}

function printToken(id: string, token: string): void {
  const host = process.env.MCP_PUBLIC_HOST?.trim();
  const server = host ? `https://${host}` : "https://<your-server>";
  // stdout carries only what the admin has to hand over.
  console.log(`\nUser:  ${id}\nToken: ${token}\n`);
  console.log("The token is not shown again. Send it privately (e.g. a password-manager share),");
  console.log("separately from this message, which you can forward as is:\n");
  console.log("----------------------------------------------------------------------------");
  console.log("You've got access to the Garmin MCP server 🎉");
  console.log(`  Server address: ${server}`);
  console.log(`  Your user name: ${id}`);
  console.log("  Your access token: sent to you separately - keep it private.");
  console.log("Setup guide (about 10 minutes):");
  console.log("  https://github.com/AndreasBankHyldal/GarminStravaMCP/blob/main/docs/getting-started.md");
  console.log("----------------------------------------------------------------------------\n");
}

function add(id: string): void {
  const users = readUsers(stateDir);
  if (users.some((user) => user.id === id)) fail(`user "${id}" already exists (use rotate to issue a new token)`);
  const token = generateToken();
  users.push({ id, tokenSha256: hashToken(token), createdAt: new Date().toISOString() });
  writeUsers(stateDir, users);
  fs.mkdirSync(path.dirname(userContextFor(stateDir, id).garminTokenDir), { recursive: true, mode: 0o700 });
  printToken(id, token);
}

function rotate(id: string): void {
  const users = readUsers(stateDir);
  const user = users.find((entry) => entry.id === id);
  if (!user) fail(`no user "${id}"`);
  const token = generateToken();
  user.tokenSha256 = hashToken(token);
  writeUsers(stateDir, users);
  printToken(id, token);
}

function remove(id: string, purge: boolean): void {
  const users = readUsers(stateDir);
  if (!users.some((user) => user.id === id)) fail(`no user "${id}"`);
  writeUsers(stateDir, users.filter((user) => user.id !== id));
  const dir = path.join(stateDir, "users", id);
  if (purge) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`Removed "${id}" and deleted ${dir}.`);
  } else {
    console.log(`Removed "${id}". Their data is kept in ${dir} (rerun with --purge to delete it).`);
  }
}

function list(): void {
  const users = readUsers(stateDir);
  console.log(`State directory: ${stateDir}`);
  console.log("owner  (MCP_AUTH_TOKEN, existing state layout)");
  for (const user of users) {
    const hasTokens = fs.existsSync(path.join(userContextFor(stateDir, user.id).garminTokenDir, "oauth1_token.json"));
    console.log(`${user.id}  created ${user.createdAt}  garmin session: ${hasTokens ? "uploaded" : "missing"}`);
  }
  if (!users.length) console.log(`(no other users in ${usersFilePath(stateDir)})`);
}

const [command, id, ...flags] = process.argv.slice(2);
switch (command) {
  case "add":
    add(requireId(id));
    break;
  case "rotate":
    rotate(requireId(id));
    break;
  case "remove":
    remove(requireId(id), flags.includes("--purge"));
    break;
  case "list":
    list();
    break;
  case "revoke-oauth": {
    const userId = id === "owner" ? id : requireId(id);
    revokeUserOAuthGrants(stateDir, userId);
    console.log(`Revoked OAuth grants for "${userId}". Existing static access tokens are unchanged.`);
    break;
  }
  default:
    console.error("Usage: users <add|rotate|remove [--purge]|revoke-oauth|list> [id]");
    process.exit(command ? 1 : 0);
}
