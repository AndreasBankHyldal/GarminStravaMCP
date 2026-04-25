import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerStravaTools } from "./strava/tools.js";
import { registerGarminTools } from "./garmin/tools.js";
import { registerAnalysisTools } from "./analysis/tools.js";
import { registerPlanningTools } from "./planning/tools.js";

// Redirect console.log to stderr so libraries can't pollute stdout
console.log = console.error;

const server = new McpServer(
  { name: "strava-garmin-mcp", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions: `This MCP server integrates with Strava and Garmin Connect to help with running training.

Available capabilities:
- Fetch and browse activities from Strava and Garmin Connect
- Get detailed activity data including splits, laps, heart rate, and pace
- Analyze run performance (pace consistency, HR drift, elevation)
- Compare data between Strava and Garmin for the same activity
- View training trends over weeks/months
- Create and manage training plans with planned workouts
- Check training plan compliance against actual activities
- Access Garmin fitness stats (VO2max, sleep, heart rate, steps)
- Create workouts on Garmin Connect (syncs to your watch)
- Create and edit activities on Strava
- Search all activities and find personal records

Tips:
- Use strava_get_activities or garmin_get_activities to browse recent runs
- Use analyze_run_performance for deep analysis of a specific run
- Use garmin_get_personal_records to find all-time bests
- Use garmin_search_activities to find specific activities
- Use create_training_plan to set up a structured training schedule
- Use garmin_add_running_workout to push workouts to your Garmin watch`,
  }
);

registerStravaTools(server);
registerGarminTools(server);
registerAnalysisTools(server);
registerPlanningTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP Strava/Garmin server running on stdio");
