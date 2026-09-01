import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import * as garminClient from "../garmin/client.js";
import { speedToPacePerKm } from "../utils.js";
import {
  classifyCompletedCyclePhase,
  daysBetween,
  estimateCycleContext,
  toDateKey,
} from "./cycle.js";
import {
  getGarminExtendedWellness,
  getGarminRecoverySnapshot,
  getGarminWeightKg,
  inspectSensitiveGarminDocument,
} from "./garmin.js";
import {
  buildNutritionTargets,
  buildTrainingContext,
  estimateEnergyAvailability,
  screenTrainingHealth,
} from "./guidance.js";
import {
  addCycleEvent,
  deleteCycleEvent,
  getCycleEvents,
  getPeriodStartDates,
  getWomenDailyLog,
  getWomenDailyLogs,
  getWomenHealthProfile,
  saveWomenDailyLog,
  saveWomenHealthProfile,
} from "./store.js";
import { CyclePhase, LIFE_STAGES, WomenDailyLog } from "./types.js";

type ComparablePhase = Exclude<CyclePhase, "unknown">;

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format");

const symptomSchema = z.object({
  name: z.string().min(1).max(80).describe("Symptom name, e.g. cramps, fatigue, dizziness"),
  severity: z.number().min(0).max(10).describe("Current severity from 0-10"),
});

