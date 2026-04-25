import { config } from "../config.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.resolve(__dirname, "..", "..", ".strava-tokens.json");

interface StravaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

let cachedTokens: StravaTokens | null = null;

function loadTokens(): StravaTokens {
  if (cachedTokens && cachedTokens.expires_at > Date.now() / 1000 + 60) {
    return cachedTokens;
  }

  if (fs.existsSync(TOKEN_FILE)) {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
    cachedTokens = data;
    return data;
  }

  return {
    access_token: config.strava.accessToken,
    refresh_token: config.strava.refreshToken,
    expires_at: 0,
  };
}

function saveTokens(tokens: StravaTokens): void {
  cachedTokens = tokens;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

export async function getAccessToken(): Promise<string> {
  const tokens = loadTokens();

  if (tokens.expires_at > Date.now() / 1000 + 60) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    throw new Error(
      "No Strava refresh token. Run `npm run strava-auth` to authenticate."
    );
  }

  const resp = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.strava.clientId,
      client_secret: config.strava.clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    throw new Error(`Strava token refresh failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json() as StravaTokens;
  saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
  });

  return data.access_token;
}
