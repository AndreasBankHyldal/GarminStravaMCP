import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAnalysisTools } from "../src/analysis/tools.js";
import { registerGarminTools } from "../src/garmin/tools.js";
import { registerReportResource, reportResult, reportToolMeta } from "../src/presentation/resource.js";
import { DASHBOARD_URI, REPORT_META_KEY } from "../src/presentation/model.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { zonesReport } from "../src/presentation/reports.js";
import { formatGarminHeartRateZones } from "../src/garmin/format.js";

test("MCP lists dashboard links and a sandboxed resource without requiring UI capability", async () => {
  const server = new McpServer({ name: "fitness-reports-test", version: "1" });
  registerReportResource(server);
  registerAnalysisTools(server);
  registerGarminTools(server);
  const client = new Client({ name: "plain-mcp-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const dashboardTools = [
      "analyze_run_performance", "get_training_trends", "race_day_strategy",
      "get_load_fatigue_model", "get_readiness_score", "weekly_coach_brief",
      "garmin_get_activity_details", "garmin_get_heart_rate_zones",
    ];
    for (const name of dashboardTools) {
      const tool = tools.find(tool => tool.name === name);
      assert.ok(tool, `${name} is still registered`);
      assert.deepEqual(tool._meta?.ui, { resourceUri: DASHBOARD_URI });
    }
    const run = tools.find(tool => tool.name === "analyze_run_performance");
    assert.deepEqual(run?.inputSchema.required, ["activity_id"]);
    assert.equal(tools.find(tool => tool.name === "garmin_get_activities")?._meta, undefined);
    assert.equal(tools.find(tool => tool.name === "garmin_delete_workout")?._meta, undefined);
    const { resources } = await client.listResources();
    const resource = resources.find(resource => resource.uri === DASHBOARD_URI);
    assert.equal(resource?.mimeType, "text/html;profile=mcp-app");
    assert.deepEqual(resource?._meta?.ui, {
      prefersBorder: false,
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
    });

    const invalidResult = await client.callTool({ name: "analyze_run_performance", arguments: {} });
    assert.equal(invalidResult.isError, true);
    assert.equal(invalidResult._meta, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test("normal MCP calls preserve JSON and transmit the UI-only report metadata", async () => {
  const server = new McpServer({ name: "fitness-result-test", version: "1" });
  const data = formatGarminHeartRateZones([{ sport: "RUNNING", zone1Floor: 100, zone2Floor: 120, zone3Floor: 140, zone4Floor: 160, zone5Floor: 180, maxHeartRateUsed: 195 }]);
  registerAppTool(server, "fixture-report", { inputSchema: {}, _meta: reportToolMeta },
    async () => reportResult(data, zonesReport(data)));
  const client = new Client({ name: "plain-mcp-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "fixture-report", arguments: {} });
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(data, null, 2) }]);
    assert.deepEqual(result._meta?.[REPORT_META_KEY], zonesReport(data));
    assert.equal(result.isError, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});
