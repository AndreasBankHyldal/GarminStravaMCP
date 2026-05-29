const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Enrich a date string with human-readable temporal context to prevent LLM hallucination */
export function enrichDate(dateStr: string): {
  iso: string;
  human: string;
  day_of_week: string;
  days_ago: number;
} {
  const d = new Date(dateStr);
  const now = new Date();
  const daysAgo = Math.floor((now.getTime() - d.getTime()) / 86400000);

  return {
    iso: d.toISOString(),
    human: `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`,
    day_of_week: DAYS[d.getDay()],
    days_ago: Math.max(0, daysAgo),
  };
}

export function speedToPacePerKm(metersPerSecond: number): string {
  if (!metersPerSecond || metersPerSecond <= 0) return "N/A";
  const totalSecs = Math.round(1000 / metersPerSecond);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "0m 0s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

/** A lap as recorded by the watch (one per rep / recovery / warmup etc.). */
export interface LapLike {
  name?: string;
  distance: number; // meters
  moving_time: number; // seconds
  average_speed: number; // m/s
  average_heartrate?: number;
  max_heartrate?: number;
  lap_index?: number;
}

export interface LapAnalysis {
  count: number;
  looks_like_interval_workout: boolean;
  interval_summary: string | null;
  note: string;
  laps: Array<{
    lap: number;
    name?: string;
    distance_m: number;
    distance_km: number;
    duration: string;
    pace_per_km: string;
    avg_hr: number | null;
    max_hr: number | null;
  }>;
}

function formatDistanceLabel(meters: number): string {
  return meters % 1000 === 0 ? `${meters / 1000}km` : `${meters}m`;
}

/**
 * Analyze watch laps. For interval workouts this exposes true rep pace (e.g.
 * 600m reps) that 1km splits hide by averaging reps with recovery. Returns null
 * when there aren't enough laps to be meaningful (<= 1 lap).
 */
export function analyzeLaps(laps: LapLike[] | undefined): LapAnalysis | null {
  if (!laps || laps.length <= 1) return null;

  const detail = laps.map((l, i) => {
    const paceMin = l.average_speed > 0 ? 1000 / l.average_speed / 60 : 0;
    return {
      lap: l.lap_index ?? i + 1,
      name: l.name,
      distance_m: Math.round(l.distance),
      distance_km: +(l.distance / 1000).toFixed(2),
      duration: formatDuration(l.moving_time),
      pace_per_km: speedToPacePerKm(l.average_speed),
      avg_hr: l.average_heartrate ?? null,
      max_hr: l.max_heartrate ?? null,
      _paceMin: paceMin,
      _distance: l.distance,
      _time: l.moving_time,
      _speed: l.average_speed,
    };
  });

  // Interval heuristic: pace varies meaningfully and several laps aren't ~1km.
  const paces = detail.map((l) => l._paceMin).filter((p) => p > 0);
  const paceRange = paces.length ? Math.max(...paces) - Math.min(...paces) : 0;
  const nonKmLaps = detail.filter((l) => Math.abs(l.distance_m - 1000) > 150).length;
  const looksLikeIntervals = paceRange > 0.5 && nonKmLaps >= 2;

  // Build a quick summary like "6×600m @ 3:45/km". Work reps are the laps
  // faster than the run's average lap pace; group them by rounded distance.
  let intervalSummary: string | null = null;
  if (looksLikeIntervals && paces.length) {
    const avgPace = paces.reduce((a, b) => a + b, 0) / paces.length;
    const workLaps = detail.filter((l) => l._speed > 0 && l._paceMin < avgPace);

    const groups = new Map<number, { dist: number; time: number; count: number }>();
    for (const l of workLaps) {
      // Round to nearest 100m so 590m / 610m GPS noise lands in one bucket.
      const bucket = Math.round(l._distance / 100) * 100;
      const g = groups.get(bucket) ?? { dist: 0, time: 0, count: 0 };
      g.dist += l._distance;
      g.time += l._time;
      g.count += 1;
      groups.set(bucket, g);
    }

    const parts = [...groups.entries()]
      .filter(([, g]) => g.count >= 2)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([bucket, g]) => {
        const avgSpeed = g.time > 0 ? g.dist / g.time : 0;
        return `${g.count}×${formatDistanceLabel(bucket)} @ ${speedToPacePerKm(avgSpeed)}/km`;
      });

    if (parts.length) intervalSummary = parts.join(" + ");
  }

  return {
    count: detail.length,
    looks_like_interval_workout: looksLikeIntervals,
    interval_summary: intervalSummary,
    note: looksLikeIntervals
      ? "This looks like an interval workout — read the lap paces below for true rep pace (e.g. 600m reps). 1km splits average reps with recovery and understate rep pace."
      : "Per-lap breakdown. For interval workouts these laps reflect the real rep structure; 1km splits can hide rep pace.",
    laps: detail.map(({ _paceMin, _distance, _time, _speed, ...rest }) => rest),
  };
}

/** Classify effort based on pace relative to a threshold (min/km) */
export function classifyEffort(paceSecondsPerKm: number): string {
  if (paceSecondsPerKm > 390) return "easy";
  if (paceSecondsPerKm > 330) return "moderate";
  if (paceSecondsPerKm > 290) return "tempo";
  if (paceSecondsPerKm > 250) return "threshold";
  return "interval/race";
}

/** Classify heart rate zone (generic 5-zone model) */
export function classifyHRZone(hr: number, maxHR = 195): string {
  const pct = hr / maxHR;
  if (pct < 0.6) return "Zone 1 (Recovery)";
  if (pct < 0.7) return "Zone 2 (Easy/Aerobic)";
  if (pct < 0.8) return "Zone 3 (Tempo)";
  if (pct < 0.9) return "Zone 4 (Threshold)";
  return "Zone 5 (VO2max/Anaerobic)";
}
