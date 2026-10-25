import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loginWithInteractiveMfa } from "../src/garmin/mfa.js";
import { readTokenBundle, writeTokenBundle } from "../src/garmin/token-store.js";
import { ensurePrivateDirectory, ensurePrivateFile } from "../src/private-files.js";

function clientFor(login: (manager: ReturnType<typeof mfaManager>, sessionId: string) => Promise<void>) {
  const manager = mfaManager();
  return {
    client: { mfaManager: manager },
    async login(_username: string, _password: string, sessionId: string): Promise<void> {
      await login(manager, sessionId);
    },
  };
}

function mfaManager() {
  return {
    async waitForMFACode(_sessionId: string, _timeout?: number): Promise<string> {
      throw new Error("The logging, file-backed MFA store must not be used");
    },
  };
}

test("interactive MFA keeps codes in memory and never logs them or uses the file-backed waiter", async (t) => {
  const logged: unknown[][] = [];
  t.mock.method(console, "log", (...args: unknown[]) => logged.push(args));
  t.mock.method(console, "error", (...args: unknown[]) => logged.push(args));
  let received = "";
  const client = clientFor(async (manager, sessionId) => {
    assert.match(sessionId, /^garmin-auth-[0-9a-f-]{36}$/);
    received = await manager.waitForMFACode(sessionId);
  });
  const original = client.client.mfaManager.waitForMFACode;
  await loginWithInteractiveMfa(client, "test-user", "test-password", async () => " 123456 ");
  assert.equal(received, "123456");
  assert.deepEqual(logged, []);
  assert.equal(client.client.mfaManager.waitForMFACode, original);
});

test("interactive MFA only prompts when Garmin actually requests a code", async () => {
  const client = clientFor(async () => {});
  const original = client.client.mfaManager.waitForMFACode;
  await loginWithInteractiveMfa(client, "test-user", "test-password", async () => {
    assert.fail("No MFA challenge was received");
  });
  assert.equal(client.client.mfaManager.waitForMFACode, original);
});

test("interactive MFA surfaces terminal failures, empty codes and timeouts and restores the original waiter", async () => {
  for (const scenario of ["terminal", "empty", "timeout"]) {
    const client = clientFor(async (manager, sessionId) => {
      await manager.waitForMFACode(sessionId, 5);
    });
    const original = client.client.mfaManager.waitForMFACode;
    await assert.rejects(loginWithInteractiveMfa(client, "test-user", "test-password", async () => {
      if (scenario === "terminal") throw new Error("Terminal unavailable");
      if (scenario === "timeout") return new Promise<string>(() => {});
      return " ";
    }), scenario === "terminal" ? /Terminal unavailable/ : scenario === "empty" ? /No Garmin MFA/ : /timed out/);
    assert.equal(client.client.mfaManager.waitForMFACode, original);
  }
});

test("token writes repair legacy permissions and leave no temporary files", { skip: process.platform === "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "garmin-token-security-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "tokens");
  fs.mkdirSync(directory);
  fs.chmodSync(directory, 0o755);
  for (const file of ["oauth1_token.json", "oauth2_token.json"]) {
    fs.writeFileSync(path.join(directory, file), "{}");
    fs.chmodSync(path.join(directory, file), 0o644);
  }
  const bundle = {
    oauth1: { oauth_token: "test-oauth1", oauth_token_secret: "test-secret" },
    oauth2: { access_token: "test-access", refresh_token: "test-refresh" },
  };
  writeTokenBundle(directory, bundle);
  assert.deepEqual(readTokenBundle(directory), bundle);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["oauth1_token.json", "oauth2_token.json"]);
  for (const file of fs.readdirSync(directory)) {
    assert.equal(fs.statSync(path.join(directory, file)).mode & 0o777, 0o600);
  }
});

test("private files preserve contents and never change an existing parent directory's permissions", {
  skip: process.platform === "win32",
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "garmin-file-security-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o755);
  const file = path.join(root, "existing.sqlite");
  fs.writeFileSync(file, "existing data");
  fs.chmodSync(file, 0o644);
  ensurePrivateFile(file);
  assert.equal(fs.readFileSync(file, "utf8"), "existing data");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(root).mode & 0o777, 0o755);
  const created = path.join(root, "new.sqlite");
  ensurePrivateFile(created);
  assert.equal(fs.statSync(created).mode & 0o777, 0o600);
  const directory = path.join(root, "private");
  ensurePrivateDirectory(directory);
  fs.chmodSync(directory, 0o755);
  ensurePrivateDirectory(directory);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
});

test("reading legacy tokens repairs permissions without changing their contents", {
  skip: process.platform === "win32",
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "garmin-read-security-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o755);
  const bundle = {
    oauth1: { oauth_token: "test-oauth1", oauth_token_secret: "test-secret" },
    oauth2: { access_token: "test-access", refresh_token: "test-refresh" },
  };
  const files = [
    ["oauth1_token.json", JSON.stringify(bundle.oauth1)],
    ["oauth2_token.json", JSON.stringify(bundle.oauth2)],
  ];
  for (const [file, text] of files) {
    fs.writeFileSync(path.join(root, file), text);
    fs.chmodSync(path.join(root, file), 0o644);
  }
  assert.deepEqual(readTokenBundle(root), bundle);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  for (const [file, text] of files) {
    assert.equal(fs.statSync(path.join(root, file)).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(root, file), "utf8"), text);
  }
});
