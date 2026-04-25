import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as stravaClient from "./client.js";

function speedToPacePerKm(metersPerSecond: number): string {
  if (metersPerSecond <= 0) return "N/A";
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

function formatActivity(a: stravaClient.StravaActivity) {
  return {
    id: a.id,
    name: a.name,
    type: a.sport_type || a.type,
    date: a.start_date_local,
    distance_km: (a.distance / 1000).toFixed(2),
    duration: formatDuration(a.moving_time),
    pace_per_km: speedToPacePerKm(a.average_speed),
    elevation_gain_m: a.total_elevation_gain,
    avg_heartrate: a.average_heartrate ?? null,
    max_heartrate: a.max_heartrate ?? null,
    calories: a.calories ?? null,
  };
}

export function registerStravaTools(server: McpServer): void {
  server.tool(
    "strava_get_activities",
    "Fetch recent activities from Strava. Returns a list of activities with distance, pace, heart rate, etc.",
    {
      count: z.number().min(1).max(100).default(20).describe("Number of activities to fetch"),
      after: z.string().optional().describe("Only activities after this date (ISO 8601)"),
      before: z.string().optional().describe("Only activities before this date (ISO 8601)"),
    },
    async ({ count, after, before }) => {
      try {
        const afterTs = after ? Math.floor(new Date(after).getTime() / 1000) : undefined;
        const beforeTs = before ? Math.floor(new Date(before).getTime() / 1000) : undefined;
        const activities = await stravaClient.getActivities(1, count, afterTs, beforeTs);
        const formatted = activities.map(formatActivity);

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
    "strava_get_activity_details",
    "Get detailed data for a specific Strava activity, including laps and splits.",
    {
      activity_id: z.number().describe("The Strava activity ID"),
    },
    async ({ activity_id }) => {
      try {
        const activity = await stravaClient.getActivityDetails(activity_id);
        const detail = {
          ...formatActivity(activity),
          description: activity.description,
          suffer_score: activity.suffer_score,
          laps: activity.laps?.map((l) => ({
            name: l.name,
            distance_km: (l.distance / 1000).toFixed(2),
            duration: formatDuration(l.moving_time),
            pace_per_km: speedToPacePerKm(l.average_speed),
            avg_heartrate: l.average_heartrate ?? null,
          })),
          splits_per_km: activity.splits_metric?.map((s) => ({
            km: s.split,
            pace: speedToPacePerKm(s.average_speed),
            duration: formatDuration(s.moving_time),
            avg_heartrate: s.average_heartrate ?? null,
          })),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
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
    "strava_get_athlete_stats",
    "Get the authenticated athlete's aggregate stats (totals for runs, rides, etc.).",
    {},
    async () => {
      try {
        const stats = await stravaClient.getAthleteStats();
        const formatted = {
          recent_runs: {
            count: stats.recent_run_totals.count,
            distance_km: (stats.recent_run_totals.distance / 1000).toFixed(1),
            time: formatDuration(stats.recent_run_totals.moving_time),
            elevation_m: stats.recent_run_totals.elevation_gain,
          },
          ytd_runs: {
            count: stats.ytd_run_totals.count,
            distance_km: (stats.ytd_run_totals.distance / 1000).toFixed(1),
            time: formatDuration(stats.ytd_run_totals.moving_time),
            elevation_m: stats.ytd_run_totals.elevation_gain,
          },
          all_time_runs: {
            count: stats.all_run_totals.count,
            distance_km: (stats.all_run_totals.distance / 1000).toFixed(1),
            time: formatDuration(stats.all_run_totals.moving_time),
            elevation_m: stats.all_run_totals.elevation_gain,
          },
          recent_rides: {
            count: stats.recent_ride_totals.count,
            distance_km: (stats.recent_ride_totals.distance / 1000).toFixed(1),
          },
          ytd_rides: {
            count: stats.ytd_ride_totals.count,
            distance_km: (stats.ytd_ride_totals.distance / 1000).toFixed(1),
          },
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
    "strava_get_activity_streams",
    "Get time-series data (heart rate, pace, elevation, cadence) for a Strava activity.",
    {
      activity_id: z.number().describe("The Strava activity ID"),
      streams: z
        .array(z.enum(["time", "heartrate", "velocity_smooth", "altitude", "cadence", "distance"]))
        .default(["time", "heartrate", "velocity_smooth", "altitude"])
        .describe("Which data streams to fetch"),
    },
    async ({ activity_id, streams }) => {
      try {
        const data = await stravaClient.getActivityStreams(activity_id, streams);
        const result: Record<string, number[]> = {};
        for (const stream of data) {
          result[stream.type] = stream.data;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  activity_id,
                  streams: Object.keys(result),
                  sample_count: Object.values(result)[0]?.length ?? 0,
                  data: result,
                },
                null,
                2
              ),
            },
          ],
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
