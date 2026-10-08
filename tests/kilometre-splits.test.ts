import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildKilometreSplits, kilometreSplitsSchema } from "../src/garmin/splits.js";
import type { GarminActivityChart, GarminActivityDetails, GarminActivitySplits } from "../src/garmin/client.js";
import { registerGarminTools } from "../src/garmin/tools.js";
import { analyzeGarminRun } from "../src/analysis/tools.js";
import { captureToolResult, identifyReportTool } from "../src/presentation/capture.js";
import { reportSchema, REPORT_META_KEY } from "../src/presentation/model.js";
import { runReport } from "../src/presentation/reports.js";

const descriptors = [
  ["sumDistance", "meter", 100],
  ["sumElapsedDuration", "second", 1000],
  ["sumMovingDuration", "second", 1000],
  ["directHeartRate", "bpm", 1],
  ["directDoubleCadence", "stepsPerMinute", 1],
  ["directCorrectedElevation", "meter", 100],
  ["directPower", "watt", 1],
  ["directAirTemperature", "celsius", 1],
] as const;

function chart(rows: Array<Array<number | null>>): GarminActivityChart {
  return {
    metricDescriptors: descriptors.map(([key, unit, factor], metricsIndex) => ({
      key, metricsIndex, unit: { key: unit, factor },
    })),
    activityDetailMetrics: rows.map(metrics => ({ metrics })),
  };
}

const stream = chart([
  [0, 0, 0, 140, 170, 0, 250, 0],
  [600, 180, 180, 146, 170, 6, 250, 0],
  [1200, 360, 360, 152, 170, 12, 250, 0],
  [1800, 540, 540, 158, 170, 18, 250, 0],
  [2500, 750, 750, 165, 170, 25, 250, 0],
]);

const activity: GarminActivityDetails = {
  activityId: 42, activityName: "Synthetic 2.5 km run", activityTypeDTO: { typeKey: "running" },
  summaryDTO: {
    startTimeLocal: "2026-10-07T10:00:00", distance: 2500, duration: 750,
    movingDuration: 750, averageSpeed: 2500 / 750, elevationGain: 25,
    averageHR: 152, maxHR: 165, calories: 200, averageRunCadence: 170,
  },
};

test("interpolates true kilometre boundaries, normalizes partial-km pace and ignores encoding factors", () => {
  const result = kilometreSplitsSchema.parse(buildKilometreSplits(stream, 2500));
  assert.equal(result.data_quality.status, "complete");
  assert.equal(result.data_quality.pace_time_basis, "moving");
  assert.deepEqual(result.km_splits.map(s => s.distance_m), [1000, 1000, 500]);
  assert.deepEqual(result.km_splits.map(s => s.moving_time_seconds), [300, 300, 150]);
  assert.deepEqual(result.km_splits.map(s => s.cumulative_moving_time_seconds), [300, 600, 750]);
  assert.deepEqual(result.km_splits.map(s => s.pace_per_km), ["5:00", "5:00", "5:00"]);
  assert.deepEqual(result.km_splits.map(s => s.is_partial), [false, false, true]);
  assert.deepEqual(result.km_splits.map(s => s.avg_heartrate), [145, 155, 162.5]);
  assert.deepEqual(result.km_splits.map(s => s.elevation_gain_m), [10, 10, 5]);
  assert.deepEqual(result.km_splits.map(s => s.elevation_loss_m), [0, 0, 0]);
  assert.deepEqual(result.km_splits.map(s => s.elevation_start_m), [0, 10, 20]);
  assert.deepEqual(result.km_splits.map(s => s.elevation_end_m), [10, 20, 25]);
  assert.deepEqual(result.km_splits.map(s => s.elevation_min_m), [0, 10, 20]);
  assert.deepEqual(result.km_splits.map(s => s.elevation_max_m), [10, 20, 25]);
  assert.equal(result.km_splits[0].cadence_spm, 170);
  assert.equal(result.km_splits[0].avg_power_w, 250);
  assert.equal(result.km_splits[0].temperature_c, 0, "zero temperature is a real reading");
  assert.equal(result.km_splits[0].metric_coverage_percent.heart_rate, 100);
  assert.equal(result.pacing_summary?.full_km_count, 2);
  assert.equal(result.pacing_summary?.strategy, "even");
  assert.equal(result.pacing_summary?.pace_std_deviation_seconds, 0);
  assert.match(result.data_quality.warnings.join(" "), /gaps exceed 30/);
});

