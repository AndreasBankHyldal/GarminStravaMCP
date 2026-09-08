import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
import { createGarminEventObserver, createReportStore, startReportServer } from "./runtime.mjs";
import { captureToolResult } from "./reports.mjs";

const canvasId = "garmin-fitness";
const servers = new Map();
let session;
let store;
const html = await readFile(new URL("./dashboard.html", import.meta.url), "utf8");
const reportInput = {
  type: "object",
  properties: { reportId: { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", description: "Saved report ID from a Garmin tool's dashboard context." } },
  required: ["reportId"],
  additionalProperties: false,
};

function reportStore() {
  if (!session?.workspacePath) throw new CanvasError("garmin_workspace_missing", "Copilot did not provide session artifact storage for fitness reports.");
  store ??= createReportStore(join(session.workspacePath, "files", "garmin-reports"));
  return store;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function openReport(ctx) {
  const snapshot = await reportStore().read(ctx.input.reportId);
  let entry = servers.get(ctx.instanceId);
  if (entry && entry.reportId !== snapshot.id) {
    await entry.close();
    servers.delete(ctx.instanceId);
    entry = undefined;
  }
  if (!entry) {
    const connection = await startReportServer(html, () => reportStore().read(snapshot.id));
    entry = { ...connection, reportId: snapshot.id };
    servers.set(ctx.instanceId, entry);
  }
  return { title: snapshot.result._meta?.["garmin/report"]?.title ?? "Garmin fitness report", url: entry.url, status: "Saved Garmin result" };
}

async function closeReport(ctx) {
  const entry = servers.get(ctx.instanceId);
  if (!entry) return;
  servers.delete(ctx.instanceId);
  await entry.close();
}

async function captureResult(toolName, text) {
  let snapshot;
  try {
    const result = captureToolResult(toolName, text);
    snapshot = await reportStore().save(toolName, result);
  } catch (error) {
    // Report failures must not hide or replace the original Garmin tool result.
    await session.log(`Garmin dashboard could not be created: ${errorMessage(error)}`, { level: "warning" });
    return;
  }
  const instanceId = `fitness-${snapshot.id}`;
  try {
    await session.rpc.canvas.open({ canvasId, instanceId, input: { reportId: snapshot.id } });
  } catch (error) {
    await session.log(`Garmin report saved, but its canvas did not open: ${errorMessage(error)}`, { level: "warning" });
  }
}

session = await joinSession({
  canvases: [
    createCanvas({
      id: canvasId,
      displayName: "Garmin fitness",
      description: "Display saved live Garmin tool results as interactive run, trend, heart-rate zone, and training dashboards.",
      inputSchema: reportInput,
      actions: [
        {
          name: "get_report",
          description: "Read the saved report shown in this panel; does not call Garmin or alter data.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          handler: async ctx => {
            const entry = servers.get(ctx.instanceId);
            if (!entry) throw new CanvasError("garmin_panel_closed", "Open this Garmin report before reading it.");
            return reportStore().read(entry.reportId);
          },
        },
      ],
      open: openReport,
      onClose: closeReport,
    }),
  ],
  tools: [{
    name: "garmin_fitness_reports",
    description: "List native Garmin fitness dashboards captured from real Garmin tool results in this session. Successful supported Garmin MCP calls automatically open their dashboard; use this tool to find saved report IDs for reopening with the garmin-fitness canvas. Do not launch demos or fabricate chart data.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => JSON.stringify((await reportStore().list()).map(snapshot => ({
      reportId: snapshot.id, toolName: snapshot.toolName, capturedAt: snapshot.capturedAt,
      title: snapshot.result._meta?.["garmin/report"]?.title,
      canvasId, instanceId: `fitness-${snapshot.id}`,
    }))),
  }],
});

// Event subscriptions survive provider reloads without replacing the CLI's hook processor.
const observer = createGarminEventObserver({
  onReport: captureResult,
  onFailure: message => session.log(message, { level: "warning" }),
});
session.on("tool.execution_start", event => observer.start(event.data));
session.on("abort", () => observer.clear());
session.on("tool.execution_complete", event => {
  void observer.complete(event.data).catch(error => {
    console.error("Garmin canvas event failed:", errorMessage(error));
    void session.log("The Garmin dashboard could not be opened. The original tool result is unchanged.", { level: "warning" }).catch(console.error);
  });
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  for (const entry of servers.values()) await entry.close();
  servers.clear();
}
process.once("SIGTERM", () => {
  void shutdown().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
});
