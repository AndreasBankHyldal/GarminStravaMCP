import type { GarminActivityChart } from "../garmin/client.js";
import { metricReader } from "../garmin/splits.js";

/** Longest recording gap that is interpolated; longer gaps are treated as paused time and excluded. */
export const MAX_INTERPOLATION_GAP_SECONDS = 10;
export const POWER_CURVE_DURATIONS = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600] as const;

export type RideChannel = "power" | "heart_rate" | "cadence" | "speed" | "distance" | "elevation" | "temperature";
const channels: RideChannel[] = ["power", "heart_rate", "cadence", "speed", "distance", "elevation", "temperature"];
type Series = (number | null)[];

/** Ride data resampled to one value per recorded second; paused time is removed. */
export interface RideStream {
  seconds: number;
  series: Record<RideChannel, Series>;
  available: Record<RideChannel, boolean>;
  excludedPauseSeconds: number;
  maxSampleGapSeconds: number | null;
  warnings: string[];
}

export const round = (value: number | null | undefined, digits = 1) =>
  value == null || !Number.isFinite(value) ? null : +value.toFixed(digits);

export function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${seconds / 60}m`;
  return `${seconds / 3600}h`;
}

export function readRideStream(chart: GarminActivityChart): RideStream {
  const warnings: string[] = [];
  const meters = { meter: 1, meters: 1, m: 1, centimeter: 0.01, cm: 0.01, kilometer: 1000, km: 1000 };
  const seconds = { second: 1, seconds: 1, s: 1, ms: 0.001, millisecond: 0.001 };
  const elapsed = metricReader(chart, ["sumElapsedDuration"], seconds);
  const timestamp = metricReader(chart, ["directTimestamp"], { gmt: 0.001, ms: 0.001 });
  const timer = metricReader(chart, ["sumDuration"], seconds);
  const moving = metricReader(chart, ["sumMovingDuration"], seconds);
  const time = elapsed ?? timestamp ?? timer ?? moving;
  const readers: Record<RideChannel, ReturnType<typeof metricReader>> = {
    power: metricReader(chart, ["directPower"], { watt: 1, watts: 1, w: 1 }),
    heart_rate: metricReader(chart, ["directHeartRate"], { bpm: 1 }),
    cadence: metricReader(chart, ["directBikeCadence", "directCadence"], { rpm: 1, revolutionsperminute: 1 }),
    speed: metricReader(chart, ["directSpeed"], { mps: 1, meterpersecond: 1, meterspersecond: 1, "m/s": 1, kph: 1 / 3.6, kmh: 1 / 3.6, kilometersperhour: 1 / 3.6 }),
    distance: metricReader(chart, ["sumDistance"], meters),
    elevation: metricReader(chart, ["directCorrectedElevation", "directElevation"], meters),
    temperature: metricReader(chart, ["directAirTemperature"], { celsius: 1, c: 1 }),
  };
  const empty = () => Object.fromEntries(channels.map(key => [key, [] as Series])) as Record<RideChannel, Series>;
  const result: RideStream = {
    seconds: 0, series: empty(),
    available: Object.fromEntries(channels.map(key => [key, false])) as Record<RideChannel, boolean>,
    excludedPauseSeconds: 0, maxSampleGapSeconds: null, warnings,
  };
  if (!time) {
    warnings.push("Ride stream unavailable: Garmin did not provide a time channel with supported units.");
    return result;
  }
  if (!elapsed && !timestamp) warnings.push("Elapsed time unavailable; stream uses Garmin timer/moving time, so pauses cannot be detected.");

  type Raw = { t: number } & Record<RideChannel, number | null>;
  const raw: Raw[] = [];
  let skipped = 0;
  for (const row of chart.activityDetailMetrics ?? []) {
    const t = time(row.metrics);
    if (t === null || (raw.length && t <= raw.at(-1)!.t)) {
      skipped++;
      continue;
    }
    const sample = { t } as Raw;
    for (const key of channels) {
      const value = readers[key]?.(row.metrics) ?? null;
      const valid = value !== null && (key === "elevation" || key === "temperature" || (key === "heart_rate" ? value > 0 : value >= 0));
      sample[key] = valid ? value : null;
    }
    raw.push(sample);
  }
  if (skipped) warnings.push(`${skipped} rows without a valid, increasing timestamp were excluded.`);
  if (raw.length < 2) {
    warnings.push("Ride stream unavailable: fewer than two valid time samples.");
    return result;
  }

  // Resample to 1 Hz so rolling power windows and time-in-zone use real seconds.
  const out = empty();
  const emit = (a: Raw, b: Raw | null, fraction: number) => {
    for (const key of channels) {
      const from = a[key];
      const to = b ? b[key] : null;
      out[key].push(fraction === 0 ? from : from === null || to === null ? null : from + (to - from) * fraction);
    }
  };
  let maxGap = 0;
  for (let i = 0; i < raw.length - 1; i++) {
    const a = raw[i], b = raw[i + 1];
    const gap = b.t - a.t;
    maxGap = Math.max(maxGap, gap);
    if (gap > MAX_INTERPOLATION_GAP_SECONDS) {
      emit(a, null, 0);
      result.excludedPauseSeconds += gap - 1;
      continue;
    }
    for (let offset = 0; offset < gap; offset++) emit(a, b, offset / gap);
  }
  emit(raw.at(-1)!, null, 0);
  result.maxSampleGapSeconds = round(maxGap, 3);
  if (result.excludedPauseSeconds > 0) {
    warnings.push(`${Math.round(result.excludedPauseSeconds)} s of recording gaps longer than ${MAX_INTERPOLATION_GAP_SECONDS} s were treated as paused time and excluded from power, zone and segment calculations.`);
  }

  // Derive missing distance/speed from each other when only one is recorded.
  if (!out.distance.some(v => v !== null) && out.speed.some(v => v !== null)) {
    let total = 0;
    out.distance = out.speed.map(speed => (total += speed ?? 0));
    warnings.push("Distance was integrated from the speed channel.");
  }
  if (!out.speed.some(v => v !== null) && out.distance.some(v => v !== null)) {
    out.speed = out.distance.map((d, i) => {
      const next = out.distance[i + 1];
      return d === null || next == null ? null : Math.max(0, next - d);
    });
  }
  result.series = out;
  result.seconds = out.power.length;
  for (const key of channels) result.available[key] = out[key].some(v => v !== null);
  return result;
}

export function coveragePercent(series: Series, start = 0, end = series.length): number {
  if (end <= start) return 0;
  let valid = 0;
  for (let i = start; i < end; i++) if (series[i] !== null) valid++;
  return round(100 * valid / (end - start)) ?? 0;
}

export function mean(series: Series, start = 0, end = series.length, predicate: (value: number) => boolean = () => true): number | null {
  let sum = 0, count = 0;
  for (let i = start; i < end; i++) {
    const value = series[i];
    if (value !== null && predicate(value)) {
      sum += value;
      count++;
    }
  }
  return count ? sum / count : null;
}

export function maximum(series: Series, start = 0, end = series.length): number | null {
  let best: number | null = null;
  for (let i = start; i < end; i++) {
    const value = series[i];
    if (value !== null && (best === null || value > best)) best = value;
  }
  return best;
}

/** Dropouts are skipped; the remaining seconds are treated as one continuous effort. */
function validValues(series: Series, start = 0, end = series.length): number[] {
  const values: number[] = [];
  for (let i = start; i < end; i++) if (series[i] !== null) values.push(series[i]!);
  return values;
}

/** Coggan normalized power: fourth-power mean of the 30-second rolling average. */
export function normalizedPower(power: Series, start = 0, end = power.length): number | null {
  const values = validValues(power, start, end);
  if (values.length < 30) return null;
  let window = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    window += values[i];
    if (i >= 30) window -= values[i - 30];
    if (i >= 29) {
      sum += (window / 30) ** 4;
      count++;
    }
  }
  return (sum / count) ** 0.25;
}

export function bestAveragePower(power: Series, duration: number): number | null {
  const values = validValues(power);
  if (values.length < duration) return null;
  let window = 0;
  let best = 0;
  for (let i = 0; i < values.length; i++) {
    window += values[i];
    if (i >= duration) window -= values[i - duration];
    if (i >= duration - 1) best = Math.max(best, window / duration);
  }
  return best;
}

export function powerCurve(power: Series, weightKg: number | null) {
  return POWER_CURVE_DURATIONS.flatMap(duration => {
    const watts = bestAveragePower(power, duration);
    return watts === null ? [] : [{
      duration_s: duration, label: durationLabel(duration),
      watts: Math.round(watts), w_per_kg: weightKg ? round(watts / weightKg, 2) : null,
    }];
  });
}

const POWER_ZONE_MODEL = [
  { label: "Active recovery", upper: 0.55 },
  { label: "Endurance", upper: 0.75 },
  { label: "Tempo", upper: 0.90 },
  { label: "Lactate threshold", upper: 1.05 },
  { label: "VO2max", upper: 1.20 },
  { label: "Anaerobic capacity", upper: 1.50 },
  { label: "Neuromuscular", upper: null },
] as const;

/** Coggan 7-zone model as whole-watt ranges for a given FTP. */
export function powerZones(ftp: number) {
  let previousMax = -1;
  return POWER_ZONE_MODEL.map((zone, index) => {
    const max = zone.upper === null ? null : Math.floor(ftp * zone.upper);
    const result = {
      zone: index + 1, label: zone.label,
      min_w: previousMax + 1, max_w: max,
      min_percent_ftp: index === 0 ? 0 : Math.round(POWER_ZONE_MODEL[index - 1].upper! * 100) + 1,
      max_percent_ftp: zone.upper === null ? null : Math.round(zone.upper * 100),
    };
    previousMax = max ?? previousMax;
    return result;
  });
}

function distribution<T extends { seconds: number }>(items: T[], total: number) {
  return items.map(item => ({ ...item, seconds: Math.round(item.seconds), percent: total > 0 ? round(100 * item.seconds / total) ?? 0 : 0 }));
}

export function timeInPowerZones(power: Series, ftp: number) {
  const zones = powerZones(ftp).map(zone => ({ ...zone, seconds: 0 }));
  let total = 0;
  for (const value of power) {
    if (value === null) continue;
    const watts = Math.round(value);
    (zones.find(zone => zone.max_w === null || watts <= zone.max_w) ?? zones.at(-1)!).seconds++;
    total++;
  }
  return distribution(zones, total);
}

export interface HeartRateZoneBounds {
  zone: number;
  label: string;
  min_bpm: number | null;
  max_bpm: number | null;
}

export function timeInHeartRateZones(heartRate: Series, zones: HeartRateZoneBounds[]) {
  const usable = zones.filter(zone => zone.min_bpm !== null).sort((a, b) => a.min_bpm! - b.min_bpm!);
  if (!usable.length) return null;
  const buckets: (HeartRateZoneBounds & { seconds: number })[] = [
    { zone: 0, label: "Below zone 1", min_bpm: null, max_bpm: usable[0].min_bpm! - 1, seconds: 0 },
    ...usable.map(zone => ({ zone: zone.zone, label: zone.label, min_bpm: zone.min_bpm, max_bpm: zone.max_bpm, seconds: 0 })),
  ];
  let total = 0;
  for (const value of heartRate) {
    if (value === null) continue;
    let bucket = buckets[0];
    for (const candidate of buckets.slice(1)) if (value >= candidate.min_bpm!) bucket = candidate;
    bucket.seconds++;
    total++;
  }
  return distribution(buckets, total);
}

export function cadenceSummary(cadence: Series, speed: Series) {
  const pedaling = validValues(cadence).filter(value => value > 0);
  if (!pedaling.length) return null;
  let rolling = 0, coasting = 0;
  for (let i = 0; i < cadence.length; i++) {
    if (cadence[i] === null) continue;
    // Stationary seconds (e.g. traffic lights) are not coasting.
    if (speed[i] !== null && speed[i]! < 1) continue;
    rolling++;
    if (cadence[i]! < 1) coasting++;
  }
  const bins = [
    { range: "<70 rpm", min: 0, max: 70 }, { range: "70-79 rpm", min: 70, max: 80 },
    { range: "80-89 rpm", min: 80, max: 90 }, { range: "90-99 rpm", min: 90, max: 100 },
    { range: "100+ rpm", min: 100, max: Infinity },
  ].map(bin => ({ range: bin.range, seconds: pedaling.filter(value => value >= bin.min && value < bin.max).length }));
  return {
    avg_pedaling_rpm: round(pedaling.reduce((sum, value) => sum + value, 0) / pedaling.length),
    max_rpm: round(pedaling.reduce((max, value) => Math.max(max, value), 0)),
    coasting_percent: rolling ? round(100 * coasting / rolling) : null,
    distribution: distribution(bins, pedaling.length),
  };
}

/** Power:HR (efficiency factor) comparison between equal-time halves. */
export function powerHeartRateDecoupling(power: Series, heartRate: Series) {
  const half = Math.floor(power.length / 2);
  if (half < 600) return null;
  const halves = [[0, half], [half, power.length]].map(([start, end]) => ({
    power: mean(power, start, end), heartRate: mean(heartRate, start, end),
    powerCoverage: coveragePercent(power, start, end), heartRateCoverage: coveragePercent(heartRate, start, end),
  }));
  if (halves.some(h => h.power === null || h.heartRate === null || h.powerCoverage < 80 || h.heartRateCoverage < 80 || h.power <= 0)) return null;
  const [first, second] = halves.map(h => h.power! / h.heartRate!);
  return {
    first_half: { avg_power_w: round(halves[0].power), avg_heartrate: round(halves[0].heartRate) },
    second_half: { avg_power_w: round(halves[1].power), avg_heartrate: round(halves[1].heartRate) },
    first_half_efficiency: round(first, 3), second_half_efficiency: round(second, 3),
    decoupling_percent: round(100 * (first - second) / first),
  };
}

/** Hysteresis matching Garmin's ride totals on real 1 Hz altitude data; it filters sensor noise without flattening rollers. */
export const ELEVATION_HYSTERESIS_M = 1.5;

function elevationChange(elevation: Series, start: number, end: number) {
  let gain = 0, loss = 0;
  let reference: number | null = null;
  for (let i = start; i <= end && i < elevation.length; i++) {
    const value = elevation[i];
    if (value === null) continue;
    if (reference === null) {
      reference = value;
    } else if (value - reference >= ELEVATION_HYSTERESIS_M) {
      gain += value - reference;
      reference = value;
    } else if (reference - value >= ELEVATION_HYSTERESIS_M) {
      loss += reference - value;
      reference = value;
    }
  }
  return reference === null ? { gain: null, loss: null } : { gain: round(gain), loss: round(loss) };
}

/** Summary for seconds [start, end); the end boundary sample closes distance and elevation. */
function rangeSummary(stream: RideStream, start: number, end: number) {
  const { power, heart_rate: hr, cadence, distance, elevation } = stream.series;
  const last = Math.min(end, stream.seconds - 1);
  const meters = distance[start] !== null && distance[last] !== null ? Math.max(0, distance[last]! - distance[start]!) : null;
  const seconds = end - start;
  const change = elevationChange(elevation, start, last);
  return {
    time_seconds: seconds,
    distance_m: round(meters),
    avg_speed_kmh: meters !== null && seconds > 0 ? round(meters / seconds * 3.6) : null,
    avg_power_w: round(mean(power, start, end)),
    normalized_power_w: round(normalizedPower(power, start, end)),
    max_power_w: round(maximum(power, start, end)),
    avg_heartrate: round(mean(hr, start, end)),
    max_heartrate: round(maximum(hr, start, end)),
    avg_cadence_rpm: round(mean(cadence, start, end, value => value > 0)),
    elevation_gain_m: change.gain,
    elevation_loss_m: change.loss,
    avg_grade_percent: meters && meters > 0 && elevation[start] !== null && elevation[last] !== null
      ? round(100 * (elevation[last]! - elevation[start]!) / meters) : null,
  };
}

/** Fixed-distance segments (time segments when the ride has no distance, e.g. trainer rides). */
export function rideSegments(stream: RideStream, segmentKm: number, segmentMinutes = 10) {
  const distance = stream.series.distance;
  const useDistance = stream.available.distance && (distance.at(-1) ?? 0) > 0;
  const boundaries: number[] = [0];
  if (useDistance) {
    const size = segmentKm * 1000;
    let next = size;
    for (let i = 0; i < stream.seconds; i++) {
      if (distance[i] !== null && distance[i]! >= next) {
        boundaries.push(i);
        while (distance[i]! >= next) next += size;
      }
    }
  } else {
    for (let i = segmentMinutes * 60; i < stream.seconds; i += segmentMinutes * 60) boundaries.push(i);
  }
  if (boundaries.at(-1)! < stream.seconds - 1) boundaries.push(stream.seconds - 1);
  const items = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i], end = boundaries[i + 1];
    if (end <= start) continue;
    const summary = rangeSummary(stream, start, end);
    const fullSize = useDistance ? segmentKm * 1000 : segmentMinutes * 60;
    const size = useDistance ? summary.distance_m ?? 0 : end - start;
    items.push({
      index: items.length + 1,
      start_km: useDistance ? round((distance[start] ?? 0) / 1000, 2) : null,
      end_km: useDistance ? round((distance[end] ?? 0) / 1000, 2) : null,
      start_minute: round(start / 60),
      is_partial: size < fullSize * 0.98,
      ...summary,
    });
  }
  return { basis: useDistance ? "distance" as const : "time" as const, segment_size: useDistance ? segmentKm : segmentMinutes, items };
}

function climbCategory(lengthM: number, gradePercent: number): string {
  const score = lengthM * gradePercent;
  return score >= 80_000 ? "HC" : score >= 64_000 ? "Cat 1" : score >= 32_000 ? "Cat 2" : score >= 16_000 ? "Cat 3" : score >= 8_000 ? "Cat 4" : "Uncategorized";
}

/** Detect sustained climbs (≥500 m, ≥25 m gain, ≥3 % average) on a smoothed 50 m distance profile. */
export function detectClimbs(stream: RideStream, weightKg: number | null) {
  const { distance, elevation } = stream.series;
  if (!stream.available.distance || !stream.available.elevation) return [];
  const step = 50;
  const profile: { d: number; e: number; i: number }[] = [];
  let target = 0;
  let previous: { d: number; e: number; i: number } | null = null;
  for (let i = 0; i < stream.seconds; i++) {
    const d = distance[i], e = elevation[i];
    if (d === null || e === null) continue;
    while (d >= target) {
      const interpolated = previous && d > previous.d && previous.d <= target
        ? previous.e + (e - previous.e) * (target - previous.d) / (d - previous.d)
        : e;
      profile.push({ d: target, e: interpolated, i });
      target += step;
    }
    previous = { d, e, i };
  }
  if (profile.length < 10) return [];
  const smooth = profile.map((point, index) => {
    const window = profile.slice(Math.max(0, index - 2), index + 3);
    return { ...point, e: window.reduce((sum, p) => sum + p.e, 0) / window.length };
  });
  const grade = (a: number, b: number) => b > a ? 100 * (smooth[b].e - smooth[a].e) / (smooth[b].d - smooth[a].d) : 0;
  const lookahead = 4; // 200 m

  const climbs = [];
  let i = 0;
  while (i < smooth.length - 1) {
    let top = i;
    for (let j = i + 1; j < smooth.length; j++) {
      if (smooth[j].e > smooth[top].e) top = j;
      else if (smooth[top].e - smooth[j].e > 10 || smooth[j].d - smooth[top].d > 1000) break;
    }
    const peak = top;
    let start = i;
    for (let k = i; k <= top; k++) if (smooth[k].e < smooth[start].e) start = k;
    // Trim gentle approaches and false-flat summits so grade reflects the climb itself.
    while (start + lookahead < top && grade(start, start + lookahead) < 2) start++;
    while (top - lookahead > start && grade(top - lookahead, top) < 2) top--;
    const length = smooth[top].d - smooth[start].d;
    const gain = smooth[top].e - smooth[start].e;
    const average = length > 0 ? 100 * gain / length : 0;
    if (length >= 500 && gain >= 25 && average >= 3) {
      let maxGrade = 0;
      for (let k = start; k + lookahead <= top; k++) maxGrade = Math.max(maxGrade, grade(k, k + lookahead));
      const from = smooth[start].i, to = Math.max(from + 1, smooth[top].i);
      const summary = rangeSummary(stream, from, to);
      const seconds = to - from;
      climbs.push({
        index: climbs.length + 1,
        start_km: round(smooth[start].d / 1000, 2),
        end_km: round(smooth[top].d / 1000, 2),
        length_m: Math.round(length),
        elevation_gain_m: Math.round(gain),
        avg_grade_percent: round(average),
        max_grade_200m_percent: round(maxGrade),
        category: climbCategory(length, average),
        time_seconds: seconds,
        avg_speed_kmh: round(length / seconds * 3.6),
        vam_m_per_h: Math.round(gain / (seconds / 3600)),
        avg_power_w: summary.avg_power_w,
        normalized_power_w: summary.normalized_power_w,
        avg_w_per_kg: summary.avg_power_w !== null && weightKg ? round(summary.avg_power_w / weightKg, 2) : null,
        avg_heartrate: summary.avg_heartrate,
        avg_cadence_rpm: summary.avg_cadence_rpm,
      });
    }
    i = Math.max(i + 1, peak);
  }
  return climbs;
}
