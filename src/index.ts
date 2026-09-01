import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerGarminTools } from "./garmin/tools.js";
import { registerAnalysisTools } from "./analysis/tools.js";
import { registerPlanningTools } from "./planning/tools.js";
import { registerWomenTools } from "./women/tools.js";
import { config } from "./config.js";

// Redirect console.log to stderr so libraries can't pollute stdout
console.log = console.error;

const womenCapabilities = config.women.toolsEnabled
  ? `
- Log menstrual-health symptoms locally and estimate cycle context with explicit uncertainty
- Combine current symptoms with Garmin sleep, HRV, resting HR, Body Battery, and load data
- Calculate evidence-based fueling ranges and screen for RED-S, iron, bleeding, and bone-health concerns
- Compare the athlete's own patterns across completed cycles without deterministic phase rules`
  : "";
const womenTips = config.women.toolsEnabled
  ? `
- Use women_get_training_context rather than menstrual phase alone when adjusting a session
- Treat women_screen_training_health as educational triage, never diagnosis or medical clearance`
  : "";

const server = new McpServer(
  { name: "garmin-connect-mcp", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
    instructions: `This MCP server integrates with Garmin Connect to help with running training.

Available capabilities:
- Fetch and browse activities from Garmin Connect
- Get detailed activity data including splits, laps, heart rate, and pace
- Analyze run performance (pace consistency, HR drift, elevation)
- View training trends over weeks/months
- Create and manage training plans with planned workouts
- Check training plan compliance against actual activities
- Access Garmin fitness stats (VO2max, sleep, heart rate, steps)
- Create workouts on Garmin Connect (syncs to your watch)
- Search all activities and find personal records
- Read configured Garmin heart rate zones and thresholds
- Compute training load and fatigue model (CTL/ATL/TSB style)
- Produce a daily readiness score from sleep/HRV/HR/load
- Generate weekly coach brief with trend-based recommendations
- Auto-adjust training plans based on compliance and fatigue
- Smart delta-sync training plans to Garmin calendar${womenCapabilities}

All dates include day-of-week and human-readable format to avoid temporal confusion.
Activities include effort level classification and heart rate zone information.

Tips:
- Use garmin_get_activities to browse recent runs
- Use analyze_run_performance for deep analysis of a Garmin activity
- Use garmin_get_personal_records to find all-time bests
- Use garmin_search_activities to find specific activities
- Use garmin_get_heart_rate_zones before making heart-rate-based training recommendations
- Use create_training_plan to set up a structured training schedule
- Use garmin_add_running_workout to push workouts to your Garmin watch${womenTips}
- Use the prompts for guided multi-step analysis workflows`,
  }
);

// --- Resources: always-available context ---

server.resource(
  "garmin-health",
  "garmin://health/today",
  { description: "Today's Garmin health snapshot: heart rate, sleep, steps, training status" },
  async () => {
    try {
      const garmin = await import("./garmin/client.js");
      const [hr, sleep, steps] = await Promise.all([
        garmin.getHeartRate().catch(() => null),
        garmin.getSleepData().catch(() => null),
        garmin.getSteps().catch(() => null),
      ]);

      return {
        contents: [{
          uri: "garmin://health/today",
          mimeType: "application/json",
          text: JSON.stringify({
            date: new Date().toISOString().split("T")[0],
            heart_rate: hr,
            sleep: sleep,
            steps: steps,
          }, null, 2),
        }],
      };
    } catch {
      return {
        contents: [{
          uri: "garmin://health/today",
          mimeType: "text/plain",
          text: "Garmin not connected. Set GARMIN_USERNAME and GARMIN_PASSWORD in .env.",
        }],
      };
    }
  }
);

// --- Prompts: pre-built multi-step analysis workflows ---

