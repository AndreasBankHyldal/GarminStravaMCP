import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as garminClient from "./client.js";
import { formatDuration } from "../utils.js";
import {
  formatGarminActivity,
  formatGarminActivityDetails,
  formatGarminHeartRateZones,
  getGarminMovingSpeed,
} from "./format.js";

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
    "garmin_get_personal_records",
    "Scan all Garmin activities to find personal records: highest HR, fastest pace, longest run, most elevation, etc. Can scan up to 500 activities.",
    {
      max_activities: z.number().min(10).max(500).default(200).describe("Max activities to scan"),
      activity_type: z.string().optional().describe("Filter by type (e.g. 'running', 'cycling')"),
    },
    async ({ max_activities, activity_type }) => {
      try {
        let activities = await garminClient.getAllActivities(max_activities);

        if (activity_type) {
          activities = activities.filter(
            (a) => a.activityType?.typeKey?.toLowerCase().includes(activity_type.toLowerCase())
          );
        }

        if (activities.length === 0) {
          return {
            content: [{ type: "text", text: "No activities found matching the criteria." }],
          };
        }

        const withHR = activities.filter((a) => a.maxHR > 0);
        const withDist = activities.filter((a) => a.distance > 0);
        const withSpeed = activities.filter((a) => getGarminMovingSpeed(a) > 0);
        const withElev = activities.filter((a) => a.elevationGain > 0);
        const withCal = activities.filter((a) => a.calories > 0);

        const highest = (arr: typeof activities, key: keyof typeof activities[0]) => {
          if (arr.length === 0) return null;
          const best = arr.reduce((max, a) => ((a[key] as number) > (max[key] as number) ? a : max));
          return { value: best[key], activity: formatGarminActivity(best) };
        };

        const lowest = (arr: typeof activities, key: keyof typeof activities[0]) => {
          if (arr.length === 0) return null;
          const best = arr.reduce((min, a) => ((a[key] as number) < (min[key] as number) ? a : min));
          return { value: best[key], activity: formatGarminActivity(best) };
        };

        // Fastest pace = highest average speed
        const fastestPace = withSpeed.length > 0
          ? (() => {
              const best = withSpeed.reduce((max, activity) =>
                getGarminMovingSpeed(activity) > getGarminMovingSpeed(max)
                  ? activity
                  : max
              );
              const secPerKm = 1000 / getGarminMovingSpeed(best);
              const mins = Math.floor(secPerKm / 60);
              const secs = Math.round(secPerKm % 60);
              return { pace_per_km: `${mins}:${secs.toString().padStart(2, "0")}`, activity: formatGarminActivity(best) };
            })()
          : null;

        const records = {
          activities_scanned: activities.length,
          highest_heart_rate: highest(withHR, "maxHR"),
          highest_avg_heart_rate: highest(withHR, "averageHR"),
          lowest_avg_heart_rate: withHR.length > 0
            ? (() => {
                const best = withHR.reduce((min, a) => a.averageHR < min.averageHR ? a : min);
                return { value: best.averageHR, activity: formatGarminActivity(best) };
              })()
            : null,
          fastest_pace: fastestPace,
          longest_distance: highest(withDist, "distance"),
          longest_duration: highest(activities.filter((a) => a.duration > 0), "duration"),
          most_elevation: highest(withElev, "elevationGain"),
          most_calories: highest(withCal, "calories"),
          highest_vo2max: highest(activities.filter((a) => a.vO2MaxValue && a.vO2MaxValue > 0), "vO2MaxValue"),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(records, null, 2) }],
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
    "garmin_search_activities",
    "Search through all Garmin activities with flexible filters. Useful for finding specific activities or answering questions like 'my fastest 5K' or 'runs over 15km'.",
    {
      max_activities: z.number().min(10).max(500).default(200).describe("Max activities to scan"),
      activity_type: z.string().optional().describe("Filter by type (e.g. 'running')"),
      min_distance_km: z.number().optional().describe("Minimum distance in km"),
      max_distance_km: z.number().optional().describe("Maximum distance in km"),
      min_hr: z.number().optional().describe("Minimum average heart rate"),
      max_hr: z.number().optional().describe("Maximum average heart rate"),
      after: z.string().optional().describe("Only activities after this date (ISO 8601)"),
      before: z.string().optional().describe("Only activities before this date (ISO 8601)"),
      sort_by: z.enum(["date", "distance", "duration", "pace", "heartrate", "elevation"]).default("date").describe("Sort results by"),
      sort_order: z.enum(["asc", "desc"]).default("desc").describe("Sort order"),
      limit: z.number().min(1).max(50).default(10).describe("Max results to return"),
    },
    async ({ max_activities, activity_type, min_distance_km, max_distance_km, min_hr, max_hr, after, before, sort_by, sort_order, limit }) => {
      try {
        let activities = await garminClient.getAllActivities(max_activities);

        if (activity_type) {
          activities = activities.filter(
            (a) => a.activityType?.typeKey?.toLowerCase().includes(activity_type.toLowerCase())
          );
        }
        if (min_distance_km) {
          activities = activities.filter((a) => a.distance / 1000 >= min_distance_km);
        }
        if (max_distance_km) {
          activities = activities.filter((a) => a.distance / 1000 <= max_distance_km);
        }
        if (min_hr) {
          activities = activities.filter((a) => a.averageHR >= min_hr);
        }
        if (max_hr) {
          activities = activities.filter((a) => a.averageHR <= max_hr);
        }
        if (after) {
          const afterDate = new Date(after);
          activities = activities.filter((a) => new Date(a.startTimeLocal) >= afterDate);
        }
        if (before) {
          const beforeDate = new Date(before);
          activities = activities.filter((a) => new Date(a.startTimeLocal) <= beforeDate);
        }

        // Sort
        const sortFns: Record<string, (a: any, b: any) => number> = {
          date: (a, b) => new Date(a.startTimeLocal).getTime() - new Date(b.startTimeLocal).getTime(),
          distance: (a, b) => a.distance - b.distance,
          duration: (a, b) => a.duration - b.duration,
          pace: (a, b) => getGarminMovingSpeed(a) - getGarminMovingSpeed(b),
          heartrate: (a, b) => (a.averageHR || 0) - (b.averageHR || 0),
          elevation: (a, b) => (a.elevationGain || 0) - (b.elevationGain || 0),
        };

        activities.sort(sortFns[sort_by] ?? sortFns.date);
        if (sort_order === "desc") activities.reverse();

        const results = activities.slice(0, limit).map(formatGarminActivity);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { total_matching: activities.length, showing: results.length, results },
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
    "garmin_get_activity_details",
    "Get detailed Garmin activity data, including individual laps and interval/recovery structure.",
    {
      activity_id: z.number().describe("The Garmin activity ID"),
    },
    async ({ activity_id }) => {
      try {
        const [activity, splits] = await Promise.all([
          garminClient.getActivityDetails(activity_id),
          garminClient.getActivitySplits(activity_id),
        ]);
        const formatted = formatGarminActivityDetails(activity, splits);
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
    "garmin_get_heart_rate_zones",
    "Get the athlete's configured Garmin heart rate zones, including sport-specific BPM ranges, max heart rate, resting heart rate, and lactate-threshold heart rate.",
    {},
    async () => {
      try {
        const profiles = await garminClient.getHeartRateZones();
        const formatted = formatGarminHeartRateZones(profiles);
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

  server.tool(
    "garmin_get_workouts",
    "Get planned workouts from Garmin Connect.",
    {
      count: z.number().min(1).max(50).default(10).describe("Number of workouts to fetch"),
    },
    async ({ count }) => {
      try {
        const workouts = await garminClient.getWorkouts(0, count);
        return {
          content: [{ type: "text", text: JSON.stringify(workouts, null, 2) }],
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
    "garmin_add_running_workout",
    `Create a structured running workout on Garmin Connect with steps like warmup, intervals, recovery, cooldown. Syncs to your watch with step-by-step guidance during the run.

For a simple single-distance run, just provide name + distance_km.
For structured workouts (intervals, tempo), provide the steps array.

Example interval workout steps:
  [{"type":"warmup","distance_meters":2000,"description":"Easy jog"},
   {"type":"interval","distance_meters":800,"repeat":4,"target_pace_max_per_km":4.5,"target_pace_min_per_km":5.0,"description":"Fast"},
   {"type":"recovery","duration_seconds":120,"description":"Slow jog"},
   {"type":"cooldown","distance_meters":1500,"description":"Easy jog"}]`,
    {
      name: z.string().describe("Workout name (e.g. '4x800m Intervals')"),
      distance_km: z.number().optional().describe("Total distance in km (used only for simple single-step workouts)"),
      description: z.string().default("").describe("Workout description/notes"),
      steps: z.array(z.object({
        type: z.enum(["warmup", "cooldown", "interval", "recovery", "rest"]).describe("Step type"),
        distance_meters: z.number().optional().describe("Step distance in meters"),
        duration_seconds: z.number().optional().describe("Step duration in seconds (alternative to distance)"),
        description: z.string().optional().describe("Step description shown on watch"),
        repeat: z.number().optional().describe("Repeat this step + following recovery N times (for intervals)"),
        target_pace_min_per_km: z.number().optional().describe("Slowest target pace in min/km (e.g. 6.0 for 6:00/km)"),
        target_pace_max_per_km: z.number().optional().describe("Fastest target pace in min/km (e.g. 4.5 for 4:30/km)"),
      })).optional().describe("Structured workout steps. If omitted, creates a simple single-distance run."),
    },
    async ({ name, distance_km, description, steps }) => {
      try {
        let result: any;

        if (steps && steps.length > 0) {
          // Structured workout with steps
          const payload = garminClient.buildStructuredWorkout(name, description, steps);
          result = await garminClient.addStructuredWorkout(payload);
        } else if (distance_km) {
          // Simple single-distance workout
          const meters = Math.round(distance_km * 1000);
          result = await garminClient.addRunningWorkout(name, meters, description);
        } else {
          return {
            content: [{ type: "text", text: "Error: Provide either distance_km for a simple run or steps for a structured workout." }],
            isError: true,
          };
        }

        const workoutId = result?.workoutId ?? result?.id;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              workout_id: workoutId,
              message: steps
                ? `Structured workout "${name}" with ${steps.length} steps created on Garmin Connect! It will sync to your watch with step-by-step guidance.`
                : `Workout "${name}" (${distance_km}km) created on Garmin Connect!`,
              workout: result,
            }, null, 2),
          }],
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
    "garmin_delete_workout",
    "Delete a workout from Garmin Connect.",
    {
      workout_id: z.string().describe("The Garmin workout ID to delete"),
    },
    async ({ workout_id }) => {
      try {
        await garminClient.deleteWorkout(workout_id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, message: `Workout ${workout_id} deleted.` }, null, 2),
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
    "garmin_get_training_status",
    "Get Garmin training status: VO2max, training load, recovery time, training effect.",
    {
      date: z.string().optional().describe("Date in ISO 8601 format (defaults to today)"),
    },
    async ({ date }) => {
      try {
        const d = date ? new Date(date) : undefined;
        const status = await garminClient.getTrainingStatus(d);
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
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
    "garmin_get_hrv",
    "Get Heart Rate Variability (HRV) data from Garmin for a specific date.",
    {
      date: z.string().optional().describe("Date in ISO 8601 format (defaults to today)"),
    },
    async ({ date }) => {
      try {
        const d = date ? new Date(date) : undefined;
        const hrv = await garminClient.getHRVData(d);
        return {
          content: [{ type: "text", text: JSON.stringify(hrv, null, 2) }],
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
    "garmin_schedule_workout",
    "Schedule an existing Garmin workout for a specific date. The workout will appear on your calendar and sync to your watch.",
    {
      workout_id: z.string().describe("The Garmin workout ID to schedule"),
      date: z.string().describe("Date to schedule the workout (ISO 8601)"),
    },
    async ({ workout_id, date }) => {
      try {
        const result = await garminClient.scheduleWorkout(workout_id, new Date(date));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Workout ${workout_id} scheduled for ${date}. It will sync to your Garmin watch!`,
                result,
              }, null, 2),
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
