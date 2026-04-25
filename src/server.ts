import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerStravaTools } from "./strava/tools.js";
import { registerGarminTools } from "./garmin/tools.js";
import { registerAnalysisTools } from "./analysis/tools.js";
import { registerPlanningTools } from "./planning/tools.js";

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "strava-garmin-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
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

Tips:
- Use strava_get_activities or garmin_get_activities to browse recent runs
- Use analyze_run_performance for deep analysis of a specific run
- Use create_training_plan to set up a structured training schedule
- Use check_plan_compliance to see how well the plan is being followed`,
    }
  );

  registerStravaTools(server);
  registerGarminTools(server);
  registerAnalysisTools(server);
  registerPlanningTools(server);

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Strava/Garmin server running on stdio");
}