test("pauses at a kilometre boundary belong to the following split, not moving pace", () => {
  const result = buildKilometreSplits(chart([
    [0, 0, 0, 140, 170, 0, 250, 10],
    [1000, 300, 300, 150, 170, 0, 250, 10],
    [1000, 350, 300, 130, 0, 0, 0, 10],
    [2000, 650, 600, 150, 170, 0, 250, 10],
  ]), 2000);
  assert.deepEqual(result.km_splits.map(s => s.moving_time_seconds), [300, 300]);
  assert.deepEqual(result.km_splits.map(s => s.elapsed_time_seconds), [300, 350]);
  assert.deepEqual(result.km_splits.map(s => s.stopped_time_seconds), [0, 50]);
  assert.deepEqual(result.km_splits.map(s => s.pace_per_km), ["5:00", "5:00"]);
  assert.deepEqual(result.km_splits.map(s => s.elapsed_pace_per_km), ["5:00", "5:50"]);
  assert.deepEqual(result.km_splits.map(s => s.avg_heartrate), [145, 140]);
});

test("converts declared centimetres and milliseconds, without dividing by Garmin factor", () => {
  const converted: GarminActivityChart = {
    metricDescriptors: stream.metricDescriptors!.map(d => ({
      ...d, unit: { key: d.key === "sumDistance" || d.key === "directCorrectedElevation" ? "centimeter" :
        d.key === "sumElapsedDuration" || d.key === "sumMovingDuration" ? "ms" : d.unit!.key, factor: 123 },
    })),
    activityDetailMetrics: stream.activityDetailMetrics!.map(({ metrics }) => ({
      metrics: metrics.map((v, i) => v === null ? null : i === 0 || i === 5 ? v * 100 : i === 1 || i === 2 ? v * 1000 : v),
    })),
  };
  assert.deepEqual(buildKilometreSplits(converted, 2500).km_splits, buildKilometreSplits(stream, 2500).km_splits);
});

test("computes time-weighted HR and speed/HR decoupling rather than averaging irregular rows", () => {
  const result = buildKilometreSplits(chart([
    [0, 0, 0, 100],
    [500, 50, 50, 100],
    [1000, 300, 300, 160],
    [2000, 600, 600, 160],
  ]), 2000);
  assert.equal(result.km_splits[0].avg_heartrate, 125);
  assert.equal(result.km_splits[0].max_heartrate, 160);
  assert.equal(result.pacing_summary?.first_half_avg_heartrate, 125);
  assert.equal(result.pacing_summary?.second_half_avg_heartrate, 160);
  assert.equal(result.pacing_summary?.hr_drift_percent, 28);
  assert.equal(result.pacing_summary?.aerobic_decoupling_percent, 21.875);
});

test("missing sensor pairs remain null and insufficient HR coverage suppresses drift", () => {
  const result = buildKilometreSplits(chart([
    [0, 0, 0, 0], [500, 150, 150, 140], [1000, 300, 300, null],
    [1500, 450, 450, 150], [2000, 600, 600, 150],
  ]), 2000);
  assert.equal(result.km_splits[0].avg_heartrate, null);
  assert.equal(result.km_splits[0].max_heartrate, null);
  assert.equal(result.km_splits[0].cadence_spm, null);
  assert.equal(result.km_splits[0].elevation_gain_m, null);
  assert.equal(result.km_splits[1].metric_coverage_percent.heart_rate, 50);
  assert.equal(result.pacing_summary?.hr_drift_percent, null);
  assert.equal(result.pacing_summary?.aerobic_decoupling_percent, null);
  assert.match(result.pacing_summary!.notes.join(" "), /80%/);
});

