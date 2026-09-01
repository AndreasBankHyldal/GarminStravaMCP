import GarminConnectModule from "@gooin/garmin-connect";
import { config } from "../config.js";
import fs from "node:fs";

const GarminConnect = (GarminConnectModule as any).GarminConnect ?? GarminConnectModule;

const TOKEN_DIR = config.paths.garminTokenDir;

let client: any = null;
let lastLoginAttempt = 0;
const LOGIN_COOLDOWN_MS = 60_000; // Wait at least 60s between login attempts
let lastHealthCheckAt = 0;
let requestQueue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

const HEALTH_CHECK_INTERVAL_MS = 10 * 60_000;
const REQUEST_GAP_MS = 450;
const RATE_LIMIT_BASE_DELAY_MS = 2_000;
const MAX_RATE_LIMIT_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAuthError(err: any): boolean {
  const status = err?.response?.status ?? err?.status;
  const msg = String(err?.message ?? "");
  return status === 401 || status === 403 || /401|403|forbidden|unauthorized/i.test(msg);
}

function isRateLimitError(err: any): boolean {
  const status = err?.response?.status ?? err?.status;
  const msg = String(err?.message ?? "");
  return status === 429 || /429|too many requests|rate limit/i.test(msg);
}

function isMfaRequiredError(err: any): boolean {
  const msg = String(err?.message ?? "");
  // The library throws a (Chinese) message when MFA is required but no code channel is provided.
  return /MFA|mfa|多因|验证码|two.?factor|2fa/i.test(msg);
}

function getRetryDelayMs(err: any, attempt: number): number {
  const retryAfterHeader =
    err?.response?.headers?.["retry-after"] ??
    err?.response?.headers?.get?.("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  const exponential = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 800);
  return exponential + jitter;
}

function enqueueRequest<T>(task: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const gap = Date.now() - lastRequestAt;
    if (gap < REQUEST_GAP_MS) {
      await sleep(REQUEST_GAP_MS - gap);
    }
    lastRequestAt = Date.now();
    return task();
  };

  const next = requestQueue.then(run, run);
  requestQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function tryLoadTokens(gc: any): Promise<boolean> {
  if (!fs.existsSync(TOKEN_DIR)) return false;
  try {
    await gc.loadTokenByFile(TOKEN_DIR);
    return true;
  } catch {
    return false;
  }
}

async function saveTokens(gc: any): Promise<void> {
  try {
    if (!fs.existsSync(TOKEN_DIR)) {
      fs.mkdirSync(TOKEN_DIR, { recursive: true });
    }
    await gc.exportTokenToFile(TOKEN_DIR);
  } catch {
    // Non-critical — we'll just re-login next time
  }
}

async function performLogin(gc: any): Promise<void> {
  const now = Date.now();
  if (now - lastLoginAttempt < LOGIN_COOLDOWN_MS) {
    const waitSec = Math.ceil((LOGIN_COOLDOWN_MS - (now - lastLoginAttempt)) / 1000);
    throw new Error(
      `Garmin login rate-limited. Wait ${waitSec}s before retrying. ` +
      `Garmin blocks repeated login attempts — this is a cooldown to protect your account.`
    );
  }
  lastLoginAttempt = now;
  await gc.login();
  await saveTokens(gc);
}

export async function getGarminClient(): Promise<any> {
  if (client) {
    // Periodically verify token health to avoid using stale sessions indefinitely.
    if (Date.now() - lastHealthCheckAt > HEALTH_CHECK_INTERVAL_MS) {
      try {
        await client.getUserProfile();
        lastHealthCheckAt = Date.now();
      } catch (err: any) {
        if (isAuthError(err)) {
          client = null;
        } else {
          throw err;
        }
      }
    } else {
      return client;
    }
    if (client) return client;
  }

  if (!config.garmin.username || !config.garmin.password) {
    throw new Error(
      "Garmin credentials not configured. Set GARMIN_USERNAME and GARMIN_PASSWORD in .env"
    );
  }

  const gc = new GarminConnect({
    username: config.garmin.username,
    password: config.garmin.password,
    mfa: { type: "file", dir: config.paths.garminMfaDir },
  });

  // Try cached tokens first to avoid unnecessary logins
  const tokensLoaded = await tryLoadTokens(gc);

  if (!tokensLoaded) {
    // No cached tokens — must do a fresh login
    try {
      await performLogin(gc);
    } catch (err: any) {
      if (isMfaRequiredError(err)) {
        throw new Error(
          "Garmin requires MFA (a code was sent via SMS/email/app), but the MCP server " +
          "can't prompt for it over stdio. Run `npm run garmin-auth` once in a terminal to " +
          "enter the code and cache your session tokens, then restart the server."
        );
      }
      throw new Error(`Garmin login failed: ${err.message}`);
    }
  }

  client = gc;
  lastHealthCheckAt = Date.now();
  return client;
}

/** Wrap a Garmin API call with automatic re-auth on 403 */
async function withRetry<T>(fn: (gc: any) => Promise<T>): Promise<T> {
  return enqueueRequest(async () => {
    let gc = await getGarminClient();

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      try {
        return await fn(gc);
      } catch (err: any) {
        if (isAuthError(err)) {
          // Session likely expired — clear and re-auth once.
          console.error("Garmin session expired, re-authenticating...");
          client = null;
          try {
            gc = await getGarminClient();
            await performLogin(gc);
            client = gc;
            lastHealthCheckAt = Date.now();
            continue;
          } catch (retryErr: any) {
            client = null;
            throw new Error(`Garmin re-auth failed: ${retryErr.message}`);
          }
        }

        if (isRateLimitError(err) && attempt < MAX_RATE_LIMIT_RETRIES) {
          const waitMs = getRetryDelayMs(err, attempt);
          console.error(`Garmin rate-limited (429). Retrying in ${Math.ceil(waitMs / 1000)}s...`);
          await sleep(waitMs);
          continue;
        }

        throw err;
      }
    }

    throw new Error("Garmin request failed after retries.");
  });
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
  averageMovingSpeed?: number;
  maxSpeed: number;
  averageHR: number;
  maxHR: number;
  calories: number;
  elevationGain: number;
  averageRunningCadenceInStepsPerMinute?: number;
  vO2MaxValue?: number;
  [key: string]: any;
}

