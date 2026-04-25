import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as garminClient from "./client.js";

function speedToPacePerKm(metersPerSecond: number): string {
  if (!metersPerSecond || metersPerSecond <= 0) return "N/A";
  const secondsPerKm = 1000 / metersPerSecond;
  const mins = Math.floor(secondsPerKm / 60);
  const secs = Math.round(secondsPerKm % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

function formatGarminActivity(a: garminClient.GarminActivity) {
  return {
    id: a.activityId,
    name: a.activityName,
    type: a.activityType?.typeKey ?? "unknown",
    date: a.startTimeLocal,
    distance_km: a.distance ? (a.distance / 1000).toFixed(2) : "0",
    duration: formatDuration(a.duration ?? 0),
    moving_duration: formatDuration(a.movingDuration ?? 0),
    pace_per_km: speedToPacePerKm(a.averageSpeed),
    elevation_gain_m: a.elevationGain ?? 0,
    avg_heartrate: a.averageHR ?? null,
    max_heartrate: a.maxHR ?? null,
    calories: a.calories ?? null,
    cadence_spm: a.averageRunningCadenceInStepsPerMinute ?? null,
    vo2max: a.vO2MaxValue ?? null,
  };
}

export function registerGarminTools(server: McpServer): void {
  server.tool(
    "garmin_get_activities",
    "Fetch recent activities from Garmin Connect.",
    {
      count: z.number().min(1).max(100).default(20).describe("Number of activities to fetch"),
      offset: z.number().min(0).default(0).describe("Offset for pagination"),
    },
    async ({ count, offset }) => {
      try {
        const activities = await garminClient.getActivities(offset, count);
        const formatted = activities.map(formatGarminActivity);
        return {
          content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "garmin_get_activity_details",
    "Get detailed data for a specific Garmin activity.",
    {
      activity_id: z.number().describe("The Garmin activity ID"),
    },
    async ({ activity_id }) => {
      try {
        const activity = await garminClient.getActivityDetails(activity_id);
        const formatted = formatGarminActivity(activity);
        return {
          content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "garmin_get_fitness_stats",
    "Get fitness stats from Garmin: user profile, settings, and recent activity summary.",
    {},
    async () => {
      try {
        const [profile, settings] = await Promise.all([
          garminClient.getUserProfile(),
          garminClient.getUserSettings(),
        ]);

        const recentActivities = await garminClient.getActivities(0, 5);
        const formatted = {
          profile: {
            displayName: profile?.displayName,
            profileImageUrl: profile?.profileImageUrlLarge,
          },
          settings: {
            weight_kg: settings?.userData?.weight ? settings.userData.weight / 1000 : null,
            height_cm: settings?.userData?.height,
            birthDate: settings?.userData?.birthDate,
            vo2max: settings?.userData?.vo2Max,
          },
          recent_activities_summary: recentActivities.slice(0, 5).map(formatGarminActivity),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "garmin_get_heart_rate",
    "Get heart rate data from Garmin for a specific date.",
    {
      date: z.string().optional().describe("Date in ISO 8601 format (defaults to today)"),
    },
    async ({ date }) => {
      try {
        const d = date ? new Date(date) : undefined;
        const hr = await garminClient.getHeartRate(d);
        return {
          content: [{ type: "text", text: JSON.stringify(hr, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "garmin_get_sleep",
    "Get sleep data from Garmin for a specific date.",
    {
      date: z.string().optional().describe("Date in ISO 8601 format (defaults to today)"),
    },
    async ({ date }) => {
      try {
        const d = date ? new Date(date) : undefined;
        const sleep = await garminClient.getSleepData(d);
        return {
          content: [{ type: "text", text: JSON.stringify(sleep, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "garmin_get_steps",
    "Get step count from Garmin for a specific date.",
    {
      date: z.string().optional().describe("Date in ISO 8601 format (defaults to today)"),
    },
    async ({ date }) => {
      try {
        const d = date ? new Date(date) : undefined;
        const steps = await garminClient.getSteps(d);
        return {
          content: [{ type: "text", text: JSON.stringify({ date: date ?? "today", steps }, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