server.prompt(
  "analyze-recent-training",
  "Comprehensive training analysis over a specified period. Fetches activities, calculates trends, and provides insights.",
  { weeks: z.string().optional().describe("Number of weeks to analyze (default: 4)") },
  ({ weeks }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Analyze my training over the last ${weeks ?? "4"} weeks. Please:
1. Fetch my recent activities from Garmin using garmin_get_activities
2. Calculate weekly mileage trends using get_training_trends
3. Identify my hardest and easiest sessions
4. Look for patterns (are certain days harder? is mileage increasing?)
5. Flag any concerns (sudden volume increases >10%/week, missing rest days)
6. Provide 2-3 actionable recommendations for the coming week

Present the analysis in a clear, structured format with a weekly summary table.`,
      },
    }],
  })
);

server.prompt(
  "activity-deep-dive",
  "Deep dive into a specific activity with splits, HR analysis, and performance context.",
  { activity_id: z.string().describe("Garmin activity ID to analyze") },
  ({ activity_id }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Do a deep dive analysis of Garmin activity ${activity_id}. Please:
1. Fetch the activity details with garmin_get_activity_details
2. Analyze the run with analyze_run_performance
3. Assess:
   - Pacing strategy (even splits? negative split? fade?)
   - Heart rate drift and what it indicates about fitness/fatigue
   - Effort level relative to the workout type
   - Any notable patterns in the data
4. Compare to similar recent workouts if possible
5. Rate the overall execution of this run and suggest what to focus on next`,
      },
    }],
  })
);

server.prompt(
  "training-readiness-check",
  "Check if you're ready to train hard today based on recent load, sleep, and recovery.",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Check my training readiness for today. Please:
1. Fetch my last 7 days of activities from Garmin (garmin_get_activities, count 10)
2. Check my Garmin sleep data (garmin_get_sleep) and heart rate (garmin_get_heart_rate)
3. Try to get training status from Garmin (garmin_get_training_status)
4. Assess:
   - How much training load in the last 3 days?
   - When was my last rest day?
   - Sleep quality last night
   - Any signs of fatigue (elevated resting HR, poor sleep)
5. Give a clear recommendation: ready for hard training, moderate day, or rest day
6. If ready, suggest what type of workout would be most beneficial`,
      },
    }],
  })
);

server.prompt(
  "compare-recent-runs",
  "Compare your most recent runs to identify trends and improvements.",
  { count: z.string().optional().describe("Number of runs to compare (default: 5)") },
  ({ count }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Compare my last ${count ?? "5"} runs. Please:
1. Fetch recent activities from Garmin (garmin_get_activities)
2. For each run, note: distance, pace, heart rate, effort level
3. Look for:
   - Pace improvements or declines
   - Heart rate efficiency changes (same pace at lower HR = fitness gain)
   - Volume progression
   - Recovery patterns between hard sessions
4. Present as a comparison table and highlight the most interesting trends
5. Identify your strongest and weakest recent performance`,
      },
    }],
  })
);

if (config.women.toolsEnabled) {
  server.prompt(
    "women-training-check",
    "Symptom-led training and fueling check using local menstrual-health logs and Garmin recovery data.",
    {
      planned_session: z
        .enum(["rest", "easy", "moderate", "hard", "race"])
        .describe("Session currently planned"),
    },
    ({ planned_session }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Help me assess a planned ${planned_session} session using an evidence-based, symptom-led approach.

1. Use women_get_cycle_context only for uncertain context, not as a deterministic training rule
2. Use women_get_training_context with planned_session "${planned_session}" and Garmin recovery enabled
3. If fueling is relevant, ask for the minimum inputs needed by women_get_nutrition_targets
4. If the logs contain medical warning signs, use women_screen_training_health and prioritize its triage
5. Explain which signals changed the recommendation and which data was unavailable

Do not claim that a menstrual phase causes better performance or injury risk.`,
        },
      }],
    })
  );
}

server.prompt(
  "race-plan",
  "Create a training plan leading up to a target race.",
  {
    race_distance: z.string().describe("Race distance (e.g. '5K', '10K', 'half marathon', 'marathon')"),
    race_date: z.string().describe("Race date (ISO 8601)"),
    goal_time: z.string().optional().describe("Target finish time (e.g. '1:45:00')"),
  },
  ({ race_distance, race_date, goal_time }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Help me plan for a ${race_distance} race on ${race_date}${goal_time ? ` with a goal time of ${goal_time}` : ""}.

1. First, check my recent training with garmin_get_activities and get_training_trends to understand my current fitness
2. Based on my current ability, assess whether the goal is realistic
3. Create a structured training plan using create_training_plan with:
   - Appropriate weekly mileage progression (no more than 10% increase/week)
   - Key workouts: long runs, tempo runs, intervals, easy runs, rest days
   - A proper taper in the final 1-2 weeks
   - Target paces for each workout type based on my current fitness
4. If possible, create key workouts on Garmin using garmin_add_running_workout
5. Provide race day strategy (pacing plan, nutrition reminders)`,
      },
    }],
  })
);

// --- Register all tools ---

registerGarminTools(server);
registerAnalysisTools(server);
registerPlanningTools(server);
registerWomenTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Garmin Connect MCP server running on stdio");
