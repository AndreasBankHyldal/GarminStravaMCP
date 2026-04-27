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

  server.tool(
    "race_day_strategy",
    `Create a detailed race day pacing strategy. Uses your actual training data, personal records, and running science (VDOT equivalent tables, negative split pacing, HR zone targets) to build a km-by-km plan. Accounts for race distance, goal time, elevation, and conditions.`,
    {
      race_distance_km: z.number().describe("Race distance in km (e.g. 5, 10, 21.1, 42.2)"),
      goal_time_minutes: z.number().optional().describe("Goal finish time in minutes (e.g. 25 for a 25min 5K, 105 for 1:45 half). If omitted, estimates from your data."),
      elevation_gain_m: z.number().optional().describe("Expected elevation gain in meters. Adds pace adjustment for hills."),
      temperature_c: z.number().optional().describe("Expected temperature in Celsius. Adds heat adjustment above 15°C."),
      course_profile: z.enum(["flat", "rolling", "hilly"]).optional().describe("Course terrain profile"),
    },
    async ({ race_distance_km, goal_time_minutes, elevation_gain_m, temperature_c, course_profile }) => {
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

