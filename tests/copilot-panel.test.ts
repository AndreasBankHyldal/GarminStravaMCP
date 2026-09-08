import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFitnessPanel, FITNESS_PANEL_ID } from "../src/copilot/panel.js";
import { createGarminEventObserver, createReportStore, startReportServer } from "../src/copilot/runtime.js";
import { captureToolResult } from "../src/presentation/capture.js";

const canvasId = "garmin-fitness";
const extensionId = "user:garmin-fitness";
const snapshotResult = captureToolResult("get_training_trends", JSON.stringify({
  period: "Last 4 weeks", total_runs: 0, total_km: "0", volume_trend: "insufficient data", weekly_breakdown: [],
}));

function harness(initialPanels: { canvasId: string; extensionId: string; instanceId: string }[] = []) {
  const openPanels = new Map(initialPanels.map(panel => [panel.instanceId, panel]));
  const selected: string[] = [];
  const closed: string[] = [];
  const opened: string[] = [];
  const panel = createFitnessPanel({
    canvasId, extensionId,
    selectReport: async id => { selected.push(id); },
    listOpen: async () => ({ openCanvases: [...openPanels.values()] }),
    close: async ({ instanceId }) => { closed.push(instanceId); openPanels.delete(instanceId); },
    open: async input => {
      assert.deepEqual(input.input, { selected: true });
      opened.push(input.instanceId);
      openPanels.set(input.instanceId, input);
    },
  });
  return { panel, selected, closed, opened, openPanels };
}

test("requested report replaces the content in one panel rather than opening per-result tabs", async () => {
  const state = harness();
  await state.panel.show("analysis-report");
  await state.panel.show("zones-requested-next");
  await state.panel.show("trends-requested-next");
  assert.deepEqual(state.opened, [FITNESS_PANEL_ID, FITNESS_PANEL_ID, FITNESS_PANEL_ID]);
  assert.equal(state.openPanels.size, 1);
  assert.deepEqual(state.selected, ["analysis-report", "zones-requested-next", "trends-requested-next"]);
  assert.deepEqual(state.closed, []);
});

test("consolidating old Garmin panels does not close unrelated canvases or other providers", async () => {
  const state = harness([
    { canvasId, extensionId, instanceId: "old-analysis" },
    { canvasId, extensionId, instanceId: "old-details" },
    { canvasId, extensionId, instanceId: "old-zones" },
    { canvasId: "browser", extensionId: "connection:1", instanceId: "docs" },
    { canvasId, extensionId: "project:another-provider", instanceId: "other-provider" },
  ]);
  await state.panel.show("requested-analysis");
  assert.deepEqual(state.closed, ["old-analysis", "old-details", "old-zones"]);
  assert.equal([...state.openPanels.values()].filter(panel => panel.extensionId === extensionId).length, 1);
  assert.ok(state.openPanels.has("docs"));
  assert.ok(state.openPanels.has("other-provider"));
});

test("data gathering never opens supporting reports; presentation explicitly follows user intent", async () => {
  const state = harness();
  const saved: string[] = [];
  const observer = createGarminEventObserver({
    onReport: async toolName => { saved.push(toolName); },
    onFailure: async () => { assert.fail("No tool should fail"); },
  });
  for (const toolName of ["garmin_get_activity_details", "analyze_run_performance", "garmin_get_heart_rate_zones"]) {
    observer.start({ toolCallId: toolName, toolName: `garmin-${toolName}` });
    await observer.complete({ toolCallId: toolName, success: true, result: { content: "{}" } });
  }
  assert.equal(saved.length, 3);
  assert.equal(state.opened.length, 0);
  await state.panel.show(saved[1]);
  assert.deepEqual(state.selected, ["analyze_run_performance"]);
  await state.panel.show(saved[2]);
  assert.deepEqual(state.selected, ["analyze_run_performance", "garmin_get_heart_rate_zones"]);
  assert.equal(state.openPanels.size, 1);
});

test("concurrent show requests are serialized and an earlier failure does not block later selection", async () => {
  const calls: string[] = [];
  const panel = createFitnessPanel({
    canvasId, extensionId,
    selectReport: async id => {
      calls.push(id);
      if (id === "missing") throw new Error("Report not found");
    },
    listOpen: async () => ({ openCanvases: [] }),
    close: async () => {},
    open: async () => { calls.push("open"); },
  });
  const failed = panel.show("missing");
  const next = panel.show("valid");
  await assert.rejects(failed, /Report not found/);
  await next;
  assert.deepEqual(calls, ["missing", "valid", "open"]);
});

test("selected report survives reload and the stable URL reads the new selection, not its first input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "garmin-selection-"));
  const store = createReportStore(directory);
  const first = await store.save("get_training_trends", snapshotResult);
  const second = await store.save("get_training_trends", snapshotResult);
  await store.select(first.id);
  const server = await startReportServer("<title>Fitness report</title>", () => store.selected(), true);
  try {
    assert.equal((await createReportStore(directory).selected()).id, first.id);
    const before = await (await fetch(`${server.url}state`)).json();
    assert.equal(before.id, first.id);
    assert.equal(before.followsSelection, true);
    await store.select(second.id);
    const after = await (await fetch(`${server.url}state`)).json();
    assert.equal(after.id, second.id);
    assert.equal((await createReportStore(directory).selected()).id, second.id);
    assert.equal((await store.list()).length, 2, "selection pointer is not a saved report");
    await assert.rejects(store.select("../secrets"), /Invalid Garmin report ID/);
    assert.equal((await store.selected()).id, second.id);
  } finally {
    await server.close();
    await rm(directory, { recursive: true });
  }
});
