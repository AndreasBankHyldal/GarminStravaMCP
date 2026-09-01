import * as garminClient from "../garmin/client.js";
import { WearableRecoveryData } from "./guidance.js";
import { toDateKey } from "./cycle.js";

interface Captured<T> {
  value: T | null;
  error: string | null;
}

export interface GarminRecoverySnapshot {
  date: string;
  recovery: WearableRecoveryData;
  additional_metrics: {
    average_sleep_stress: number | null;
    average_sleep_respiration: number | null;
    overnight_skin_temperature_c: number | null;
    overnight_pulse_ox_percent: number | null;
    sleep_need_hours: number | null;
    hydration_logged_ml: number | null;
    weight_kg: number | null;
    vo2max: number | null;
    recovery_time_hours: number | null;
    garmin_hrv_status: string | null;
    garmin_training_status: string | number | null;
  };
  unavailable: Array<{ metric: string; error: string }>;
  provenance: {
    source: "garmin_unofficial_api";
    note: string;
  };
}

export async function getGarminRecoverySnapshot(
  dateInput: string
): Promise<GarminRecoverySnapshot> {
  const dateKey = toDateKey(dateInput);
  const date = new Date(`${dateKey}T12:00:00Z`);
  const [
    sleep,
    sleepSummary,
    hrv,
    heartRate,
    trainingStatus,
    hydration,
    weight,
    personalInfo,
  ] =
    await Promise.all([
      capture(() => garminClient.getSleepData(date)),
      capture(() => garminClient.getSleepDailySummary(date, date)),
      capture(() => garminClient.getHRVData(date)),
      capture(() => garminClient.getHeartRate(date)),
      capture(() => garminClient.getTrainingStatus(date)),
      capture(() => garminClient.getDailyHydration(date)),
      capture(() => garminClient.getDailyWeightData(date)),
      capture(() => garminClient.getPersonalInfo()),
    ]);

  const sleepData = asRecord(sleep.value);
  const sleepDto = asRecord(sleepData?.dailySleepDTO);
  const sleepScores = asRecord(sleepDto?.sleepScores);
  const overallSleepScore = asRecord(sleepScores?.overall);
  const dailySleepValues = selectDailySleepValues(sleepSummary.value, dateKey);
  const hrvData = asRecord(hrv.value);
  const hrvSummary = asRecord(hrvData?.hrvSummary);
  const heartRateData = asRecord(heartRate.value);
  const trainingData = selectTrainingStatus(trainingStatus.value);
  const trainingLoad = asRecord(trainingData?.acuteTrainingLoadDTO);
  const weightData = asRecord(weight.value);
  const totalAverage = asRecord(weightData?.totalAverage);
  const biometricProfile = asRecord(asRecord(personalInfo.value)?.biometricProfile);
  const recoveryTimeRaw =
    finiteNumber(trainingData?.recoveryTime) ??
    finiteNumber(trainingData?.recoveryTimeSeconds);

  const hydrationOunces = finiteNumber(hydration.value);
  const unavailable = [
    unavailableMetric("sleep", sleep),
    unavailableMetric("sleep_summary", sleepSummary),
    unavailableMetric("hrv", hrv),
    unavailableMetric("heart_rate", heartRate),
    unavailableMetric("training_status", trainingStatus),
    unavailableMetric("hydration", hydration),
    unavailableMetric("weight", weight),
    unavailableMetric("personal_info", personalInfo),
  ].filter((item): item is { metric: string; error: string } => item !== null);

  return {
    date: dateKey,
    recovery: {
      sleep_score: finiteNumber(overallSleepScore?.value),
      sleep_duration_hours: divide(finiteNumber(sleepDto?.sleepTimeSeconds), 3600),
      hrv_last_night:
        finiteNumber(hrvSummary?.lastNightAvg) ??
        finiteNumber(sleepData?.avgOvernightHrv),
      hrv_baseline: finiteNumber(hrvSummary?.weeklyAvg),
      resting_hr:
        finiteNumber(heartRateData?.restingHeartRate) ??
        finiteNumber(sleepData?.restingHeartRate),
      resting_hr_baseline: finiteNumber(
        heartRateData?.lastSevenDaysAvgRestingHeartRate
      ),
      body_battery_change: finiteNumber(sleepData?.bodyBatteryChange),
      acute_chronic_load_ratio: finiteNumber(
        trainingLoad?.dailyAcuteChronicWorkloadRatio
      ),
    },
    additional_metrics: {
      average_sleep_stress: finiteNumber(sleepDto?.avgSleepStress),
      average_sleep_respiration: finiteNumber(sleepDto?.averageRespirationValue),
      overnight_skin_temperature_c:
        finiteNumber(dailySleepValues?.skinTempC) ??
        finiteNumber(sleepDto?.skinTempC),
      overnight_pulse_ox_percent: finiteNumber(dailySleepValues?.spO2),
      sleep_need_hours: divide(
        finiteNumber(dailySleepValues?.sleepNeed),
        3600
      ),
      hydration_logged_ml:
        hydrationOunces === null ? null : Math.round(hydrationOunces * 29.5735),
      weight_kg: divide(finiteNumber(totalAverage?.weight), 1000),
      vo2max: finiteNumber(biometricProfile?.vo2Max),
      recovery_time_hours:
        recoveryTimeRaw === null
          ? null
          : Math.round(
              (recoveryTimeRaw > 500 ? recoveryTimeRaw / 3600 : recoveryTimeRaw) *
                10
            ) / 10,
      garmin_hrv_status:
        stringValue(hrvSummary?.status) ?? stringValue(sleepData?.hrvStatus),
      garmin_training_status:
        stringValue(trainingData?.trainingStatusFeedbackPhrase) ??
        finiteNumber(trainingData?.trainingStatus),
    },
    unavailable,
    provenance: {
      source: "garmin_unofficial_api",
      note:
        "Garmin recovery data comes from undocumented consumer endpoints and may change. Missing metrics are reported rather than inferred.",
    },
  };
}

