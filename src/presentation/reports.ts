import type { formatGarminActivityDetails } from "../garmin/format.js";
import type { LapAnalysis } from "../utils.js";
import type { Chart, Color, Metric, Point, Report } from "./model.js";

const unavailable = "Unavailable";
const zoneColors: Color[] = ["blue", "green", "amber", "orange", "red"];

function metric(label: string, value: string | number | null | undefined, color: Color = "blue", detail?: string): Metric {
  return { label, value: value == null || value === "N/A" || (typeof value === "number" && !Number.isFinite(value)) ? unavailable : String(value), color, detail };
}

function number(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: number | null | undefined): number | null {
  return value != null && value > 0 && Number.isFinite(value) ? value : null;
}

export function paceSeconds(pace: string): number | null {
  const match = /^(\d+):(\d{2})(?:\s*\/km)?$/.exec(pace.trim());
  if (!match) return null;
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  return seconds > 0 ? seconds : null;
}

function chart(id: string, title: string, unit: string, points: Point[], color: Color = "blue", kind: Chart["kind"] = "bar", description = ""): Chart {
  return { id, title, description, kind, unit, format: "number", series: [{ label: title, color, points }] };
}

function report(title: string, subtitle: string, metrics: Metric[], charts: Chart[], notes: string[] = []): Report {
  return { version: 1, title, subtitle, metrics, sections: [{ id: "overview", label: "Overview", metrics: [], charts, notes }] };
}

export interface RunReportData {
  source: string;
  activity: {
    name: string;
    date: { human: string };
    distance_km: number;
    total_time: string;
    avg_pace: string;
    avg_heartrate: number | null;
    max_heartrate: number | null;
    cadence_spm: number | null;
    elevation_gain_m: number;
    training_effect: number | null;
    anaerobic_training_effect: number | null;
    training_load: number | null;
  };
  laps?: LapAnalysis;
  split_summaries?: ReturnType<typeof formatGarminActivityDetails>["split_summaries"];
  interval_consistency?: { rep_count: number; average_rep_distance_m: number; average_rep_pace: string; std_deviation_min: string; rating: string };
  hr_drift?: { first_half_avg: number; second_half_avg: number; drift_percent: string; assessment: string };
  elevation?: { min_m: number; max_m: number; total_gain: number };
}

export function runReport(data: RunReportData): Report {
  const activity = data.activity;
  const laps = data.laps?.laps ?? [];
  const lapLabel = (lap: typeof laps[number]) => `Lap ${lap.lap}${lap.name ? ` - ${lap.name}` : ""} (${lap.distance_m} m)`;
  const lapColor = (name?: string): Color => name === "RECOVERY" ? "green" : name === "WARMUP" || name === "COOLDOWN" ? "amber" : "blue";
  const pace = chart("lap-pace", "Pace by lap", "min/km", laps.map(lap => ({
    label: lapLabel(lap), value: paceSeconds(lap.pace_per_km), color: lapColor(lap.name),
  })), "blue", "bar", "Lower is faster. Warmup and recovery remain separate from work reps; these are recorded laps, not necessarily kilometre splits.");
  pace.format = "pace";
  const charts = [
    pace,
    chart("lap-hr", "Heart rate by lap", "bpm", laps.map(lap => ({ label: lapLabel(lap), value: positive(lap.avg_hr) })), "red", "line", "Average heart rate for each recorded lap. Missing readings are gaps, not zero."),
  ];
  const notes: string[] = [];
  if (data.laps?.interval_summary) notes.push(data.laps.interval_summary);
  if (!laps.length) notes.push("Lap charts are unavailable: Garmin did not provide a multi-lap breakdown.");
  if (data.interval_consistency) notes.push(`Work-rep consistency: ${data.interval_consistency.rating} across ${data.interval_consistency.rep_count} reps.`);
  if (data.hr_drift) {
    charts.push(chart("hr-drift", "Heart-rate drift", "bpm", [
      { label: "First half", value: data.hr_drift.first_half_avg },
      { label: "Second half", value: data.hr_drift.second_half_avg },
    ], "red", "bar", `${data.hr_drift.drift_percent}% change between halves. Changes in pace, terrain, and interval structure can also affect this comparison.`));
  }
  return report(activity.name, activity.date.human, [
    metric("Distance", activity.distance_km, "blue", "km"),
    metric("Moving time", activity.total_time),
    metric("Average pace", activity.avg_pace, "green", "min/km"),
    metric("Average heart rate", positive(activity.avg_heartrate), "red", "bpm"),
    metric("Elevation gain", activity.elevation_gain_m, "purple", "m"),
    metric("Training effect", activity.training_effect, "amber", "Garmin aerobic effect"),
  ], charts, notes);
}

