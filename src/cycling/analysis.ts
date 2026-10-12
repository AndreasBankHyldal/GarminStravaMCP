import * as garminClient from "../garmin/client.js";
import type { GarminActivity, GarminLap } from "../garmin/client.js";
import { formatGarminHeartRateZones, getGarminMovingSpeed } from "../garmin/format.js";
import { enrichDate, formatDuration, startOfWeek } from "../utils.js";
import {
  bestAveragePower, cadenceSummary, coveragePercent, detectClimbs, durationLabel, maximum, mean,
  normalizedPower, POWER_CURVE_DURATIONS, powerCurve, powerHeartRateDecoupling, powerZones,
  readRideStream, rideSegments, round, timeInHeartRateZones, timeInPowerZones, type RideStream,
} from "./stream.js";
import { isCyclingType, isEbike, isIndoorRide } from "./activity-type.js";
import type {
  CyclingEvent, CyclingFitness, CyclingTrends, FtpSource, PowerProfile, RideAnalysis, TssSource,
} from "./schema.js";

export type CyclingApi = Pick<typeof garminClient,
  "getActivityDetails" | "getActivitySplits" | "getActivityChart" | "getHeartRateZones" |
  "getCyclingFtp" | "getUserSettings" | "getAllActivities">;

const DAY_MS = 86_400_000;

export { isCyclingType, isEbike, isIndoorRide };

