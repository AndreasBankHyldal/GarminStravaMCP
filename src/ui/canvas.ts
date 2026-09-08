import { dispose, receiveResult, showState } from "./view.js";

type ToolResult = Parameters<typeof receiveResult>[0];
interface SavedReport {
  id: string;
  toolName: string;
  capturedAt: string;
  result: ToolResult;
  followsSelection: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolResult(value: unknown): value is ToolResult {
  // Validate the envelope fields used by the view; it validates reportSchema itself.
  return isRecord(value)
    && Array.isArray(value.content)
    && value.content.every((block: unknown) =>
      isRecord(block) && typeof block.type === "string"
      && (block.type !== "text" || typeof block.text === "string"))
    && (value.isError === undefined || typeof value.isError === "boolean")
    && (value._meta === undefined || isRecord(value._meta));
}

function readSnapshot(value: unknown): SavedReport {
  if (!isRecord(value)
    || typeof value.id !== "string" || !value.id.trim()
    || typeof value.toolName !== "string" || !value.toolName.trim()
    || typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))
    || !isToolResult(value.result)
    || (value.followsSelection !== undefined && typeof value.followsSelection !== "boolean")) {
    throw new Error("The local endpoint returned a malformed saved report.");
  }
  return { id: value.id, toolName: value.toolName, capturedAt: value.capturedAt, result: value.result, followsSelection: value.followsSelection === true };
}

function colorMode(value: string | undefined): "light" | "dark" | "auto" | undefined {
  return value === "light" || value === "dark" || value === "auto" ? value : undefined;
}

function applyCanvasTheme(preferred?: HTMLElement): void {
  const mode = colorMode(preferred?.dataset.colorMode)
    ?? colorMode(document.documentElement.dataset.colorMode)
    ?? colorMode(document.body.dataset.colorMode);
  if (mode === "light" || mode === "dark") document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
}

applyCanvasTheme();
const themeObserver = new MutationObserver((mutations) => {
  const target = mutations.at(-1)?.target;
  applyCanvasTheme(target instanceof HTMLElement ? target : undefined);
});
for (const target of [document.documentElement, document.body]) {
  themeObserver.observe(target, { attributes: true, attributeFilter: ["data-color-mode"] });
}

const dashboard = document.getElementById("dashboard");
if (!dashboard) throw new Error("The dashboard root element is missing.");

const snapshotBar = document.createElement("section");
snapshotBar.className = "snapshot-bar";
snapshotBar.setAttribute("aria-label", "Saved report details");
const caption = document.createElement("div");
const label = document.createElement("p");
label.className = "snapshot-label";
label.textContent = "Saved Garmin tool output · Read-only snapshot";
const source = document.createElement("p");
source.className = "snapshot-source";
source.hidden = true;
const note = document.createElement("p");
note.className = "snapshot-note";
note.textContent = "This report is not live. Reloading reads the stored snapshot, not new Garmin data.";
caption.append(label, source, note);
const reload = document.createElement("button");
reload.type = "button";
reload.className = "page-button snapshot-reload";
reload.textContent = "Reload saved report";
reload.title = "Reload the stored snapshot without requesting new Garmin data";
snapshotBar.append(caption, reload);
dashboard.before(snapshotBar);

const readOnlyLabel = document.querySelector(".read-only-label");
if (readOnlyLabel) readOnlyLabel.textContent = "Saved snapshot";
const footer = document.querySelector(".app-footer");
if (footer) {
  footer.textContent = "Source values, not a diagnosis. This browser does not persist readings. The saved report is a session artifact.";
}

let activeRequest: AbortController | undefined;
let reportId: string | undefined;
let disposed = false;

async function loadSnapshot(): Promise<void> {
  if (disposed || activeRequest) return;
  const request = new AbortController();
  activeRequest = request;
  reload.disabled = true;
  source.replaceChildren();
  source.hidden = true;
  showState("loading", "Loading saved Garmin report", "Reading the tool output captured for this report. No new Garmin data is requested.");
  const timeout = window.setTimeout(() => request.abort(), 15000);
  try {
    const response = await fetch("./state", {
      mode: "same-origin",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: request.signal,
    });
    if (!response.ok) throw new Error(`The local report endpoint returned HTTP ${response.status}.`);
    const payload: unknown = await response.json();
    const snapshot = readSnapshot(payload);
    if (reportId !== undefined && snapshot.id !== reportId && !snapshot.followsSelection) {
      throw new Error("The local endpoint returned a different report. Reopen the intended saved report.");
    }
    if (disposed) return;
    reportId = snapshot.id;
    note.textContent = snapshot.followsSelection
      ? "One tab for the requested report. Supporting tool calls do not change it. Reloading reads the selected saved snapshot, not new Garmin data."
      : "This report is not live. Reloading reads the stored snapshot, not new Garmin data.";
    source.textContent = `Source tool: ${snapshot.toolName} · Captured: `;
    const capturedAt = document.createElement("time");
    capturedAt.dateTime = snapshot.capturedAt;
    capturedAt.textContent = snapshot.capturedAt;
    source.append(capturedAt);
    source.hidden = false;
    receiveResult(snapshot.result);
    document.title = `${document.title} · Saved report`;
  } catch (error: unknown) {
    if (disposed) return;
    source.replaceChildren();
    source.hidden = true;
    const message = request.signal.aborted
      ? "The local report endpoint did not respond within 15 seconds."
      : error instanceof Error ? error.message : String(error);
    showState("error", "Saved report could not be loaded", `${message} Use “Reload saved report” to retry the stored snapshot, or reopen the report in Copilot if its local server has closed. No sample or stale readings are shown.`);
  } finally {
    window.clearTimeout(timeout);
    activeRequest = undefined;
    if (!disposed) reload.disabled = false;
  }
}

reload.addEventListener("click", () => { void loadSnapshot(); });
window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  disposed = true;
  activeRequest?.abort();
  themeObserver.disconnect();
  dispose();
});

void loadSnapshot();
