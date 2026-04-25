import { GarminConnect } from "garmin-connect";
import { config } from "../config.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_DIR = path.resolve(__dirname, "..", "..", ".garmin-tokens");

let client: InstanceType<typeof GarminConnect> | null = null;

export async function getGarminClient(): Promise<InstanceType<typeof GarminConnect>> {
  if (client) return client;

  if (!config.garmin.username || !config.garmin.password) {
    throw new Error(
      "Garmin credentials not configured. Set GARMIN_USERNAME and GARMIN_PASSWORD in .env"
    );
  }

  client = new GarminConnect({
    username: config.garmin.username,
    password: config.garmin.password,
  });

  // Try to load cached session tokens
  if (fs.existsSync(TOKEN_DIR)) {
    try {
      client.loadTokenByFile(TOKEN_DIR);
    } catch {
      // Token expired or invalid, will re-login
    }
  }

  try {
    await client.login();
    // Cache the session tokens
    if (!fs.existsSync(TOKEN_DIR)) {
      fs.mkdirSync(TOKEN_DIR, { recursive: true });
    }
    client.exportTokenToFile(TOKEN_DIR);
  } catch (err: any) {
    client = null;
    throw new Error(`Garmin login failed: ${err.message}`);
  }

  return client;
}

export interface GarminActivity {
  activityId: number;
  activityName: string;
  activityType: { typeKey: string };
  startTimeLocal: string;
  distance: number;
  duration: number;
  movingDuration: number;
  averageSpeed: number;
  maxSpeed: number;
  averageHR: number;
  maxHR: number;
  calories: number;
  elevationGain: number;
  averageRunningCadenceInStepsPerMinute?: number;
  vO2MaxValue?: number;
  [key: string]: any;
}

export async function getActivities(start = 0, limit = 20): Promise<GarminActivity[]> {
  const gc = await getGarminClient();
  return gc.getActivities(start, limit) as Promise<GarminActivity[]>;
}

export async function getActivityDetails(activityId: number): Promise<GarminActivity> {
  const gc = await getGarminClient();
  return gc.getActivity({ activityId }) as Promise<GarminActivity>;
}

export async function getHeartRate(date?: Date): Promise<any> {
  const gc = await getGarminClient();
  return gc.getHeartRate(date);
}

export async function getSleepData(date?: Date): Promise<any> {
  const gc = await getGarminClient();
  return gc.getSleepData(date);
}

export async function getSteps(date?: Date): Promise<number> {
  const gc = await getGarminClient();
  return gc.getSteps(date);
}

export async function getUserProfile(): Promise<any> {
  const gc = await getGarminClient();
  return gc.getUserProfile();
}

export async function getUserSettings(): Promise<any> {
  const gc = await getGarminClient();
  return gc.getUserSettings();
}
