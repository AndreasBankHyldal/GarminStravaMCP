import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "../src/server.js";
import { startHttpServer, type RunningHttpServer } from "../src/http/server.js";
import { currentUser, isValidUserId, runAsUser, userContextFor, type UserContext } from "../src/users/context.js";
import { createUserRegistry, generateToken, hashToken, readUsers, writeUsers } from "../src/users/registry.js";
import { parseTokenBundle, readTokenBundle, tokenUploadUrl, writeTokenBundle } from "../src/garmin/token-store.js";
import { closeDb } from "../src/db/database.js";
import { resetGarminClient } from "../src/garmin/client.js";

const OWNER_TOKEN = "owner-token-0123456789abcdef0123456789abcdef";
const ALICE_TOKEN = generateToken();
const BOB_TOKEN = generateToken();

const sampleBundle = {
  oauth1: { oauth_token: "o1-token", oauth_token_secret: "o1-secret" },
  oauth2: { access_token: "o2-access", refresh_token: "o2-refresh", expires_at: 123 },
};

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "garmin-mcp-users-"));
}

function ownerFor(stateDir: string): UserContext {
  const dir = path.join(stateDir, "owner");
  return {
    id: "owner",
    garminTokenDir: path.join(dir, ".garmin-tokens"),
    garminMfaDir: path.join(dir, ".garmin-mfa"),
    dbPath: path.join(dir, "data", "training.db"),
    garminUsername: "",
    garminPassword: "",
  };
}

function seedUsers(stateDir: string): void {
  writeUsers(stateDir, [
    { id: "alice", tokenSha256: hashToken(ALICE_TOKEN), createdAt: "2026-10-13T00:00:00.000Z" },
    { id: "bob", tokenSha256: hashToken(BOB_TOKEN), createdAt: "2026-10-13T00:00:00.000Z" },
  ]);
}

test("user ids are restricted to safe path segments and never 'owner'", () => {
  for (const id of ["alice", "a", "bob-2", "x_y", "a".repeat(32)]) assert.equal(isValidUserId(id), true, id);
  for (const id of ["", "owner", "Alice", "../x", "a/b", "-a", "a b", "a".repeat(33)]) {
    assert.equal(isValidUserId(id), false, id);
  }
  assert.throws(() => userContextFor("/state", "../etc"), /Invalid user id/);
});

test("users file is validated", () => {
  const dir = tempStateDir();
  const write = (users: unknown) => fs.writeFileSync(path.join(dir, "users.json"), JSON.stringify({ users }));
  assert.deepEqual(readUsers(dir), []);
  write([{ id: "owner", tokenSha256: hashToken("x") }]);
  assert.throws(() => readUsers(dir), /invalid user id/);
  write([{ id: "alice", tokenSha256: "not-a-hash" }]);
  assert.throws(() => readUsers(dir), /invalid tokenSha256/);
  write([{ id: "alice", tokenSha256: hashToken("x") }, { id: "alice", tokenSha256: hashToken("y") }]);
  assert.throws(() => readUsers(dir), /duplicate/);
});

test("registry resolves owner and users, stores only hashes, and reloads on change", () => {
  const stateDir = tempStateDir();
  const owner = ownerFor(stateDir);
  const registry = createUserRegistry({ stateDir, owner, ownerToken: OWNER_TOKEN });

  assert.equal(registry.authenticate(OWNER_TOKEN), owner);
  assert.equal(registry.authenticate(ALICE_TOKEN), null);

  seedUsers(stateDir);
  assert.doesNotMatch(fs.readFileSync(path.join(stateDir, "users.json"), "utf8"), new RegExp(ALICE_TOKEN));
  assert.equal(fs.statSync(path.join(stateDir, "users.json")).mode & 0o777, 0o600);

  const alice = registry.authenticate(ALICE_TOKEN);
  assert.equal(alice?.id, "alice");
  assert.equal(alice?.dbPath, path.join(stateDir, "users", "alice", "data", "training.db"));
  assert.equal(alice?.garminTokenDir, path.join(stateDir, "users", "alice", ".garmin-tokens"));
  assert.equal(alice?.garminPassword, "");
  assert.equal(registry.authenticate(BOB_TOKEN)?.id, "bob");
  assert.equal(registry.authenticate("wrong"), null);
  assert.equal(registry.authenticate(""), null);

  writeUsers(stateDir, readUsers(stateDir).filter((user) => user.id !== "bob"));
  assert.equal(registry.authenticate(BOB_TOKEN), null);

  // A broken file keeps the last valid list instead of locking everyone out.
  fs.writeFileSync(path.join(stateDir, "users.json"), "{ not json");
  assert.equal(registry.authenticate(ALICE_TOKEN)?.id, "alice");
});