export function activityReport(data: Omit<RunReportData["activity"], "total_time" | "avg_pace"> & {
  source: string;
  moving_duration: string;
  pace_per_km: string;
  laps: LapAnalysis | null;
}): Report {
  return runReport({
    source: data.source,
    activity: { ...data, total_time: data.moving_duration, avg_pace: data.pace_per_km },
    laps: data.laps ?? undefined,
  });
}

interface TrainingTrends {
  period: string;
  total_runs: number;
  total_km: string;
  volume_trend: string;
  weekly_breakdown: { week_of: string; runs: number; total_km: string; avg_pace: string; avg_heartrate: number | null }[];
}

export function trendsReport(data: TrainingTrends): Report {
  const weeks = data.weekly_breakdown;
  const pace = chart("weekly-pace", "Average running pace", "min/km", weeks.map(week => ({
    label: week.week_of, value: paceSeconds(week.avg_pace),
  })), "green", "line", "Lower is faster. Weekly aggregate pace also reflects terrain and workout mix, not just fitness.");
  pace.format = "pace";
  return report("Training trends", data.period, [
    metric("Running distance", data.total_km, "blue", "km"),
    metric("Runs", data.total_runs, "green"),
    metric("Volume trend", data.volume_trend, "purple"),
  ], [
    chart("weekly-volume", "Weekly running distance", "km", weeks.map(week => ({
      label: week.week_of, value: number(week.total_km),
    })), "blue", "bar", "Weeks start on Monday. The first and current weeks may be partial."),
    pace,
    chart("weekly-hr", "Average running heart rate", "bpm", weeks.map(week => ({
      label: week.week_of, value: positive(week.avg_heartrate),
    })), "red", "line", "Average of recorded run heart rates. Weeks without heart-rate readings remain unavailable."),
  ], [
    "Based on the fetched Garmin activity history (up to 500 activities). A zero-activity week means no records were returned, not proof of rest.",
    "Compare complete weeks before interpreting volume changes.",
  ]);
}

export function zonesReport(data: {
  profile_count: number;
  profiles: {
    sport: string;
    training_method: string | null;
    max_heart_rate_bpm: number | null;
    resting_heart_rate_bpm: number | null;
    lactate_threshold_heart_rate_bpm: number | null;
    zones: { zone: number; label: string; min_bpm: number | null; max_bpm: number | null }[];
  }[];
}): Report {
  return {
    version: 1,
    title: "Heart-rate zones",
    subtitle: "Your configured Garmin ranges, grouped by sport",
    metrics: [metric("Sport profiles", data.profile_count, "purple")],
    sections: data.profiles.map((profile, index) => ({
      id: `profile-${index}`,
      label: profile.sport,
      metrics: [
        metric("Maximum HR", profile.max_heart_rate_bpm, "red", "bpm"),
        metric("Resting HR", profile.resting_heart_rate_bpm, "blue", "bpm"),
        metric("Lactate threshold", profile.lactate_threshold_heart_rate_bpm, "orange", "bpm"),
        metric("Training method", profile.training_method, "purple"),
      ],
      charts: [chart("zones", "Configured zone ranges", "bpm", profile.zones.map((zone, i) => {
        const valid = zone.min_bpm != null && zone.max_bpm != null && zone.min_bpm > 0 && zone.max_bpm >= zone.min_bpm;
        return { label: `Z${zone.zone} - ${zone.label}`, low: valid ? zone.min_bpm : null, value: valid ? zone.max_bpm : null, color: zoneColors[i] };
      }), "blue", "range", "Blue Z1 / green Z2 / amber Z3 / orange Z4 / red Z5. All ranges use the same BPM scale.")],
      notes: [
        "These are configured BPM boundaries, not measured time in zones. Zone names are descriptive labels, not individualized physiological thresholds.",
        ...(profile.zones.some(zone => zone.min_bpm == null || zone.max_bpm == null || zone.max_bpm < zone.min_bpm) ? ["Some zone boundaries are missing or inconsistent in Garmin and cannot be plotted. See the raw JSON for the supplied values."] : []),
      ],
    })),
  };
}

interface LoadSnapshot {
  ctl: number;
  atl: number;
  tsb: number;
  acute_chronic_ratio: number;
  fatigue_risk: string;
}

