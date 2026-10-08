import { z } from "zod";
import type { GarminActivityChart } from "./client.js";
import { speedToPacePerKm } from "../utils.js";

const nullableNumber = z.number().finite().nullable();
export const kilometreSplitsSchema = z.object({
  data_quality: z.object({
    status: z.enum(["complete", "partial", "unavailable"]),
    method: z.literal("distance_stream_interpolation"),
    pace_time_basis: z.enum(["moving", "elapsed"]).nullable(),
    sample_count: z.number(),
    max_sample_gap_seconds: nullableNumber,
    warnings: z.array(z.string()),
  }),
  km_splits: z.array(z.object({
    km: z.number(), start_km: z.number(), end_km: z.number(),
    distance_m: z.number(), is_partial: z.boolean(),
    moving_time_seconds: nullableNumber, elapsed_time_seconds: nullableNumber,
    stopped_time_seconds: nullableNumber,
    cumulative_moving_time_seconds: nullableNumber, cumulative_elapsed_time_seconds: nullableNumber,
    pace_seconds_per_km: nullableNumber, pace_per_km: z.string().nullable(),
    elapsed_pace_per_km: z.string().nullable(),
    pace_delta_previous_seconds: nullableNumber,
    avg_heartrate: nullableNumber, max_heartrate: nullableNumber,
    cadence_spm: nullableNumber, avg_power_w: nullableNumber, temperature_c: nullableNumber,
    elevation_gain_m: nullableNumber, elevation_loss_m: nullableNumber, net_elevation_m: nullableNumber,
    elevation_start_m: nullableNumber, elevation_end_m: nullableNumber,
    elevation_min_m: nullableNumber, elevation_max_m: nullableNumber,
    metric_coverage_percent: z.object({
      heart_rate: z.number(), cadence: z.number(), power: z.number(), temperature: z.number(), elevation: z.number(),
    }),
  })),
  pacing_summary: z.object({
    full_km_count: z.number(),
    fastest_full_km: nullableNumber, slowest_full_km: nullableNumber,
    pace_std_deviation_seconds: nullableNumber,
    first_half_pace_per_km: z.string().nullable(), second_half_pace_per_km: z.string().nullable(),
    second_half_pace_change_percent: nullableNumber,
    strategy: z.enum(["negative_split", "positive_split", "even", "unavailable"]),
    first_half_avg_heartrate: nullableNumber, second_half_avg_heartrate: nullableNumber,
    hr_drift_percent: nullableNumber, aerobic_decoupling_percent: nullableNumber,
    notes: z.array(z.string()),
  }).nullable(),
});
export type KilometreSplits = z.infer<typeof kilometreSplitsSchema>;

type Sensor = "heart_rate" | "cadence" | "power" | "temperature" | "elevation";
type Sample = Record<Sensor, number | null> & { distance: number; elapsed: number | null; moving: number | null; time: number };
const sensors: Sensor[] = ["heart_rate", "cadence", "power", "temperature", "elevation"];
const rounded = (value: number | null) => value === null ? null : +value.toFixed(3);
const pace = (seconds: number | null, meters: number) =>
  seconds !== null && seconds > 0 ? speedToPacePerKm(meters / seconds) : null;

// Garmin values are already in unit.key; factor describes encoding, not a divisor.
function metricReader(chart: GarminActivityChart, keys: string[], units: Record<string, number>, scale = 1) {
  const descriptor = keys.map(key => chart.metricDescriptors?.find(item => item.key === key)).find(Boolean);
  if (!descriptor) return null;
  const multiplier = units[descriptor.unit?.key.toLowerCase() ?? ""];
  if (multiplier === undefined) return null;
  return (row: Array<number | null>): number | null => {
    const value = row[descriptor.metricsIndex];
    return typeof value === "number" && Number.isFinite(value) ? value * multiplier * scale : null;
  };
}