export function registerWomenTools(server: McpServer): void {
  if (!config.women.toolsEnabled) return;

  server.tool(
    "women_set_health_profile",
    "Set the locally stored reproductive-life-stage context used by women's training tools. Sensitive data stays in the local SQLite database.",
    {
      life_stage: z.enum(LIFE_STAGES).describe(
        "Current context. Menstrual phase is disabled for contraception, pregnancy, postpartum, and postmenopause."
      ),
      contraception_type: z.string().max(120).nullable().optional().describe(
        "Optional contraception description. Avoid brand names if unnecessary."
      ),
      typical_cycle_length_days: z.number().int().min(15).max(90).nullable().optional(),
      typical_period_length_days: z.number().int().min(1).max(14).nullable().optional(),
    },
    async ({
      life_stage,
      contraception_type,
      typical_cycle_length_days,
      typical_period_length_days,
    }) => {
      try {
        const profile = saveWomenHealthProfile({
          life_stage,
          contraception_type:
            life_stage === "hormonal_contraception"
              ? contraception_type
              : null,
          typical_cycle_length_days,
          typical_period_length_days,
        });
        return jsonResult({
          success: true,
          profile,
          privacy:
            "Stored locally. Reproductive-health data is not sent to Garmin by this tool.",
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "women_log_daily_health",
    "Log a period event, symptoms, and subjective recovery locally. Current symptoms are weighted more heavily than estimated cycle phase.",
    {
      date: dateSchema.describe("Date being logged"),
      period_started: z.boolean().default(false),
      period_ended: z.boolean().default(false),
      positive_lh_test: z.boolean().default(false).describe(
        "Optional positive urinary LH test; it supports but does not confirm ovulation"
      ),
      period_flow: z
        .enum(["none", "spotting", "light", "moderate", "heavy", "very_heavy"])
        .nullable()
        .optional(),
      symptoms: z.array(symptomSchema).max(30).optional(),
      overall_symptom_severity: z.number().int().min(0).max(10).nullable().optional(),
      energy: z.number().int().min(1).max(5).nullable().optional(),
      fatigue: z.number().int().min(1).max(5).nullable().optional(),
      soreness: z.number().int().min(1).max(5).nullable().optional(),
      sleep_quality: z.number().int().min(1).max(5).nullable().optional(),
      stress: z.number().int().min(1).max(5).nullable().optional(),
      motivation: z.number().int().min(1).max(5).nullable().optional(),
      perceived_performance: z.number().int().min(1).max(5).nullable().optional(),
      session_rpe: z.number().min(0).max(10).nullable().optional(),
      notes: z.string().max(1000).nullable().optional(),
    },
    async ({
      date,
      period_started,
      period_ended,
      positive_lh_test,
      ...daily
    }) => {
      try {
        const dateKey = toDateKey(date);
        const events: string[] = [];
        if (period_started) {
          addCycleEvent({
            event_date: dateKey,
            event_type: "period_start",
            source: "user_input",
          });
          events.push("period_start");
        }
        if (period_ended) {
          addCycleEvent({
            event_date: dateKey,
            event_type: "period_end",
            source: "user_input",
          });
          events.push("period_end");
        }
        if (positive_lh_test) {
          addCycleEvent({
            event_date: dateKey,
            event_type: "positive_lh_test",
            source: "user_input",
          });
          events.push("positive_lh_test");
        }
        const log = saveWomenDailyLog({ date: dateKey, ...daily });
        return jsonResult({
          success: true,
          events_recorded: events,
          daily_log: log,
          provenance: "user_input",
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "women_delete_cycle_event",
    "Delete an incorrectly recorded local cycle event.",
    {
      date: dateSchema,
      event_type: z.enum(["period_start", "period_end", "positive_lh_test"]),
      source: z.enum(["user_input", "garmin_unofficial_api"]).optional(),
    },
    async ({ date, event_type, source }) => {
      try {
        const deleted = deleteCycleEvent(toDateKey(date), event_type, source);
        return jsonResult({ success: true, deleted });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "women_get_cycle_context",
    "Estimate cycle context probabilistically from confirmed period starts and optional LH tests. It never changes training solely because of phase and is not suitable for contraception.",
    {
      date: dateSchema.optional().describe("Target date; defaults to today"),
    },
    async ({ date }) => {
      try {
        const targetDate = date ?? today();
        const lhDates = getCycleEvents("positive_lh_test").map(
          (event) => event.event_date
        );
        const context = estimateCycleContext(
          getWomenHealthProfile(),
          getPeriodStartDates(),
          targetDate,
          lhDates
        );
        return jsonResult({
          ...context,
          evidence_note:
            "Systematic-review evidence finds only trivial average performance differences across menstrual phases; use personal symptoms and repeated observations.",
          not_for_contraception:
            "Calendar phase estimates must not be used to prevent or achieve pregnancy.",
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "garmin_get_recovery_snapshot",
    "Pull a transparent recovery snapshot from Garmin: sleep/need, HRV, resting HR, Body Battery change, training load/recovery, hydration, weight, VO2max, respiration, Pulse Ox, and available skin temperature.",
    {
      date: dateSchema.optional().describe("Date; defaults to today"),
    },
    async ({ date }) => {
      try {
        return jsonResult(await getGarminRecoverySnapshot(date ?? today()));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "garmin_get_extended_wellness",
    "Fetch Garmin's raw Body Battery and all-day stress documents without guessing undocumented field meanings.",
    {
      date: dateSchema.optional().describe("Date; defaults to today"),
    },
    async ({ date }) => {
      try {
        return jsonResult(await getGarminExtendedWellness(date ?? today()));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "women_get_training_context",
    "Estimate today's training context from symptoms, personal cycle records, and Garmin recovery data. Phase is informational and never creates a mandatory workout rule.",
    {
      date: dateSchema.optional().describe("Date; defaults to today"),
      planned_session: z.enum(["rest", "easy", "moderate", "hard", "race"]),
      use_garmin: z.boolean().default(true),
    },
    async ({ date, planned_session, use_garmin }) => {
      try {
        const dateKey = date ?? today();
        const profile = getWomenHealthProfile();
        if (
          profile?.life_stage === "pregnant" ||
          profile?.life_stage === "postpartum"
        ) {
          return jsonResult({
            status: "clinical_boundary",
            life_stage: profile.life_stage,
            planned_session,
            guidance:
              "Automated training adjustment is disabled. Use individualized guidance from an obstetric or qualified perinatal exercise professional.",
          });
        }
        const cycle = estimateCycleContext(
          profile,
          getPeriodStartDates(),
          dateKey,
          getCycleEvents("positive_lh_test").map((event) => event.event_date)
        );
        const dailyLog = getWomenDailyLog(dateKey);
        const garmin = use_garmin
          ? await getGarminRecoverySnapshot(dateKey)
          : null;
        const context = buildTrainingContext(
          cycle,
          dailyLog,
          garmin?.recovery ?? {},
          planned_session
        );
        return jsonResult({
          ...context,
          local_daily_log: dailyLog,
          garmin_snapshot: garmin,
          disclaimer:
            "Educational decision support only; not medical clearance or treatment.",
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "women_get_nutrition_targets",
    "Calculate evidence-based fueling and hydration ranges by training load and session demands. Menstrual phase does not change the macro targets.",
    {
      body_mass_kg: z.number().min(25).max(300).optional().describe(
        "Optional if a recent Garmin weight measurement is available"
      ),
      use_garmin_weight: z.boolean().default(true),
      date: dateSchema.optional().describe("Date for Garmin weight; defaults to today"),
      daily_training_load: z.enum(["light", "moderate", "high", "very_high"]),
      session_duration_minutes: z.number().min(0).max(1440),
      session_intensity: z.enum(["easy", "moderate", "hard", "race"]),
      hours_before_session: z.number().min(0).max(24).optional(),
      rapid_recovery_needed: z.boolean().default(false).describe(
        "Use only when the next demanding session is within about 8 hours"
      ),
      sweat_rate_liters_per_hour: z.number().min(0.1).max(5).optional(),
      hot_or_humid: z.boolean().default(false),
      low_energy_availability_concern: z.boolean().default(false),
    },
    async ({
      body_mass_kg,
      use_garmin_weight,
      date,
      ...input
    }) => {
      try {
        const dateKey = date ?? today();
        const profile = getWomenHealthProfile();
        if (
          profile?.life_stage === "pregnant" ||
          profile?.life_stage === "postpartum"
        ) {
          return jsonResult({
            status: "clinical_boundary",
            life_stage: profile.life_stage,
            guidance:
              "Automated nutrition targets are disabled. Use individualized guidance from a qualified perinatal clinician or sports dietitian.",
          });
        }
        const mass =
          body_mass_kg ??
          (use_garmin_weight ? await getGarminWeightKg(dateKey) : null);
        if (mass === null) {
          throw new Error(
            "Provide body_mass_kg or enable use_garmin_weight with an available Garmin measurement."
          );
        }
        return jsonResult({
          body_mass_kg: mass,
          body_mass_source: body_mass_kg ? "user_input" : "garmin_unofficial_api",
          ...buildNutritionTargets({
            body_mass_kg: mass,
            life_stage: profile?.life_stage,
            ...input,
          }),
          disclaimer:
            "Educational ranges, not an individualized medical nutrition prescription.",
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "women_estimate_energy_availability",
    "Estimate energy availability with an uncertainty range. This is educational, non-diagnostic, and is not IOC RED-S CAT2.",
    {
      age_years: z.number().int().min(13).max(100),
      energy_intake_kcal: z.number().min(500).max(15000),
      exercise_energy_expenditure_kcal: z.number().min(0).max(10000),
      fat_free_mass_kg: z.number().min(15).max(200),
      intake_uncertainty_percent: z.number().min(0).max(50).default(20),
      exercise_uncertainty_percent: z.number().min(0).max(50).default(20),
      fat_free_mass_uncertainty_percent: z.number().min(0).max(25).default(5),
    },
    async (input) => {
      try {
        const profile = getWomenHealthProfile();
        if (
          profile?.life_stage === "pregnant" ||
          profile?.life_stage === "postpartum"
        ) {
          return jsonResult({
            status: "clinical_boundary",
            life_stage: profile.life_stage,
            guidance:
              "Energy-availability interpretation is disabled during pregnancy/postpartum; use a qualified perinatal clinician or sports dietitian.",
          });
        }
        return jsonResult(estimateEnergyAvailability(input));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "women_screen_training_health",
    "Non-diagnostic educational screen for menstrual-health, iron, bone-stress, pregnancy, and low-energy-availability concerns. It is not RED-S CAT2 or medical clearance.",
    {
      age_years: z.number().int().min(13).max(100),
      life_stage: z.enum(LIFE_STAGES),
      has_started_menstruating: z.boolean().optional(),
      days_since_last_period: z.number().int().min(0).max(1000).optional(),
      cycle_lengths_days: z.array(z.number().int().min(10).max(120)).max(24).optional(),
      bleeding_days: z.number().int().min(0).max(60).optional(),
      changes_protection_every_two_hours_or_less: z.boolean().default(false),
      soaking_protection_hourly_for_two_hours: z.boolean().default(false),
      chest_pain_during_exercise: z.boolean().default(false),
      fainted_during_exercise: z.boolean().default(false),
      severe_pelvic_pain: z.boolean().default(false),
      pregnancy_possible: z.boolean().default(false),
      bleeding_during_known_or_possible_pregnancy: z.boolean().default(false),
      postmenopausal_bleeding: z.boolean().default(false),
      postcoital_or_intermenstrual_bleeding: z.boolean().default(false),
      bone_stress_injury_history: z.boolean().default(false),
      restrictive_eating_or_fear_of_weight_gain: z.boolean().default(false),
      rapid_or_unintentional_weight_loss: z.boolean().default(false),
      persistent_fatigue: z.boolean().default(false),
      breathlessness: z.boolean().default(false),
      palpitations: z.boolean().default(false),
      dizziness: z.boolean().default(false),
      recurrent_illness_or_injury: z.boolean().default(false),
      unexplained_performance_decline: z.boolean().default(false),
      vegetarian_or_vegan: z.boolean().default(false),
      high_endurance_volume: z.boolean().default(false),
    },
    async (input) => {
      try {
        return jsonResult(screenTrainingHealth(input));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "women_analyze_cycle_training_patterns",
    "Compare the athlete's own activity and symptom patterns across estimated phases in completed cycles. Requires repeated personal data and never assumes causation.",
    {
      sport_type: z.string().min(1).max(50).default("run"),
      max_activities: z.number().int().min(20).max(500).default(300),
    },
    async ({ sport_type, max_activities }) => {
      try {
        const periodStarts = getPeriodStartDates();
        if (periodStarts.length < 3) {
          return jsonResult({
            status: "insufficient_data",
            completed_cycles: Math.max(0, periodStarts.length - 1),
            requirement:
              "Record at least three period starts (two completed cycles) before comparing phase patterns.",
          });
        }
        const profile = getWomenHealthProfile();
        if (
          profile &&
          profile.life_stage !== "naturally_cycling" &&
          profile.life_stage !== "unknown"
        ) {
          return jsonResult({
            status: "not_applicable",
            life_stage: profile.life_stage,
            reason:
              "Natural cycle-phase comparison is disabled for this reproductive-life-stage context.",
          });
        }

        const startDate = periodStarts[0];
        const endDate = periodStarts[periodStarts.length - 1];
        const activities = await fetchActivitySamples(
          sport_type,
          max_activities,
          startDate,
          endDate
        );
        const logs = getWomenDailyLogs(startDate, endDate);
        const periodLength = profile?.typical_period_length_days ?? 5;
        const summaries = summarizePatterns(
          periodStarts,
          periodLength,
          activities,
          logs
        );
        return jsonResult({
          status: "descriptive_only",
          source: "garmin",
          sport_type,
          completed_cycles: periodStarts.length - 1,
          activities_analyzed: activities.length,
          phase_summaries: summaries,
          interpretation: [
            "Treat only repeated, personally consistent patterns as useful hypotheses.",
            "Different workout types, weather, terrain, sleep, and fueling can explain apparent phase differences.",
            "No phase causes a mandatory training change; current symptoms and recovery remain primary.",
          ],
          evidence:
            "Group-level performance differences across menstrual phases are trivial on average and underlying evidence quality is low.",
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  if (config.garmin.womenHealthEnabled) {
    registerSensitiveGarminWomenHealthTools(server);
  }
}

function registerSensitiveGarminWomenHealthTools(server: McpServer): void {
  server.tool(
    "garmin_get_menstrual_day",
    "Opt-in sensitive read: fetch Garmin's opaque menstrual day-view JSON through an unofficial endpoint. Response fields are not publicly documented.",
    {
      date: dateSchema,
      include_raw: z.boolean().default(true),
    },
    async ({ date, include_raw }) => {
      try {
        const raw = await garminClient.getMenstrualDataForDate(
          new Date(`${date}T12:00:00Z`)
        );
        return jsonResult(inspectSensitiveGarminDocument(raw, include_raw));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "garmin_get_menstrual_calendar",
    "Opt-in sensitive read: fetch Garmin's opaque menstrual calendar JSON through an unofficial endpoint. Candidate dates are unverified and are never auto-saved.",
    {
      start_date: dateSchema,
      end_date: dateSchema,
      include_raw: z.boolean().default(true),
    },
    async ({ start_date, end_date, include_raw }) => {
      try {
        const rangeDays = daysBetween(start_date, end_date);
        if (rangeDays < 0 || rangeDays > 366) {
          throw new Error("Date range must be between 0 and 366 days.");
        }
        const raw = await garminClient.getMenstrualCalendarData(
          new Date(`${start_date}T12:00:00Z`),
          new Date(`${end_date}T12:00:00Z`)
        );
        return jsonResult(inspectSensitiveGarminDocument(raw, include_raw));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "garmin_get_pregnancy_summary",
    "Opt-in sensitive read: fetch Garmin's opaque pregnancy snapshot through an unofficial endpoint. No training prescription is generated.",
    {
      include_raw: z.boolean().default(true),
    },
    async ({ include_raw }) => {
      try {
        const raw = await garminClient.getPregnancySummary();
        return jsonResult(inspectSensitiveGarminDocument(raw, include_raw));
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}

interface ActivitySample {
  date: string;
  distance_m: number;
  duration_s: number;
  avg_hr: number | null;
}

async function fetchActivitySamples(
  sportType: string,
  maxActivities: number,
  startDate: string,
  endDate: string
): Promise<ActivitySample[]> {
  const sport = sportType.toLowerCase();
  const activities = await garminClient.getAllActivities(maxActivities);
  return activities
    .filter((activity) => {
      const date = toDateKey(activity.startTimeLocal);
      return (
        date >= startDate &&
        date < endDate &&
        (activity.activityType?.typeKey ?? "").toLowerCase().includes(sport)
      );
    })
    .map((activity) => ({
      date: toDateKey(activity.startTimeLocal),
      distance_m: activity.distance ?? 0,
      duration_s: activity.movingDuration ?? activity.duration ?? 0,
      avg_hr: activity.averageHR ?? null,
    }));
}

function summarizePatterns(
  periodStarts: string[],
  periodLength: number,
  activities: ActivitySample[],
  logs: WomenDailyLog[]
) {
  const phases: ComparablePhase[] = [
    "menstruation",
    "follicular",
    "periovulatory",
    "luteal",
  ];
  const activityGroups = Object.fromEntries(
    phases.map((phase) => [phase, [] as ActivitySample[]])
  ) as Record<ComparablePhase, ActivitySample[]>;
  const logGroups = Object.fromEntries(
    phases.map((phase) => [phase, [] as WomenDailyLog[]])
  ) as Record<ComparablePhase, WomenDailyLog[]>;

  for (const activity of activities) {
    const phase = phaseForCompletedCycle(
      activity.date,
      periodStarts,
      periodLength
    );
    if (phase !== "unknown") activityGroups[phase].push(activity);
  }
  for (const log of logs) {
    const phase = phaseForCompletedCycle(log.date, periodStarts, periodLength);
    if (phase !== "unknown") logGroups[phase].push(log);
  }

  return Object.fromEntries(
    phases.map((phase) => {
      const group = activityGroups[phase];
      const phaseLogs = logGroups[phase];
      const totalDistance = sum(group.map((item) => item.distance_m));
      const totalDuration = sum(group.map((item) => item.duration_s));
      const speed = totalDuration > 0 ? totalDistance / totalDuration : 0;
      return [
        phase,
        {
          activity_count: group.length,
          enough_activity_data: group.length >= 3,
          total_distance_km: round(totalDistance / 1000, 1),
          average_session_minutes:
            group.length > 0 ? round(totalDuration / group.length / 60, 1) : null,
          aggregate_pace_per_km: speed > 0 ? speedToPacePerKm(speed) : null,
          aggregate_speed_kmh: speed > 0 ? round(speed * 3.6, 1) : null,
          average_heart_rate: average(
            group
              .map((item) => item.avg_hr)
              .filter((value): value is number => value !== null)
          ),
          logged_days: phaseLogs.length,
          average_symptom_severity: average(
            phaseLogs
              .map((log) => log.overall_symptom_severity)
              .filter((value): value is number => value != null)
          ),
          average_energy: average(
            phaseLogs
              .map((log) => log.energy)
              .filter((value): value is number => value != null)
          ),
          average_perceived_performance: average(
            phaseLogs
              .map((log) => log.perceived_performance)
              .filter((value): value is number => value != null)
          ),
        },
      ];
    })
  );
}

function phaseForCompletedCycle(
  date: string,
  periodStarts: string[],
  periodLength: number
): CyclePhase {
  for (let index = 0; index < periodStarts.length - 1; index++) {
    if (date >= periodStarts[index] && date < periodStarts[index + 1]) {
      return classifyCompletedCyclePhase(
        date,
        periodStarts[index],
        periodStarts[index + 1],
        periodLength
      );
    }
  }
  return "unknown";
}

function average(values: number[]): number | null {
  return values.length ? round(sum(values) / values.length, 1) : null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function today(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}
