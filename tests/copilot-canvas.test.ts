import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import test from "node:test";
import { captureToolResult, identifyReportTool, snapshotSchema } from "../src/presentation/capture.js";
import { createGarminEventObserver, createReportStore, startReportServer } from "../src/copilot/runtime.js";

const zones = {
  source: "garmin", profile_count: 1,
  profiles: [{
    sport: "RUNNING", training_method: "LTHR", max_heart_rate_bpm: 195,
    resting_heart_rate_bpm: 48, lactate_threshold_heart_rate_bpm: 172,
    zones: [
      { zone: 1, label: "Recovery", min_bpm: 100, max_bpm: 119 },
      { zone: 2, label: "Easy/Aerobic", min_bpm: 120, max_bpm: 139 },
    ],
  }],
};

test("captures existing Garmin JSON without requiring server metadata or credentials", () => {
  const text = JSON.stringify(zones, null, 2);
  const result = captureToolResult("garmin_get_heart_rate_zones", text);
  assert.equal(result.content[0].text, text);
  assert.equal(result._meta?.["garmin/report"].title, "Heart-rate zones");
  assert.equal(result._meta?.["garmin/report"].sections[0].charts[0].series[0].points[0].value, 119);
  const envelope = captureToolResult("garmin_get_heart_rate_zones", JSON.stringify({ content: [{ type: "text", text }] }));
  assert.deepEqual(envelope, result);
});

test("report hook recognises MCP Garmin namespaces without observing unrelated tools", () => {
  for (const name of ["garmin_get_heart_rate_zones", "garmin-garmin_get_heart_rate_zones", "functions.garmin-garmin_get_heart_rate_zones", "mcp__garmin__garmin_get_heart_rate_zones"]) {
    assert.equal(identifyReportTool(name), "garmin_get_heart_rate_zones", name);
  }
  for (const name of ["get_report", "garmin-delete_workout", "garmin-garmin_get_sleep", "notgarmin-get_training_trends", "stripe-get_training_trends", "garmin-get_training_trends_extra", "bash"]) {
    assert.equal(identifyReportTool(name), undefined, name);
  }
});

test("malformed, truncated, and error results are rejected, not replaced by demo values", () => {
  for (const text of ["Error: unavailable", '{"profiles":', "null", "{}"]) {
    assert.throws(() => captureToolResult("garmin_get_heart_rate_zones", text));
  }
  assert.throws(() => captureToolResult("garmin_get_heart_rate_zones", JSON.stringify({
    isError: true, content: [{ type: "text", text: JSON.stringify(zones) }],
  })), /error/);
});

