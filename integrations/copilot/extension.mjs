import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
import { createFitnessPanel, createGarminEventObserver, createReportStore, FITNESS_PANEL_ID, startReportServer } from "./runtime.mjs";
import { captureToolResult } from "./reports.mjs";

const canvasId = "garmin-fitness";
const servers = new Map();
const captures = new Set();
let session;
let store;
let panel;
let extensionId;
const html = await readFile(new URL("./dashboard.html", import.meta.url), "utf8");
const reportIdProperty = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
  description: "Saved report ID from garmin_fitness_reports.",
};
const reportInput = {
  type: "object",
  properties: { reportId: reportIdProperty, selected: { const: true } },
  oneOf: [{ required: ["reportId"] }, { required: ["selected"] }],
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
  extensionId = ctx.extensionId;
  const selected = ctx.input.selected === true;
  const readSnapshot = selected ? () => reportStore().selected() : () => reportStore().read(ctx.input.reportId);
  const snapshot = await readSnapshot();
  let entry = servers.get(ctx.instanceId);
  if (entry && (entry.selected !== selected || (!selected && entry.reportId !== snapshot.id))) {
    await entry.close();
    servers.delete(ctx.instanceId);
    entry = undefined;
  }
  if (!entry) {
    const connection = await startReportServer(html, readSnapshot, selected);
    entry = { ...connection, reportId: snapshot.id, selected, readSnapshot };
    servers.set(ctx.instanceId, entry);
  }
  return { title: selected ? "Fitness report" : snapshot.result._meta?.["garmin/report"]?.title ?? "Garmin fitness report", url: entry.url, status: "Saved Garmin result" };
}

async function closeReport(ctx) {
  const entry = servers.get(ctx.instanceId);
  if (!entry) return;
  servers.delete(ctx.instanceId);
  await entry.close();
}

async function captureResult(toolName, text) {
  try {
    const result = captureToolResult(toolName, text);
    await reportStore().save(toolName, result);
  } catch (error) {
    // Report failures must not hide or replace the original Garmin tool result.
    await session.log(`Garmin dashboard could not be created: ${errorMessage(error)}`, { level: "warning" });
    return;
  }
}

async function showReport(reportId) {
  await Promise.all([...captures]);
  if (!panel) {
    if (!extensionId) {
      const { canvases } = await session.rpc.canvas.list();
      const owner = canvases.find(canvas => canvas.canvasId === canvasId && canvas.extensionName === "garmin-fitness");
      if (!owner) throw new CanvasError("garmin_provider_missing", "The Garmin canvas provider is unavailable.");
      extensionId = owner.extensionId;
    }
    panel = createFitnessPanel({
      canvasId, extensionId,
      selectReport: id => reportStore().select(id),
      listOpen: () => session.rpc.canvas.listOpen(),
      close: input => session.rpc.canvas.close(input),
      open: input => session.rpc.canvas.open(input),
    });
  }
  await panel.show(reportId);
  const snapshot = await reportStore().read(reportId);
  const { openCanvases } = await session.rpc.canvas.listOpen();
  return {
    reportId,
    instanceId: FITNESS_PANEL_ID,
    title: snapshot.result._meta?.["garmin/report"]?.title,
    openFitnessTabs: openCanvases.filter(canvas => canvas.canvasId === canvasId && canvas.extensionId === extensionId).length,
  };
}

session = await joinSession({
  systemMessage: {
    mode: "append",
    content: "Garmin dashboard presentation: Garmin report tools save results without opening panels. After collecting the data needed to answer a user's request, call garmin_fitness_reports and then garmin_fitness_show_report with the saved reportId for the report the user actually requested. For run analysis, show analyze_run_performance only; supporting activity details, HR zones, and trend calls must not open their own panels. If the user asks for HR zones, trends, readiness, or another report, show that requested report instead. Do not use a fixed preference for run analysis across requests. Use the single reusable fitness panel, not a new open_canvas instance per result. Do not open any report merely because a Garmin tool was used for background research or testing. Never show an old successful report as the result of a failed new request.",
  },
  canvases: [
    createCanvas({
      id: canvasId,
      displayName: "Garmin fitness",
      description: "Display the requested Garmin report. Prefer garmin_fitness_show_report to reuse one panel without opening supporting reports.",
      inputSchema: reportInput,
      actions: [
        {
          name: "get_report",
          description: "Read the saved report shown in this panel; does not call Garmin or alter data.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          handler: async ctx => {
            const entry = servers.get(ctx.instanceId);
            if (!entry) throw new CanvasError("garmin_panel_closed", "Open this Garmin report before reading it.");
            return entry.readSnapshot();
          },
        },
      ],
      open: openReport,
      onClose: closeReport,
    }),
  ],
  tools: [{
    name: "garmin_fitness_reports",
    description: "List saved Garmin reports without opening tabs. After gathering data, select the report the user actually requested and call garmin_fitness_show_report. Do not display supporting-tool results such as HR zones/details during a run-analysis request.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      await Promise.all([...captures]);
      return JSON.stringify((await reportStore().list()).map(snapshot => ({
        reportId: snapshot.id, toolName: snapshot.toolName, capturedAt: snapshot.capturedAt,
        title: snapshot.result._meta?.["garmin/report"]?.title,
      })));
    },
  }, {
    name: "garmin_fitness_show_report",
    description: "Show only the saved Garmin report the user requested in one reusable fitness tab. Call once after gathering data; do not call for supporting HR-zone/detail/trend results unless those are the requested output. Replaces the selected report and closes duplicate Garmin tabs without deleting saved data or touching unrelated panels.",
    parameters: { type: "object", properties: { reportId: reportIdProperty }, required: ["reportId"], additionalProperties: false },
    handler: async args => JSON.stringify(await showReport(args.reportId)),
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
  const capture = observer.complete(event.data).catch(error => {
    console.error("Garmin canvas event failed:", errorMessage(error));
    void session.log("The Garmin dashboard could not be opened. The original tool result is unchanged.", { level: "warning" }).catch(console.error);
  });
  captures.add(capture);
  void capture.finally(() => captures.delete(capture));
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