test("HR coverage threshold is applied before rounding and even-pacing boundaries tolerate floating-point error", () => {
  const incompleteHR = buildKilometreSplits(chart([
    [0, 0, 0, 140], [800, 79.9999, 79.9999, 140],
    [850, 85, 85, null], [1000, 100, 100, 140], [2000, 200, 200, 140],
  ]), 2000);
  assert.ok(incompleteHR.km_splits[0].metric_coverage_percent.heart_rate < 80);
  assert.equal(incompleteHR.pacing_summary?.hr_drift_percent, null);
  assert.equal(incompleteHR.pacing_summary?.aerobic_decoupling_percent, null);
  for (const time of [594, 606]) {
    const even = buildKilometreSplits(chart([[0, 0, 0], [1000, 300, 300], [2000, time, time]]), 2000);
    assert.equal(even.pacing_summary?.strategy, "even");
    assert.equal(Math.abs(even.pacing_summary!.second_half_pace_change_percent!), 2);
  }
});

test("missing moving time switches explicitly to elapsed pace; missing elapsed time is not invented", () => {
  const elapsedOnly = {
    ...stream, metricDescriptors: stream.metricDescriptors!.filter(d => d.key !== "sumMovingDuration"),
  };
  const result = buildKilometreSplits(elapsedOnly, 2500);
  assert.equal(result.data_quality.pace_time_basis, "elapsed");
  assert.equal(result.km_splits[0].pace_per_km, "5:00");
  assert.equal(result.km_splits[0].moving_time_seconds, null);
  assert.equal(result.km_splits[0].stopped_time_seconds, null);
  assert.match(result.data_quality.warnings.join(" "), /includes pauses/);
  const movingOnly = buildKilometreSplits({
    ...stream, metricDescriptors: stream.metricDescriptors!.filter(d => d.key !== "sumElapsedDuration"),
  }, 2500);
  assert.equal(movingOnly.km_splits[0].elapsed_time_seconds, null);
  assert.equal(movingOnly.data_quality.pace_time_basis, "moving");
});

test("epoch timestamps become elapsed seconds, not huge cumulative epoch values", () => {
  const epoch = {
    ...stream,
    metricDescriptors: stream.metricDescriptors!.map(d => d.key === "sumElapsedDuration" ?
      { ...d, key: "directTimestamp", unit: { key: "gmt", factor: 0 } } : d),
    activityDetailMetrics: stream.activityDetailMetrics!.map(({ metrics }) => ({
      metrics: metrics.map((v, i) => i === 1 && v !== null ? 1_700_000_000_000 + v * 1000 : v),
    })),
  };
  assert.equal(buildKilometreSplits(epoch, 2500).km_splits[2].cumulative_elapsed_time_seconds, 750);
});

test("single-leg cadence is doubled once; total cadence is not doubled", () => {
  const singleLeg = {
    ...stream,
    metricDescriptors: stream.metricDescriptors!.map(d => d.key === "directDoubleCadence" ? { ...d, key: "directRunCadence" } : d),
    activityDetailMetrics: stream.activityDetailMetrics!.map(({ metrics }) => ({
      metrics: metrics.map((v, i) => i === 4 && v !== null ? v / 2 : v),
    })),
  };
  assert.equal(buildKilometreSplits(singleLeg, 2500).km_splits[0].cadence_spm, 170);
});

test("missing start/end coverage never fabricates a first or final split", () => {
  const result = buildKilometreSplits({
    ...stream, activityDetailMetrics: stream.activityDetailMetrics!.slice(1),
  }, 3000);
  assert.equal(result.data_quality.status, "partial");
  assert.deepEqual(result.km_splits.map(s => s.pace_per_km), [null, "5:00", null]);
  assert.equal(result.pacing_summary?.strategy, "unavailable");
  assert.match(result.data_quality.warnings.join(" "), /no extrapolation/);
  assert.equal(buildKilometreSplits({}, 3000).data_quality.status, "unavailable");
  assert.equal(buildKilometreSplits(chart([[500, 150, 150], [900, 270, 270]]), 1000).data_quality.status, "unavailable");
});

