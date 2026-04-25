import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db/database.js";
import crypto from "node:crypto";

export function registerPlanningTools(server: McpServer): void {
  server.tool(
    "create_training_plan",
    "Create a new multi-week training plan. Provide a name, start date, goal, and an array of planned workouts.",
    {
      name: z.string().describe("Plan name (e.g. 'Half Marathon Build')"),
      description: z.string().optional().describe("Plan description"),
      start_date: z.string().describe("Plan start date (ISO 8601)"),
      end_date: z.string().optional().describe("Plan end date (ISO 8601)"),
      goal: z.string().optional().describe("Goal for this plan (e.g. 'Sub-2h half marathon')"),
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
    async ({ name, description, start_date, end_date, goal, workouts }) => {
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

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  plan_id: planId,
                  name,
                  workouts_count: workouts.length,
                  message: `Training plan "${name}" created with ${workouts.length} workouts.`,
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
    },
    async ({ plan_id, name, description, goal, update_workouts, add_workouts }) => {
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

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "Training plan updated successfully.",
                updated_workouts: update_workouts?.length ?? 0,
                added_workouts: add_workouts?.length ?? 0,
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
