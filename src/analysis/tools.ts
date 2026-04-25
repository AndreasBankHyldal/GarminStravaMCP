import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db/database.js";
import * as stravaClient from "../strava/client.js";
import * as garminClient from "../garmin/client.js";
import { speedToPacePerKm, enrichDate, formatDuration } from "../utils.js";

export function registerAnalysisTools(server: McpServer): void {
  server.tool(
    "analyze_run_performance",
    "Analyze a specific run's performance: pace consistency, HR drift, split analysis. Provide a Strava activity ID.",
    {
      activity_id: z.number().describe("Strava activity ID to analyze"),
    },
    async ({ activity_id }) => {
      try {
        const [activity, streams] = await Promise.all([
          stravaClient.getActivityDetails(activity_id),
          stravaClient.getActivityStreams(activity_id, [
            "time",
            "heartrate",
            "velocity_smooth",
            "altitude",
            "distance",
          ]),
        ]);

        const streamData: Record<string, number[]> = {};
        for (const s of streams) {
          streamData[s.type] = s.data;
        }

        const analysis: any = {
          activity: {
            name: activity.name,
            date: activity.start_date_local,
            distance_km: (activity.distance / 1000).toFixed(2),
            total_time: formatDuration(activity.moving_time),
            avg_pace: speedToPacePerKm(activity.average_speed),
            avg_heartrate: activity.average_heartrate,
            max_heartrate: activity.max_heartrate,
          },
        };

        // Split analysis
        if (activity.splits_metric?.length) {
          const paces = activity.splits_metric.map(
            (s) => 1000 / s.average_speed / 60
          );
          const avgPace = paces.reduce((a, b) => a + b, 0) / paces.length;
          const paceVariance =
            paces.reduce((sum, p) => sum + Math.pow(p - avgPace, 2), 0) / paces.length;

          analysis.splits = {
            count: activity.splits_metric.length,
            paces: activity.splits_metric.map((s) => ({
              km: s.split,
              pace: speedToPacePerKm(s.average_speed),
              hr: s.average_heartrate ?? null,
            })),
            pace_consistency: {
              std_deviation_min: Math.sqrt(paceVariance).toFixed(2),
              rating:
                Math.sqrt(paceVariance) < 0.2
                  ? "Excellent"
                  : Math.sqrt(paceVariance) < 0.4
                  ? "Good"
                  : Math.sqrt(paceVariance) < 0.7
                  ? "Fair"
                  : "Variable",
            },
          };

          // Negative split check
          const mid = Math.floor(paces.length / 2);
          const firstHalf = paces.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
          const secondHalf = paces.slice(mid).reduce((a, b) => a + b, 0) / (paces.length - mid);
          analysis.splits.negative_split = secondHalf < firstHalf;
        }

        // HR drift analysis
        if (streamData.heartrate?.length && streamData.time?.length) {
          const hr = streamData.heartrate;
          const totalPoints = hr.length;
          const firstHalfHR =
            hr.slice(0, Math.floor(totalPoints / 2)).reduce((a, b) => a + b, 0) /
            Math.floor(totalPoints / 2);
          const secondHalfHR =
            hr.slice(Math.floor(totalPoints / 2)).reduce((a, b) => a + b, 0) /
            (totalPoints - Math.floor(totalPoints / 2));

          const drift = ((secondHalfHR - firstHalfHR) / firstHalfHR) * 100;
          analysis.hr_drift = {
            first_half_avg: Math.round(firstHalfHR),
            second_half_avg: Math.round(secondHalfHR),
            drift_percent: drift.toFixed(1),
            assessment:
              Math.abs(drift) < 3
                ? "Minimal drift - good aerobic fitness"
                : drift < 5
                ? "Normal drift"
                : "Significant drift - may indicate dehydration or insufficient base fitness",
          };
        }

        // Elevation analysis
        if (streamData.altitude?.length) {
          const alt = streamData.altitude;
          analysis.elevation = {
            min_m: Math.round(Math.min(...alt)),
            max_m: Math.round(Math.max(...alt)),
            total_gain: activity.total_elevation_gain,
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(analysis, null, 2) }],
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
    "compare_activities",
    "Compare a Strava activity with the corresponding Garmin activity by date/distance matching.",
    {
      strava_activity_id: z.number().describe("Strava activity ID"),
    },
    async ({ strava_activity_id }) => {
      try {
        const stravaActivity = await stravaClient.getActivityDetails(strava_activity_id);
        const garminActivities = await garminClient.getActivities(0, 20);

        // Find matching Garmin activity by date and distance proximity
        const stravaDate = new Date(stravaActivity.start_date).getTime();
        const stravaDist = stravaActivity.distance;

        const match = garminActivities.find((ga) => {
          const gDate = new Date(ga.startTimeLocal).getTime();
          const timeDiff = Math.abs(gDate - stravaDate);
          const distDiff = Math.abs((ga.distance ?? 0) - stravaDist);
          return timeDiff < 3600000 && distDiff < 500; // within 1hr and 500m
        });

        if (!match) {
          return {
            content: [
              {
                type: "text",
                text: "No matching Garmin activity found for this Strava activity. The activities may be outside the recent 20 activities window.",
              },
            ],
          };
        }

        const comparison = {
          strava: {
            name: stravaActivity.name,
            date: stravaActivity.start_date_local,
            distance_km: (stravaActivity.distance / 1000).toFixed(2),
            duration: formatDuration(stravaActivity.moving_time),
            pace: speedToPacePerKm(stravaActivity.average_speed),
            avg_hr: stravaActivity.average_heartrate,
            max_hr: stravaActivity.max_heartrate,
            calories: stravaActivity.calories,
            elevation: stravaActivity.total_elevation_gain,
          },
          garmin: {
            name: match.activityName,
            date: match.startTimeLocal,
            distance_km: ((match.distance ?? 0) / 1000).toFixed(2),
            duration: formatDuration(match.duration ?? 0),
            pace: speedToPacePerKm(match.averageSpeed),
            avg_hr: match.averageHR,
            max_hr: match.maxHR,
            calories: match.calories,
            elevation: match.elevationGain,
            vo2max: match.vO2MaxValue,
            cadence_spm: match.averageRunningCadenceInStepsPerMinute,
          },
          differences: {
            distance_diff_m: Math.abs(stravaActivity.distance - (match.distance ?? 0)).toFixed(0),
            hr_diff: stravaActivity.average_heartrate && match.averageHR
              ? Math.abs(stravaActivity.average_heartrate - match.averageHR).toFixed(0)
              : "N/A",
            note: "Small differences are normal due to different GPS processing algorithms",
          },
        };

        return {
          content: [{ type: "text", text: JSON.stringify(comparison, null, 2) }],
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
    "get_training_trends",
    "Get aggregated training trends over recent weeks: weekly mileage, average pace, heart rate trends.",
    {
      weeks: z.number().min(1).max(52).default(8).describe("Number of weeks to analyze"),
      source: z.enum(["strava", "garmin"]).default("strava").describe("Data source"),
    },
    async ({ weeks, source }) => {
      try {
        const afterDate = new Date();
        afterDate.setDate(afterDate.getDate() - weeks * 7);
        const afterTs = Math.floor(afterDate.getTime() / 1000);

        let activities: any[];

        if (source === "strava") {
          activities = (await stravaClient.getActivities(1, 100, afterTs)).map((a) => ({
            date: a.start_date_local,
            type: a.sport_type || a.type,
            distance: a.distance,
            duration: a.moving_time,
            pace: a.average_speed,
            hr: a.average_heartrate,
            elevation: a.total_elevation_gain,
          }));
        } else {
          const garminActs = await garminClient.getActivities(0, 100);
          activities = garminActs
            .filter((a) => new Date(a.startTimeLocal) >= afterDate)
            .map((a) => ({
              date: a.startTimeLocal,
              type: a.activityType?.typeKey ?? "unknown",
              distance: a.distance ?? 0,
              duration: a.duration ?? 0,
              pace: a.averageSpeed,
              hr: a.averageHR,
              elevation: a.elevationGain,
            }));
        }

        // Group by week
        const weeklyData: Record<string, any[]> = {};
        for (const act of activities) {
          const d = new Date(act.date);
          const weekStart = new Date(d);
          weekStart.setDate(d.getDate() - d.getDay() + 1); // Monday
          const weekKey = weekStart.toISOString().split("T")[0];
          if (!weeklyData[weekKey]) weeklyData[weekKey] = [];
          weeklyData[weekKey].push(act);
        }

        const weeklyTrends = Object.entries(weeklyData)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([week, acts]) => {
            const runs = acts.filter(
              (a) =>
                a.type.toLowerCase().includes("run") ||
                a.type.toLowerCase() === "running"
            );
            const totalDist = runs.reduce((sum, a) => sum + a.distance, 0);
            const totalDuration = runs.reduce((sum, a) => sum + a.duration, 0);
            const avgHr =
              runs.filter((r) => r.hr).length > 0
                ? runs.filter((r) => r.hr).reduce((sum, r) => sum + r.hr, 0) /
                  runs.filter((r) => r.hr).length
                : null;

            return {
              week_of: week,
              total_activities: acts.length,
              runs: runs.length,
              total_km: (totalDist / 1000).toFixed(1),
              total_time: formatDuration(totalDuration),
              avg_pace: totalDuration > 0 ? speedToPacePerKm(totalDist / totalDuration) : "N/A",
              avg_heartrate: avgHr ? Math.round(avgHr) : null,
            };
          });

        // Overall trends
        const allKms = weeklyTrends.map((w) => parseFloat(w.total_km));
        const trend =
          allKms.length >= 2
            ? allKms[allKms.length - 1] > allKms[0]
              ? "increasing"
              : allKms[allKms.length - 1] < allKms[0]
              ? "decreasing"
              : "stable"
            : "insufficient data";

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  period: `Last ${weeks} weeks`,
                  source,
                  weekly_breakdown: weeklyTrends,
                  volume_trend: trend,
                  total_runs: weeklyTrends.reduce((s, w) => s + w.runs, 0),
                  total_km: allKms.reduce((s, k) => s + k, 0).toFixed(1),
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