function positive(source: unknown, keys: string[]): number | null {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    const value = Number((source as Record<string, unknown>)[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function finite(source: unknown, keys: string[]): number | null {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    const raw = (source as Record<string, unknown>)[key];
    if (raw == null || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export async function resolveWeightKg(api: Pick<CyclingApi, "getUserSettings">, override?: number): Promise<number | null> {
  if (override && override > 0) return override;
  const settings = await api.getUserSettings().catch(() => null);
  const weight = positive(settings?.userData, ["weight"]);
  // Garmin stores weight in grams.
  return weight === null ? null : round(weight > 300 ? weight / 1000 : weight, 1);
}

export async function resolveCyclingHeartRateProfile(api: Pick<CyclingApi, "getHeartRateZones">) {
  const profiles = await api.getHeartRateZones().catch(() => []);
  const formatted = formatGarminHeartRateZones(Array.isArray(profiles) ? profiles : []).profiles;
  const profile = formatted.find(p => p.sport.toUpperCase() === "CYCLING") ??
    formatted.find(p => p.sport.toUpperCase() === "DEFAULT") ?? formatted[0] ?? null;
  if (!profile) return { profile: null, thresholdHr: null, thresholdEstimated: false };
  const threshold = profile.lactate_threshold_heart_rate_bpm ??
    (profile.max_heart_rate_bpm ? Math.round(profile.max_heart_rate_bpm * 0.9) : null);
  return { profile, thresholdHr: threshold, thresholdEstimated: profile.lactate_threshold_heart_rate_bpm === null && threshold !== null };
}

/** Threshold power estimate: 95 % of the best 20-minute average. */
export const estimateFtpFrom20Min = (watts: number) => Math.round(watts * 0.95);

function pickFtp(user: number | undefined, activity: number | null, garmin: number | null): { ftp: number | null; source: FtpSource } {
  if (user && user > 0) return { ftp: user, source: "user" };
  if (activity) return { ftp: activity, source: "activity" };
  if (garmin) return { ftp: garmin, source: "garmin" };
  return { ftp: null, source: "unavailable" };
}

function formatLap(lap: GarminLap, index: number) {
  const speed = lap.averageMovingSpeed ?? lap.averageSpeed;
  return {
    lap: lap.lapIndex ?? index + 1,
    intensity: lap.intensityType ?? null,
    distance_km: round((lap.distance ?? 0) / 1000, 2) ?? 0,
    duration: formatDuration(lap.movingDuration ?? lap.duration ?? 0),
    avg_speed_kmh: speed > 0 ? round(speed * 3.6) : null,
    avg_power_w: positive(lap, ["averagePower"]),
    normalized_power_w: positive(lap, ["normalizedPower"]),
    max_power_w: positive(lap, ["maxPower"]),
    avg_heartrate: positive(lap, ["averageHR"]),
    max_heartrate: positive(lap, ["maxHR"]),
    avg_cadence_rpm: positive(lap, ["averageBikeCadence", "averageBikingCadenceInRevPerMinute"]),
    elevation_gain_m: finite(lap, ["elevationGain"]),
  };
}

export interface RideAnalysisOptions {
  ftp_watts?: number;
  weight_kg?: number;
  segment_km?: number;
}

export async function analyzeGarminRide(
  activityId: number,
  options: RideAnalysisOptions = {},
  api: CyclingApi = garminClient
): Promise<RideAnalysis> {
  const activity = await api.getActivityDetails(activityId);
  const type = activity.activityTypeDTO?.typeKey ?? "unknown";
  if (!isCyclingType(type)) {
    throw new Error(`Activity ${activityId} is a "${type}" activity, not a ride. Use analyze_run_performance for runs.`);
  }
  const warnings: string[] = [];
  const [splits, chart, hr, garminFtp, weight] = await Promise.all([
    api.getActivitySplits(activityId).catch(() => ({ activityId, lapDTOs: [] })),
    api.getActivityChart(activityId, 100_000).catch((error: unknown) => {
      warnings.push(`Second-by-second data unavailable (${error instanceof Error ? error.message : String(error)}); only Garmin summary values are shown.`);
      return null;
    }),
    resolveCyclingHeartRateProfile(api),
    options.ftp_watts ? Promise.resolve(null) : api.getCyclingFtp().catch(() => null),
    resolveWeightKg(api, options.weight_kg),
  ]);
  const summary = activity.summaryDTO;
  const stream: RideStream | null = chart ? readRideStream(chart) : null;
  const hasStream = !!stream && stream.seconds > 1;
  if (stream) warnings.push(...stream.warnings);
  const s = hasStream ? stream!.series : null;
  const streamPower = !!s && stream!.available.power;
  const indoor = isIndoorRide(type);
  const ebike = isEbike(type);

  const { ftp, source: ftpSource } = pickFtp(options.ftp_watts, positive(summary, ["functionalThresholdPower"]), garminFtp);
  const garminReported = {
    avg_w: positive(summary, ["averagePower", "avgPower"]),
    max_w: positive(summary, ["maxPower"]),
    normalized_w: positive(summary, ["normalizedPower", "normPower"]),
    tss: positive(summary, ["trainingStressScore"]),
    intensity_factor: positive(summary, ["intensityFactor"]),
  };
  const avgPower = streamPower ? mean(s!.power) : garminReported.avg_w;
  const maxPower = streamPower ? maximum(s!.power) : garminReported.max_w;
  const np = (streamPower ? normalizedPower(s!.power) : null) ?? garminReported.normalized_w;
  const powerSeconds = streamPower ? s!.power.filter(value => value !== null).length : 0;
  let intensity: number | null = null, tss: number | null = null, tssSource: TssSource | null = null;
  if (np && ftp && powerSeconds > 0) {
    intensity = np / ftp;
    tss = powerSeconds * np * intensity / (ftp * 3600) * 100;
    tssSource = "power";
  } else if (garminReported.tss) {
    tss = garminReported.tss;
    intensity = garminReported.intensity_factor;
    tssSource = "garmin";
  }
  const movingSeconds = summary.movingDuration ?? summary.duration ?? 0;
  const avgHr = positive(summary, ["averageHR"]) ?? (s ? round(mean(s.heart_rate)) : null);
  if (tss === null && avgHr && hr.thresholdHr && movingSeconds > 0) {
    // Same hrTSS fallback as the weekly trends and fitness model, so ride and model agree.
    tss = movingSeconds / 3600 * (avgHr / hr.thresholdHr) ** 2 * 100;
    tssSource = "heart_rate";
  }
  const powerAvailable = avgPower !== null || np !== null;
  if (!powerAvailable) warnings.push("No power meter data: power metrics, power zones and the power curve are unavailable.");
  if (powerAvailable && !ftp) warnings.push("FTP unknown: intensity factor, TSS and power zones need an FTP. Pass ftp_watts or set FTP in Garmin Connect (get_cycling_power_profile can estimate one).");
  if (ebike && powerAvailable) warnings.push("E-bike activity: recorded power may be rider power only; motor assistance is not included in speed/power relationships.");

  const movingSpeed = getGarminMovingSpeed(summary);
  const decoupling = s ? powerHeartRateDecoupling(s.power, s.heart_rate) : null;
  const variability = np && avgPower ? np / avgPower : null;
  const coverage = {
    power: s ? coveragePercent(s.power) : 0,
    heart_rate: s ? coveragePercent(s.heart_rate) : 0,
    cadence: s ? coveragePercent(s.cadence) : 0,
    speed: s ? coveragePercent(s.speed) : 0,
    elevation: s ? coveragePercent(s.elevation) : 0,
  };
  const recordedChannels = (Object.keys(coverage) as (keyof typeof coverage)[]).filter(key => coverage[key] > 0);

  const hrZones = s && hr.profile ? timeInHeartRateZones(s.heart_rate, hr.profile.zones) : null;
  const notes = [
    "Stream metrics are computed from Garmin's second-by-second recording resampled to 1 Hz; recording gaps over 10 s count as paused time and are excluded. Segment elevation uses a 1.5 m hysteresis to filter altitude noise.",
    ...(powerAvailable ? [
      "Normalized power uses Coggan's 30-second rolling fourth-power mean. TSS = seconds × NP × IF / (FTP × 3600) × 100; Garmin's own values are listed separately under garmin_reported.",
      "Power zones use Coggan's 7-zone model (% of FTP).",
    ] : []),
    ...(tssSource === "heart_rate" ? [`TSS is a heart-rate estimate: moving hours × (average HR / threshold HR ${hr.thresholdHr}${hr.thresholdEstimated ? ", estimated as 90 % of max HR" : ""})² × 100. It is less precise than power-based TSS, especially for variable rides.`] : []),
    "Heart-rate zones use your Garmin cycling profile (default profile if none).",
    "Climbs: sustained rises of at least 500 m, 25 m gain and 3 % average on a smoothed 50 m elevation profile. Categories follow the common length × grade score; VAM is metres climbed per hour.",
  ];
  if (indoor) notes.push("Indoor ride: speed and distance come from the trainer or virtual platform and are not comparable with outdoor rides.");

  return {
    source: "garmin",
    activity_id: activityId,
    activity: {
      name: activity.activityName,
      type,
      date: enrichDate(summary.startTimeLocal),
      indoor,
      e_bike: ebike,
      distance_km: summary.distance > 0 ? round(summary.distance / 1000, 2) : null,
      moving_time: formatDuration(movingSeconds),
      elapsed_time: formatDuration(finite(summary, ["elapsedDuration"]) ?? summary.duration ?? 0),
      moving_time_seconds: Math.round(movingSeconds),
      avg_speed_kmh: movingSpeed > 0 ? round(movingSpeed * 3.6) : null,
      max_speed_kmh: positive(summary, ["maxSpeed"]) ? round(positive(summary, ["maxSpeed"])! * 3.6) : s ? round((maximum(s.speed) ?? 0) * 3.6) || null : null,
      elevation_gain_m: finite(summary, ["elevationGain"]),
      elevation_loss_m: finite(summary, ["elevationLoss"]),
      avg_heartrate: avgHr,
      max_heartrate: positive(summary, ["maxHR"]) ?? (s ? round(maximum(s.heart_rate)) : null),
      avg_cadence_rpm: positive(summary, ["averageBikeCadence", "averageBikingCadenceInRevPerMinute"]) ?? (s ? round(mean(s.cadence, 0, s.cadence.length, value => value > 0)) : null),
      calories: positive(summary, ["calories"]),
      avg_temperature_c: finite(summary, ["averageTemperature"]) ?? (s ? round(mean(s.temperature)) : null),
      training_effect: positive(summary, ["trainingEffect"]),
      anaerobic_training_effect: positive(summary, ["anaerobicTrainingEffect"]),
      training_load: positive(summary, ["activityTrainingLoad"]),
    },
    power: {
      available: powerAvailable,
      avg_w: round(avgPower), max_w: round(maxPower), normalized_w: round(np),
      variability_index: round(variability, 2),
      intensity_factor: round(intensity, 2), tss: round(tss), tss_source: tssSource,
      work_kj: streamPower ? round(s!.power.reduce<number>((sum, value) => sum + (value ?? 0), 0) / 1000) : null,
      ftp_w: ftp, ftp_source: ftpSource,
      weight_kg: weight,
      avg_w_per_kg: avgPower && weight ? round(avgPower / weight, 2) : null,
      normalized_w_per_kg: np && weight ? round(np / weight, 2) : null,
      ftp_w_per_kg: ftp && weight ? round(ftp / weight, 2) : null,
      coverage_percent: coverage.power,
      garmin_reported: garminReported,
    },
    power_curve: streamPower ? powerCurve(s!.power, weight) : [],
    power_zones: streamPower && ftp ? timeInPowerZones(s!.power, ftp) : null,
    heart_rate_zones: hrZones && hr.profile ? { profile: hr.profile.sport, zones: hrZones } : null,
    cadence: s ? cadenceSummary(s.cadence, s.speed) : null,
    efficiency: decoupling ? {
      efficiency_factor: np && avgHr ? round(np / avgHr, 2) : null,
      ...decoupling,
      assessment: variability && variability > 1.1
        ? "Variable ride (VI above 1.10): power:HR decoupling is only meaningful for steady endurance efforts."
        : decoupling.decoupling_percent !== null && decoupling.decoupling_percent < 5
          ? "Power:HR decoupling under 5 % between equal-time halves, typical of a steady, well-paced aerobic effort."
          : "Power:HR decoupled by 5 % or more between halves. Heat, dehydration, fueling, terrain and accumulated fatigue all contribute; this is descriptive, not a diagnosis.",
    } : null,
    segments: s ? rideSegments(stream!, options.segment_km ?? 5) : { basis: "distance", segment_size: options.segment_km ?? 5, items: [] },
    climbs: s && !indoor ? detectClimbs(stream!, weight) : [],
    laps: (splits.lapDTOs ?? []).length > 1 ? splits.lapDTOs!.map(formatLap) : [],
    data_quality: {
      status: !hasStream ? "summary_only" : recordedChannels.some(key => coverage[key] < 90) ? "partial" : "complete",
      recorded_seconds: stream?.seconds ?? 0,
      excluded_pause_seconds: Math.round(stream?.excludedPauseSeconds ?? 0),
      max_sample_gap_seconds: stream?.maxSampleGapSeconds ?? null,
      coverage_percent: coverage,
      warnings,
    },
    notes,
  };
}

// --- Activity-list summaries (no per-ride stream download) ---

export interface RideSummary {
  id: number;
  name: string;
  type: string;
  date: string;
  indoor: boolean;
  distance_m: number;
  moving_s: number;
  elevation_gain_m: number;
  avg_speed_mps: number;
  avg_hr: number | null;
  max_hr: number | null;
  avg_power: number | null;
  norm_power: number | null;
  tss: number | null;
  curve: Map<number, number>;
}

export function summarizeRide(activity: GarminActivity): RideSummary {
  const curve = new Map<number, number>();
  for (const duration of POWER_CURVE_DURATIONS) {
    const watts = positive(activity, [`maxAvgPower_${duration}`]);
    if (watts) curve.set(duration, watts);
  }
  if (!curve.has(1200)) {
    const twenty = positive(activity, ["max20MinPower"]);
    if (twenty) curve.set(1200, twenty);
  }
  const type = activity.activityType?.typeKey ?? "unknown";
  return {
    id: activity.activityId,
    name: activity.activityName ?? "Ride",
    type,
    date: activity.startTimeLocal,
    indoor: isIndoorRide(type),
    distance_m: activity.distance ?? 0,
    moving_s: activity.movingDuration || activity.duration || 0,
    elevation_gain_m: activity.elevationGain ?? 0,
    avg_speed_mps: getGarminMovingSpeed(activity),
    avg_hr: positive(activity, ["averageHR"]),
    max_hr: positive(activity, ["maxHR"]),
    avg_power: positive(activity, ["avgPower", "averagePower"]),
    norm_power: positive(activity, ["normPower", "normalizedPower"]),
    tss: positive(activity, ["trainingStressScore"]),
    curve,
  };
}

export interface TssContext {
  ftp: number | null;
  thresholdHr: number | null;
}

/** Garmin TSS, else power-based TSS, else hrTSS, else a conservative IF 0.65 duration estimate. */
export function rideTss(ride: RideSummary, ctx: TssContext): { tss: number; source: TssSource } {
  const hours = ride.moving_s / 3600;
  if (ride.tss) return { tss: ride.tss, source: "garmin" };
  if (ride.norm_power && ctx.ftp) return { tss: hours * (ride.norm_power / ctx.ftp) ** 2 * 100, source: "power" };
  if (ride.avg_hr && ctx.thresholdHr) return { tss: hours * (ride.avg_hr / ctx.thresholdHr) ** 2 * 100, source: "heart_rate" };
  return { tss: hours * 0.65 ** 2 * 100, source: "duration_estimate" };
}

export function recentRides(history: GarminActivity[], days: number, now = new Date()): RideSummary[] {
  const after = now.getTime() - days * DAY_MS;
  return history
    .filter(activity => isCyclingType(activity.activityType?.typeKey))
    .filter(activity => {
      const time = new Date(activity.startTimeLocal).getTime();
      return time >= after && time <= now.getTime();
    })
    .map(summarizeRide);
}

const emptySources = () => ({ garmin: 0, power: 0, heart_rate: 0, duration_estimate: 0 });

// --- Power profile ---

export interface PowerProfileOptions {
  days: number;
  max_activities: number;
  max_stream_rides: number;
  ftp_watts?: number;
  weight_kg?: number;
}

export async function buildPowerProfile(options: PowerProfileOptions, api: CyclingApi = garminClient, now = new Date()): Promise<PowerProfile> {
  const [history, garminFtp, weight] = await Promise.all([
    api.getAllActivities(options.max_activities),
    api.getCyclingFtp().catch(() => null),
    resolveWeightKg(api, options.weight_kg),
  ]);
  const rides = recentRides(history, options.days, now);
  const withPower = rides.filter(ride => ride.avg_power || ride.norm_power || ride.curve.size);
  const needsStream = withPower.filter(ride => ride.curve.size === 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, options.max_stream_rides);
  let streamsFetched = 0;
  for (const ride of needsStream) {
    const chart = await api.getActivityChart(ride.id, 100_000).catch(() => null);
    if (!chart) continue;
    streamsFetched++;
    const stream = readRideStream(chart);
    for (const duration of POWER_CURVE_DURATIONS) {
      const watts = bestAveragePower(stream.series.power, duration);
      if (watts) ride.curve.set(duration, watts);
    }
  }

  const best = POWER_CURVE_DURATIONS.flatMap(duration => {
    let top: RideSummary | null = null;
    for (const ride of withPower) {
      const watts = ride.curve.get(duration);
      if (watts && (!top || watts > top.curve.get(duration)!)) top = ride;
    }
    return top ? [{ duration, ride: top, watts: top.curve.get(duration)! }] : [];
  });
  const twenty = best.find(item => item.duration === 1200);
  const estimated = twenty ? estimateFtpFrom20Min(twenty.watts) : null;
  const user = options.ftp_watts && options.ftp_watts > 0 ? options.ftp_watts : null;
  const selected = user ?? garminFtp ?? estimated;
  const selectedSource: FtpSource = user ? "user" : garminFtp ? "garmin" : estimated ? "estimated_from_20min" : "unavailable";

  const notes = [
    "Best efforts use Garmin's per-activity mean-maximal power where provided, otherwise they are computed from downloaded second-by-second streams (limited by max_stream_rides).",
    "The FTP estimate is 95 % of the best 20-minute power in the period. It is only as good as the hardest sustained effort you recorded; a submaximal period underestimates FTP.",
    "Power zones follow Coggan's 7-zone model based on the selected FTP.",
  ];
  if (!withPower.length) notes.push("No rides with power data were found in this period. A power meter or smart trainer is needed for a power profile.");
  if (garminFtp && estimated && Math.abs(estimated - garminFtp) / garminFtp > 0.05) {
    notes.push(`Garmin FTP (${garminFtp} W) differs from the 20-minute estimate (${estimated} W) by more than 5 %; consider an FTP test or updating Garmin.`);
  }
  const skipped = withPower.filter(ride => ride.curve.size === 0).length;
  if (skipped) notes.push(`${skipped} ride(s) with power had no best-effort data and were not downloaded; increase max_stream_rides to include them.`);
  if (rides.some(ride => isEbike(ride.type))) notes.push("E-bike rides are included; their power may not reflect unassisted rider output.");

  return {
    source: "garmin",
    period_days: options.days,
    rides_analyzed: rides.length,
    rides_with_power: withPower.length,
    streams_fetched: streamsFetched,
    weight_kg: weight,
    ftp: {
      selected_w: selected, selected_source: selectedSource,
      garmin_w: garminFtp, user_w: user, estimated_w: estimated,
      w_per_kg: selected && weight ? round(selected / weight, 2) : null,
      estimate_basis: twenty ? `95 % of ${Math.round(twenty.watts)} W best 20 minutes (${twenty.ride.name}, ${twenty.ride.date.slice(0, 10)})` : null,
    },
    power_curve: best.map(({ duration, ride, watts }) => ({
      duration_s: duration, label: durationLabel(duration), watts: Math.round(watts),
      w_per_kg: weight ? round(watts / weight, 2) : null,
      percent_ftp: selected ? Math.round(100 * watts / selected) : null,
      activity_id: ride.id, activity_name: ride.name, date: ride.date.slice(0, 10),
    })),
    power_zones: selected ? powerZones(selected) : null,
    notes,
  };
}

// --- Weekly trends ---

export function buildCyclingTrends(history: GarminActivity[], weeks: number, ctx: TssContext, now = new Date()): CyclingTrends {
  const rides = recentRides(history, weeks * 7, now);
  const key = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const buckets = new Map<string, RideSummary[]>();
  const after = new Date(now.getTime() - weeks * 7 * DAY_MS);
  for (const week = startOfWeek(after); week <= now; week.setDate(week.getDate() + 7)) buckets.set(key(week), []);
  const sources = emptySources();
  const tssById = new Map<number, number>();
  for (const ride of rides) {
    buckets.get(key(startOfWeek(new Date(ride.date))))?.push(ride);
    const { tss, source } = rideTss(ride, ctx);
    sources[source]++;
    tssById.set(ride.id, tss);
  }
  const weighted = (items: RideSummary[], pick: (ride: RideSummary) => number | null) => {
    let sum = 0, time = 0;
    for (const ride of items) {
      const value = pick(ride);
      if (value) {
        sum += value * ride.moving_s;
        time += ride.moving_s;
      }
    }
    return time ? Math.round(sum / time) : null;
  };
  const weekly = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, items]) => {
    const outdoor = items.filter(ride => !ride.indoor && ride.distance_m > 0 && ride.moving_s > 0);
    const outdoorDistance = outdoor.reduce((sum, ride) => sum + ride.distance_m, 0);
    const outdoorTime = outdoor.reduce((sum, ride) => sum + ride.moving_s, 0);
    const seconds = items.reduce((sum, ride) => sum + ride.moving_s, 0);
    return {
      week_of: week,
      rides: items.length,
      indoor_rides: items.filter(ride => ride.indoor).length,
      distance_km: round(items.reduce((sum, ride) => sum + ride.distance_m, 0) / 1000) ?? 0,
      moving_hours: round(seconds / 3600, 2) ?? 0,
      moving_time: formatDuration(seconds),
      elevation_m: Math.round(items.reduce((sum, ride) => sum + ride.elevation_gain_m, 0)),
      outdoor_avg_speed_kmh: outdoorTime ? round(outdoorDistance / outdoorTime * 3.6) : null,
      avg_power_w: weighted(items, ride => ride.avg_power),
      avg_heartrate: weighted(items, ride => ride.avg_hr),
      tss: Math.round(items.reduce((sum, ride) => sum + (tssById.get(ride.id) ?? 0), 0)),
      longest_ride_km: round(Math.max(0, ...items.map(ride => ride.distance_m)) / 1000) ?? 0,
    };
  });
  const hours = weekly.map(week => week.moving_hours);
  const half = Math.floor(hours.length / 2);
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const early = average(hours.slice(0, half)), late = average(hours.slice(half));
  const trend = !rides.length || hours.length < 2 ? "insufficient data"
    : early === 0 ? (late > 0 ? "increasing" : "stable")
      : late > early * 1.1 ? "increasing" : late < early * 0.9 ? "decreasing" : "stable";
  const notes = [
    "Weeks start on Monday; the first and current weeks may be partial. Volume trend compares average weekly hours in the later half of the period with the earlier half (±10 %).",
    "Outdoor average speed excludes indoor/virtual rides. Average power and heart rate are weighted by moving time across rides that recorded them.",
    "Weekly TSS uses Garmin TSS when available, then power with your FTP, then heart rate relative to threshold HR, then a conservative duration estimate.",
  ];
  const complete = weekly.slice(0, -1);
  if (complete.length >= 4) {
    const last = complete.at(-1)!.moving_hours;
    const prior = average(complete.slice(-4, -1).map(week => week.moving_hours));
    if (prior > 0) notes.push(`Last complete week: ${last} h vs ${round(prior, 2)} h average of the 3 weeks before (${round(100 * (last / prior - 1))} %).`);
  }
  return {
    source: "garmin",
    period: `Last ${weeks} weeks`,
    total_rides: rides.length,
    total_km: round(rides.reduce((sum, ride) => sum + ride.distance_m, 0) / 1000) ?? 0,
    total_hours: round(rides.reduce((sum, ride) => sum + ride.moving_s, 0) / 3600, 1) ?? 0,
    total_elevation_m: Math.round(rides.reduce((sum, ride) => sum + ride.elevation_gain_m, 0)),
    total_tss: Math.round([...tssById.values()].reduce((sum, value) => sum + value, 0)),
    volume_trend: trend,
    tss_sources: sources,
    weekly_breakdown: weekly,
    notes,
  };
}

// --- Fitness (performance management) model ---

export function cyclingForm(tsb: number): string {
  if (tsb > 25) return "transition (fresh, possible detraining)";
  if (tsb > 5) return "fresh (race-ready)";
  if (tsb >= -10) return "neutral";
  if (tsb >= -30) return "productive training load";
  return "high fatigue (overreaching risk)";
}

export function buildCyclingFitness(history: GarminActivity[], days: number, ctx: TssContext & { thresholdEstimated?: boolean }, now = new Date()): CyclingFitness {
  const rides = recentRides(history, days, now);
  const sources = emptySources();
  const byDate = new Map<string, number>();
  const localKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  for (const ride of rides) {
    const { tss, source } = rideTss(ride, ctx);
    sources[source]++;
    const keyDate = ride.date.slice(0, 10);
    byDate.set(keyDate, (byDate.get(keyDate) ?? 0) + tss);
  }
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days + 1);
  let ctl = 0, atl = 0;
  const daily: CyclingFitness["model"]["daily"] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const key = localKey(day);
    const tss = byDate.get(key) ?? 0;
    ctl += (tss - ctl) / 42;
    atl += (tss - atl) / 7;
    daily.push({ date: key, tss: round(tss) ?? 0, ctl: round(ctl) ?? 0, atl: round(atl) ?? 0, tsb: round(ctl - atl) ?? 0 });
  }
  const current = daily.at(-1) ?? { ctl: 0, atl: 0, tsb: 0 };
  const weekAgo = daily.at(-8)?.ctl ?? 0;
  const ramp = round(current.ctl - weekAgo) ?? 0;
  const guidance = [
    "CTL (fitness) is a 42-day exponentially weighted TSS average, ATL (fatigue) a 7-day average and TSB (form) = CTL − ATL. These are training-load estimates, not physiological measurements.",
    "TSB bands (general guidance): above +25 transition, +5 to +25 fresh, −10 to +5 neutral, −30 to −10 productive training, below −30 high fatigue.",
  ];
  if (days < 84) guidance.push("CTL needs roughly 6+ weeks of history to stabilise; with a short window it starts from zero and underestimates fitness.");
  if (ramp > 8) guidance.push(`CTL ramp rate of ${ramp}/week is aggressive; ramps above ~5-8/week are hard to sustain without extra recovery.`);
  else if (ramp < -5) guidance.push(`CTL is falling ${Math.abs(ramp)}/week: consistent with a taper, recovery block or reduced training.`);
  const estimated = sources.heart_rate + sources.duration_estimate;
  if (estimated && rides.length) guidance.push(`${estimated} of ${rides.length} rides had no Garmin or power TSS and use heart-rate or duration estimates${ctx.thresholdEstimated ? " (threshold HR estimated at 90 % of max HR)" : ""}.`);
  return {
    source: "garmin",
    days,
    rides_analyzed: rides.length,
    ftp_w: ctx.ftp,
    threshold_heartrate_bpm: ctx.thresholdHr,
    tss_sources: sources,
    model: {
      current: { ctl: current.ctl, atl: current.atl, tsb: current.tsb, ramp_rate_per_week: ramp, form: cyclingForm(current.tsb) },
      daily: daily.slice(-42),
    },
    guidance,
  };
}