export function loadReport(data: {
  days: number;
  runs_analyzed: number;
  model: { current: LoadSnapshot; daily_load: { date: string; load: number; ctl: number; atl: number; tsb: number }[] };
}): Report {
  const { current, daily_load: days } = data.model;
  const load = chart("load-history", "Fitness and fatigue", "load units", [], "blue", "line", "CTL is the slower 42-day estimate; ATL is the faster 7-day estimate. Showing the most recent 21 days of the model.");
  load.series = [
    { label: "Fitness (CTL)", color: "blue", points: days.map(day => ({ label: day.date, value: number(day.ctl) })) },
    { label: "Fatigue (ATL)", color: "orange", points: days.map(day => ({ label: day.date, value: number(day.atl) })) },
  ];
  return report("Training load & balance", `${data.days}-day model / ${data.runs_analyzed} runs`, [
    metric("Fitness (CTL)", current.ctl),
    metric("Fatigue (ATL)", current.atl, "orange"),
    metric("Balance (TSB)", current.tsb, "purple"),
    metric("Load ratio", current.acute_chronic_ratio, "amber", current.fatigue_risk),
  ], [
    load,
    chart("balance-history", "Training balance", "load units", days.map(day => ({
      label: day.date, value: number(day.tsb),
    })), "purple", "bar", "TSB = CTL - ATL. Negative values mean recent load is higher than the longer-term estimate."),
  ], ["This is a heuristic training-load model, not Garmin's proprietary load score or a diagnosis of injury risk."]);
}

export function readinessReport(data: {
  readiness_score: number;
  recommendation: string;
  confidence: string;
  components: Record<string, { adjustment: number }>;
}): Report {
  return report("Daily readiness", "Recovery signals & recent training load", [
    metric("Readiness", data.readiness_score, "blue", "out of 100"),
    metric("Confidence", data.confidence, "purple"),
    metric("Recommendation", data.recommendation.replaceAll("_", " "), data.readiness_score >= 78 ? "green" : data.readiness_score >= 62 ? "amber" : "orange"),
  ], [chart("readiness-components", "What moved the score", "score points",
    Object.entries(data.components).map(([label, component]) => ({
      label: label.replaceAll("_", " "), value: number(component.adjustment), color: component.adjustment < 0 ? "orange" : "green",
    })), "blue", "bar", "Adjustments to a starting score of 70; the final result is capped to 0-100. Missing signals do not contribute.")],
  ["This score is a heuristic, not medical clearance or Garmin Training Readiness. Missing recovery metrics reduce confidence; use symptoms and how you feel alongside it."]);
}

interface WeekSummary {
  runs: number;
  total_km: number;
  avg_pace: string;
  hard_sessions: number;
}

export function weeklyReport(data: {
  period: { start: string; end_exclusive: string };
  this_week: WeekSummary;
  previous_week: WeekSummary;
  plan_adherence: string;
  coach_notes: string[];
}): Report {
  return report("Weekly coaching brief", `${data.period.start} to ${data.period.end_exclusive} (end exclusive)`, [
    metric("Running distance", data.this_week.total_km, "blue", "km"),
    metric("Runs", data.this_week.runs, "green"),
    metric("Quality sessions", data.this_week.hard_sessions, "orange"),
    metric("Plan adherence", data.plan_adherence, "purple"),
  ], [chart("weekly-comparison", "Running volume comparison", "km", [
    { label: "Previous week", value: number(data.previous_week.total_km), color: "purple" },
    { label: "Selected week", value: number(data.this_week.total_km), color: "blue" },
  ], "blue", "bar", "A current week is incomplete; compare like-for-like periods before increasing training.")], data.coach_notes);
}

export function raceReport(data: {
  race: { distance_label: string; goal_time: string; goal_pace: string; goal_source: string; feasibility_assessment: string };
  adjustments: { adjusted_time: string; adjusted_pace: string } | null;
  pacing_strategy: string;
  km_splits: { km: number | string; target_pace: string; phase: string; notes: string }[];
  race_day_tips: string[];
}): Report {
  const splits = chart("race-splits", "Target pace by kilometre", "min/km",
    data.km_splits.map(split => ({
      label: `km ${split.km} - ${split.phase}`,
      value: paceSeconds(split.target_pace),
      color: split.phase.includes("Start") ? "green" : split.phase.includes("Build") ? "blue" : split.phase.includes("Sustain") ? "amber" : split.phase.includes("Push") ? "orange" : "red",
    })), "blue", "bar", "Planned pace, not a prediction of actual splits. Lower is faster. Partial final kilometres retain their distance label.");
  splits.format = "pace";
  return report(`${data.race.distance_label} race strategy`, data.pacing_strategy, [
    metric("Goal time", data.race.goal_time),
    metric("Goal pace", data.race.goal_pace, "green"),
    ...(data.adjustments ? [
      metric("Adjusted time", data.adjustments.adjusted_time, "orange"),
      metric("Adjusted pace", data.adjustments.adjusted_pace, "amber"),
    ] : []),
  ], [splits], [data.race.goal_source, data.race.feasibility_assessment, ...data.race_day_tips]);
}