function readSamples(chart: GarminActivityChart, warnings: string[]): Sample[] {
  const meters = { meter: 1, meters: 1, m: 1, centimeter: 0.01, cm: 0.01, kilometer: 1000, km: 1000 };
  const seconds = { second: 1, seconds: 1, s: 1, ms: 0.001, millisecond: 0.001 };
  const distance = metricReader(chart, ["sumDistance"], meters);
  const elapsed = metricReader(chart, ["sumElapsedDuration"], seconds);
  const timestamp = metricReader(chart, ["directTimestamp"], { gmt: 0.001, ms: 0.001 });
  const moving = metricReader(chart, ["sumMovingDuration"], seconds);
  if (!distance || (!elapsed && !timestamp && !moving)) {
    warnings.push("Kilometre splits unavailable: Garmin did not provide cumulative distance and time with supported units.");
    return [];
  }
  const readers = {
    heart_rate: metricReader(chart, ["directHeartRate"], { bpm: 1 }),
    // directRunCadence counts one leg; directDoubleCadence is already total steps/minute.
    cadence: metricReader(chart, ["directDoubleCadence"], { spm: 1, stepsperminute: 1 }) ??
      metricReader(chart, ["directRunCadence"], { spm: 1, stepsperminute: 1 }, 2),
    power: metricReader(chart, ["directPower"], { watt: 1, watts: 1, w: 1 }),
    temperature: metricReader(chart, ["directAirTemperature"], { celsius: 1, c: 1 }),
    elevation: metricReader(chart, ["directCorrectedElevation", "directElevation"], meters),
  };
  for (const key of sensors) {
    if (!readers[key]) warnings.push(`${key} unavailable: measurement absent or unit unsupported.`);
  }
  const samples: Sample[] = [];
  let invalidRows = 0;
  for (const row of chart.activityDetailMetrics ?? []) {
    const d = distance(row.metrics);
    const e = elapsed ? elapsed(row.metrics) : timestamp?.(row.metrics) ?? null;
    const m = moving?.(row.metrics) ?? null;
    const t = elapsed || timestamp ? e : m;
    if (d === null || d < 0 || t === null || (e !== null && e < 0) || (m !== null && m < 0)) {
      invalidRows++;
      continue;
    }
    const previous = samples.at(-1);
    if (previous && (d < previous.distance || t < previous.time || (m !== null && previous.moving !== null && m < previous.moving))) {
      throw new Error("Garmin distance/time samples go backwards; reliable kilometre splits cannot be calculated.");
    }
    if (previous && t === previous.time) {
      if (d !== previous.distance) throw new Error("Garmin distance changes without advancing time.");
      invalidRows++;
      continue;
    }
    const sample: Sample = { distance: d, elapsed: e, moving: m, time: t, heart_rate: null, cadence: null, power: null, temperature: null, elevation: null };
    for (const key of sensors) {
      const value = readers[key]?.(row.metrics) ?? null;
      sample[key] = value !== null && (key === "elevation" || key === "temperature" || (key === "heart_rate" ? value > 0 : value >= 0)) ? value : null;
    }
    samples.push(sample);
  }
  if (invalidRows) warnings.push(`${invalidRows} missing or duplicate distance/time rows were excluded.`);
  if (samples.length < 2) {
    warnings.push("Kilometre splits unavailable: fewer than two valid distance/time samples.");
    return [];
  }
  if (samples.some(sample => sample.elapsed === null)) {
    for (const sample of samples) sample.elapsed = null;
    warnings.push("Elapsed time unavailable; only Garmin moving time is available.");
  } else {
    const origin = samples[0].elapsed!;
    // Epoch timestamps must be relative to the first sample; elapsed counters are already relative.
    if (!elapsed) for (const sample of samples) sample.elapsed = sample.elapsed! - origin;
  }
  if (samples.some(sample => sample.moving === null)) {
    for (const sample of samples) sample.moving = null;
    warnings.push("Moving time unavailable or incomplete; pace uses elapsed time and includes pauses.");
  }
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (a.elapsed !== null && b.elapsed !== null && a.moving !== null && b.moving !== null &&
        b.moving - a.moving > b.elapsed - a.elapsed + 0.01) {
      throw new Error("Garmin moving time exceeds elapsed time between samples.");
    }
    if (b.distance > a.distance && a.moving !== null && b.moving === a.moving) {
      throw new Error("Garmin distance advances without advancing moving time.");
    }
  }
  return samples;
}

function boundary(samples: Sample[], distance: number): { index: number; elapsed: number | null; moving: number | null; elevation: number | null } | null {
  if (distance < samples[0].distance || distance > samples.at(-1)!.distance) return null;
  let low = 0, high = samples.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle].distance < distance) low = middle + 1;
    else high = middle;
  }
  const b = samples[low];
  if (b.distance === distance) return { index: low, elapsed: b.elapsed, moving: b.moving, elevation: b.elevation };
  const a = samples[low - 1];
  const fraction = (distance - a.distance) / (b.distance - a.distance);
  const interpolate = (key: "elapsed" | "moving" | "elevation") => a[key] === null || b[key] === null ? null : a[key]! + (b[key]! - a[key]!) * fraction;
  return { index: low - 1, elapsed: interpolate("elapsed"), moving: interpolate("moving"), elevation: interpolate("elevation") };
}