test("native reports persist by domain ID across store instances and reject path traversal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "garmin-canvas-store-"));
  try {
    const store = createReportStore(directory);
    assert.deepEqual(await store.list(), []);
    const snapshot = await store.save("garmin_get_heart_rate_zones", captureToolResult("garmin_get_heart_rate_zones", JSON.stringify(zones)));
    assert.deepEqual(await createReportStore(directory).read(snapshot.id), JSON.parse(JSON.stringify(snapshot)));
    assert.equal((await createReportStore(directory).list())[0].id, snapshot.id);
    assert.equal(snapshotSchema.parse(JSON.parse(await readFile(join(directory, `${snapshot.id}.json`), "utf8"))).id, snapshot.id);
    if (process.platform !== "win32") assert.equal((await stat(join(directory, `${snapshot.id}.json`))).mode & 0o777, 0o600);
    await assert.rejects(store.read("../../credentials"), /Invalid Garmin report ID/);
    await assert.rejects(store.remove("../other"), /Invalid Garmin report ID/);
    await writeFile(join(directory, `${snapshot.id}.json`), JSON.stringify({ ...snapshot, id: "693b4170-d740-49f5-98a2-23b4235896ea" }));
    await assert.rejects(store.read(snapshot.id), /does not match/);
    await store.remove(snapshot.id);
    await assert.rejects(store.read(snapshot.id), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("loopback renderer exposes only its tokenised read-only snapshot and static HTML", async () => {
  const snapshot = snapshotSchema.parse({
    id: "693b4170-d740-49f5-98a2-23b4235896ea", capturedAt: "2026-09-08T12:00:00Z",
    toolName: "garmin_get_heart_rate_zones",
    result: captureToolResult("garmin_get_heart_rate_zones", JSON.stringify(zones)),
  });
  const html = "<!doctype html><title>Garmin</title>";
  const server = await startReportServer(html, async () => snapshot);
  const origin = new URL(server.url).origin;
  try {
    const page = await fetch(server.url);
    assert.equal(await page.text(), html);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    assert.deepEqual(await (await fetch(`${server.url}state`)).json(), JSON.parse(JSON.stringify(snapshot)));
    assert.equal((await fetch(`${origin}/state`)).status, 404);
    assert.equal((await fetch(`${server.url}state`, { method: "POST", body: "{}" })).status, 405);
    assert.equal((await fetch(`${server.url}state`, { headers: { Origin: "https://untrusted.example" } })).status, 403);
    const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(`${server.url}state`, { headers: { Host: "untrusted.example" } }, response => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    });
    assert.equal(reboundStatus, 403);
    assert.equal((await fetch(`${server.url}../credentials`)).status, 404);
  } finally {
    await server.close();
  }
  await assert.rejects(fetch(server.url));
});

test("two canvas panels can show one persisted report without sharing their HTTP lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "garmin-canvas-panels-"));
  const store = createReportStore(directory);
  const snapshot = await store.save("garmin_get_heart_rate_zones", captureToolResult("garmin_get_heart_rate_zones", JSON.stringify(zones)));
  const first = await startReportServer("<title>Panel one</title>", () => store.read(snapshot.id));
  const second = await startReportServer("<title>Panel two</title>", () => store.read(snapshot.id));
  try {
    assert.notEqual(first.url, second.url);
    const before = await (await fetch(`${first.url}state`)).json();
    assert.deepEqual(await (await fetch(`${second.url}state`)).json(), before);
    await first.close();
    assert.deepEqual(await (await fetch(`${second.url}state`)).json(), before);
  } finally {
    await first.close();
    await second.close();
    await rm(directory, { recursive: true });
  }
});

test("unsupported or missing values cannot be smuggled into a valid native report", () => {
  assert.throws(() => captureToolResult("get_training_trends", JSON.stringify({
    period: "Last 4 weeks", total_runs: 1, total_km: "5", volume_trend: "stable",
    weekly_breakdown: [{ week_of: "2026-09-07", runs: 1, total_km: "5", avg_pace: null, avg_heartrate: 140 }],
  })));
  const result = captureToolResult("get_training_trends", JSON.stringify({
    period: "Last 4 weeks", total_runs: 0, total_km: "0", volume_trend: "insufficient data",
    weekly_breakdown: [{ week_of: "2026-09-07", runs: 0, total_km: "0", avg_pace: "N/A", avg_heartrate: null }],
  }));
  assert.equal(result._meta?.["garmin/report"].sections[0].charts[0].series[0].points[0].value, 0);
  assert.equal(result._meta?.["garmin/report"].sections[0].charts[1].series[0].points[0].value, null);
});

test("event observer pairs concurrent tool calls and captures each result once", async () => {
  const captured: { toolName: string; text: string }[] = [];
  const warnings: string[] = [];
  const observer = createGarminEventObserver({
    onReport: async (toolName, text) => { captured.push({ toolName, text }); },
    onFailure: async message => { warnings.push(message); },
  });
  observer.start({ toolCallId: "a", toolName: "garmin-get_training_trends" });
  observer.start({ toolCallId: "b", toolName: "garmin-garmin_get_heart_rate_zones" });
  observer.start({ toolCallId: "ignored", toolName: "bash" });
  await observer.complete({
    toolCallId: "b", success: true,
    result: { content: "short", detailedContent: "long", contents: [{ type: "text", text: "original JSON" }] },
  });
  await observer.complete({ toolCallId: "ignored", success: true, result: { content: "not Garmin" } });
  await observer.complete({ toolCallId: "a", success: true, result: { content: "short", detailedContent: "complete JSON" } });
  await observer.complete({ toolCallId: "b", success: true, result: { content: "duplicate" } });
  assert.deepEqual(captured, [
    { toolName: "garmin_get_heart_rate_zones", text: "original JSON" },
    { toolName: "get_training_trends", text: "complete JSON" },
  ]);
  assert.deepEqual(warnings, []);
});

test("failed or aborted requests cannot become successful native dashboards", async () => {
  const warnings: string[] = [];
  const observer = createGarminEventObserver({
    onReport: async () => { assert.fail("No successful report should be captured"); },
    onFailure: async message => { warnings.push(message); },
  });
  observer.start({ toolCallId: "failed", toolName: "garmin-get_training_trends" });
  await observer.complete({ toolCallId: "failed", success: false, result: { content: "error" } });
  observer.start({ toolCallId: "empty", toolName: "garmin-get_training_trends" });
  await observer.complete({ toolCallId: "empty", success: true });
  observer.start({ toolCallId: "cancelled", toolName: "garmin-get_training_trends" });
  observer.clear();
  await observer.complete({ toolCallId: "cancelled", success: true, result: { content: "stale" } });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /no new dashboard/);
  assert.match(warnings[1], /no readable report/);
});
