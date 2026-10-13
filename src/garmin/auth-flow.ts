#!/usr/bin/env tsx
/**
 * One-time interactive Garmin Connect authentication flow (handles MFA / SMS codes).
 * Run with: npm run garmin-auth
 *
 * Garmin may require multi-factor authentication (a code sent via SMS/email/app).
 * The MCP server runs over stdio and cannot prompt for that code interactively, so
 * this script performs the login in a terminal where you CAN enter the code, then
 * caches the resulting session tokens in the configured state directory. The server
 * reuses those cached tokens and only needs a fresh login when they expire.
 *
 * Hosted servers can't log in to Garmin themselves (Garmin rate-limits datacenter IPs), so:
 *   npm run garmin-auth -- --upload https://your-host        log in here, then upload the session
 *   npm run garmin-auth -- --upload https://your-host --skip-login   upload existing tokens
 * The upload authenticates with your personal server token from GARMIN_MCP_TOKEN (or a prompt).
 */
import GarminConnectModule from "@gooin/garmin-connect";
import { MFAManager as MFAManagerImport } from "@gooin/garmin-connect";
import { config } from "../config.js";
import fs from "node:fs";
import readline from "node:readline";
import { readTokenBundle, tokenUploadUrl } from "./token-store.js";

const GarminConnect = (GarminConnectModule as any).GarminConnect ?? GarminConnectModule;
const MFAManager = (MFAManagerImport as any) ?? (GarminConnectModule as any).MFAManager;

const TOKEN_DIR = config.paths.garminTokenDir;
const MFA_DIR = config.paths.garminMfaDir;

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseArgs(argv: string[]): { uploadUrl: string | null; skipLogin: boolean } {
  const index = argv.indexOf("--upload");
  const uploadUrl = index === -1 ? null : argv[index + 1];
  if (index !== -1 && (!uploadUrl || uploadUrl.startsWith("--"))) {
    console.error("Error: --upload needs the server URL, e.g. --upload https://your-name.duckdns.org");
    process.exit(1);
  }
  const skipLogin = argv.includes("--skip-login");
  if (skipLogin && !uploadUrl) {
    console.error("Error: --skip-login is only useful together with --upload <url>");
    process.exit(1);
  }
  return { uploadUrl, skipLogin };
}

async function uploadTokens(serverUrl: string): Promise<void> {
  const target = tokenUploadUrl(serverUrl);
  const bundle = readTokenBundle(TOKEN_DIR);
  const token = process.env.GARMIN_MCP_TOKEN?.trim() || (await prompt("Your server access token: "));
  if (!token) throw new Error("No server access token given (set GARMIN_MCP_TOKEN)");

  const response = await fetch(target, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(bundle),
  });
  if (response.status === 401) throw new Error("The server rejected the access token (401)");
  if (!response.ok) {
    throw new Error(`Upload failed: HTTP ${response.status} ${await response.text()}`);
  }
  const result = (await response.json()) as { user?: string };
  console.log(`✅ Garmin session uploaded to ${new URL(target).host} for user "${result.user}".`);
}

async function main() {
  const { uploadUrl, skipLogin } = parseArgs(process.argv.slice(2));
  if (skipLogin && uploadUrl) {
    try {
      await uploadTokens(uploadUrl);
      process.exit(0);
    } catch (err: any) {
      console.error(`\n❌ ${err?.message ?? err}`);
      process.exit(1);
    }
  }

  if (!config.garmin.username || !config.garmin.password) {
    console.error("Error: Set GARMIN_USERNAME and GARMIN_PASSWORD in your .env file");
    process.exit(1);
  }

  // Explicit MFA session dir — the library defaults to /tmp, which doesn't exist on Windows.
  fs.mkdirSync(MFA_DIR, { recursive: true });

  console.log("\n⌚ Garmin Connect Setup (with MFA support)\n");
  console.log(`Logging in as ${config.garmin.username}...`);
  console.log("If your account has MFA enabled, Garmin will send you a code (SMS/email/app).\n");

  const gc = new GarminConnect({
    username: config.garmin.username,
    password: config.garmin.password,
    mfa: { type: "file", dir: MFA_DIR },
  });

  const sessionId = `garmin-auth-${Date.now()}`;
  let loginSettled = false;

  // Kick off login. If MFA is required, this blocks until the code is submitted
  // (or the library's 5-minute timeout elapses).
  const loginPromise = gc
    .login(config.garmin.username, config.garmin.password, sessionId)
    .then(() => {
      loginSettled = true;
    })
    .catch((err: any) => {
      loginSettled = true;
      throw err;
    });

  // Give the login flow a moment to reach the MFA challenge (and send the SMS).
  await new Promise((r) => setTimeout(r, 2500));

  if (!loginSettled) {
    const code = await prompt("Enter the MFA code Garmin sent you: ");
    if (code) {
      const submitted = await MFAManager.getInstance().submitMFACode(sessionId, code);
      if (!submitted) {
        console.error(
          "\n⚠️  Could not submit the MFA code (no waiting session found). " +
          "The login may have already failed or timed out. Try again."
        );
      }
    }
  }

  try {
    await loginPromise;
  } catch (err: any) {
    console.error(`\n❌ Garmin login failed: ${err?.message ?? err}`);
    cleanup();
    process.exit(1);
  }

  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  await gc.exportTokenToFile(TOKEN_DIR);
  cleanup();

  console.log("\n✅ Garmin authentication successful! Tokens saved to .garmin-tokens/");
  console.log(`   Token location: ${TOKEN_DIR}`);
  console.log("   The MCP server will reuse these tokens — no MFA needed until they expire.\n");
  if (uploadUrl) {
    try {
      await uploadTokens(uploadUrl);
    } catch (err: any) {
      console.error(`\n❌ ${err?.message ?? err}`);
      console.error("   Retry the upload without logging in again: add --skip-login");
      process.exit(1);
    }
  }
  process.exit(0);
}

function cleanup() {
  try {
    fs.rmSync(MFA_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