function rangeMetrics(samples: Sample[], start: number, end: number, basis: "moving" | "elapsed") {
  const first = boundary(samples, start), last = boundary(samples, end);
  if (!first || !last) return null;
  const difference = (key: "elapsed" | "moving") => first[key] === null || last[key] === null ? null : last[key]! - first[key]!;
  const duration = difference(basis)!;
  if (duration <= 0) return null;
  const sums = Object.fromEntries(sensors.map(key => [key, { weighted: 0, seconds: 0, minimum: Infinity, maximum: -Infinity }])) as Record<Sensor, { weighted: number; seconds: number; minimum: number; maximum: number }>;
  let gain = 0, loss = 0;
  for (let i = first.index; i < samples.length - 1 && samples[i].distance < end; i++) {
    const a = samples[i], b = samples[i + 1];
    const delta = b.distance - a.distance;
    const from = delta === 0 ? 0 : Math.max(0, (start - a.distance) / delta);
    const to = delta === 0 ? 1 : Math.min(1, (end - a.distance) / delta);
    if (to <= from) continue;
    const weight = (b[basis]! - a[basis]!) * (to - from);
    if (weight <= 0) continue;
    for (const key of sensors) {
      if (a[key] === null || b[key] === null) continue;
      const v1 = a[key]! + (b[key]! - a[key]!) * from;
      const v2 = a[key]! + (b[key]! - a[key]!) * to;
      sums[key].weighted += (v1 + v2) / 2 * weight;
      sums[key].seconds += weight;
      sums[key].minimum = Math.min(sums[key].minimum, v1, v2);
      sums[key].maximum = Math.max(sums[key].maximum, v1, v2);
      if (key === "elevation") {
        gain += Math.max(0, v2 - v1);
        loss += Math.max(0, v1 - v2);
      }
    }
  }
  const average = (key: Sensor) => sums[key].seconds > 0 ? rounded(sums[key].weighted / sums[key].seconds) : null;
  const coverage = Object.fromEntries(sensors.map(key => [key, Math.min(100, 100 * sums[key].seconds / duration)])) as Record<Sensor, number>;
  return {
    moving: difference("moving"), elapsed: difference("elapsed"),
    cumulativeMoving: last.moving, cumulativeElapsed: last.elapsed,
    secondsPerKm: duration * 1000 / (end - start),
    heartRate: average("heart_rate"),
    maxHeartRate: Number.isFinite(sums.heart_rate.maximum) ? rounded(sums.heart_rate.maximum) : null,
    cadence: average("cadence"), power: average("power"), temperature: average("temperature"),
    gain: sums.elevation.seconds > 0 ? rounded(gain) : null,
    loss: sums.elevation.seconds > 0 ? rounded(loss) : null,
    elevationStart: rounded(first.elevation), elevationEnd: rounded(last.elevation),
    elevationMin: Number.isFinite(sums.elevation.minimum) ? rounded(sums.elevation.minimum) : null,
    elevationMax: Number.isFinite(sums.elevation.maximum) ? rounded(sums.elevation.maximum) : null,
    coverage,
  };
}

