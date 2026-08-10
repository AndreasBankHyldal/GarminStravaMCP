#!/usr/bin/env tsx
/**
 * One-time Strava OAuth authentication flow.
 * Run with: npm run strava-auth
 *
 * This starts a local server, opens your browser, and captures the OAuth code.
 */
import http from "node:http";
import { config } from "../config.js";
import fs from "node:fs";

const TOKEN_FILE = config.paths.stravaTokenFile;
const PORT = 8089;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

async function main() {
  if (!config.strava.clientId || !config.strava.clientSecret) {
    console.error("Error: Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in your .env file");
    console.error("Get these from https://www.strava.com/settings/api");
    process.exit(1);
  }

  const authUrl =
    `https://www.strava.com/oauth/authorize` +
    `?client_id=${config.strava.clientId}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&approval_prompt=auto` +
    `&scope=read,activity:read_all,profile:read_all`;

  console.log("\n🏃 Strava OAuth Setup\n");
  console.log("1. Make sure your Strava API app has this callback URL:");
  console.log(`   ${REDIRECT_URI}\n`);
  console.log("2. Open this URL in your browser:\n");
  console.log(`   ${authUrl}\n`);
  console.log("Waiting for authorization...\n");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${PORT}`);

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");

      if (!code) {
        res.writeHead(400);
        res.end("No code received");
        return;
      }

      try {
        const tokenResp = await fetch("https://www.strava.com/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: config.strava.clientId,
            client_secret: config.strava.clientSecret,
            code,
            grant_type: "authorization_code",
          }),
        });

        if (!tokenResp.ok) {
          throw new Error(`Token exchange failed: ${await tokenResp.text()}`);
        }

        const data = await tokenResp.json() as any;

        const tokens = {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: data.expires_at,
        };

        fs.mkdirSync(config.paths.stateDir, { recursive: true });
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html><body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>✅ Strava Connected!</h1>
            <p>Tokens saved. You can close this window.</p>
          </body></html>
        `);

        console.log("✅ Authentication successful! Tokens saved to .strava-tokens.json");
        console.log(`   Token location: ${TOKEN_FILE}`);
        console.log("   You can now start the MCP server with: npm run dev\n");

        setTimeout(() => process.exit(0), 500);
      } catch (err) {
        res.writeHead(500);
        res.end(`Error: ${err}`);
        console.error("Error during token exchange:", err);
      }
    }
  });

  server.listen(PORT, () => {
    console.log(`Local callback server listening on port ${PORT}`);
  });
}

main().catch(console.error);