export async function getGarminExtendedWellness(dateInput: string) {
  const dateKey = toDateKey(dateInput);
  const date = new Date(`${dateKey}T12:00:00Z`);
  const [bodyBattery, stress] = await Promise.all([
    capture(() => garminClient.getBodyBattery(date)),
    capture(() => garminClient.getAllDayStress(date)),
  ]);
  return {
    date: dateKey,
    body_battery: bodyBattery.value,
    stress: stress.value,
    unavailable: [
      unavailableMetric("body_battery", bodyBattery),
      unavailableMetric("stress", stress),
    ].filter((item): item is { metric: string; error: string } => item !== null),
    provenance: {
      source: "garmin_unofficial_api",
      schema: "opaque_garmin_json",
      note:
        "Raw wellness documents are returned without guessing undocumented field meanings.",
    },
  };
}

export async function getGarminWeightKg(dateInput: string): Promise<number> {
  const dateKey = toDateKey(dateInput);
  const raw = await garminClient.getDailyWeightData(
    new Date(`${dateKey}T12:00:00Z`)
  );
  const totalAverage = asRecord(asRecord(raw)?.totalAverage);
  const weightGrams = finiteNumber(totalAverage?.weight);
  if (weightGrams === null || weightGrams <= 0) {
    throw new Error(`No Garmin weight measurement is available for ${dateKey}.`);
  }
  return Math.round((weightGrams / 1000) * 10) / 10;
}

export function inspectSensitiveGarminDocument(
  payload: unknown,
  includeRaw: boolean
) {
  const candidates: Array<{
    field_path: string;
    value: string;
    confidence: "unverified";
  }> = [];
  walkForDateCandidates(payload, "$", candidates, 0);
  return {
    document_present: payload !== null && payload !== undefined,
    date_candidates: candidates.slice(0, 100),
    interpretation:
      "Candidates are not confirmed period starts. Garmin publishes no schema for this unofficial response; inspect field paths and record confirmed dates manually.",
    raw_document: includeRaw ? payload : undefined,
    provenance: {
      source: "garmin_unofficial_api",
      sensitivity: "reproductive_health",
      schema: "opaque_garmin_json",
    },
  };
}

async function capture<T>(operation: () => Promise<T>): Promise<Captured<T>> {
  try {
    return { value: await operation(), error: null };
  } catch (error) {
    return {
      value: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function unavailableMetric<T>(
  metric: string,
  captured: Captured<T>
): { metric: string; error: string } | null {
  return captured.error ? { metric, error: captured.error } : null;
}

function selectTrainingStatus(value: unknown): Record<string, unknown> | null {
  const root = asRecord(value);
  const map = asRecord(root?.latestTrainingStatusData);
  if (!map) return null;
  const entries = Object.values(map)
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null);
  return (
    entries.find((entry) => entry.primaryTrainingDevice === true) ??
    entries[0] ??
    null
  );
}

function selectDailySleepValues(
  value: unknown,
  date: string
): Record<string, unknown> | null {
  const individualStats = asRecord(value)?.individualStats;
  if (!Array.isArray(individualStats)) return null;
  const records = individualStats
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null);
  const selected =
    records.find((item) => item.calendarDate === date) ?? records[0] ?? null;
  return asRecord(selected?.values);
}

function walkForDateCandidates(
  value: unknown,
  path: string,
  output: Array<{ field_path: string; value: string; confidence: "unverified" }>,
  depth: number
): void {
  if (depth > 12 || output.length >= 100) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walkForDateCandidates(item, `${path}[${index}]`, output, depth + 1)
    );
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    const childPath = `${path}.${key}`;
    const relevantKey = /(date|start|period|cycle|ovulat|menstru)/i.test(key);
    if (
      relevantKey &&
      typeof child === "string" &&
      /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(child)
    ) {
      output.push({
        field_path: childPath,
        value: child.slice(0, 10),
        confidence: "unverified",
      });
    }
    walkForDateCandidates(child, childPath, output, depth + 1);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function divide(value: number | null, divisor: number): number | null {
  return value === null ? null : Math.round((value / divisor) * 10) / 10;
}