export interface GarminActivityDetails {
  activityId: number;
  activityName: string;
  activityTypeDTO: { typeKey: string };
  metadataDTO?: {
    lapCount?: number;
    hasSplits?: boolean;
    hasIntensityIntervals?: boolean;
  };
  summaryDTO: {
    startTimeLocal: string;
    distance: number;
    duration: number;
    movingDuration: number;
    averageSpeed: number;
    averageMovingSpeed?: number;
    elevationGain: number;
    averageHR: number;
    maxHR: number;
    calories: number;
    averageRunCadence: number;
    trainingEffect?: number;
    anaerobicTrainingEffect?: number;
    activityTrainingLoad?: number;
  };
  splitSummaries?: GarminSplitSummary[] | null;
}

export interface GarminLap {
  lapIndex: number;
  intensityType?: string;
  distance: number;
  duration: number;
  movingDuration: number;
  averageSpeed: number;
  averageMovingSpeed?: number;
  averageHR?: number;
  maxHR?: number;
  averageRunCadence?: number;
  elevationGain?: number;
}

export interface GarminActivitySplits {
  activityId: number;
  lapDTOs?: GarminLap[];
}

export interface GarminSplitSummary {
  splitType: string;
  noOfSplits: number;
  distance: number;
  duration: number;
  movingDuration: number;
  averageSpeed: number;
  averageMovingSpeed?: number;
  averageHR?: number;
  maxHR?: number;
  averageRunCadence?: number;
  elevationGain?: number;
}

export interface GarminActivityChart {
  metricDescriptors?: Array<{
    metricsIndex: number;
    key: string;
  }>;
  activityDetailMetrics?: Array<{
    metrics: Array<number | null>;
  }>;
}

export interface GarminHeartRateZoneProfile {
  sport?: string;
  trainingMethod?: string;
  zone1Floor?: number;
  zone2Floor?: number;
  zone3Floor?: number;
  zone4Floor?: number;
  zone5Floor?: number;
  maxHeartRateUsed?: number;
  restingHeartRateUsed?: number;
  lactateThresholdHeartRateUsed?: number;
  [key: string]: unknown;
}

