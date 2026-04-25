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
  const secondsPerKm = 1000 / metersPerSecond;
  const mins = Math.floor(secondsPerKm / 60);
  const secs = Math.round(secondsPerKm % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "0m 0s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
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