test("Garmin's small GPS increment at timer start and rounded final distance retain every split", () => {
  const race = buildKilometreSplits(chart([
    [2.2100000381469727, 0, 0, 140, 165, 32.8],
    [1000, 300, 300, 150, 165, 8],
    [2000, 600, 600, 160, 165, 49.4],
    [23328.0595703125, 7000, 7000, 190, 165, 49.4],
  ]), 23328.06);
  assert.equal(race.data_quality.status, "complete");
  assert.equal(race.km_splits[0].pace_per_km, "5:00");
  assert.equal(race.km_splits[0].avg_heartrate, 145);
  assert.ok(race.km_splits.every(split => split.pace_per_km !== null && split.avg_heartrate !== null));
  assert.equal(race.pacing_summary?.full_km_count, 23);
  assert.ok(race.pacing_summary?.hr_drift_percent !== null);
  assert.match(race.data_quality.warnings.join(" "), /anchored at the recorded timer start/);
  assert.match(race.data_quality.warnings.join(" "), /0.01 m numeric precision/);
});

test("start/end reconciliation never hides real missing coverage", () => {
  for (const [distance, elapsed] of [[2.21, 1], [10.01, 0]]) {
    const incomplete = buildKilometreSplits(chart([[distance, elapsed, elapsed, 140], [1000, 300, 300, 150]]), 1000);
    assert.equal(incomplete.data_quality.status, "unavailable");
    assert.equal(incomplete.km_splits[0].pace_per_km, null);
  }
  const missingEnd = buildKilometreSplits(chart([[0, 0, 0, 140], [1000, 300, 300, 150], [1999, 600, 600, 160]]), 2000);
  assert.equal(missingEnd.data_quality.status, "partial");
  assert.equal(missingEnd.km_splits[1].pace_per_km, null);
});

test("rejects backwards samples, impossible clocks and invalid distance", () => {
  for (const rows of [
    [[0, 0, 0], [1000, 300, 300], [500, 400, 400]],
    [[0, 0, 0], [1000, 300, 300], [2000, 200, 200]],
    [[0, 0, 0], [1000, 300, 400]],
    [[0, 0, 0], [1000, 0, 0]],
    [[0, 0, 0], [1000, 300, 0]],
  ]) assert.throws(() => buildKilometreSplits(chart(rows), 2000), /Garmin/);
  for (const distance of [0, -1, Infinity, NaN]) assert.throws(() => buildKilometreSplits(stream, distance), /positive distance/);
});

test("handles missing/duplicate required rows and rejects unsupported distance units without guessing", () => {
  const result = buildKilometreSplits(chart([
    [0, 0, 0], [0, 0, 0], [null, 5, 5], [1000, 300, 300],
  ]), 1000);
  assert.equal(result.data_quality.sample_count, 2);
  assert.match(result.data_quality.warnings.join(" "), /2 missing or duplicate/);
  const unsupported = {
    ...stream, metricDescriptors: stream.metricDescriptors!.map(d => d.key === "sumDistance" ? { ...d, unit: { key: "unknown" } } : d),
  };
  assert.equal(buildKilometreSplits(unsupported, 2500).data_quality.status, "unavailable");
});

test("classifies equal-distance halves and excludes a fast partial kilometre from comparisons", () => {
  const negative = buildKilometreSplits(chart([
    [0, 0, 0], [1000, 360, 360], [2000, 600, 600], [2500, 690, 690],
  ]), 2500);
  assert.equal(negative.pacing_summary?.strategy, "negative_split");
  assert.equal(negative.pacing_summary?.fastest_full_km, 2);
  assert.equal(negative.pacing_summary?.slowest_full_km, 1);
  assert.equal(negative.pacing_summary?.pace_std_deviation_seconds, 60);
  assert.equal(negative.km_splits[1].pace_delta_previous_seconds, -120);
  assert.equal(buildKilometreSplits(chart([[0, 0, 0], [1000, 240, 240], [2000, 600, 600]]), 2000).pacing_summary?.strategy, "positive_split");
  const short = buildKilometreSplits(chart([[0, 0, 0], [500, 150, 150]]), 500);
  assert.equal(short.km_splits.length, 1);
  assert.equal(short.km_splits[0].is_partial, true);
  assert.equal(short.pacing_summary?.fastest_full_km, null);
});