export async function getActivities(start = 0, limit = 20): Promise<GarminActivity[]> {
  return withRetry(gc => gc.getActivities(start, limit));
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

export async function getActivityDetails(activityId: number): Promise<GarminActivityDetails> {
  return withRetry(gc => gc.getActivity({ activityId }));
}

export async function getActivitySplits(activityId: number): Promise<GarminActivitySplits> {
  return withRetry(gc => gc.get(`${gc.url.ACTIVITY}${activityId}/splits`));
}

export async function getActivityChart(activityId: number): Promise<GarminActivityChart> {
  return withRetry(gc =>
    gc.get(`${gc.url.ACTIVITY}${activityId}/details`, {
      params: { maxChartSize: 2000, maxPolylineSize: 0 },
    })
  );
}

export async function getHeartRate(date?: Date): Promise<any> {
  return withRetry(gc => gc.getHeartRate(date));
}

export async function getHeartRateZones(): Promise<GarminHeartRateZoneProfile[]> {
  return withRetry(gc =>
    gc.get(`${gc.url.GC_API}/biometric-service/heartRateZones`)
  );
}

export async function getSleepData(date?: Date): Promise<any> {
  return withRetry(gc => gc.getSleepData(date));
}

export async function getSteps(date?: Date): Promise<number> {
  return withRetry(gc => gc.getSteps(date));
}

export async function getUserProfile(): Promise<any> {
  return withRetry(gc => gc.getUserProfile());
}

export async function getUserSettings(): Promise<any> {
  return withRetry(gc => gc.getUserSettings());
}

export async function getWorkouts(start = 0, limit = 20): Promise<any[]> {
  return withRetry(gc => gc.getWorkouts(start, limit));
}

export async function addRunningWorkout(
  name: string,
  meters: number,
  description: string
): Promise<any> {
  return withRetry(gc => gc.addRunningWorkout(name, meters, description));
}

/** Create a structured workout with multiple steps (warmup, intervals, rest, cooldown) */
export async function addStructuredWorkout(workout: GarminWorkoutPayload): Promise<any> {
  return withRetry(gc => gc.addWorkout(workout));
}

// --- Structured workout types ---

export interface GarminWorkoutStep {
  type: "ExecutableStepDTO";
  stepId: null;
  stepOrder: number;
  childStepId: null;
  description: string | null;
  stepType: { stepTypeId: number; stepTypeKey: string };
  endCondition: { conditionTypeKey: string; conditionTypeId: number };
  preferredEndConditionUnit: { unitKey: string } | null;
  endConditionValue: number | null;
  endConditionCompare: null;
  endConditionZone: null;
  targetType: { workoutTargetTypeId: number; workoutTargetTypeKey: string };
  targetValueOne: number | null;
  targetValueTwo: number | null;
  zoneNumber: null;
}

export interface GarminRepeatStep {
  type: "RepeatGroupDTO";
  stepId: null;
  stepOrder: number;
  stepType: { stepTypeId: number; stepTypeKey: "repeat" };
  numberOfIterations: number;
  workoutSteps: GarminWorkoutStep[];
  smartRepeat: boolean;
  childStepId: null;
}

export interface GarminWorkoutPayload {
  workoutId?: undefined;
  sportType: { sportTypeId: number; sportTypeKey: string };
  workoutName: string;
  description?: string;
  workoutSegments: {
    segmentOrder: number;
    sportType: { sportTypeId: number; sportTypeKey: string };
    workoutSteps: (GarminWorkoutStep | GarminRepeatStep)[];
  }[];
}

const SPORT_RUNNING = { sportTypeId: 1, sportTypeKey: "running" };

const STEP_TYPES: Record<string, { stepTypeId: number; stepTypeKey: string }> = {
  warmup:   { stepTypeId: 1, stepTypeKey: "warmup" },
  cooldown: { stepTypeId: 2, stepTypeKey: "cooldown" },
  interval: { stepTypeId: 3, stepTypeKey: "interval" },
  recovery: { stepTypeId: 4, stepTypeKey: "recovery" },
  rest:     { stepTypeId: 5, stepTypeKey: "rest" },
  repeat:   { stepTypeId: 6, stepTypeKey: "repeat" },
};

const END_CONDITIONS: Record<string, { conditionTypeId: number; conditionTypeKey: string }> = {
  distance:   { conditionTypeId: 3, conditionTypeKey: "distance" },
  time:       { conditionTypeId: 2, conditionTypeKey: "time" },
  lap_button: { conditionTypeId: 1, conditionTypeKey: "lap.button" },
};

const UNIT_KEYS: Record<string, { unitKey: string }> = {
  kilometer: { unitKey: "kilometer" },
  meter:     { unitKey: "meter" },
  second:    { unitKey: "second" },
};

const TARGET_NONE = { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" };
const TARGET_PACE = { workoutTargetTypeId: 6, workoutTargetTypeKey: "pace.zone" };

function makeStep(
  order: number,
  stepType: string,
  opts: {
    endType?: "distance" | "time" | "lap_button";
    endValue?: number | null; // meters for distance, seconds for time
    unit?: "kilometer" | "meter" | "second";
    description?: string | null;
    targetPaceMinPerKm?: number | null; // e.g. 5.5 for 5:30/km — min pace
    targetPaceMaxPerKm?: number | null; // max pace
  } = {}
): GarminWorkoutStep {
  const st = STEP_TYPES[stepType] ?? STEP_TYPES.interval;
  const endType = opts.endType ?? "lap_button";
  const ec = END_CONDITIONS[endType] ?? END_CONDITIONS.lap_button;
  const unit = opts.unit ?? (endType === "distance" ? "meter" : endType === "time" ? "second" : "meter");

  let targetType = TARGET_NONE;
  let targetValueOne: number | null = null;
  let targetValueTwo: number | null = null;

  // Pace targets: Garmin expects m/s values
  if (opts.targetPaceMinPerKm != null && opts.targetPaceMaxPerKm != null) {
    targetType = TARGET_PACE;
    // Convert min/km to m/s (faster pace = higher m/s = lower min/km)
    targetValueOne = 1000 / (opts.targetPaceMaxPerKm * 60); // faster (higher m/s)
    targetValueTwo = 1000 / (opts.targetPaceMinPerKm * 60); // slower (lower m/s)
  }

  return {
    type: "ExecutableStepDTO",
    stepId: null,
    stepOrder: order,
    childStepId: null,
    description: opts.description ?? null,
    stepType: st,
    endCondition: ec,
    preferredEndConditionUnit: endType !== "lap_button" ? UNIT_KEYS[unit] ?? null : null,
    endConditionValue: opts.endValue ?? null,
    endConditionCompare: null,
    endConditionZone: null,
    targetType,
    targetValueOne,
    targetValueTwo,
    zoneNumber: null,
  };
}

function makeRepeat(
  order: number,
  iterations: number,
  steps: GarminWorkoutStep[]
): GarminRepeatStep {
  return {
    type: "RepeatGroupDTO",
    stepId: null,
    stepOrder: order,
    stepType: STEP_TYPES.repeat as any,
    numberOfIterations: iterations,
    workoutSteps: steps,
    smartRepeat: false,
    childStepId: null,
  };
}

export interface WorkoutStepInput {
  type: "warmup" | "cooldown" | "interval" | "recovery" | "rest";
  distance_meters?: number;
  duration_seconds?: number;
  description?: string;
  target_pace_min_per_km?: number; // slower bound, e.g. 6.0
  target_pace_max_per_km?: number; // faster bound, e.g. 5.0
  repeat?: number; // if set, this step + the next "recovery" step repeat N times
}

/**
 * Build a structured Garmin workout from a list of step inputs.
 * Supports warmup, cooldown, intervals with repeats, recovery, rest, and pace targets.
 */
export function buildStructuredWorkout(
  name: string,
  description: string,
  steps: WorkoutStepInput[]
): GarminWorkoutPayload {
  const workoutSteps: (GarminWorkoutStep | GarminRepeatStep)[] = [];
  let order = 1;
  let i = 0;

  while (i < steps.length) {
    const s = steps[i];

    // If this step has a repeat count, group it with the following recovery step
    if (s.repeat && s.repeat > 1) {
      const intervalStep = makeStep(1, s.type, {
        endType: s.distance_meters ? "distance" : s.duration_seconds ? "time" : "lap_button",
        endValue: s.distance_meters ?? s.duration_seconds ?? null,
        unit: s.distance_meters ? "meter" : "second",
        description: s.description,
        targetPaceMinPerKm: s.target_pace_min_per_km,
        targetPaceMaxPerKm: s.target_pace_max_per_km,
      });

      const repeatChildren: GarminWorkoutStep[] = [intervalStep];

      // Check if next step is recovery/rest — include it in the repeat group
      if (i + 1 < steps.length && (steps[i + 1].type === "recovery" || steps[i + 1].type === "rest")) {
        const recStep = steps[i + 1];
        repeatChildren.push(makeStep(2, recStep.type, {
          endType: recStep.distance_meters ? "distance" : recStep.duration_seconds ? "time" : "lap_button",
          endValue: recStep.distance_meters ?? recStep.duration_seconds ?? null,
          unit: recStep.distance_meters ? "meter" : "second",
          description: recStep.description,
        }));
        i++; // skip the recovery step
      }

      workoutSteps.push(makeRepeat(order++, s.repeat, repeatChildren));
    } else {
      // Regular step
      workoutSteps.push(makeStep(order++, s.type, {
        endType: s.distance_meters ? "distance" : s.duration_seconds ? "time" : "lap_button",
        endValue: s.distance_meters ?? s.duration_seconds ?? null,
        unit: s.distance_meters ? "meter" : "second",
        description: s.description,
        targetPaceMinPerKm: s.target_pace_min_per_km,
        targetPaceMaxPerKm: s.target_pace_max_per_km,
      }));
    }
    i++;
  }

  return {
    sportType: SPORT_RUNNING,
    workoutName: name,
    description,
    workoutSegments: [{
      segmentOrder: 1,
      sportType: SPORT_RUNNING,
      workoutSteps,
    }],
  };
}

export async function deleteWorkout(workoutId: string): Promise<any> {
  return withRetry(gc => gc.deleteWorkout({ workoutId }));
}

export async function scheduleWorkout(workoutId: string, date?: Date): Promise<any> {
  return withRetry(gc => gc.scheduleWorkout({ workoutId }, date));
}

export async function getTrainingStatus(date?: Date): Promise<any> {
  return withRetry(gc => gc.getTrainingStatus(date));
}

export async function getHRVData(date?: Date): Promise<any> {
  return withRetry(gc => gc.getHRVData(date));
}
