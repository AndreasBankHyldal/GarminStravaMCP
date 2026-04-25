import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as stravaClient from "./client.js";
import { enrichDate, speedToPacePerKm, formatDuration, classifyEffort, classifyHRZone } from "../utils.js";

function formatActivity(a: stravaClient.StravaActivity) {
  const paceSecPerKm = a.average_speed > 0 ? 1000 / a.average_speed : 0;
  return {
    id: a.id,
    name: a.name,
    type: a.sport_type || a.type,
    date: enrichDate(a.start_date_local),
    distance_km: +(a.distance / 1000).toFixed(2),
    duration: formatDuration(a.moving_time),
    moving_time_seconds: a.moving_time,
    pace_per_km: speedToPacePerKm(a.average_speed),
    effort_level: paceSecPerKm > 0 ? classifyEffort(paceSecPerKm) : null,
    elevation_gain_m: a.total_elevation_gain,
    avg_heartrate: a.average_heartrate ?? null,
    max_heartrate: a.max_heartrate ?? null,
    hr_zone: a.average_heartrate ? classifyHRZone(a.average_heartrate) : null,
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

  server.tool(
    "strava_create_activity",
    "Create a manual activity on Strava (e.g. log a run that wasn't GPS-tracked).",
    {
      name: z.string().describe("Activity name"),
      sport_type: z.enum(["Run", "Trail Run", "Walk", "Hike", "Ride", "Swim", "Workout"]).default("Run").describe("Sport type"),
      start_date: z.string().describe("Start date/time in ISO 8601 format"),
      elapsed_time_minutes: z.number().describe("Total elapsed time in minutes"),
      distance_km: z.number().optional().describe("Distance in kilometers"),
      description: z.string().optional().describe("Activity description"),
    },
    async ({ name, sport_type, start_date, elapsed_time_minutes, distance_km, description }) => {
      try {
        const activity = await stravaClient.createManualActivity({
          name,
          sport_type,
          start_date_local: start_date,
          elapsed_time: Math.round(elapsed_time_minutes * 60),
          distance: distance_km ? distance_km * 1000 : undefined,
          description,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: `Activity "${name}" created on Strava!`,
                  activity_id: activity.id,
                  activity: formatActivity(activity),
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

  server.tool(
    "strava_update_activity",
    "Update an existing Strava activity (name, description, or sport type).",
    {
      activity_id: z.number().describe("Strava activity ID to update"),
      name: z.string().optional().describe("New activity name"),
      description: z.string().optional().describe("New description"),
      sport_type: z.string().optional().describe("New sport type"),
    },
    async ({ activity_id, name, description, sport_type }) => {
      try {
        const params: any = {};
        if (name) params.name = name;
        if (description) params.description = description;
        if (sport_type) params.sport_type = sport_type;

        const activity = await stravaClient.updateActivity(activity_id, params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: `Activity ${activity_id} updated on Strava.`,
                  activity: formatActivity(activity),
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