test("run analysis integrates km splits without relabelling interval laps; native capture retains charts", async () => {
  const laps: GarminActivitySplits = {
    activityId: 42,
    lapDTOs: [1, 2, 3].map(lapIndex => ({
      lapIndex, intensityType: lapIndex === 2 ? "RECOVERY" : "ACTIVE",
      distance: 800, duration: 240, movingDuration: 240, averageSpeed: 800 / 240,
    })),
  };
  const calls: number[] = [];
  const analysis = await analyzeGarminRun(42, {
    getActivityDetails: async () => activity,
    getActivitySplits: async () => laps,
    getActivityChart: async (id, resolution) => { assert.equal(id, 42); calls.push(resolution!); return stream; },
  });
  assert.deepEqual(calls, [100_000]);
  assert.equal(analysis.activity_id, 42);
  assert.deepEqual(analysis.elevation, { min_m: 0, max_m: 25, total_gain: 25 });
  assert.deepEqual(analysis.laps!.laps.map(lap => lap.distance_m), [800, 800, 800]);
  assert.deepEqual(analysis.kilometre_splits!.km_splits.map(s => s.distance_m), [1000, 1000, 500]);
  assert.equal(analysis.interval_consistency?.rep_count, 2);
  assert.match(analysis.kilometre_splits!.pacing_summary!.notes.join(" "), /mix work and recovery/);
  const report = reportSchema.parse(runReport(analysis));
  assert.deepEqual(report.sections[0].charts[0].series[0].points.map(p => p.value), [300, 300, 300]);
  assert.match(report.sections[0].charts[0].series[0].points[2].label, /partial/);
  const captured = captureToolResult("analyze_run_performance", JSON.stringify(analysis));
  assert.deepEqual(captured._meta?.[REPORT_META_KEY], report);
  const withoutStream = await analyzeGarminRun(42, {
    getActivityDetails: async () => activity, getActivitySplits: async () => laps, getActivityChart: async () => ({}),
  });
  assert.equal(withoutStream.kilometre_splits?.data_quality.status, "unavailable");
  assert.equal(withoutStream.laps?.count, 3);
});

test("splits tool works over MCP, validates IDs, captures a dashboard and propagates failures", async () => {
  const server = new McpServer({ name: "km-splits-test", version: "1" });
  let suppliedChart = stream;
  let fail = false, calls = 0;
  registerGarminTools(server, {
    getActivityDetails: async id => { assert.equal(id, 42); calls++; if (fail) throw new Error("Garmin request failed"); return activity; },
    getActivityChart: async (id, size) => { assert.equal(id, 42); assert.equal(size, 100_000); return suppliedChart; },
  });
  const client = new Client({ name: "km-splits-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const id of [-1, 0, 1.5]) {
      assert.equal((await client.callTool({ name: "garmin_get_km_splits", arguments: { activity_id: id } })).isError, true);
    }
    assert.equal(calls, 0);
    const result = await client.callTool({ name: "garmin_get_km_splits", arguments: { activity_id: 42 } });
    assert.equal(result.isError, undefined);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const data = JSON.parse(text);
    assert.equal(data.id, 42);
    assert.equal(data.kilometre_splits.km_splits.length, 3);
    assert.equal(data.laps, null);
    assert.deepEqual(captureToolResult("garmin_get_km_splits", text)._meta, result._meta);
    assert.equal(identifyReportTool("functions.garmin-garmin_get_km_splits"), "garmin_get_km_splits");
    suppliedChart = {};
    const missing = await client.callTool({ name: "garmin_get_km_splits", arguments: { activity_id: 42 } });
    assert.equal(missing.isError, true);
    assert.equal(missing._meta, undefined);
    fail = true;
    const failed = await client.callTool({ name: "garmin_get_km_splits", arguments: { activity_id: 42 } });
    assert.equal(failed.isError, true);
    assert.match(JSON.stringify(failed.content), /Garmin request failed/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("AI routing and documentation request the full run-performance report in one call", async () => {
  const [instructions, extension, readme] = await Promise.all([
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../integrations/copilot/extension.mjs", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);
  for (const guidance of [instructions, extension]) {
    assert.match(guidance, /run-analysis or run-performance requests, always use analyze_run_performance/);
    assert.match(guidance, /complete all-in-one report/);
    assert.match(guidance, /elevation\/altitude in meters/);
    assert.match(guidance, /Do not narrow a run-performance request to a splits-only report/);
  }
  assert.match(readme, /run analysis or run performance, use `analyze_run_performance`/);
  assert.match(readme, /explicit splits-only requests/);
});
