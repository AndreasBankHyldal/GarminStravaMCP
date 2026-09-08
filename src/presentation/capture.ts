import { z } from "zod";
import { reportSchema, REPORT_META_KEY } from "./model.js";
import { activityReport, loadReport, raceReport, readinessReport, runReport, trendsReport, weeklyReport, zonesReport } from "./reports.js";

const nullableNumber = z.number().finite().nullable();
const date = z.object({ human: z.string() });
const lap = z.object({
  lap: z.number(), name: z.string().optional(), distance_m: z.number(), distance_km: z.number(),
  duration: z.string(), pace_per_km: z.string(), avg_hr: nullableNumber, max_hr: nullableNumber,
});
const laps = z.object({
  count: z.number(), looks_like_interval_workout: z.boolean(), interval_summary: z.string().nullable(),
  note: z.string(), laps: z.array(lap),
});
const activity = z.object({
  name: z.string(), date, distance_km: z.number(), avg_heartrate: nullableNumber,
  max_heartrate: nullableNumber, cadence_spm: nullableNumber, elevation_gain_m: z.number(),
  training_effect: nullableNumber, anaerobic_training_effect: nullableNumber, training_load: nullableNumber,
});
const run = z.object({
  source: z.string(),
  activity: activity.extend({ total_time: z.string(), avg_pace: z.string() }),
  laps: laps.optional(),
  interval_consistency: z.object({
    rep_count: z.number(), average_rep_distance_m: z.number(), average_rep_pace: z.string(),
    std_deviation_min: z.string(), rating: z.string(),
  }).optional(),
  hr_drift: z.object({
    first_half_avg: z.number(), second_half_avg: z.number(), drift_percent: z.string(), assessment: z.string(),
  }).optional(),
});
const details = activity.extend({
  id: z.number(), source: z.string(), type: z.string(),
  date: date.extend({ iso: z.string(), day_of_week: z.string(), days_ago: z.number() }),
  duration: z.string(), moving_duration: z.string(), moving_time_seconds: z.number(),
  pace_per_km: z.string(), effort_level: z.string().nullable(), hr_zone: z.string().nullable(),
  calories: nullableNumber, laps: laps.nullable(),
  split_summaries: z.array(z.object({
    type: z.string(), count: z.number(), distance_km: z.number(), duration: z.string(), pace_per_km: z.string(),
    avg_heartrate: nullableNumber, max_heartrate: nullableNumber, cadence_spm: nullableNumber,
  })),
});
const trends = z.object({
  period: z.string(), total_runs: z.number(), total_km: z.string(), volume_trend: z.string(),
  weekly_breakdown: z.array(z.object({
    week_of: z.string(), runs: z.number(), total_km: z.string(), avg_pace: z.string(), avg_heartrate: nullableNumber,
  })),
});
const zones = z.object({
  source: z.string(), profile_count: z.number(),
  profiles: z.array(z.object({
    sport: z.string(), training_method: z.string().nullable(), max_heart_rate_bpm: nullableNumber,
    resting_heart_rate_bpm: nullableNumber, lactate_threshold_heart_rate_bpm: nullableNumber,
    zones: z.array(z.object({
      zone: z.number(), label: z.string(), min_bpm: nullableNumber, max_bpm: nullableNumber,
    })),
  })),
});
const loadSnapshot = z.object({
  ctl: z.number(), atl: z.number(), tsb: z.number(), acute_chronic_ratio: z.number(), fatigue_risk: z.string(),
});
const load = z.object({
  days: z.number(), runs_analyzed: z.number(),
  model: z.object({
    current: loadSnapshot,
    daily_load: z.array(z.object({ date: z.string(), load: z.number(), ctl: z.number(), atl: z.number(), tsb: z.number() })),
  }),
});
const readiness = z.object({
  readiness_score: z.number(), recommendation: z.string(), confidence: z.string(),
  components: z.record(z.string(), z.object({ adjustment: z.number() })),
});
const week = z.object({ runs: z.number(), total_km: z.number(), avg_pace: z.string(), hard_sessions: z.number() });
const weekly = z.object({
  period: z.object({ start: z.string(), end_exclusive: z.string() }),
  this_week: week, previous_week: week, plan_adherence: z.string(), coach_notes: z.array(z.string()),
});
const race = z.object({
  race: z.object({
    distance_label: z.string(), goal_time: z.string(), goal_pace: z.string(),
    goal_source: z.string(), feasibility_assessment: z.string(),
  }),
  adjustments: z.object({ adjusted_time: z.string(), adjusted_pace: z.string() }).nullable(),
  pacing_strategy: z.string(),
  km_splits: z.array(z.object({ km: z.union([z.number(), z.string()]), target_pace: z.string(), phase: z.string(), notes: z.string() })),
  race_day_tips: z.array(z.string()),
});

const adapters = {
  analyze_run_performance: (data: unknown) => runReport(run.parse(data)),
  garmin_get_activity_details: (data: unknown) => activityReport(details.parse(data)),
  get_training_trends: (data: unknown) => trendsReport(trends.parse(data)),
  garmin_get_heart_rate_zones: (data: unknown) => zonesReport(zones.parse(data)),
  get_load_fatigue_model: (data: unknown) => loadReport(load.parse(data)),
  get_readiness_score: (data: unknown) => readinessReport(readiness.parse(data)),
  weekly_coach_brief: (data: unknown) => weeklyReport(weekly.parse(data)),
  race_day_strategy: (data: unknown) => raceReport(race.parse(data)),
};
export type ReportTool = keyof typeof adapters;
export const reportToolNames = Object.keys(adapters);

export function identifyReportTool(name: string): ReportTool | undefined {
  for (const key of Object.keys(adapters) as ReportTool[]) {
    if (name === key || name === `functions.${key}`) return key;
    // Accept MCP namespaces while rejecting lookalike names and unrelated tools.
    const prefix = name.slice(0, -key.length);
    if (name.endsWith(key) && /(?:^|[._-])garmin(?:[._-]+)$/.test(prefix)) return key;
  }
  return undefined;
}

export const capturedResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  isError: z.boolean().optional(),
  _meta: z.object({ [REPORT_META_KEY]: reportSchema }).optional(),
});
export const snapshotSchema = z.object({
  id: z.string().uuid(),
  toolName: z.string(),
  capturedAt: z.string().datetime(),
  result: capturedResultSchema,
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export function captureToolResult(toolName: ReportTool, text: string) {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error("Garmin returned non-JSON or truncated content; a dashboard cannot be created.");
  }
  // Some clients preserve the MCP content envelope instead of flattening its text.
  const envelope = z.object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    isError: z.boolean().optional(),
  }).safeParse(data);
  if (envelope.success) {
    if (envelope.data.isError) throw new Error("Garmin returned an error, not a fitness report.");
    const texts = envelope.data.content.filter(block => block.type === "text" && block.text !== undefined);
    if (texts.length !== 1) throw new Error("Expected one Garmin JSON report in the MCP result.");
    return capturePlainResult(toolName, texts[0].text!);
  }
  return resultWithReport(toolName, data, text);
}

function capturePlainResult(toolName: ReportTool, text: string) {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error("The Garmin result does not contain a complete JSON report.");
  }
  return resultWithReport(toolName, data, text);
}

function resultWithReport(toolName: ReportTool, data: unknown, text: string) {
  const report = adapters[toolName](data);
  return capturedResultSchema.parse({
    content: [{ type: "text", text }],
    _meta: { [REPORT_META_KEY]: reportSchema.parse(report) },
  });
}
