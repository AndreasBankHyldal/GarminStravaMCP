import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { REPORT_META_KEY, reportSchema, type Metric, type Report } from "../presentation/model.js";
import { createChart } from "./chart.js";

export type ViewState = "loading" | "ready" | "empty" | "error" | "cancelled";

const root = document.getElementById("dashboard");
if (!root) throw new Error("The dashboard root element is missing.");
const dashboard: HTMLElement = root;
const announcement = document.getElementById("announcement");
let chartDisposers: (() => void)[] = [];

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function dispose(): void {
  for (const dispose of chartDisposers) dispose();
  chartDisposers = [];
}

function reset(state: ViewState): void {
  dispose();
  dashboard.replaceChildren();
  dashboard.dataset.state = state;
  dashboard.setAttribute("aria-busy", String(state === "loading"));
  announce("");
}

function announce(message: string): void {
  if (announcement) announcement.textContent = message;
}

function originalResult(result: CallToolResult): HTMLDetailsElement {
  const details = element("details", "raw-result");
  details.id = "raw-result";
  details.append(element("summary", "", "Original tool result · JSON / source content"));
  details.append(element("p", "details-description", "Text blocks below are the exact original tool content, without reformatting. Non-text blocks are shown as JSON, never loaded as external assets."));
  const content = result.content ?? [];
  if (!content.length) details.append(element("p", "empty-message", "The tool returned no original content blocks."));
  for (const [index, block] of content.entries()) {
    const pre = element("pre", "raw-content");
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", `Original tool content, block ${index + 1}`);
    pre.textContent = block.type === "text" ? block.text : JSON.stringify(block, null, 2);
    details.append(pre);
  }
  return details;
}

export function showState(state: Exclude<ViewState, "ready">, title: string, message: string, result?: CallToolResult): void {
  reset(state);
  const panel = element("section", "state-panel");
  panel.setAttribute("role", state === "error" ? "alert" : "status");
  const symbol = element("span", `state-symbol ${state === "loading" ? "loading-symbol" : ""}`, state === "error" ? "!" : state === "cancelled" ? "—" : "");
  symbol.setAttribute("aria-hidden", "true");
  panel.append(symbol, element("h1", "", title), element("p", "", message));
  dashboard.append(panel);
  if (result) dashboard.append(originalResult(result));
  document.title = `${title} · Garmin`;
}

function metrics(items: Metric[], label: string): HTMLElement {
  const grid = element("dl", "metric-grid");
  grid.setAttribute("aria-label", label);
  for (const metric of items) {
    const card = element("div", "metric-card");
    card.dataset.color = metric.color;
    const numericValue = /^-?\d+(?:\.\d+)?$/.test(metric.value) ? Number(metric.value) : null;
    const displayValue = numericValue !== null && Number.isFinite(numericValue)
      ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(numericValue)
      : metric.value;
    card.append(element("dt", "metric-label", metric.label), element("dd", "metric-value", displayValue));
    if (metric.detail) card.append(element("dd", "metric-detail", metric.detail));
    grid.append(card);
  }
  return grid;
}