test("registry invalidates removed, rotated and re-created users only", () => {
  const stateDir = tempStateDir();
  seedUsers(stateDir);
  const invalidated: string[] = [];
  const registry = createUserRegistry({
    stateDir,
    owner: ownerFor(stateDir),
    ownerToken: OWNER_TOKEN,
    onUserInvalidated: (user) => invalidated.push(user.id),
  });
  registry.authenticate(ALICE_TOKEN);
  assert.deepEqual(invalidated, []);

  const users = readUsers(stateDir);
  writeUsers(stateDir, [{ ...users[0], tokenSha256: hashToken("rotated") }, users[1]]);
  registry.authenticate(BOB_TOKEN);
  assert.deepEqual(invalidated, ["alice"]);

  writeUsers(stateDir, [{ ...users[0], tokenSha256: hashToken("rotated") }]);
  registry.authenticate(BOB_TOKEN);
  assert.deepEqual(invalidated, ["alice", "bob"]);

  writeUsers(stateDir, [{ ...users[0], tokenSha256: hashToken("rotated"), createdAt: "2026-10-14T00:00:00.000Z" }]);
  registry.authenticate("rotated");
  assert.deepEqual(invalidated, ["alice", "bob", "alice"]);
});

test("user context follows async work started inside runAsUser", async () => {
  const alice = userContextFor("/state", "alice");
  const seen = await runAsUser(alice, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return currentUser().id;
  });
  assert.equal(seen, "alice");
  assert.equal(currentUser().id, "owner");
});

test("token bundles are validated and written privately", () => {
  assert.deepEqual(parseTokenBundle(sampleBundle), sampleBundle);
  for (const bad of [null, [], {}, { oauth1: {}, oauth2: {} }, { ...sampleBundle, oauth1: { oauth_token: "x" } },
    { ...sampleBundle, oauth2: { access_token: "x", refresh_token: 5 } }]) {
    assert.throws(() => parseTokenBundle(bad));
  }

  const dir = path.join(tempStateDir(), "tokens");
  writeTokenBundle(dir, parseTokenBundle(sampleBundle));
  assert.deepEqual(readTokenBundle(dir), sampleBundle);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "oauth1_token.json")).mode & 0o777, 0o600);
});

test("upload URL accepts the server or /mcp URL and refuses plain HTTP", () => {
  for (const input of ["https://g.example.org", "https://g.example.org/", "https://g.example.org/mcp", "https://g.example.org/mcp/"]) {
    assert.equal(tokenUploadUrl(input), "https://g.example.org/garmin-tokens", input);
  }
  assert.equal(tokenUploadUrl("http://localhost:3000/mcp"), "http://localhost:3000/garmin-tokens");
  assert.throws(() => tokenUploadUrl("http://g.example.org"), /plain HTTP/);
});

async function withMultiUserServer(run: (server: RunningHttpServer, stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = tempStateDir();
  seedUsers(stateDir);
  const server = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    authToken: OWNER_TOKEN,
    users: createUserRegistry({
      stateDir,
      owner: ownerFor(stateDir),
      ownerToken: OWNER_TOKEN,
      onUserInvalidated: (user) => {
        closeDb(user.dbPath);
        resetGarminClient(user.id);
      },
    }),
    allowedHosts: [],
    createMcpServer: createServer,
  });
  try {
    await run(server, stateDir);
  } finally {
    await server.close();
  }
}