export function buildKilometreSplits(chart: GarminActivityChart, distanceMeters: number, isInterval = false): KilometreSplits {
  const warnings: string[] = [];
  const samples = readSamples(chart, warnings);
  const result: KilometreSplits = {
    data_quality: { status: "unavailable", method: "distance_stream_interpolation", pace_time_basis: null, sample_count: samples.length, max_sample_gap_seconds: null, warnings },
    km_splits: [], pacing_summary: null,
  };
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) throw new Error("Garmin activity has no positive distance to split.");
  if (!samples.length) return result;
  const basis = samples[0].moving === null ? "elapsed" : "moving";
  result.data_quality.pace_time_basis = basis;
  let maxGap = 0;
  for (let i = 1; i < samples.length; i++) maxGap = Math.max(maxGap, samples[i].time - samples[i - 1].time);
  result.data_quality.max_sample_gap_seconds = rounded(maxGap);
  if (maxGap > 30) warnings.push("Sample gaps exceed 30 seconds; interpolated boundaries and sensor averages may be less accurate.");
  if (samples[0].distance > 0 || samples.at(-1)!.distance < distanceMeters) warnings.push("Distance samples do not cover the entire activity; unbracketed splits remain unavailable (no extrapolation).");
  if (Math.abs(samples.at(-1)!.distance - distanceMeters) > Math.max(10, distanceMeters * 0.01)) warnings.push("Stream distance differs from the activity summary by more than 10 m or 1%; check recording quality.");
  const notes = [
    "Split boundaries are interpolated from recorded cumulative distance, not renamed watch laps. The final partial kilometre is excluded from fastest/slowest and consistency comparisons.",
    "Sensor averages are time-weighted over valid sample pairs; coverage is the percentage of split time with usable readings. Elevation gain/loss are sample estimates, not grade-adjusted pace.",
    "Half comparisons use equal distances, not equal times. Positive pace change means slower; positive aerobic decoupling means lower speed per heart beat in the second half. HR drift and decoupling are descriptive, not a diagnosis; terrain, heat, pauses and workout structure can affect them.",
  ];
  if (isInterval) notes.push("This is an interval workout: kilometre splits mix work and recovery. Use the recorded ACTIVE laps to assess rep execution.");
  for (let start = 0, km = 1; start < distanceMeters; start += 1000, km++) {
    const end = Math.min(start + 1000, distanceMeters);
    const metrics = rangeMetrics(samples, start, end, basis);
    const previous = result.km_splits.at(-1)?.pace_seconds_per_km ?? null;
    const seconds = metrics?.secondsPerKm ?? null;
    result.km_splits.push({
      km, start_km: start / 1000, end_km: end / 1000, distance_m: end - start, is_partial: end - start < 1000,
      moving_time_seconds: rounded(metrics?.moving ?? null), elapsed_time_seconds: rounded(metrics?.elapsed ?? null),
      stopped_time_seconds: metrics?.elapsed != null && metrics.moving !== null ? rounded(Math.max(0, metrics.elapsed - metrics.moving)) : null,
      cumulative_moving_time_seconds: rounded(metrics?.cumulativeMoving ?? null), cumulative_elapsed_time_seconds: rounded(metrics?.cumulativeElapsed ?? null),
      pace_seconds_per_km: rounded(seconds), pace_per_km: pace(seconds, 1000),
      elapsed_pace_per_km: pace(metrics?.elapsed ?? null, end - start),
      pace_delta_previous_seconds: seconds !== null && previous !== null ? rounded(seconds - previous) : null,
      avg_heartrate: metrics?.heartRate ?? null, max_heartrate: metrics?.maxHeartRate ?? null,
      cadence_spm: metrics?.cadence ?? null, avg_power_w: metrics?.power ?? null, temperature_c: metrics?.temperature ?? null,
      elevation_gain_m: metrics?.gain ?? null, elevation_loss_m: metrics?.loss ?? null,
      net_elevation_m: metrics?.gain != null && metrics.loss !== null ? rounded(metrics.gain - metrics.loss) : null,
      elevation_start_m: metrics?.elevationStart ?? null, elevation_end_m: metrics?.elevationEnd ?? null,
      elevation_min_m: metrics?.elevationMin ?? null, elevation_max_m: metrics?.elevationMax ?? null,
      metric_coverage_percent: metrics?.coverage ?? { heart_rate: 0, cadence: 0, power: 0, temperature: 0, elevation: 0 },
    });
  }
  const full = result.km_splits.filter(split => !split.is_partial && split.pace_seconds_per_km !== null);
  const paces = full.map(split => split.pace_seconds_per_km!);
  const mean = paces.reduce((sum, p) => sum + p, 0) / paces.length;
  const first = rangeMetrics(samples, 0, distanceMeters / 2, basis);
  const second = rangeMetrics(samples, distanceMeters / 2, distanceMeters, basis);
  const change = first && second ? 100 * (second.secondsPerKm / first.secondsPerKm - 1) : null;
  const hrComparable = first?.heartRate != null && second?.heartRate != null && first.coverage.heart_rate >= 80 && second.coverage.heart_rate >= 80;
  if (!hrComparable) notes.push("HR drift/decoupling unavailable: each half needs at least 80% valid HR coverage.");
  result.pacing_summary = {
    full_km_count: full.length,
    fastest_full_km: full.length ? full.reduce((best, split) => split.pace_seconds_per_km! < best.pace_seconds_per_km! ? split : best).km : null,
    slowest_full_km: full.length ? full.reduce((worst, split) => split.pace_seconds_per_km! > worst.pace_seconds_per_km! ? split : worst).km : null,
    pace_std_deviation_seconds: paces.length >= 2 ? rounded(Math.sqrt(paces.reduce((sum, p) => sum + (p - mean) ** 2, 0) / paces.length)) : null,
    first_half_pace_per_km: pace(first?.secondsPerKm ?? null, 1000), second_half_pace_per_km: pace(second?.secondsPerKm ?? null, 1000),
    second_half_pace_change_percent: rounded(change),
    strategy: change === null ? "unavailable" : change < -2 - 1e-9 ? "negative_split" : change > 2 + 1e-9 ? "positive_split" : "even",
    first_half_avg_heartrate: first?.heartRate ?? null, second_half_avg_heartrate: second?.heartRate ?? null,
    hr_drift_percent: hrComparable ? rounded(100 * (second!.heartRate! / first!.heartRate! - 1)) : null,
    aerobic_decoupling_percent: hrComparable ? rounded(100 * (1 - first!.secondsPerKm * first!.heartRate! / (second!.secondsPerKm * second!.heartRate!))) : null,
    notes,
  };
  const usable = result.km_splits.filter(split => split.pace_seconds_per_km !== null).length;
  result.data_quality.status = usable === result.km_splits.length ? "complete" : usable > 0 ? "partial" : "unavailable";
  if (!usable) warnings.push("Kilometre splits unavailable: no split boundaries are fully bracketed by the distance/time samples.");
  return result;
}
