import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db/database.js";
import crypto from "node:crypto";
import * as garminClient from "../garmin/client.js";
import * as stravaClient from "../strava/client.js";

export function registerPlanningTools(server: McpServer): void {
  server.tool(
    "create_training_plan",
    "Create a multi-week training plan. Optionally syncs workouts to Garmin Connect calendar (scheduled on the correct dates, visible on your watch).",
    {
      name: z.string().describe("Plan name (e.g. 'Half Marathon Build')"),
      description: z.string().optional().describe("Plan description"),
      start_date: z.string().describe("Plan start date (ISO 8601)"),
      end_date: z.string().optional().describe("Plan end date (ISO 8601)"),
      goal: z.string().optional().describe("Goal for this plan (e.g. 'Sub-2h half marathon')"),
      sync_to_garmin: z.boolean().default(false).describe("If true, creates workouts on Garmin Connect and schedules them on the correct dates in your Garmin calendar. They will sync to your watch."),
      workouts: z
        .array(
          z.object({
            date: z.string().describe("Workout date (ISO 8601)"),
            workout_type: z
              .enum(["easy_run", "long_run", "tempo", "intervals", "recovery", "rest", "race", "cross_training"])
              .describe("Type of workout"),
            description: z.string().optional().describe("Workout description"),
            target_distance_km: z.number().optional().describe("Target distance in km"),
            target_duration_minutes: z.number().optional().describe("Target duration in minutes"),
            target_pace_per_km: z.string().optional().describe("Target pace (e.g. '5:30')"),
            intensity: z
              .enum(["easy", "moderate", "tempo", "threshold", "interval", "race"])
              .optional()
              .describe("Workout intensity"),
          })
        )
        .describe("Array of planned workouts"),
    },
    async ({ name, description, start_date, end_date, goal, sync_to_garmin, workouts }) => {
      try {
        const db = getDb();
        const planId = crypto.randomUUID();

        db.prepare(
          `INSERT INTO training_plans (id, name, description, start_date, end_date, goal) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(planId, name, description ?? null, start_date, end_date ?? null, goal ?? null);

        const insertWorkout = db.prepare(
          `INSERT INTO planned_workouts (plan_id, date, workout_type, description, target_distance_km, target_duration_minutes, target_pace_per_km, intensity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );

        const insertMany = db.transaction((wkts: typeof workouts) => {
          for (const w of wkts) {
            insertWorkout.run(
              planId,
              w.date,
              w.workout_type,
              w.description ?? null,
              w.target_distance_km ?? null,
              w.target_duration_minutes ?? null,
              w.target_pace_per_km ?? null,
              w.intensity ?? null
            );
          }
        });

        insertMany(workouts);

        let garminSyncResult: any = null;
        if (sync_to_garmin) {
          const planWorkouts = db
            .prepare("SELECT * FROM planned_workouts WHERE plan_id = ? ORDER BY date")
            .all(planId) as any[];
          garminSyncResult = await syncPlanToGarmin(db, planId, name, planWorkouts, {
            deleteOrphans: false,
          });
        }

        const result: any = {
          success: true,
          plan_id: planId,
          name,
          workouts_count: workouts.length,
          message: `Training plan "${name}" created with ${workouts.length} workouts.`,
        };

        if (sync_to_garmin && garminSyncResult) {
          result.garmin_sync = garminSyncResult;
          if (garminSyncResult.scheduled > 0 || garminSyncResult.rescheduled > 0) {
            result.message += ` ${garminSyncResult.scheduled + garminSyncResult.rescheduled} workouts synced to your Garmin calendar — they'll appear on your watch.`;
          }
        }

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
    "get_training_plan",
    "Get a training plan and its workouts. If no plan_id is given, returns the most recent plan.",
    {
      plan_id: z.string().optional().describe("Plan ID (omit for most recent plan)"),
    },
    async ({ plan_id }) => {
      try {
        const db = getDb();

        let plan: any;
        if (plan_id) {
          plan = db.prepare("SELECT * FROM training_plans WHERE id = ?").get(plan_id);
        } else {
          plan = db
            .prepare("SELECT * FROM training_plans ORDER BY created_at DESC LIMIT 1")
            .get();
        }

        if (!plan) {
          return {
            content: [
              {
                type: "text",
                text: "No training plan found. Use create_training_plan to create one.",
              },
            ],
          };
        }

        const workouts = db
          .prepare(
            "SELECT * FROM planned_workouts WHERE plan_id = ? ORDER BY date"
          )
          .all(plan.id);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ plan, workouts }, null, 2),
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
    "update_training_plan",
    "Update a training plan: modify plan metadata or individual workouts.",
    {
      plan_id: z.string().describe("Plan ID to update"),
      name: z.string().optional().describe("New plan name"),
      description: z.string().optional().describe("New description"),
      goal: z.string().optional().describe("New goal"),
      update_workouts: z
        .array(
          z.object({
            workout_id: z.number().describe("Workout row ID to update"),
            date: z.string().optional(),
            workout_type: z.string().optional(),
            description: z.string().optional(),
            target_distance_km: z.number().optional(),
            target_duration_minutes: z.number().optional(),
            target_pace_per_km: z.string().optional(),
            intensity: z.string().optional(),
            completed: z.boolean().optional(),
            notes: z.string().optional(),
          })
        )
        .optional()
        .describe("Workouts to update"),
      add_workouts: z
        .array(
          z.object({
            date: z.string(),
            workout_type: z.string(),
            description: z.string().optional(),
            target_distance_km: z.number().optional(),
            target_duration_minutes: z.number().optional(),
            target_pace_per_km: z.string().optional(),
            intensity: z.string().optional(),
          })
        )
        .optional()
        .describe("New workouts to add to the plan"),
      sync_to_garmin: z
        .boolean()
        .default(false)
        .describe("If true, perform smart delta-sync to Garmin calendar after updating."),
    },
    async ({ plan_id, name, description, goal, update_workouts, add_workouts, sync_to_garmin }) => {
      try {
        const db = getDb();

        // Update plan metadata
        if (name || description || goal) {
          const sets: string[] = [];
          const vals: any[] = [];
          if (name) { sets.push("name = ?"); vals.push(name); }
          if (description) { sets.push("description = ?"); vals.push(description); }
          if (goal) { sets.push("goal = ?"); vals.push(goal); }
          sets.push("updated_at = datetime('now')");
          vals.push(plan_id);
          db.prepare(`UPDATE training_plans SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
        }

        // Update existing workouts
        if (update_workouts?.length) {
          for (const w of update_workouts) {
            const sets: string[] = [];
            const vals: any[] = [];
            if (w.date) { sets.push("date = ?"); vals.push(w.date); }
            if (w.workout_type) { sets.push("workout_type = ?"); vals.push(w.workout_type); }
            if (w.description) { sets.push("description = ?"); vals.push(w.description); }
            if (w.target_distance_km !== undefined) { sets.push("target_distance_km = ?"); vals.push(w.target_distance_km); }
            if (w.target_duration_minutes !== undefined) { sets.push("target_duration_minutes = ?"); vals.push(w.target_duration_minutes); }
            if (w.target_pace_per_km) { sets.push("target_pace_per_km = ?"); vals.push(w.target_pace_per_km); }
            if (w.intensity) { sets.push("intensity = ?"); vals.push(w.intensity); }
            if (w.completed !== undefined) { sets.push("completed = ?"); vals.push(w.completed ? 1 : 0); }
            if (w.notes) { sets.push("notes = ?"); vals.push(w.notes); }

            if (sets.length > 0) {
              vals.push(w.workout_id);
              db.prepare(`UPDATE planned_workouts SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
            }
          }
        }

        // Add new workouts
        if (add_workouts?.length) {
          const insert = db.prepare(
            `INSERT INTO planned_workouts (plan_id, date, workout_type, description, target_distance_km, target_duration_minutes, target_pace_per_km, intensity)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          );
          for (const w of add_workouts) {
            insert.run(plan_id, w.date, w.workout_type, w.description ?? null, w.target_distance_km ?? null, w.target_duration_minutes ?? null, w.target_pace_per_km ?? null, w.intensity ?? null);
          }
        }

        let garminSyncResult: any = null;
        if (sync_to_garmin) {
          const plan = db.prepare("SELECT id, name FROM training_plans WHERE id = ?").get(plan_id) as any;
          if (!plan) {
            throw new Error(`Plan ${plan_id} not found`);
          }
          const workouts = db
            .prepare("SELECT * FROM planned_workouts WHERE plan_id = ? ORDER BY date")
            .all(plan_id) as any[];
          garminSyncResult = await syncPlanToGarmin(db, plan_id, plan.name, workouts, {
            deleteOrphans: true,
          });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "Training plan updated successfully.",
                updated_workouts: update_workouts?.length ?? 0,
                added_workouts: add_workouts?.length ?? 0,
                garmin_sync: garminSyncResult,
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

  server.tool(
    "sync_training_plan_to_garmin",
    "Smart delta-sync of a training plan to Garmin calendar. Creates, updates, reschedules, and removes workouts as needed.",
    {
      plan_id: z.string().optional().describe("Plan ID (omit for most recent plan)"),
      delete_orphans: z.boolean().default(true).describe("Delete workouts on Garmin that no longer exist in the training plan"),
    },
    async ({ plan_id, delete_orphans }) => {
      try {
        const db = getDb();
        const plan = (plan_id
          ? db.prepare("SELECT * FROM training_plans WHERE id = ?").get(plan_id)
          : db.prepare("SELECT * FROM training_plans ORDER BY created_at DESC LIMIT 1").get()) as any;

        if (!plan) {
          return {
            content: [{ type: "text", text: "No training plan found to sync." }],
            isError: true,
          };
        }

        const workouts = db
          .prepare("SELECT * FROM planned_workouts WHERE plan_id = ? ORDER BY date")
          .all(plan.id) as any[];

        const sync = await syncPlanToGarmin(db, plan.id, plan.name, workouts, {
          deleteOrphans: delete_orphans,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                plan_id: plan.id,
                plan_name: plan.name,
                ...sync,
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
    "adjust_training_plan",
    "Adaptive training plan engine. Analyzes compliance and recent load, then proposes (or applies) updates to upcoming workouts.",
    {
      plan_id: z.string().optional().describe("Plan ID (omit for most recent plan)"),
      source: z.enum(["strava", "garmin"]).default("strava").describe("Activity source used for compliance/load analysis"),
      mode: z.enum(["preview", "apply"]).default("preview").describe("Preview recommendations or apply changes directly"),
      aggressiveness: z.enum(["conservative", "balanced", "aggressive"]).default("balanced").describe("How strongly to adjust"),
      lookback_days: z.number().min(7).max(56).default(14).describe("How many days back to evaluate"),
    },
    async ({ plan_id, source, mode, aggressiveness, lookback_days }) => {
      try {
        const db = getDb();
        const plan = (plan_id
          ? db.prepare("SELECT * FROM training_plans WHERE id = ?").get(plan_id)
          : db.prepare("SELECT * FROM training_plans ORDER BY created_at DESC LIMIT 1").get()) as any;

        if (!plan) {
          return {
            content: [{ type: "text", text: "No training plan found." }],
            isError: true,
          };
        }

        const workouts = db
          .prepare("SELECT * FROM planned_workouts WHERE plan_id = ? ORDER BY date")
          .all(plan.id) as any[];

        const today = new Date();
        const lookbackStart = new Date(today);
        lookbackStart.setDate(today.getDate() - lookback_days);
        const adjustmentWindowEnd = new Date(today);
        adjustmentWindowEnd.setDate(today.getDate() + 14);

        const historical = workouts.filter((w) => {
          const d = new Date(w.date);
          return d >= lookbackStart && d < today;
        });
        const upcoming = workouts.filter((w) => {
          const d = new Date(w.date);
          return d >= today && d <= adjustmentWindowEnd;
        });

        const actualRuns = await fetchActualRuns(source, lookbackStart, today);
        const byDate = new Map<string, any[]>();
        for (const run of actualRuns) {
          const key = run.date.slice(0, 10);
          if (!byDate.has(key)) byDate.set(key, []);
          byDate.get(key)!.push(run);
        }

        let completed = 0;
        let partial = 0;
        let missed = 0;
        let planned = 0;

        for (const w of historical) {
          if (!isRunnableWorkout(w.workout_type)) continue;
          planned++;
          const dayRuns = byDate.get(String(w.date).slice(0, 10)) ?? [];
          if (dayRuns.length === 0) {
            missed++;
            continue;
          }
          const best = dayRuns[0];
          if (w.target_distance_km && best.distance_km) {
            const ratio = Math.abs(best.distance_km - w.target_distance_km) / Math.max(w.target_distance_km, 0.1);
            if (ratio <= 0.2) completed++;
            else partial++;
          } else {
            completed++;
          }
        }

        const complianceRate = planned > 0 ? (completed + partial * 0.5) / planned : 1;
        const load = computeLoadSnapshot(actualRuns, today);

        let volumeFactor = 1;
        let intensityAction: "down" | "same" | "up" = "same";

        if (complianceRate < 0.6 || load.acute_chronic_ratio > 1.3) {
          volumeFactor = aggressiveness === "conservative" ? 0.8 : aggressiveness === "aggressive" ? 0.9 : 0.85;
          intensityAction = "down";
        } else if (complianceRate > 0.85 && load.acute_chronic_ratio < 0.95) {
          volumeFactor = aggressiveness === "aggressive" ? 1.08 : aggressiveness === "conservative" ? 1.03 : 1.05;
          intensityAction = "up";
        } else if (load.acute_chronic_ratio > 1.5) {
          volumeFactor = 0.8;
          intensityAction = "down";
        }

        const proposals: any[] = [];
        for (const w of upcoming) {
          if (!isRunnableWorkout(w.workout_type)) continue;
          const proposedType =
            intensityAction === "down"
              ? lowerIntensityWorkoutType(w.workout_type)
              : intensityAction === "up"
              ? raiseIntensityWorkoutType(w.workout_type)
              : w.workout_type;

          const newDistance =
            w.target_distance_km != null
              ? roundToTenth(Math.max(1, w.target_distance_km * volumeFactor))
              : null;
          const newDuration =
            w.target_duration_minutes != null
              ? Math.max(15, Math.round(w.target_duration_minutes * volumeFactor))
              : null;

          const changed =
            proposedType !== w.workout_type ||
            (newDistance != null && newDistance !== w.target_distance_km) ||
            (newDuration != null && newDuration !== w.target_duration_minutes);

          if (!changed) continue;

          proposals.push({
            workout_id: w.id,
            date: w.date,
            original: {
              workout_type: w.workout_type,
              target_distance_km: w.target_distance_km,
              target_duration_minutes: w.target_duration_minutes,
            },
            proposed: {
              workout_type: proposedType,
              target_distance_km: newDistance,
              target_duration_minutes: newDuration,
            },
            reason:
              intensityAction === "down"
                ? "High fatigue/load or low compliance"
                : intensityAction === "up"
                ? "Good compliance with manageable load"
                : "Minor optimization",
          });
        }

        if (mode === "apply" && proposals.length > 0) {
          const updateStmt = db.prepare(
            "UPDATE planned_workouts SET workout_type = ?, target_distance_km = ?, target_duration_minutes = ?, notes = ? WHERE id = ?"
          );
          const tx = db.transaction((items: typeof proposals) => {
            for (const p of items) {
              const note = `[auto-adjust ${new Date().toISOString().slice(0, 10)}] ${p.reason}`;
              updateStmt.run(
                p.proposed.workout_type,
                p.proposed.target_distance_km,
                p.proposed.target_duration_minutes,
                note,
                p.workout_id
              );
            }
          });
          tx(proposals);
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                mode,
                plan_id: plan.id,
                plan_name: plan.name,
                analysis_window_days: lookback_days,
                compliance: {
                  planned,
                  completed,
                  partial,
                  missed,
                  compliance_rate: `${(complianceRate * 100).toFixed(0)}%`,
                },
                load_snapshot: load,
                strategy: {
                  aggressiveness,
                  volume_factor: volumeFactor,
                  intensity_action: intensityAction,
                },
                upcoming_workouts_checked: upcoming.length,
                adjustments_count: proposals.length,
                adjustments: proposals,
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
    "check_plan_compliance",
    "Compare planned workouts against actual completed activities to check plan adherence.",
    {
      plan_id: z.string().optional().describe("Plan ID (omit for most recent plan)"),
      source: z.enum(["strava", "garmin"]).default("strava").describe("Activity data source"),
    },
    async ({ plan_id, source }) => {
      try {
        const db = getDb();

        let plan: any;
        if (plan_id) {
          plan = db.prepare("SELECT * FROM training_plans WHERE id = ?").get(plan_id);
        } else {
          plan = db.prepare("SELECT * FROM training_plans ORDER BY created_at DESC LIMIT 1").get();
        }

        if (!plan) {
          return {
            content: [{ type: "text", text: "No training plan found." }],
          };
        }

        const workouts = db
          .prepare("SELECT * FROM planned_workouts WHERE plan_id = ? ORDER BY date")
          .all(plan.id) as any[];

        // Fetch actual activities for the plan period
        const startDate = new Date(plan.start_date);
        const endDate = plan.end_date ? new Date(plan.end_date) : new Date();

        let actualActivities: any[];

        if (source === "strava") {
          const afterTs = Math.floor(startDate.getTime() / 1000);
          const beforeTs = Math.floor(endDate.getTime() / 1000);
          const activities = await (await import("../strava/client.js")).getActivities(1, 100, afterTs, beforeTs);
          actualActivities = activities.map((a) => ({
            date: a.start_date_local.split("T")[0],
            distance_km: a.distance / 1000,
            duration_min: a.moving_time / 60,
            type: a.sport_type || a.type,
            name: a.name,
          }));
        } else {
          const garminActs = await (await import("../garmin/client.js")).getActivities(0, 100);
          actualActivities = garminActs
            .filter((a) => {
              const d = new Date(a.startTimeLocal);
              return d >= startDate && d <= endDate;
            })
            .map((a) => ({
              date: a.startTimeLocal.split("T")[0],
              distance_km: (a.distance ?? 0) / 1000,
              duration_min: (a.duration ?? 0) / 60,
              type: a.activityType?.typeKey ?? "unknown",
              name: a.activityName,
            }));
        }

        // Match planned vs actual
        const compliance = workouts.map((w: any) => {
          const plannedDate = w.date.split("T")[0];
          const matching = actualActivities.filter(
            (a) => a.date === plannedDate
          );

          const bestMatch = matching.length > 0 ? matching[0] : null;

          let status = "missed";
          let distanceMatch = false;

          if (bestMatch && w.target_distance_km) {
            distanceMatch =
              Math.abs(bestMatch.distance_km - w.target_distance_km) / w.target_distance_km < 0.15;
            status = distanceMatch ? "completed" : "partial";
          } else if (bestMatch) {
            status = "completed";
          }

          if (w.workout_type === "rest") {
            status = "rest_day";
          }

          return {
            date: plannedDate,
            planned: {
              type: w.workout_type,
              distance_km: w.target_distance_km,
              duration_min: w.target_duration_minutes,
              pace: w.target_pace_per_km,
            },
            actual: bestMatch
              ? {
                  name: bestMatch.name,
                  distance_km: bestMatch.distance_km.toFixed(2),
                  duration_min: bestMatch.duration_min.toFixed(0),
                }
              : null,
            status,
          };
        });

        const completed = compliance.filter((c) => c.status === "completed").length;
        const partial = compliance.filter((c) => c.status === "partial").length;
        const missed = compliance.filter((c) => c.status === "missed").length;
        const restDays = compliance.filter((c) => c.status === "rest_day").length;
        const total = compliance.length - restDays;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  plan: { name: plan.name, goal: plan.goal },
                  summary: {
                    total_workouts: total,
                    completed,
                    partial,
                    missed,
                    rest_days: restDays,
                    compliance_rate: total > 0 ? `${((completed / total) * 100).toFixed(0)}%` : "N/A",
                  },
                  details: compliance,
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

function formatWorkoutType(type: string): string {
  const labels: Record<string, string> = {
    easy_run: "Easy Run",
    long_run: "Long Run",
    tempo: "Tempo Run",
    intervals: "Intervals",
    recovery: "Recovery Run",
    rest: "Rest Day",
    race: "Race",
    cross_training: "Cross Training",
  };
  return labels[type] ?? type;
}

function buildGarminDescription(w: {
  workout_type: string;
  description?: string;
  target_distance_km?: number;
  target_duration_minutes?: number;
  target_pace_per_km?: string;
  intensity?: string;
}): string {
  const parts: string[] = [];
  if (w.description) parts.push(w.description);
  if (w.target_distance_km) parts.push(`Distance: ${w.target_distance_km} km`);
  if (w.target_duration_minutes) parts.push(`Duration: ${w.target_duration_minutes} min`);
  if (w.target_pace_per_km) parts.push(`Target pace: ${w.target_pace_per_km} /km`);
  if (w.intensity) parts.push(`Intensity: ${w.intensity}`);
  return parts.join(" | ") || formatWorkoutType(w.workout_type);
}

/** Parse a pace string like "5:30" into decimal minutes (5.5) */
function parsePace(pace: string): number {
  const parts = pace.split(":");
  const mins = parseInt(parts[0], 10);
  const secs = parts[1] ? parseInt(parts[1], 10) : 0;
  return mins + secs / 60;
}

/**
 * Convert a planned workout into structured Garmin steps.
 * Uses workout_type, target_distance_km, target_pace_per_km, and intensity
 * to create appropriate warmup → work → cooldown structures.
 */
function buildWorkoutSteps(w: {
  workout_type: string;
  target_distance_km?: number;
  target_duration_minutes?: number;
  target_pace_per_km?: string;
  intensity?: string;
  description?: string;
}): garminClient.WorkoutStepInput[] {
  const totalDist = (w.target_distance_km ?? 5) * 1000; // meters
  const pace = w.target_pace_per_km ? parsePace(w.target_pace_per_km) : null;

  // Pace window: ±15 seconds/km around target
  const paceMin = pace ? pace + 0.25 : undefined; // slower
  const paceMax = pace ? Math.max(pace - 0.25, 2.5) : undefined; // faster

  switch (w.workout_type) {
    case "intervals": {
      // Structure: warmup → N×(interval + recovery) → cooldown
      const warmupDist = Math.min(2000, Math.round(totalDist * 0.2));
      const cooldownDist = Math.min(1500, Math.round(totalDist * 0.15));
      const workDist = totalDist - warmupDist - cooldownDist;

      // Default: 800m intervals with 90s recovery
      let intervalDist = 800;
      let recoverySeconds = 90;

      // Scale intervals based on total distance
      if (workDist > 8000) {
        intervalDist = 1000;
        recoverySeconds = 120;
      } else if (workDist < 3000) {
        intervalDist = 400;
        recoverySeconds = 60;
      }

      const reps = Math.max(2, Math.round(workDist / (intervalDist + 200))); // rough estimate

      // Interval pace: ~30-40s faster than target pace
      const intPaceMin = pace ? pace - 0.3 : undefined;
      const intPaceMax = pace ? Math.max(pace - 0.7, 2.5) : undefined;

      return [
        { type: "warmup", distance_meters: warmupDist, description: "Easy jog warmup" },
        {
          type: "interval",
          distance_meters: intervalDist,
          repeat: reps,
          description: `${intervalDist}m fast`,
          target_pace_min_per_km: intPaceMin,
          target_pace_max_per_km: intPaceMax,
        },
        { type: "recovery", duration_seconds: recoverySeconds, description: "Jog/walk recovery" },
        { type: "cooldown", distance_meters: cooldownDist, description: "Easy jog cooldown" },
      ];
    }

    case "tempo": {
      // Structure: warmup → tempo block → cooldown
      const warmupDist = Math.min(2000, Math.round(totalDist * 0.2));
      const cooldownDist = Math.min(1500, Math.round(totalDist * 0.15));
      const tempoDist = totalDist - warmupDist - cooldownDist;

      return [
        { type: "warmup", distance_meters: warmupDist, description: "Easy jog warmup" },
        {
          type: "interval",
          distance_meters: tempoDist,
          description: "Tempo effort — comfortably hard",
          target_pace_min_per_km: paceMin,
          target_pace_max_per_km: paceMax,
        },
        { type: "cooldown", distance_meters: cooldownDist, description: "Easy jog cooldown" },
      ];
    }

    case "long_run": {
      // Structure: easy start → main block at pace → optional finish fast
      const warmupDist = Math.min(2000, Math.round(totalDist * 0.1));
      const finishDist = Math.round(totalDist * 0.1);
      const mainDist = totalDist - warmupDist - finishDist;

      // Long runs are easy pace
      const easyPaceMin = pace ? pace + 0.5 : undefined;
      const easyPaceMax = pace ? pace : undefined;

      return [
        {
          type: "warmup",
          distance_meters: warmupDist,
          description: "Start easy, settle into rhythm",
        },
        {
          type: "interval",
          distance_meters: mainDist,
          description: "Steady long run pace",
          target_pace_min_per_km: easyPaceMin,
          target_pace_max_per_km: easyPaceMax,
        },
        {
          type: "cooldown",
          distance_meters: finishDist,
          description: "Easy to finish — strong if you feel good",
        },
      ];
    }

    case "easy_run":
    case "recovery": {
      // Simple: warmup → easy run → cooldown (all easy pace)
      if (totalDist <= 4000) {
        // Short easy run — just a single step
        return [
          {
            type: "warmup",
            distance_meters: totalDist,
            description: "Easy effort — keep it relaxed",
            target_pace_min_per_km: pace ? pace + 0.5 : undefined,
            target_pace_max_per_km: paceMax,
          },
        ];
      }
      const warmupDist = Math.round(totalDist * 0.15);
      const mainDist = Math.round(totalDist * 0.7);
      const cooldownDist = totalDist - warmupDist - mainDist;
      return [
        { type: "warmup", distance_meters: warmupDist, description: "Gentle start" },
        {
          type: "interval",
          distance_meters: mainDist,
          description: "Easy, conversational pace",
          target_pace_min_per_km: pace ? pace + 0.5 : undefined,
          target_pace_max_per_km: paceMax,
        },
        { type: "cooldown", distance_meters: cooldownDist, description: "Easy cooldown" },
      ];
    }

    case "race": {
      // Race: warmup → race effort → cooldown
      const warmupDist = 1500;
      const cooldownDist = 1000;
      const raceDist = Math.max(totalDist - warmupDist - cooldownDist, totalDist * 0.8);
      return [
        { type: "warmup", distance_meters: warmupDist, description: "Pre-race warmup jog" },
        {
          type: "interval",
          distance_meters: raceDist,
          description: "Race pace!",
          target_pace_min_per_km: paceMin,
          target_pace_max_per_km: paceMax,
        },
        { type: "cooldown", distance_meters: cooldownDist, description: "Cooldown" },
      ];
    }

    default:
      // Unknown type — return empty (will fall back to simple distance run)
      return [];
  }
}

function roundToTenth(n: number): number {
  return Math.round(n * 10) / 10;
}

function normalizeDateKey(dateStr: string): string {
  if (dateStr.length >= 10) return dateStr.slice(0, 10);
  return new Date(dateStr).toISOString().slice(0, 10);
}

function isRunnableWorkout(workoutType: string): boolean {
  return workoutType !== "rest" && workoutType !== "cross_training";
}

function lowerIntensityWorkoutType(type: string): string {
  switch (type) {
    case "intervals":
      return "tempo";
    case "tempo":
      return "easy_run";
    case "race":
      return "tempo";
    default:
      return type;
  }
}

function raiseIntensityWorkoutType(type: string): string {
  switch (type) {
    case "easy_run":
      return "tempo";
    case "tempo":
      return "intervals";
    default:
      return type;
  }
}

function computeWorkoutHash(w: any): string {
  const payload = {
    workout_type: w.workout_type,
    description: w.description ?? "",
    target_distance_km: w.target_distance_km ?? null,
    target_duration_minutes: w.target_duration_minutes ?? null,
    target_pace_per_km: w.target_pace_per_km ?? null,
    intensity: w.intensity ?? null,
  };
  return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

async function syncPlanToGarmin(
  db: any,
  planId: string,
  planName: string,
  workouts: any[],
  options: { deleteOrphans: boolean }
): Promise<{
  scheduled: number;
  rescheduled: number;
  replaced: number;
  unchanged: number;
  removed: number;
  failed: number;
  details: { workout_id: number; date: string; action: string; status: string; garmin_workout_id?: string }[];
}> {
  const details: { workout_id: number; date: string; action: string; status: string; garmin_workout_id?: string }[] = [];
  let scheduled = 0;
  let rescheduled = 0;
  let replaced = 0;
  let unchanged = 0;
  let removed = 0;
  let failed = 0;

  const mappings = db
    .prepare("SELECT * FROM garmin_workout_sync WHERE plan_id = ?")
    .all(planId) as any[];
  const mappingByWorkoutId = new Map<number, any>();
  for (const m of mappings) mappingByWorkoutId.set(m.planned_workout_id, m);

  const runnable = workouts.filter((w) => isRunnableWorkout(w.workout_type));
  const runnableIds = new Set<number>(runnable.map((w) => Number(w.id)));

  // Remove Garmin workouts that no longer exist in plan.
  if (options.deleteOrphans) {
    for (const m of mappings) {
      if (!runnableIds.has(Number(m.planned_workout_id))) {
        try {
          await garminClient.deleteWorkout(String(m.garmin_workout_id));
          removed++;
          details.push({
            workout_id: Number(m.planned_workout_id),
            date: m.scheduled_date,
            action: "delete-orphan",
            status: "deleted",
            garmin_workout_id: String(m.garmin_workout_id),
          });
        } catch (err: any) {
          failed++;
          details.push({
            workout_id: Number(m.planned_workout_id),
            date: m.scheduled_date,
            action: "delete-orphan",
            status: `failed: ${err.message}`,
            garmin_workout_id: String(m.garmin_workout_id),
          });
        } finally {
          db.prepare("DELETE FROM garmin_workout_sync WHERE planned_workout_id = ?").run(
            m.planned_workout_id
          );
        }
      }
    }
  }

  const upsertMapping = db.prepare(`
    INSERT OR REPLACE INTO garmin_workout_sync (
      planned_workout_id, plan_id, garmin_workout_id, last_workout_hash, scheduled_date, last_sync_status, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  for (const w of runnable) {
    const workoutId = Number(w.id);
    const dateKey = normalizeDateKey(String(w.date));
    const hash = computeWorkoutHash(w);
    const existing = mappingByWorkoutId.get(workoutId);

    if (
      existing &&
      existing.last_workout_hash === hash &&
      normalizeDateKey(String(existing.scheduled_date)) === dateKey
    ) {
      unchanged++;
      details.push({
        workout_id: workoutId,
        date: dateKey,
        action: "noop",
        status: "unchanged",
        garmin_workout_id: String(existing.garmin_workout_id),
      });
      continue;
    }

    // Unchanged workout content but date moved: just reschedule.
    if (existing && existing.last_workout_hash === hash) {
      try {
        await garminClient.scheduleWorkout(String(existing.garmin_workout_id), new Date(dateKey));
        upsertMapping.run(
          workoutId,
          planId,
          String(existing.garmin_workout_id),
          hash,
          dateKey,
          "rescheduled"
        );
        rescheduled++;
        details.push({
          workout_id: workoutId,
          date: dateKey,
          action: "reschedule",
          status: "rescheduled",
          garmin_workout_id: String(existing.garmin_workout_id),
        });
      } catch (err: any) {
        failed++;
        details.push({
          workout_id: workoutId,
          date: dateKey,
          action: "reschedule",
          status: `failed: ${err.message}`,
          garmin_workout_id: String(existing.garmin_workout_id),
        });
      }
      continue;
    }

    // Changed workout content: replace workout on Garmin.
    if (existing) {
      try {
        await garminClient.deleteWorkout(String(existing.garmin_workout_id));
      } catch {
        // Best effort deletion; continue with replacement.
      }
    }

    try {
      const workoutName = `${planName} — ${formatWorkoutType(w.workout_type)}`;
      const workoutDesc = buildGarminDescription(w);
      const steps = buildWorkoutSteps(w);

      let created: any;
      if (steps.length > 0) {
        const payload = garminClient.buildStructuredWorkout(workoutName, workoutDesc, steps);
        created = await garminClient.addStructuredWorkout(payload);
      } else {
        const distanceMeters = (w.target_distance_km ?? 5) * 1000;
        created = await garminClient.addRunningWorkout(workoutName, distanceMeters, workoutDesc);
      }

      const newGarminWorkoutId = String(created?.workoutId ?? created?.id ?? "");
      if (!newGarminWorkoutId) {
        throw new Error("Garmin did not return workout ID");
      }

      await garminClient.scheduleWorkout(newGarminWorkoutId, new Date(dateKey));
      upsertMapping.run(workoutId, planId, newGarminWorkoutId, hash, dateKey, "scheduled");

      if (existing) replaced++;
      else scheduled++;

      details.push({
        workout_id: workoutId,
        date: dateKey,
        action: existing ? "replace" : "create",
        status: "scheduled",
        garmin_workout_id: newGarminWorkoutId,
      });
    } catch (err: any) {
      failed++;
      details.push({
        workout_id: workoutId,
        date: dateKey,
        action: existing ? "replace" : "create",
        status: `failed: ${err.message}`,
      });
    }
  }

  return { scheduled, rescheduled, replaced, unchanged, removed, failed, details };
}

type ActualRun = {
  date: string;
  distance_km: number;
  duration_min: number;
  avg_hr: number | null;
  max_hr: number | null;
  name: string;
};

async function fetchActualRuns(
  source: "strava" | "garmin",
  startDate: Date,
  endDate: Date
): Promise<ActualRun[]> {
  if (source === "strava") {
    const afterTs = Math.floor(startDate.getTime() / 1000);
    const beforeTs = Math.floor(endDate.getTime() / 1000);
    const acts = await stravaClient.getActivities(1, 200, afterTs, beforeTs);
    return acts
      .filter((a) => (a.sport_type || a.type || "").toLowerCase().includes("run"))
      .map((a) => ({
        date: normalizeDateKey(a.start_date_local),
        distance_km: a.distance / 1000,
        duration_min: a.moving_time / 60,
        avg_hr: a.average_heartrate ?? null,
        max_hr: a.max_heartrate ?? null,
        name: a.name,
      }));
  }

  const acts = await garminClient.getAllActivities(500);
  return acts
    .filter((a) => {
      const d = new Date(a.startTimeLocal);
      const type = a.activityType?.typeKey?.toLowerCase() ?? "";
      return d >= startDate && d <= endDate && type.includes("run");
    })
    .map((a) => ({
      date: normalizeDateKey(String(a.startTimeLocal)),
      distance_km: (a.distance ?? 0) / 1000,
      duration_min: (a.duration ?? 0) / 60,
      avg_hr: a.averageHR ?? null,
      max_hr: a.maxHR ?? null,
      name: a.activityName ?? "Run",
    }));
}

function computeLoadSnapshot(runs: ActualRun[], anchorDate: Date): {
  acute_avg_load: number;
  chronic_avg_load: number;
  acute_chronic_ratio: number;
  fatigue_status: string;
} {
  const maxHr = Math.max(
    190,
    ...runs.map((r) => r.max_hr ?? 0).filter((v) => Number.isFinite(v) && v > 0)
  );

  const daily = new Map<string, number>();
  for (const r of runs) {
    const hrFactor = r.avg_hr ? Math.max(0.65, Math.min(1.15, r.avg_hr / maxHr)) : 0.85;
    const load = Math.max(0, r.duration_min) * hrFactor;
    const key = normalizeDateKey(r.date);
    daily.set(key, (daily.get(key) ?? 0) + load);
  }

  const sumLastDays = (days: number): number => {
    let sum = 0;
    for (let i = 0; i < days; i++) {
      const d = new Date(anchorDate);
      d.setDate(anchorDate.getDate() - i);
      sum += daily.get(normalizeDateKey(d.toISOString())) ?? 0;
    }
    return sum;
  };

  const acuteAvg = sumLastDays(7) / 7;
  const chronicAvg = sumLastDays(28) / 28;
  const ratio = chronicAvg > 0 ? acuteAvg / chronicAvg : 1;

  const fatigueStatus =
    ratio > 1.5
      ? "high_fatigue"
      : ratio > 1.3
      ? "elevated_fatigue"
      : ratio < 0.8
      ? "underloaded_or_fresh"
      : "balanced";

  return {
    acute_avg_load: +acuteAvg.toFixed(1),
    chronic_avg_load: +chronicAvg.toFixed(1),
    acute_chronic_ratio: +ratio.toFixed(2),
    fatigue_status: fatigueStatus,
  };
}
