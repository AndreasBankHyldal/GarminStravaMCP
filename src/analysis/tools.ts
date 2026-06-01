import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db/database.js";
import * as stravaClient from "../strava/client.js";
import * as garminClient from "../garmin/client.js";
import { speedToPacePerKm, enrichDate, formatDuration, analyzeLaps } from "../utils.js";

export function registerAnalysisTools(server: McpServer): void {
  server.tool(
    "analyze_run_performance",
    "Analyze a specific run's performance: pace consistency, HR drift, per-lap and per-km split analysis. Surfaces individual laps so interval workouts (e.g. 600m reps) show true rep pace, not just averaged 1km splits. Provide a Strava activity ID.",
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

        // Lap analysis — essential for interval workouts. The 1km splits below
        // average each fast rep together with its recovery, hiding the true
        // interval pace. Laps reflect the actual structure (e.g. 600m reps).
        const lapAnalysis = analyzeLaps(activity.laps);
        if (lapAnalysis) {
          analysis.laps = lapAnalysis;
        }

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

  server.tool(
    "race_day_strategy",
    `Create a detailed race day pacing strategy. Uses your actual training data, personal records, and running science (VDOT equivalent tables, negative split pacing, HR zone targets) to build a km-by-km plan. Accounts for race distance, goal time, elevation, and conditions.`,
    {
      race_distance_km: z.number().describe("Race distance in km (e.g. 5, 10, 21.1, 42.2)"),
      goal_time_minutes: z.number().optional().describe("Goal finish time in minutes (e.g. 25 for a 25min 5K, 105 for 1:45 half). If omitted, estimates from your data."),
      elevation_gain_m: z.number().optional().describe("Expected elevation gain in meters. Adds pace adjustment for hills."),
      temperature_c: z.number().optional().describe("Expected temperature in Celsius. Adds heat adjustment above 15°C."),
      wind_speed_kph: z.number().optional().describe("Expected average wind speed in km/h. Adds pacing adjustment for windy conditions."),
      course_profile: z.enum(["flat", "rolling", "hilly"]).optional().describe("Course terrain profile"),
    },
    async ({ race_distance_km, goal_time_minutes, elevation_gain_m, temperature_c, wind_speed_kph, course_profile }) => {
      try {
        // --- 1. Gather athlete data ---
        const recentActivities = await stravaClient.getActivities(1, 30).catch(() => [] as stravaClient.StravaActivity[]);

        const runs = recentActivities.filter(
          (a) => (a.sport_type || a.type || "").toLowerCase().includes("run")
        );

        // --- 2. Estimate fitness from recent data ---
        const recentPaces = runs
          .filter(a => a.average_speed > 0 && a.distance > 1000)
          .map(a => ({
            distance_km: a.distance / 1000,
            pace_sec_per_km: 1000 / a.average_speed,
            avg_hr: a.average_heartrate,
            max_hr: a.max_heartrate,
            date: a.start_date_local,
          }));

        const allMaxHRs = recentPaces.filter(r => r.max_hr).map(r => r.max_hr!);
        const estimatedMaxHR = allMaxHRs.length > 0 ? Math.max(...allMaxHRs) : 195;

        const vdotEstimate = estimateVDOT(recentPaces, race_distance_km);

        // --- 3. Determine goal pace ---
        let goalPaceSecPerKm: number;
        let goalTimeMin: number;
        let goalSource: string;

        if (goal_time_minutes) {
          goalTimeMin = goal_time_minutes;
          goalPaceSecPerKm = (goal_time_minutes * 60) / race_distance_km;
          goalSource = "user-specified goal";
        } else if (vdotEstimate.vdot > 0) {
          goalPaceSecPerKm = predictRacePace(vdotEstimate.vdot, race_distance_km);
          goalTimeMin = (goalPaceSecPerKm * race_distance_km) / 60;
          goalSource = `estimated from VDOT ${vdotEstimate.vdot.toFixed(1)} (based on ${vdotEstimate.source})`;
        } else {
          const avgPace = recentPaces.length > 0
            ? recentPaces.reduce((s, r) => s + r.pace_sec_per_km, 0) / recentPaces.length
            : 360;
          goalPaceSecPerKm = avgPace;
          goalTimeMin = (avgPace * race_distance_km) / 60;
          goalSource = "estimated from average recent pace";
        }

        // --- 4. Apply environmental adjustments ---
        const adjustmentFactors: { reason: string; percent: number }[] = [];

        if (temperature_c != null && temperature_c > 15) {
          const heatPenalty = (temperature_c - 15) * 1.5;
          adjustmentFactors.push({ reason: `Heat (+${temperature_c}°C)`, percent: heatPenalty });
        }

        if (elevation_gain_m && elevation_gain_m > 0) {
          const elevPenalty = ((elevation_gain_m / 100) * 12 / goalPaceSecPerKm) * 100;
          adjustmentFactors.push({ reason: `Elevation (+${elevation_gain_m}m gain)`, percent: elevPenalty });
        }

        if (wind_speed_kph != null && wind_speed_kph > 10) {
          // Approximation: ~0.8% pace penalty per 5 km/h above 10 km/h.
          const windPenalty = ((wind_speed_kph - 10) / 5) * 0.8;
          adjustmentFactors.push({
            reason: `Wind (${wind_speed_kph} km/h)`,
            percent: Math.min(6, Math.max(0, windPenalty)),
          });
        }

        const totalAdjustment = adjustmentFactors.reduce((s, a) => s + a.percent, 0);
        const adjustedPace = goalPaceSecPerKm * (1 + totalAdjustment / 100);
        const adjustedTimeMin = (adjustedPace * race_distance_km) / 60;

        // --- 5. Build km-by-km pacing plan ---
        const totalKm = Math.ceil(race_distance_km);
        const splits = buildNegativeSplitPlan(adjustedPace, race_distance_km, totalKm, course_profile);

        // --- 6. HR targets per phase ---
        const hrTargets = {
          start_phase: {
            km: `1–${Math.max(2, Math.floor(race_distance_km * 0.15))}`,
            target_hr: `${Math.round(estimatedMaxHR * 0.78)}–${Math.round(estimatedMaxHR * 0.82)}`,
            zone: "Zone 3 (controlled start)",
            feel: "Comfortable, conversational, resist the urge to go fast",
          },
          middle_phase: {
            km: `${Math.max(2, Math.floor(race_distance_km * 0.15)) + 1}–${Math.floor(race_distance_km * 0.75)}`,
            target_hr: `${Math.round(estimatedMaxHR * 0.82)}–${Math.round(estimatedMaxHR * 0.87)}`,
            zone: "Zone 3–4 (steady state)",
            feel: "Comfortably hard, rhythmic breathing",
          },
          push_phase: {
            km: `${Math.floor(race_distance_km * 0.75) + 1}–${Math.floor(race_distance_km * 0.9)}`,
            target_hr: `${Math.round(estimatedMaxHR * 0.87)}–${Math.round(estimatedMaxHR * 0.92)}`,
            zone: "Zone 4 (threshold)",
            feel: "Hard but sustainable, focus on maintaining form",
          },
          finish_phase: {
            km: `${Math.floor(race_distance_km * 0.9) + 1}–${race_distance_km.toFixed(1)}`,
            target_hr: `${Math.round(estimatedMaxHR * 0.90)}–${Math.round(estimatedMaxHR * 0.95)}`,
            zone: "Zone 4–5 (kick)",
            feel: "All out! Empty the tank in the final stretch",
          },
        };

        // --- 7. Goal feasibility assessment ---
        let feasibility: string;
        if (vdotEstimate.vdot > 0 && goal_time_minutes) {
          const predictedPace = predictRacePace(vdotEstimate.vdot, race_distance_km);
          const goalVsPredict = ((goalPaceSecPerKm - predictedPace) / predictedPace) * 100;
          if (goalVsPredict > 5) {
            feasibility = "Conservative — you can likely go faster based on your fitness";
          } else if (goalVsPredict > -3) {
            feasibility = "Realistic — well aligned with your current fitness";
          } else if (goalVsPredict > -8) {
            feasibility = "Ambitious — will require a great day and perfect execution";
          } else {
            feasibility = "Very aggressive — significantly beyond current fitness indicators";
          }
        } else if (vdotEstimate.vdot > 0) {
          feasibility = "Estimated from your fitness data — should be achievable";
        } else {
          feasibility = "Unable to fully assess — insufficient recent training data";
        }

        // --- 8. Race day tips ---
        const tips = buildRaceDayTips(race_distance_km, temperature_c);

        const result = {
          race: {
            distance_km: race_distance_km,
            distance_label: getDistanceLabel(race_distance_km),
            goal_time: formatDuration(goalTimeMin * 60),
            goal_pace: fmtPace(goalPaceSecPerKm),
            goal_source: goalSource,
            feasibility_assessment: feasibility,
          },
          adjustments: totalAdjustment > 0 ? {
            factors: adjustmentFactors,
            total_adjustment_percent: `+${totalAdjustment.toFixed(1)}%`,
            adjusted_time: formatDuration(adjustedTimeMin * 60),
            adjusted_pace: fmtPace(adjustedPace),
          } : null,
          estimated_max_hr: estimatedMaxHR,
          vdot_estimate: vdotEstimate.vdot > 0 ? {
            vdot: +vdotEstimate.vdot.toFixed(1),
            source: vdotEstimate.source,
            equivalent_races: getVDOTEquivalents(vdotEstimate.vdot),
          } : null,
          pacing_strategy: "Negative split — start conservatively, build through the race",
          km_splits: splits,
          hr_targets: hrTargets,
          race_day_tips: tips,
          execution_pack: {
            fueling_plan: buildFuelingPlan(race_distance_km),
            hydration_plan: buildHydrationPlan(race_distance_km, temperature_c),
            course_tactics: buildCourseTactics(course_profile ?? "flat"),
          },
          training_data_used: {
            recent_runs_analyzed: runs.length,
            max_hr_observed: estimatedMaxHR,
            avg_recent_pace: recentPaces.length > 0
              ? fmtPace(recentPaces.reduce((s, r) => s + r.pace_sec_per_km, 0) / recentPaces.length)
              : "N/A",
          },
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
    "get_best_efforts",
    "Calculate best-effort performances (1K/5K/10K/etc.) by scanning activities and using splits/streams for rolling distance windows.",
    {
      distances_km: z.array(z.number().min(0.2).max(100)).default([1, 5, 10, 21.1]).describe("Target distances to compute best efforts for"),
      max_activities: z.number().min(5).max(60).default(25).describe("Number of recent runs to scan"),
      source: z.enum(["strava", "garmin"]).default("strava").describe("Data source (stream-based best effort currently optimized for Strava)"),
    },
    async ({ distances_km, max_activities, source }) => {
      try {
        if (source === "garmin") {
          return {
            content: [{
              type: "text",
              text: "Best-effort stream scanning is currently implemented for Strava data. Use source='strava' for accurate rolling-distance PRs.",
            }],
          };
        }

        const activities = await stravaClient.getActivities(1, max_activities);
        const runs = activities.filter((a) => (a.sport_type || a.type || "").toLowerCase().includes("run"));
        const best = new Map<number, {
          distance_km: number;
          elapsed_seconds: number;
          pace_per_km: string;
          activity_id: number;
          activity_name: string;
          date: string;
          source: string;
        }>();

        const sortedTargets = [...new Set(distances_km)].sort((a, b) => a - b);

        for (const run of runs) {
          const targetCandidates = sortedTargets.filter((d) => run.distance >= d * 1000);
          if (targetCandidates.length === 0) continue;

          const details = await stravaClient.getActivityDetails(run.id);
          const bySplit = details.splits_metric ?? [];
          let streamDistance: number[] | null = null;
          let streamTime: number[] | null = null;

          for (const targetKm of targetCandidates) {
            const targetMeters = targetKm * 1000;
            let effortSeconds = bestWindowFromSplits(bySplit, targetMeters);

            if (effortSeconds == null) {
              if (!streamDistance || !streamTime) {
                const streams = await stravaClient.getActivityStreams(run.id, ["distance", "time"]);
                streamDistance = streams.find((s) => s.type === "distance")?.data ?? null;
                streamTime = streams.find((s) => s.type === "time")?.data ?? null;
              }
              effortSeconds =
                streamDistance && streamTime
                  ? bestWindowFromStreams(streamDistance, streamTime, targetMeters)
                  : null;
            }

            if (effortSeconds == null) continue;

            const previous = best.get(targetKm);
            if (!previous || effortSeconds < previous.elapsed_seconds) {
              best.set(targetKm, {
                distance_km: targetKm,
                elapsed_seconds: effortSeconds,
                pace_per_km: fmtPace(effortSeconds / targetKm),
                activity_id: run.id,
                activity_name: run.name,
                date: run.start_date_local,
                source: bySplit.length > 0 ? "splits_metric" : "streams",
              });
            }
          }
        }

        const efforts = sortedTargets.map((d) => best.get(d)).filter(Boolean);
        const summary = efforts.length
          ? `Found best efforts for ${efforts.length}/${sortedTargets.length} requested distances.`
          : "No best efforts found. Try increasing max_activities or checking Strava permissions.";

        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              {
                source,
                activities_scanned: runs.length,
                requested_distances_km: sortedTargets,
                summary,
                best_efforts: efforts,
              },
              null,
              2
            ),
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
    "get_load_fatigue_model",
    "Compute CTL/ATL/TSB-style training load model and fatigue risk from recent running activities.",
    {
      source: z.enum(["strava", "garmin"]).default("strava").describe("Activity source"),
      days: z.number().min(21).max(180).default(90).describe("How many days to include in the model"),
    },
    async ({ source, days }) => {
      try {
        const runs = await fetchRunSamples(source, days);
        const loadModel = computeLoadModel(runs, days);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              {
                source,
                days,
                runs_analyzed: runs.length,
                model: loadModel,
              },
              null,
              2
            ),
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
    "get_readiness_score",
    "Create a daily readiness score from recovery metrics (sleep, HRV, resting HR) and training load state.",
    {
      source: z.enum(["strava", "garmin", "combined"]).default("combined").describe("Primary source for training load"),
    },
    async ({ source }) => {
      try {
        const runs = await fetchRunSamples(source === "garmin" ? "garmin" : "strava", 42);
        const loadModel = computeLoadModel(runs, 42);

        const [sleepRaw, hrvRaw, hrRaw, trainingStatusRaw] = await Promise.all([
          garminClient.getSleepData().catch(() => null),
          garminClient.getHRVData().catch(() => null),
          garminClient.getHeartRate().catch(() => null),
          garminClient.getTrainingStatus().catch(() => null),
        ]);

        const sleepScore = pickNumber(sleepRaw, [
          "overallSleepScore.value",
          "overallSleepScore",
          "dailySleepDTO.sleepScores.overall.value",
          "dailySleepDTO.sleepScore",
          "sleepScores.overall.value",
        ]);
        const hrv = pickNumber(hrvRaw, [
          "hrvSummary.lastNightAverage",
          "dailyHrvSummary.lastNightAverage",
          "lastNightAvg",
          "hrvValue",
        ]);
        const hrvBaseline = pickNumber(hrvRaw, [
          "hrvSummary.sevenDayAverage",
          "dailyHrvSummary.sevenDayAverage",
          "sevenDayAvg",
          "weeklyAvg",
        ]);
        const restingHr = pickNumber(hrRaw, [
          "restingHeartRate",
          "todayRestingHeartRate",
          "allMetrics.restingHeartRate",
        ]);
        const restingHrBaseline = pickNumber(hrRaw, [
          "lastSevenDaysAvgRestingHeartRate",
          "sevenDayAvgRestingHeartRate",
        ]);
        const recoveryHours = pickNumber(trainingStatusRaw, [
          "recoveryTime",
          "recoveryTimeSeconds",
          "trainingStatus.recoveryTime",
        ]);

        let score = 70;
        const components: Record<string, any> = {};

        if (sleepScore != null) {
          const adj = clamp((sleepScore - 75) * 0.4, -15, 15);
          score += adj;
          components.sleep = { sleep_score: sleepScore, adjustment: +adj.toFixed(1) };
        }

        if (hrv != null && hrvBaseline != null && hrvBaseline > 0) {
          const pct = (hrv - hrvBaseline) / hrvBaseline;
          const adj = clamp(pct * 35, -12, 12);
          score += adj;
          components.hrv = { hrv, baseline: hrvBaseline, adjustment: +adj.toFixed(1) };
        }

        if (restingHr != null && restingHrBaseline != null) {
          const diff = restingHr - restingHrBaseline;
          const adj = clamp(-diff * 2, -10, 8);
          score += adj;
          components.resting_hr = {
            resting_hr: restingHr,
            baseline: restingHrBaseline,
            adjustment: +adj.toFixed(1),
          };
        }

        const tsb = loadModel.current.tsb;
        const tsbAdj = tsb < -20 ? -14 : tsb < -10 ? -8 : tsb > 8 ? 5 : 0;
        score += tsbAdj;
        components.training_balance = { tsb, adjustment: tsbAdj };

        const acr = loadModel.current.acute_chronic_ratio;
        const acrAdj = acr > 1.5 ? -12 : acr > 1.3 ? -7 : acr < 0.8 ? 3 : 0;
        score += acrAdj;
        components.load_ratio = { acute_chronic_ratio: acr, adjustment: acrAdj };

        if (recoveryHours != null) {
          const normalizedRecoveryH = recoveryHours > 500 ? recoveryHours / 3600 : recoveryHours;
          const adj = normalizedRecoveryH > 36 ? -8 : normalizedRecoveryH > 24 ? -5 : 0;
          score += adj;
          components.recovery_time = {
            recovery_hours: +normalizedRecoveryH.toFixed(1),
            adjustment: adj,
          };
        }

        score = clamp(score, 0, 100);
        const recommendation =
          score >= 78
            ? "ready_for_hard_session"
            : score >= 62
            ? "moderate_day_recommended"
            : "easy_or_rest_day_recommended";

        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              {
                readiness_score: Math.round(score),
                recommendation,
                components,
                load_snapshot: loadModel.current,
                confidence:
                  Object.keys(components).length >= 5
                    ? "high"
                    : Object.keys(components).length >= 3
                    ? "medium"
                    : "low",
              },
              null,
              2
            ),
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
    "weekly_coach_brief",
    "Generate a weekly coaching brief with volume, intensity, load trend, and concrete recommendations.",
    {
      source: z.enum(["strava", "garmin"]).default("strava").describe("Data source"),
      week_offset: z.number().min(0).max(8).default(0).describe("0 = current week, 1 = previous week, etc."),
    },
    async ({ source, week_offset }) => {
      try {
        const now = new Date();
        const weekStart = startOfWeek(now);
        weekStart.setDate(weekStart.getDate() - week_offset * 7);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 7);

        const prevWeekStart = new Date(weekStart);
        prevWeekStart.setDate(prevWeekStart.getDate() - 7);
        const prevWeekEnd = new Date(weekStart);

        const runs = await fetchRunSamples(source, 35);
        const thisWeek = runs.filter((r) => {
          const d = new Date(r.date);
          return d >= weekStart && d < weekEnd;
        });
        const prevWeek = runs.filter((r) => {
          const d = new Date(r.date);
          return d >= prevWeekStart && d < prevWeekEnd;
        });

        const thisSummary = summarizeRunBlock(thisWeek);
        const prevSummary = summarizeRunBlock(prevWeek);
        const loadModel = computeLoadModel(runs, 35);

        const mileageDeltaPct =
          prevSummary.total_km > 0
            ? ((thisSummary.total_km - prevSummary.total_km) / prevSummary.total_km) * 100
            : 0;

        const notes: string[] = [];
        if (mileageDeltaPct > 12) {
          notes.push("Mileage rose quickly (>12%). Consider a lighter next week to consolidate adaptation.");
        }
        if (thisSummary.hard_sessions >= 3) {
          notes.push("High intensity count this week. Protect recovery days and keep easy runs easy.");
        }
        if (loadModel.current.acute_chronic_ratio > 1.3) {
          notes.push("Acute/chronic load is elevated. Prioritize sleep, hydration, and reduced intensity.");
        }
        if (thisSummary.hard_sessions <= 1 && thisSummary.total_km > 0) {
          notes.push("You may benefit from one quality workout next week (tempo or controlled intervals).");
        }
        if (notes.length === 0) {
          notes.push("Training load looks balanced. Continue with progressive but controlled volume.");
        }

        const db = getDb();
        const weekStartKey = weekStart.toISOString().slice(0, 10);
        const weekEndKey = weekEnd.toISOString().slice(0, 10);
        const planned = db
          .prepare("SELECT * FROM planned_workouts WHERE substr(date, 1, 10) >= ? AND substr(date, 1, 10) < ?")
          .all(weekStartKey, weekEndKey) as any[];
        const plannedRunnable = planned.filter((w) => isPlannedRun(w.workout_type));
        const completedDates = new Set(thisWeek.map((r) => r.date.slice(0, 10)));
        const adherence =
          plannedRunnable.length > 0
            ? plannedRunnable.filter((w) => completedDates.has(String(w.date).slice(0, 10))).length / plannedRunnable.length
            : null;

        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              {
                period: {
                  start: weekStart.toISOString().slice(0, 10),
                  end_exclusive: weekEnd.toISOString().slice(0, 10),
                  source,
                },
                this_week: thisSummary,
                previous_week: prevSummary,
                change: {
                  mileage_delta_percent: +mileageDeltaPct.toFixed(1),
                  hard_session_delta: thisSummary.hard_sessions - prevSummary.hard_sessions,
                },
                load_snapshot: loadModel.current,
                plan_adherence:
                  adherence == null ? "no planned workouts found" : `${(adherence * 100).toFixed(0)}%`,
                coach_notes: notes,
              },
              null,
              2
            ),
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
}

// --- VDOT calculation helpers (Jack Daniels' Running Formula) ---

function fmtPace(secPerKm: number): string {
  const mins = Math.floor(secPerKm / 60);
  const secs = Math.round(secPerKm % 60);
  return `${mins}:${secs.toString().padStart(2, "0")} /km`;
}

function estimateVDOT(
  paces: { distance_km: number; pace_sec_per_km: number; avg_hr?: number | null; max_hr?: number | null; date: string }[],
  targetDist: number,
): { vdot: number; source: string } {
  if (paces.length === 0) return { vdot: 0, source: "no data" };

  const scored = paces.map(p => {
    const distDiff = Math.abs(p.distance_km - targetDist) / targetDist;
    const timeMin = (p.pace_sec_per_km * p.distance_km) / 60;
    const vdot = calculateVDOT(p.distance_km, timeMin);
    return { ...p, vdot, distDiff };
  });

  scored.sort((a, b) => b.vdot - a.vdot);
  const bestEfforts = scored.slice(0, 5);

  let weightedSum = 0;
  let weightTotal = 0;
  for (const e of bestEfforts) {
    // Weight recent and distance-similar efforts higher
    const recency = Math.max(0.5, 1 - (Date.now() - new Date(e.date).getTime()) / (90 * 86400000));
    const distSim = Math.max(0.3, 1 - e.distDiff);
    const w = recency * distSim;
    weightedSum += e.vdot * w;
    weightTotal += w;
  }

  const vdot = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const best = bestEfforts[0];
  const source = best
    ? `${best.distance_km.toFixed(1)}km in ${formatDuration(best.pace_sec_per_km * best.distance_km)} on ${best.date.split("T")[0]}`
    : "no data";

  return { vdot, source };
}

/** Daniels & Gilbert VO2max formula */
function calculateVDOT(distKm: number, timeMin: number): number {
  const velocity = (distKm * 1000) / (timeMin * 60); // m/s

  const percentVO2 = 0.8 + 0.1894393 * Math.exp(-0.012778 * timeMin)
    + 0.2989558 * Math.exp(-0.1932605 * timeMin);
  const vo2 = -4.60 + 0.182258 * (velocity * 60) + 0.000104 * Math.pow(velocity * 60, 2);

  if (percentVO2 <= 0) return 0;
  return vo2 / percentVO2;
}

/** Binary search for race pace at a given VDOT */
function predictRacePace(vdot: number, distKm: number): number {
  let lo = distKm * 2; // impossibly fast
  let hi = distKm * 10; // very slow

  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (calculateVDOT(distKm, mid) < vdot) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return ((lo + hi) / 2 * 60) / distKm;
}

function buildNegativeSplitPlan(
  avgPace: number,
  raceDist: number,
  totalKm: number,
  profile?: "flat" | "rolling" | "hilly" | null
): { km: number | string; target_pace: string; phase: string; notes: string }[] {
  const splits: { km: number | string; target_pace: string; phase: string; notes: string }[] = [];

  for (let km = 1; km <= totalKm; km++) {
    const fraction = km / raceDist;
    let paceOffset: number;
    let phase: string;
    let notes: string;

    if (fraction <= 0.15) {
      paceOffset = avgPace * 0.04;
      phase = "🟢 Start";
      notes = "Settle in, find rhythm. Don't chase faster runners.";
    } else if (fraction <= 0.5) {
      paceOffset = avgPace * 0.015;
      phase = "🔵 Build";
      notes = "Lock into goal effort. Steady breathing.";
    } else if (fraction <= 0.75) {
      paceOffset = 0;
      phase = "🟡 Sustain";
      notes = "Maintain. This is where the race is won.";
    } else if (fraction <= 0.9) {
      paceOffset = -avgPace * 0.02;
      phase = "🟠 Push";
      notes = "Increase effort. Pass people, not the other way.";
    } else {
      paceOffset = -avgPace * 0.04;
      phase = "🔴 Kick";
      notes = "Everything you have left. Sprint the final 200m.";
    }

    if (profile === "rolling" && km % 3 === 0) {
      paceOffset += avgPace * 0.03;
      notes += " (Expect hill — effort-based, accept slower pace)";
    } else if (profile === "hilly" && km % 2 === 0) {
      paceOffset += avgPace * 0.05;
      notes += " (Hill segment — maintain effort, not pace)";
    }

    const kmPace = avgPace + paceOffset;
    const isPartialKm = km === totalKm && raceDist % 1 !== 0;
    splits.push({
      km: isPartialKm ? `${km - 1}–${raceDist.toFixed(1)}` : km,
      target_pace: fmtPace(kmPace),
      phase,
      notes,
    });
  }

  return splits;
}

function getVDOTEquivalents(vdot: number): Record<string, string> {
  const distances: [string, number][] = [
    ["5K", 5], ["10K", 10], ["Half Marathon", 21.0975], ["Marathon", 42.195],
  ];
  const result: Record<string, string> = {};
  for (const [label, dist] of distances) {
    const pace = predictRacePace(vdot, dist);
    result[label] = `${formatDuration(pace * dist)} (${fmtPace(pace)})`;
  }
  return result;
}

function getDistanceLabel(km: number): string {
  if (Math.abs(km - 5) < 0.2) return "5K";
  if (Math.abs(km - 10) < 0.2) return "10K";
  if (Math.abs(km - 15) < 0.2) return "15K";
  if (Math.abs(km - 21.1) < 0.3) return "Half Marathon";
  if (Math.abs(km - 42.2) < 0.3) return "Marathon";
  return `${km}km`;
}

function buildRaceDayTips(distKm: number, tempC?: number | null): string[] {
  const tips: string[] = [
    "Pin your bib the night before. Lay out all gear.",
    "Eat your last meal 2–3 hours before the start.",
    "Warm up with 10 min easy jogging + 4×20s strides.",
    "Start in the correct corral — don't get caught in a fast group.",
  ];

  if (distKm >= 15) {
    tips.push("Take your first gel/fuel at km 6–8, then every 5km.");
    tips.push("Drink at EVERY water station, even if you don't feel thirsty.");
  }

  if (distKm >= 30) {
    tips.push("Mentally break the race into thirds: easy, steady, strong.");
    tips.push("Prepare for 'the wall' around km 30–35. Shorten stride, focus on cadence.");
    tips.push("Practice your nutrition strategy in training — nothing new on race day!");
  }

  if (tempC != null && tempC > 20) {
    tips.push(`Hot conditions (${tempC}°C) — pour water on your head at aid stations.`);
    tips.push("Consider salt/electrolyte tabs in addition to water.");
  }

  tips.push("Trust your training. Run YOUR race, not someone else's.");
  return tips;
}

function buildFuelingPlan(distanceKm: number): string[] {
  if (distanceKm < 10) {
    return ["No in-race fuel required for most runners. Optional small carb gel at start if desired."];
  }
  if (distanceKm < 21.1) {
    return [
      "Take first gel around 30–35 minutes (roughly km 6–8).",
      "Take additional gel every 30–35 minutes if race exceeds 60 minutes.",
    ];
  }
  return [
    "Take first gel around 25–30 minutes.",
    "Continue with 1 gel every 30 minutes (~every 5–6km depending on pace).",
    "Target 45–70g carbs/hour based on gut tolerance and race intensity.",
  ];
}

function buildHydrationPlan(distanceKm: number, temperatureC?: number | null): string[] {
  const hot = temperatureC != null && temperatureC >= 20;
  if (distanceKm < 10) {
    return hot
      ? ["Drink small amounts at available aid stations due to heat."]
      : ["Hydrate pre-race; in-race hydration is optional for short races."];
  }
  const base = [
    "Take 2–4 mouthfuls at each aid station.",
    "Sip consistently from early race, not only when thirsty.",
  ];
  if (hot) {
    base.push("Use water for cooling (head/neck) at aid stations in warm conditions.");
    base.push("Consider electrolytes if race exceeds 75 minutes.");
  }
  return base;
}

function buildCourseTactics(profile: "flat" | "rolling" | "hilly"): string[] {
  if (profile === "hilly") {
    return [
      "Run hills by effort, not pace — expect slower uphill splits.",
      "Shorten stride and increase cadence on climbs.",
      "Use downhills to recover and regain rhythm without overstriding.",
    ];
  }
  if (profile === "rolling") {
    return [
      "Keep effort steady over rollers and avoid surging early.",
      "Take advantage of gentle descents to settle slightly faster than average pace.",
      "Hold form on each crest before accelerating.",
    ];
  }
  return [
    "Aim for very even effort with a controlled first 10–15%.",
    "Negative split execution should be easier on flat courses — trust the plan.",
    "Use landmarks each kilometer to check posture, breathing, and cadence.",
  ];
}

type RunSample = {
  date: string;
  distance_m: number;
  duration_s: number;
  avg_hr?: number | null;
  max_hr?: number | null;
  name?: string;
};

async function fetchRunSamples(source: "strava" | "garmin", days: number): Promise<RunSample[]> {
  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - days);

  if (source === "strava") {
    const afterTs = Math.floor(afterDate.getTime() / 1000);
    const acts = await stravaClient.getActivities(1, 200, afterTs);
    return acts
      .filter((a) => (a.sport_type || a.type || "").toLowerCase().includes("run"))
      .map((a) => ({
        date: a.start_date_local,
        distance_m: a.distance,
        duration_s: a.moving_time,
        avg_hr: a.average_heartrate ?? null,
        max_hr: a.max_heartrate ?? null,
        name: a.name,
      }));
  }

  const acts = await garminClient.getAllActivities(500);
  return acts
    .filter((a) => {
      const type = a.activityType?.typeKey?.toLowerCase() ?? "";
      return type.includes("run") && new Date(a.startTimeLocal) >= afterDate;
    })
    .map((a) => ({
      date: a.startTimeLocal,
      distance_m: a.distance ?? 0,
      duration_s: a.duration ?? 0,
      avg_hr: a.averageHR ?? null,
      max_hr: a.maxHR ?? null,
      name: a.activityName ?? "Run",
    }));
}

function computeLoadModel(runs: RunSample[], days: number): {
  current: {
    ctl: number;
    atl: number;
    tsb: number;
    acute_chronic_ratio: number;
    fatigue_risk: string;
  };
  daily_load: { date: string; load: number; ctl: number; atl: number; tsb: number }[];
} {
  const byDate = new Map<string, number>();
  const maxHr = Math.max(
    190,
    ...runs.map((r) => r.max_hr ?? 0).filter((n) => Number.isFinite(n) && n > 0)
  );

  for (const run of runs) {
    const key = String(run.date).slice(0, 10);
    const hrFactor = run.avg_hr ? clamp(run.avg_hr / maxHr, 0.65, 1.2) : 0.85;
    const load = (run.duration_s / 60) * hrFactor;
    byDate.set(key, (byDate.get(key) ?? 0) + load);
  }

  const start = new Date();
  start.setDate(start.getDate() - days + 1);
  let ctl = 0;
  let atl = 0;
  const daily: { date: string; load: number; ctl: number; atl: number; tsb: number }[] = [];

  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const load = byDate.get(key) ?? 0;
    atl = atl + (load - atl) * (1 / 7);
    ctl = ctl + (load - ctl) * (1 / 42);
    const tsb = ctl - atl;
    daily.push({
      date: key,
      load: +load.toFixed(1),
      ctl: +ctl.toFixed(1),
      atl: +atl.toFixed(1),
      tsb: +tsb.toFixed(1),
    });
  }

  const acuteAvg = daily.slice(-7).reduce((s, d) => s + d.load, 0) / 7;
  const chronicAvg = daily.slice(-28).reduce((s, d) => s + d.load, 0) / 28;
  const acr = chronicAvg > 0 ? acuteAvg / chronicAvg : 1;
  const fatigueRisk =
    acr > 1.5
      ? "high"
      : acr > 1.3
      ? "elevated"
      : acr < 0.8
      ? "low_load"
      : "balanced";

  const current = daily[daily.length - 1] ?? { ctl: 0, atl: 0, tsb: 0 };
  return {
    current: {
      ctl: current.ctl,
      atl: current.atl,
      tsb: current.tsb,
      acute_chronic_ratio: +acr.toFixed(2),
      fatigue_risk: fatigueRisk,
    },
    daily_load: daily.slice(-21),
  };
}

function pickNumber(obj: unknown, paths: string[]): number | null {
  for (const p of paths) {
    const v = getByPath(obj as any, p);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function getByPath(obj: any, path: string): any {
  if (!obj || typeof obj !== "object") return undefined;
  const parts = path.split(".");
  let cur: any = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  const day = out.getDay(); // 0 Sunday
  const shift = day === 0 ? -6 : 1 - day; // Monday start
  out.setHours(0, 0, 0, 0);
  out.setDate(out.getDate() + shift);
  return out;
}

function summarizeRunBlock(runs: RunSample[]): {
  runs: number;
  total_km: number;
  total_time: string;
  avg_pace: string;
  avg_hr: number | null;
  longest_run_km: number;
  hard_sessions: number;
} {
  if (runs.length === 0) {
    return {
      runs: 0,
      total_km: 0,
      total_time: "0m 0s",
      avg_pace: "N/A",
      avg_hr: null,
      longest_run_km: 0,
      hard_sessions: 0,
    };
  }

  const totalDist = runs.reduce((s, r) => s + r.distance_m, 0);
  const totalDur = runs.reduce((s, r) => s + r.duration_s, 0);
  const hrs = runs.map((r) => r.avg_hr).filter((n): n is number => n != null);
  const maxHr = Math.max(190, ...runs.map((r) => r.max_hr ?? 0).filter((n) => n > 0));
  const hard = runs.filter((r) => {
    const pace = r.duration_s > 0 ? r.duration_s / (r.distance_m / 1000) : Infinity;
    const hrHard = r.avg_hr ? r.avg_hr / maxHr > 0.85 : false;
    return pace < 300 || hrHard;
  }).length;

  return {
    runs: runs.length,
    total_km: +((totalDist || 0) / 1000).toFixed(1),
    total_time: formatDuration(totalDur),
    avg_pace: totalDur > 0 && totalDist > 0 ? fmtPace(totalDur / (totalDist / 1000)) : "N/A",
    avg_hr: hrs.length ? Math.round(hrs.reduce((s, h) => s + h, 0) / hrs.length) : null,
    longest_run_km: +(Math.max(...runs.map((r) => r.distance_m), 0) / 1000).toFixed(1),
    hard_sessions: hard,
  };
}

function isPlannedRun(type: string): boolean {
  return ["easy_run", "long_run", "tempo", "intervals", "recovery", "race"].includes(type);
}

function bestWindowFromSplits(
  splits: { distance: number; moving_time: number }[] | undefined,
  targetMeters: number
): number | null {
  if (!splits || splits.length === 0) return null;
  let best: number | null = null;

  for (let i = 0; i < splits.length; i++) {
    let dist = 0;
    let time = 0;
    for (let j = i; j < splits.length; j++) {
      const segDist = splits[j].distance;
      const segTime = splits[j].moving_time;
      if (dist + segDist >= targetMeters) {
        const remain = targetMeters - dist;
        const ratio = segDist > 0 ? remain / segDist : 0;
        time += segTime * ratio;
        best = best == null ? time : Math.min(best, time);
        break;
      }
      dist += segDist;
      time += segTime;
    }
  }
  return best;
}

function bestWindowFromStreams(
  distance: number[],
  time: number[],
  targetMeters: number
): number | null {
  if (!distance.length || !time.length || distance.length !== time.length) return null;
  let best: number | null = null;
  let j = 0;

  for (let i = 0; i < distance.length; i++) {
    const startDist = distance[i];
    const startTime = time[i];
    const goalDist = startDist + targetMeters;

    while (j < distance.length && distance[j] < goalDist) j++;
    if (j >= distance.length) break;

    const endTime = interpolateTimeAtDistance(distance, time, j, goalDist);
    if (endTime == null) continue;
    const elapsed = endTime - startTime;
    if (elapsed <= 0) continue;
    best = best == null ? elapsed : Math.min(best, elapsed);
  }

  return best;
}

function interpolateTimeAtDistance(
  distance: number[],
  time: number[],
  idx: number,
  targetDist: number
): number | null {
  if (idx <= 0 || idx >= distance.length) return null;
  const d1 = distance[idx - 1];
  const d2 = distance[idx];
  const t1 = time[idx - 1];
  const t2 = time[idx];
  if (d2 <= d1) return t2;
  const ratio = (targetDist - d1) / (d2 - d1);
  return t1 + (t2 - t1) * ratio;
}
