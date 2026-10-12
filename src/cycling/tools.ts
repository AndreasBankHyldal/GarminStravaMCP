import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import * as garminClient from "../garmin/client.js";
import { reportResult, reportToolMeta } from "../presentation/resource.js";
import { cyclingEventReport, cyclingFitnessReport, cyclingTrendsReport, powerProfileReport, rideReport } from "../presentation/cycling.js";
import {
  analyzeGarminRide, buildCyclingEventStrategy, buildCyclingFitness, buildCyclingTrends, buildPowerProfile,
  CYCLING_EVENT_TYPES, resolveCyclingHeartRateProfile, type CyclingApi,
} from "./analysis.js";

function errorResult(error: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  };
}

const ftpInput = z.number().int().min(50).max(700).optional()
  .describe("FTP in watts. Overrides the FTP stored in Garmin Connect.");
const weightInput = z.number().min(30).max(200).optional()
  .describe("Rider weight in kg for W/kg. Defaults to the weight in Garmin Connect.");

type WorkoutClient = Pick<typeof garminClient, "addStructuredWorkout" | "getCyclingFtp">;

export function registerCyclingTools(
  server: McpServer,
  api: CyclingApi = garminClient,
  workoutClient: WorkoutClient = garminClient
): void {
  async function tssContext() {
    const [ftp, hr] = await Promise.all([api.getCyclingFtp().catch(() => null), resolveCyclingHeartRateProfile(api)]);
    return { ftp, thresholdHr: hr.thresholdHr, thresholdEstimated: hr.thresholdEstimated };
  }

  registerAppTool(
    server,
    "analyze_ride_performance",
    {
      description: "Complete all-in-one tool for bike ride / cycling analysis (road, gravel, MTB, indoor trainer, virtual). Pass the Garmin activity_id of a ride; if unknown, find it with garmin_get_activities or garmin_search_activities (activity_type 'cycling' matches every ride type). Returns speed, distance, moving/elapsed time, elevation, power (average, max, normalized power, variability index, intensity factor, TSS, kJ, W/kg), a within-ride power curve, time in Coggan power zones and Garmin cycling HR zones, cadence distribution and coasting, power:HR decoupling/efficiency factor, distance segments (default 5 km), detected climbs with grade/VAM/power, recorded laps and explicit data-quality caveats. Includes one interactive ride dashboard.",
      inputSchema: {
        activity_id: z.number().int().positive().describe("Garmin activity ID of the ride"),
        segment_km: z.number().min(1).max(50).default(5).describe("Distance segment length in km (indoor rides without distance use 10-minute segments)"),
        ftp_watts: ftpInput,
        weight_kg: weightInput,
      },
      _meta: reportToolMeta,
    },
    async ({ activity_id, segment_km, ftp_watts, weight_kg }) => {
      try {
        const analysis = await analyzeGarminRide(activity_id, { segment_km, ftp_watts, weight_kg }, api);
        return reportResult(analysis, rideReport(analysis));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  registerAppTool(
    server,
    "get_cycling_power_profile",
    {
      description: "Cycling power profile: best power for 5 s to 60 min across recent rides (watts, W/kg, % FTP and the ride it came from), Garmin FTP versus a 20-minute FTP estimate, W/kg and Coggan power zones. Use for FTP, power zones, power curve or rider-strength questions. Includes an interactive power-curve dashboard.",
      inputSchema: {
        days: z.number().int().min(7).max(365).default(90).describe("Look-back period in days"),
        max_activities: z.number().int().min(20).max(500).default(300).describe("Max Garmin activities to scan"),
        max_stream_rides: z.number().int().min(0).max(20).default(6).describe("Max rides whose second-by-second data is downloaded when Garmin lacks best-effort fields"),
        ftp_watts: ftpInput,
        weight_kg: weightInput,
      },
      _meta: reportToolMeta,
    },
    async (input) => {
      try {
        const profile = await buildPowerProfile(input, api);
        return reportResult(profile, powerProfileReport(profile));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  registerAppTool(
    server,
    "get_cycling_trends",
    {
      description: "Weekly cycling trends: rides, hours, distance, elevation, TSS, average power, heart rate and outdoor speed per week, with a volume trend. Use for cycling volume/progress questions (get_training_trends only covers runs). Includes interactive weekly charts.",
      inputSchema: { weeks: z.number().int().min(1).max(52).default(8).describe("Number of weeks to analyze") },
      _meta: reportToolMeta,
    },
    async ({ weeks }) => {
      try {
        const [history, ctx] = await Promise.all([api.getAllActivities(500), tssContext()]);
        const trends = buildCyclingTrends(history, weeks, ctx);
        return reportResult(trends, cyclingTrendsReport(trends));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  registerAppTool(
    server,
    "get_cycling_fitness_model",
    {
      description: "TSS-based cycling performance-management model: daily TSS, fitness (CTL, 42-day), fatigue (ATL, 7-day), form (TSB) and CTL ramp rate. TSS comes from Garmin, power with FTP, heart rate relative to threshold, or a labelled duration estimate. Includes interactive fitness/fatigue/form charts.",
      inputSchema: { days: z.number().int().min(42).max(365).default(120).describe("Days of history to model (6+ weeks needed for stable CTL)") },
      _meta: reportToolMeta,
    },
    async ({ days }) => {
      try {
        const [history, ctx] = await Promise.all([api.getAllActivities(500), tssContext()]);
        const model = buildCyclingFitness(history, days, ctx);
        return reportResult(model, cyclingFitnessReport(model));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  registerAppTool(
    server,
    "cycling_event_strategy",
    {
      description: "Pacing and fueling plan for a cycling event (time trial, criterium, road race, gran fondo/sportive, ultra-endurance). Uses FTP (Garmin, override or 20-minute estimate) to set normalized-power and intensity-factor bands, climb power ceiling, HR ceiling, phase targets, estimated duration from recent comparable rides, energy use and hourly carbohydrate/fluid/sodium targets. Includes an interactive strategy dashboard.",
      inputSchema: {
        distance_km: z.number().positive().max(2000).describe("Event distance in km"),
        event_type: z.enum(CYCLING_EVENT_TYPES).default("gran_fondo").describe("Event type"),
        elevation_gain_m: z.number().min(0).max(30000).optional().describe("Total elevation gain in metres"),
        goal_duration_hours: z.number().positive().max(72).optional().describe("Expected or goal duration in hours; otherwise estimated from recent rides"),
        temperature_c: z.number().min(-20).max(50).optional().describe("Expected temperature in °C"),
        ftp_watts: ftpInput,
        weight_kg: weightInput,
      },
      _meta: reportToolMeta,
    },
    async (input) => {
      try {
        const strategy = await buildCyclingEventStrategy(input, api);
        return reportResult(strategy, cyclingEventReport(strategy));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  const target = z.object({
    type: z.enum(["power", "power_percent_ftp", "heart_rate", "cadence"])
      .describe("power = watts, power_percent_ftp = % of FTP (converted to watts), heart_rate = bpm, cadence = rpm"),
    low: z.number().positive().describe("Lower bound"),
    high: z.number().positive().describe("Upper bound"),
  });

  server.tool(
    "garmin_add_cycling_workout",
    `Create a structured cycling workout on Garmin Connect (bike computer or watch) with warmup, intervals, recovery and cooldown steps targeting power (watts or % FTP), heart rate or cadence. Use garmin_schedule_workout afterwards to put it on the calendar.

Example sweet-spot workout:
  [{"type":"warmup","duration_seconds":600,"target":{"type":"power_percent_ftp","low":50,"high":65}},
   {"type":"interval","duration_seconds":720,"repeat":3,"target":{"type":"power_percent_ftp","low":88,"high":94},"description":"Sweet spot"},
   {"type":"recovery","duration_seconds":300,"target":{"type":"power_percent_ftp","low":45,"high":55}},
   {"type":"cooldown","duration_seconds":600}]`,
    {
      name: z.string().min(1).describe("Workout name (e.g. '3x12 min sweet spot')"),
      description: z.string().default("").describe("Workout description/notes"),
      ftp_watts: ftpInput,
      steps: z.array(z.object({
        type: z.enum(["warmup", "cooldown", "interval", "recovery", "rest"]).describe("Step type"),
        duration_seconds: z.number().positive().optional().describe("Step duration in seconds"),
        distance_meters: z.number().positive().optional().describe("Step distance in meters (alternative to duration)"),
        description: z.string().optional().describe("Step description shown on the device"),
        repeat: z.number().int().min(2).optional().describe("Repeat this step + the following recovery/rest step N times"),
        target: target.optional().describe("Optional target range"),
      })).min(1).describe("Workout steps; omit duration and distance for a lap-button step"),
    },
    async ({ name, description, ftp_watts, steps }) => {
      try {
        const needsFtp = steps.some(step => step.target?.type === "power_percent_ftp");
        const ftp = needsFtp ? ftp_watts ?? await workoutClient.getCyclingFtp().catch(() => null) : null;
        if (needsFtp && !ftp) {
          throw new Error("power_percent_ftp targets need an FTP: pass ftp_watts or set FTP in Garmin Connect.");
        }
        const converted = steps.map(step => {
          if (!step.target) return { ...step, target: undefined };
          const percent = step.target.type === "power_percent_ftp";
          return {
            ...step,
            target: {
              type: percent ? "power" as const : step.target.type as "power" | "heart_rate" | "cadence",
              low: percent ? ftp! * step.target.low / 100 : step.target.low,
              high: percent ? ftp! * step.target.high / 100 : step.target.high,
            },
          };
        });
        const payload = garminClient.buildCyclingWorkout(name, description, converted);
        const result = await workoutClient.addStructuredWorkout(payload);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              workout_id: result?.workoutId ?? result?.id ?? null,
              ftp_used_w: ftp,
              message: `Cycling workout "${name}" with ${steps.length} steps created on Garmin Connect. Schedule it with garmin_schedule_workout to sync it to your device.`,
              steps: converted.map(step => ({
                type: step.type, duration_seconds: step.duration_seconds ?? null, distance_meters: step.distance_meters ?? null,
                repeat: step.repeat ?? null,
                target: step.target ? { type: step.target.type, low: Math.round(step.target.low), high: Math.round(step.target.high) } : null,
              })),
            }, null, 2),
          }],
        };
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