// --- Event pacing & fueling ---

export const CYCLING_EVENT_TYPES = ["time_trial", "criterium", "road_race", "gran_fondo", "ultra_endurance"] as const;
export type CyclingEventType = typeof CYCLING_EVENT_TYPES[number];

export interface CyclingEventInput {
  distance_km: number;
  event_type: CyclingEventType;
  elevation_gain_m?: number;
  goal_duration_hours?: number;
  temperature_c?: number;
  ftp_watts?: number;
  weight_kg?: number;
}

const DEFAULT_EVENT_HOURS: Record<CyclingEventType, number> = {
  time_trial: 1, criterium: 1, road_race: 3, gran_fondo: 5, ultra_endurance: 10,
};
const EXPECTED_VI: Record<CyclingEventType, number> = {
  time_trial: 1.02, criterium: 1.2, road_race: 1.12, gran_fondo: 1.05, ultra_endurance: 1.04,
};

/** Sustainable intensity-factor band by duration (adapted from common Coggan/Allen guidance). */
export function intensityBand(hours: number, type: CyclingEventType): [number, number] {
  const base: [number, number] = hours <= 1 ? [0.95, 1.02] : hours <= 1.5 ? [0.9, 0.97] : hours <= 2.5 ? [0.83, 0.9]
    : hours <= 3.5 ? [0.78, 0.85] : hours <= 5 ? [0.72, 0.8] : hours <= 7 ? [0.66, 0.74] : [0.58, 0.68];
  if (type === "criterium") return [Math.max(base[0], 0.9), Math.max(base[1], 1.05)];
  if (type === "road_race") return [base[0] + 0.02, base[1] + 0.02];
  return base;
}

