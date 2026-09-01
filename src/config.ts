import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Load .env manually to avoid dotenv printing to stdout (breaks MCP stdio)
const defaultStateDir =
  process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "GarminStravaMCP")
    : projectRoot;

function resolveProjectPath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function resolveStateDir(): string {
  return process.env.GARMIN_STRAVA_STATE_DIR
    ? resolveProjectPath(process.env.GARMIN_STRAVA_STATE_DIR)
    : defaultStateDir;
}

const initialStateDir = resolveStateDir();
const explicitEnvPath = process.env.GARMIN_STRAVA_ENV_FILE
  ? resolveProjectPath(process.env.GARMIN_STRAVA_ENV_FILE)
  : null;
const stateEnvPath = path.join(initialStateDir, ".env");
const legacyEnvPath = path.join(projectRoot, ".env");
const envPath =
  explicitEnvPath ??
  (fs.existsSync(stateEnvPath) ? stateEnvPath : legacyEnvPath);

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const stateDir = resolveStateDir();

function resolveStatePath(value: string | undefined, fallback: string): string {
  if (!value) return path.join(stateDir, fallback);
  return path.isAbsolute(value) ? value : path.resolve(stateDir, value);
}

function resolveStateArtifact(relativePath: string): string {
  const preferredPath = path.join(stateDir, relativePath);
  const legacyPath = path.join(projectRoot, relativePath);
  if (
    stateDir !== projectRoot &&
    !fs.existsSync(preferredPath) &&
    fs.existsSync(legacyPath)
  ) {
    console.error(
      `Using legacy project-local state at ${legacyPath}. ` +
      `Move it to ${preferredPath} to keep it outside the source tree.`
    );
    return legacyPath;
  }
  return preferredPath;
}

const defaultDbPath = path.join("data", "training.db");
const configuredDbPath = process.env.DB_PATH;
const dbPath =
  !configuredDbPath ||
  (!path.isAbsolute(configuredDbPath) &&
    path.normalize(configuredDbPath) === path.normalize(defaultDbPath))
    ? resolveStateArtifact(defaultDbPath)
    : resolveStatePath(configuredDbPath, defaultDbPath);

export const config = {
  paths: {
    projectRoot,
    stateDir,
    envFile: envPath,
    stravaTokenFile: resolveStateArtifact(".strava-tokens.json"),
    garminTokenDir: resolveStateArtifact(".garmin-tokens"),
    garminMfaDir: path.join(stateDir, ".garmin-mfa"),
  },
  strava: {
    clientId: process.env.STRAVA_CLIENT_ID ?? "",
    clientSecret: process.env.STRAVA_CLIENT_SECRET ?? "",
    accessToken: process.env.STRAVA_ACCESS_TOKEN ?? "",
    refreshToken: process.env.STRAVA_REFRESH_TOKEN ?? "",
  },
  women: {
    toolsEnabled:
      process.env.I_AM_WOMAN?.trim().toLowerCase() === "true",
  },
  garmin: {
    username: process.env.GARMIN_USERNAME ?? "",
    password: process.env.GARMIN_PASSWORD ?? "",
    womenHealthEnabled:
      process.env.GARMIN_WOMENS_HEALTH_ENABLED?.trim().toLowerCase() === "true",
  },
  dbPath,
};