function renderReport(report: Report, result: CallToolResult): void {
  reset("ready");
  document.title = `${report.title} · Garmin`;
  const heading = element("header", "report-heading");
  heading.append(element("p", "eyebrow", "YOUR FITNESS, IN FOCUS"), element("h1", "report-title", report.title));
  if (report.subtitle) heading.append(element("p", "report-subtitle", report.subtitle));
  dashboard.append(heading);
  if (report.metrics.length) dashboard.append(metrics(report.metrics, "Report metrics"));

  const sections = element("div", "report-sections");
  const tabs = element("div", "section-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Report profiles");
  const tabButtons: HTMLButtonElement[] = [];
  const panels: HTMLElement[] = [];
  const showTabs = report.sections.length > 1;

  function activate(index: number, focus: boolean): void {
    for (const [tabIndex, button] of tabButtons.entries()) {
      button.setAttribute("aria-selected", String(tabIndex === index));
      button.tabIndex = tabIndex === index ? 0 : -1;
      panels[tabIndex].hidden = tabIndex !== index;
    }
    if (focus) tabButtons[index].focus();
  }

  for (const [index, section] of report.sections.entries()) {
    const panel = element("section", "section-panel");
    panel.id = `profile-panel-${index}`;
    panel.dataset.sectionId = section.id;
    panels.push(panel);
    if (showTabs) {
      const button = element("button", "section-tab", section.label);
      button.type = "button";
      button.id = `profile-tab-${index}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", panel.id);
      button.addEventListener("click", () => activate(index, false));
      button.addEventListener("keydown", (event) => {
        let target: number;
        if (event.key === "ArrowRight") target = (index + 1) % report.sections.length;
        else if (event.key === "ArrowLeft") target = (index - 1 + report.sections.length) % report.sections.length;
        else if (event.key === "Home") target = 0;
        else if (event.key === "End") target = report.sections.length - 1;
        else return;
        event.preventDefault();
        activate(target, true);
      });
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", button.id);
      panel.tabIndex = 0;
      tabButtons.push(button);
      tabs.append(button);
    } else {
      const title = element("h2", "section-heading", section.label);
      title.id = `profile-heading-${index}`;
      panel.setAttribute("aria-labelledby", title.id);
      panel.append(title);
    }
    if (section.metrics.length) panel.append(metrics(section.metrics, `${section.label} metrics`));
    const charts = element("div", "chart-grid");
    for (const [chartIndex, chart] of section.charts.entries()) {
      const view = createChart(chart, `chart-${index}-${chartIndex}`);
      chartDisposers.push(view.dispose);
      charts.append(view.element);
    }
    if (section.charts.length) panel.append(charts);
    if (!section.charts.length && !section.metrics.length) {
      panel.append(element("p", "empty-message", "No metrics or chart readings are available for this profile."));
    }
    if (section.notes.length) {
      const notes = element("aside", "report-notes");
      notes.append(element("h3", "", "How to read this"));
      const list = element("ul", "");
      for (const note of section.notes) list.append(element("li", "", note));
      notes.append(list);
      panel.append(notes);
    }
  }
  if (showTabs) {
    sections.append(tabs);
    activate(0, false);
  }
  sections.append(...panels);
  dashboard.append(sections);
  if (!report.sections.length) {
    dashboard.append(element("p", "empty-message", "No chart profiles were included in this report."));
  }
  if (!report.metrics.length && report.sections.every(section => !section.metrics.length && !section.charts.some(chart => chart.series.some(series => series.points.some(point => point.value !== null))))) {
    dashboard.dataset.state = "empty";
    announce("Report received. No fitness readings are available.");
  } else {
    announce(`${report.title} is ready. Charts and exact source data are available below.`);
  }
  dashboard.append(originalResult(result));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function receiveResult(result: CallToolResult): void {
  try {
    if (result.isError) {
      const message = (result.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
      showState("error", "The fitness tool returned an error", message || "No readings were returned. Check the original tool result and try the tool again in your conversation.", result);
      return;
    }
    const supplied = result._meta?.[REPORT_META_KEY];
    if (supplied === undefined) {
      showState("error", "Dashboard data is missing", "The tool result did not include a Garmin dashboard report. The original response is available below. Run the tool again using an updated Garmin dashboard integration.", result);
      return;
    }
    const parsed = reportSchema.safeParse(supplied);
    if (!parsed.success) {
      const fields = parsed.error.issues.slice(0, 3).map(issue => issue.path.join(".") || "report").join(", ");
      showState("error", "Dashboard data could not be validated", `The report contains an unsupported or malformed value (${fields}). No fitness values have been inferred. Review the original tool result below and run the tool again.`, result);
      return;
    }
    renderReport(parsed.data, result);
  } catch (error: unknown) {
    showState("error", "The dashboard could not be displayed", `Rendering failed: ${errorMessage(error)}. The original tool result is available below.`, result);
  }
}