export function fuelingBand(hours: number): [number, number] {
  if (hours <= 1) return [0, 30];
  if (hours <= 2) return [30, 60];
  if (hours <= 2.5) return [45, 60];
  return [60, 90];
}

export async function buildCyclingEventStrategy(input: CyclingEventInput, api: CyclingApi = garminClient, now = new Date()): Promise<CyclingEvent> {
  const [history, garminFtp, weight, hr] = await Promise.all([
    api.getAllActivities(300).catch(() => [] as GarminActivity[]),
    input.ftp_watts ? Promise.resolve(null) : api.getCyclingFtp().catch(() => null),
    resolveWeightKg(api, input.weight_kg),
    resolveCyclingHeartRateProfile(api),
  ]);
  const rides = recentRides(history, 120, now);
  const twenty = Math.max(0, ...rides.filter(ride => now.getTime() - new Date(ride.date).getTime() <= 90 * DAY_MS).map(ride => ride.curve.get(1200) ?? 0));
  const user = input.ftp_watts && input.ftp_watts > 0 ? input.ftp_watts : null;
  const ftp = user ?? garminFtp ?? (twenty ? estimateFtpFrom20Min(twenty) : null);
  const ftpSource: FtpSource = user ? "user" : garminFtp ? "garmin" : twenty ? "estimated_from_20min" : "unavailable";
  const density = input.elevation_gain_m != null ? input.elevation_gain_m / input.distance_km : null;

  let hours: number | null = input.goal_duration_hours ?? null;
  let durationSource = hours ? "goal duration you provided" : "";
  if (!hours) {
    const candidates = rides.filter(ride => !ride.indoor && !isEbike(ride.type) && ride.avg_speed_mps > 0 &&
      ride.distance_m >= Math.min(input.distance_km * 400, 40_000));
    const similar = density === null ? candidates : candidates.filter(ride => {
      const rideDensity = ride.elevation_gain_m / (ride.distance_m / 1000);
      return Math.abs(rideDensity - density) <= Math.max(3, density * 0.5);
    });
    const pool = similar.length >= 2 ? similar : candidates;
    if (pool.length) {
      const speeds = pool.map(ride => ride.avg_speed_mps).sort((a, b) => a - b);
      const median = speeds[Math.floor(speeds.length / 2)];
      hours = input.distance_km * 1000 / median / 3600;
      durationSource = `median moving speed ${round(median * 3.6)} km/h of ${pool.length} recent outdoor ride(s)${pool === similar && density !== null ? " with similar climbing per km" : ""}; add stops and group dynamics separately`;
    } else {
      durationSource = "unavailable: no comparable recent outdoor rides; provide goal_duration_hours";
    }
  }
  const bandHours = hours ?? DEFAULT_EVENT_HOURS[input.event_type];
  const [ifLow, ifHigh] = intensityBand(bandHours, input.event_type);
  const npLow = ftp ? Math.round(ftp * ifLow) : null;
  const npHigh = ftp ? Math.round(ftp * ifHigh) : null;
  const expectedAvg = npLow && npHigh ? Math.round((npLow + npHigh) / 2 / EXPECTED_VI[input.event_type]) : null;
  const climbFactor = input.event_type === "time_trial" ? 1.05 : bandHours <= 1.5 ? 1.1 : bandHours <= 3 ? 1.0 : bandHours <= 5 ? 0.95 : 0.88;
  const hrFactor = bandHours > 3 ? 0.9 : bandHours > 1.5 ? 0.95 : 1;
  const [carbLow, carbHigh] = fuelingBand(bandHours);
  const hot = input.temperature_c != null && input.temperature_c >= 25;
  const fluid: [number, number] = hot ? [600, 1000] : [400, 750];
  const sodium: [number, number] = hot || bandHours > 2 ? [400, 800] : [200, 500];
  const work = expectedAvg && hours ? Math.round(expectedAvg * hours * 3600 / 1000) : null;

  const phase = (name: string, portion: string, low: number, high: number, guidance: string) => ({
    phase: name, portion, guidance,
    target_low_w: npLow ? Math.round(npLow * low) : null,
    target_high_w: npHigh ? Math.round(npHigh * high) : null,
  });
  const phases = input.event_type === "criterium" || input.event_type === "road_race"
    ? [
      phase("Opening", "first 15 %", 0.95, 1, "Stay sheltered and near the front without chasing every move; surges above FTP are expected but keep them short."),
      phase("Middle", "15-80 %", 1, 1, "Ride the normalized-power band; recover in the wheels, eat and drink on schedule."),
      phase("Finale", "last 20 %", 1, 1.05, "Spend remaining matches here: position for the decisive climbs or sprint."),
    ]
    : [
      phase("Settle", "first 15 %", 0.92, 0.97, "Start below target: early excess costs disproportionately later, especially in heat."),
      phase("Steady", "15-80 %", 1, 1, "Hold the band; push slightly over on climbs (never above the climb ceiling) and soft-pedal descents."),
      phase("Finish", "last 20 %", 1, 1.04, "Lift towards the top of the band only if fueling is on track and HR has stayed under the ceiling."),
    ];

  const tips = [
    "Use power as the primary pacing guide and heart rate as a cross-check; HR rises with heat and duration (cardiac drift).",
    "Practise race-day fueling in long training rides; gut tolerance for 60-90 g/h is trainable.",
    "Check tyre pressure, gearing and bike fit before the event; nothing new on race day.",
  ];
  if (input.event_type === "time_trial") tips.push("Warm up 15-20 minutes including 2-3 short efforts near target power; hold aero position and avoid the first-minute spike above 105 % of target.");
  if (density !== null && density >= 15) tips.push(`Climbing-heavy course (${round(density)} m/km): consider gearing and pace climbs by power, not speed.`);
  if (hot) tips.push(`Heat (${input.temperature_c} °C): expect lower sustainable power; start at the bottom of the band and pre-cool where possible.`);
  if (!ftp) tips.push("FTP unknown: set FTP in Garmin Connect, pass ftp_watts, or run get_cycling_power_profile to estimate one before relying on watt targets.");
  if (rides.length && !rides.some(ride => ride.avg_power || ride.norm_power || ride.curve.size)) {
    tips.unshift("None of your recent rides recorded power: pace by the heart-rate ceiling and perceived effort; watt targets only apply with a power meter or smart trainer.");
  }

  return {
    event: {
      type: input.event_type, distance_km: input.distance_km,
      elevation_gain_m: input.elevation_gain_m ?? null, climbing_m_per_km: round(density),
      temperature_c: input.temperature_c ?? null,
    },
    duration: {
      hours: round(hours, 2),
      formatted: hours ? formatDuration(hours * 3600) : null,
      implied_speed_kmh: hours ? round(input.distance_km / hours) : null,
      source: durationSource,
    },
    ftp: { watts: ftp, source: ftpSource, w_per_kg: ftp && weight ? round(ftp / weight, 2) : null },
    targets: {
      intensity_factor_low: ifLow, intensity_factor_high: ifHigh,
      normalized_power_low_w: npLow, normalized_power_high_w: npHigh,
      expected_avg_power_w: expectedAvg,
      climb_ceiling_w: ftp ? Math.round(ftp * climbFactor) : null,
      heart_rate_ceiling_bpm: hr.thresholdHr ? Math.round(hr.thresholdHr * hrFactor) : null,
      rationale: `${hours ? "" : "Duration unknown; bands assume a typical " + DEFAULT_EVENT_HOURS[input.event_type] + " h " + input.event_type.replaceAll("_", " ") + ". "}Intensity factor band for ~${round(bandHours, 1)} h; average power assumes a variability index of ${EXPECTED_VI[input.event_type]} for this event type.`,
    },
    pacing_phases: phases,
    energy: { estimated_work_kj: work, estimated_kcal: work },
    fueling: {
      carbs_g_per_hour_low: carbLow, carbs_g_per_hour_high: carbHigh,
      total_carbs_g_low: hours ? Math.round(carbLow * hours) : null,
      total_carbs_g_high: hours ? Math.round(carbHigh * hours) : null,
      fluid_ml_per_hour_low: fluid[0], fluid_ml_per_hour_high: fluid[1],
      sodium_mg_per_hour_low: sodium[0], sodium_mg_per_hour_high: sodium[1],
      plan: [
        "Eat 2-4 g/kg carbohydrate 2-4 hours before the start.",
        carbHigh > 0 ? `Start fueling within the first 20-30 minutes and take ${carbLow}-${carbHigh} g carbohydrate per hour in small, regular doses (every 15-20 minutes).` : "Fueling during the event is optional; a carbohydrate mouth rinse or small gel can help.",
        ...(carbHigh > 60 ? ["Above 60 g/h use glucose + fructose (multiple transportable carbohydrate) products to limit GI distress."] : []),
        `Drink ${fluid[0]}-${fluid[1]} ml per hour with ${sodium[0]}-${sodium[1]} mg sodium; adjust to your sweat rate and avoid gaining weight during the event.`,
        "Energy expenditure in kcal is roughly equal to mechanical work in kJ (gross efficiency ~24 %); you cannot replace it all during the event, so fuel for performance, not balance.",
      ],
    },
    tips,
  };
}
