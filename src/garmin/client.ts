import GarminConnectModule from "@gooin/garmin-connect";
import { config } from "../config.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GarminConnect = (GarminConnectModule as any).GarminConnect ?? GarminConnectModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_DIR = path.resolve(__dirname, "..", "..", ".garmin-tokens");

let client: any = null;

export async function getGarminClient(): Promise<any> {
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
      await client.loadTokenByFile(TOKEN_DIR);
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
    await client.exportTokenToFile(TOKEN_DIR);
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

export async function countActivities(): Promise<number> {
  const gc = await getGarminClient();
  const result = await gc.countActivities();
  return (result as any)?.totalActivities ?? (result as any)?.count ?? 0;
}

export async function getAllActivities(maxActivities = 500): Promise<GarminActivity[]> {
  const batchSize = 100;
  const all: GarminActivity[] = [];
  for (let start = 0; start < maxActivities; start += batchSize) {
    const batch = await getActivities(start, Math.min(batchSize, maxActivities - start));
    all.push(...batch);
    if (batch.length < batchSize) break;
  }
  return all;
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

export async function getWorkouts(start = 0, limit = 20): Promise<any[]> {
  const gc = await getGarminClient();
  return gc.getWorkouts(start, limit);
}

export async function getWorkoutDetail(workoutId: string): Promise<any> {
  const gc = await getGarminClient();
  return gc.getWorkoutDetail({ workoutId });
}

export async function addRunningWorkout(
  name: string,
  meters: number,
  description: string
): Promise<any> {
  const gc = await getGarminClient();
  return gc.addRunningWorkout(name, meters, description);
}

export async function deleteWorkout(workoutId: string): Promise<any> {
  const gc = await getGarminClient();
  return gc.deleteWorkout({ workoutId });
}

export async function scheduleWorkout(workoutId: string, date?: Date): Promise<any> {
  const gc = await getGarminClient();
  return gc.scheduleWorkout({ workoutId }, date);
}

export async function getTrainingStatus(date?: Date): Promise<any> {
  const gc = await getGarminClient();
  return gc.getTrainingStatus(date);
}

export async function getHRVData(date?: Date): Promise<any> {
  const gc = await getGarminClient();
  return gc.getHRVData(date);
}

export async function getPersonalInfo(): Promise<any> {
  const gc = await getGarminClient();
  return gc.getPersonalInfo();
}
