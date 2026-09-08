import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import type { Protocol } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, Notification, Request, Result } from "@modelcontextprotocol/sdk/types.js";
import { dispose, receiveResult, showState } from "./view.js";

// Node16 resolution loses these inherited ext-apps members; retain the SDK's exact hook types.
type ConnectionHooks = Pick<Protocol<Request, Notification, Result>, "onerror" | "onclose">;
const app: App & ConnectionHooks = new App({ name: "Garmin fitness dashboard", version: "1.0.0" }, {}, { autoResize: true });
const dashboard = document.getElementById("dashboard");
let lastResult: CallToolResult | undefined;
let connected = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

app.ontoolinput = () => {
  lastResult = undefined;
  showState("loading", "Loading your fitness data", "The tool is running. Only readings returned by the tool will be shown.");
};
app.ontoolinputpartial = () => {
  lastResult = undefined;
  showState("loading", "Preparing your report", "Waiting for the host to finish the tool request.");
};
app.ontoolresult = (result: CallToolResult) => {
  lastResult = result;
  receiveResult(result);
};
app.ontoolcancelled = () => {
  lastResult = undefined;
  showState("cancelled", "Tool request cancelled", "The previous report has been cleared. Run the fitness tool again in your conversation to load a new report.");
};
app.onhostcontextchanged = (context) => {
  if (context.theme) applyDocumentTheme(context.theme);
};
app.onerror = (error: Error) => {
  showState("error", "Dashboard connection error", `${errorMessage(error)}. Reopen this dashboard from an MCP Apps-compatible host or run the tool again.`, lastResult);
};
app.onclose = () => {
  showState("error", "Dashboard disconnected", "The connection to the host closed. Reopen the dashboard or run the tool again; this view will not show stale readings.", lastResult);
};

const connectionTimeout = window.setTimeout(() => {
  if (!connected && !lastResult && dashboard?.dataset.state === "loading") {
    showState("error", "Still waiting for the host", "The MCP Apps connection has not completed. Open this dashboard inside a compatible MCP client, or rerun the tool in your conversation.");
  }
}, 15000);

void app.connect().then(() => {
  connected = true;
  window.clearTimeout(connectionTimeout);
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (!lastResult && dashboard?.dataset.state !== "cancelled") {
    showState("loading", "Waiting for your fitness report", "Connected to the host. Your dashboard will appear when the fitness tool returns its results.");
  }
}).catch((error: unknown) => {
  window.clearTimeout(connectionTimeout);
  showState("error", "Could not connect to the host", `${errorMessage(error)}. This dashboard must run inside an MCP Apps-compatible client.`, lastResult);
});

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  window.clearTimeout(connectionTimeout);
  dispose();
});