async function callTool(url: string, token: string, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: "multi-user-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return { isError: Boolean(result.isError), text: content.map((block) => block.text).join("\n") };
  } finally {
    await client.close();
  }
}

test("each user gets their own training database over HTTP", async () => {
  await withMultiUserServer(async ({ url }, stateDir) => {
    const created = await callTool(url, ALICE_TOKEN, "create_training_plan", {
      name: "Alice 10K",
      start_date: "2026-10-20",
      workouts: [{ date: "2026-10-20", workout_type: "easy_run" }],
    });
    assert.equal(created.isError, false, created.text);

    assert.match((await callTool(url, ALICE_TOKEN, "get_training_plan", {})).text, /Alice 10K/);
    for (const token of [BOB_TOKEN, OWNER_TOKEN]) {
      const other = await callTool(url, token, "get_training_plan", {});
      assert.doesNotMatch(other.text, /Alice 10K/);
    }
    assert.ok(fs.existsSync(path.join(stateDir, "users", "alice", "data", "training.db")));
  });
});

test("a purged and re-added user id starts with an empty database", async () => {
  await withMultiUserServer(async ({ url }, stateDir) => {
    await callTool(url, ALICE_TOKEN, "create_training_plan", {
      name: "Old Alice plan",
      start_date: "2026-10-20",
      workouts: [{ date: "2026-10-20", workout_type: "easy_run" }],
    });
    assert.match((await callTool(url, ALICE_TOKEN, "get_training_plan", {})).text, /Old Alice plan/);

    // What `users remove alice --purge` followed by `users add alice` does on disk.
    writeUsers(stateDir, readUsers(stateDir).filter((user) => user.id !== "alice"));
    fs.rmSync(path.join(stateDir, "users", "alice"), { recursive: true, force: true });
    const newToken = generateToken();
    writeUsers(stateDir, [
      ...readUsers(stateDir),
      { id: "alice", tokenSha256: hashToken(newToken), createdAt: "2026-10-14T00:00:00.000Z" },
    ]);

    assert.equal((await fetch(`${url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${ALICE_TOKEN}` } })).status, 401);
    assert.doesNotMatch((await callTool(url, newToken, "get_training_plan", {})).text, /Old Alice plan/);
  });
});

test("token upload stores the session for the authenticated user only", async () => {
  await withMultiUserServer(async ({ url }, stateDir) => {
    const put = (token: string, body: unknown, method = "PUT") =>
      fetch(`${url}/garmin-tokens`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(body),
      });

    assert.equal((await put("wrong-token", sampleBundle)).status, 401);
    assert.equal((await put(ALICE_TOKEN, { oauth1: {} })).status, 400);
    assert.equal((await put(ALICE_TOKEN, undefined, "GET")).status, 405);

    const ok = await put(ALICE_TOKEN, sampleBundle);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { status: "ok", user: "alice" });
    assert.deepEqual(readTokenBundle(path.join(stateDir, "users", "alice", ".garmin-tokens")), sampleBundle);
    assert.ok(!fs.existsSync(path.join(stateDir, "users", "bob", ".garmin-tokens", "oauth1_token.json")));
    assert.ok(!fs.existsSync(path.join(stateDir, "owner", ".garmin-tokens", "oauth1_token.json")));
  });
});

test("a user without a Garmin session gets a clear error and no login attempt", async () => {
  await withMultiUserServer(async ({ url }) => {
    const result = await callTool(url, BOB_TOKEN, "garmin_get_activities", { count: 1 });
    assert.match(result.text, /No valid Garmin session for user "bob"/);
    assert.match(result.text, /never stores their Garmin password/);
  });
});
