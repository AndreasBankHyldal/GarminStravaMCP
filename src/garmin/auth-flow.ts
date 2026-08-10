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
 */
import GarminConnectModule from "@gooin/garmin-connect";
import { MFAManager as MFAManagerImport } from "@gooin/garmin-connect";
import { config } from "../config.js";
import fs from "node:fs";
import readline from "node:readline";

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

async function main() {
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
