import assert from "node:assert/strict";
import test from "node:test";
import { formatGarminActivityDetails, formatGarminHeartRateZones } from "../src/garmin/format.js";
import { reportSchema, REPORT_META_KEY } from "../src/presentation/model.js";
import { reportResult } from "../src/presentation/resource.js";
import {
  activityReport, loadReport, paceSeconds, raceReport, readinessReport,
  runReport, trendsReport, weeklyReport, zonesReport, type RunReportData,
} from "../src/presentation/reports.js";

const run: RunReportData = {
  source: "garmin",
  activity: {
    name: '<img src=x onerror="alert(1)"> Evening intervals',
    date: { human: "Tuesday, September 8, 2026" },
    distance_km: 8.4,
    total_time: "45m 12s",
    avg_pace: "5:23",
    avg_heartrate: 152,
    max_heartrate: 178,
    cadence_spm: 170,
    elevation_gain_m: 0,
    training_effect: 0,
    anaerobic_training_effect: null,
    training_load: null,
  },
  laps: {
    count: 3,
    looks_like_interval_workout: true,
    interval_summary: "2 work reps",
    note: "Recorded laps",
    laps: [
      { lap: 1, name: "ACTIVE", distance_m: 800, distance_km: 0.8, duration: "3m 24s", pace_per_km: "4:15", avg_hr: 164, max_hr: 176 },
      { lap: 2, name: "RECOVERY", distance_m: 200, distance_km: 0.2, duration: "2m", pace_per_km: "N/A", avg_hr: null, max_hr: null },
      { lap: 3, name: "ACTIVE", distance_m: 800, distance_km: 0.8, duration: "3m 26s", pace_per_km: "4:18", avg_hr: 168, max_hr: 178 },
    ],
  },
  hr_drift: { first_half_avg: 142, second_half_avg: 158, drift_percent: "11.3", assessment: "Significant drift" },
};

test("run dashboard preserves recorded lap structure, missing readings, and real zeros", () => {
  const dashboard = reportSchema.parse(runReport(run));
  assert.equal(dashboard.title, run.activity.name);
  assert.equal(dashboard.metrics.find(item => item.label === "Training effect")?.value, "0");
  assert.equal(dashboard.metrics.find(item => item.label === "Elevation gain")?.value, "0");
  const [pace, hr, drift] = dashboard.sections[0].charts;
  assert.equal(pace.format, "pace");
  assert.deepEqual(pace.series[0].points.map(point => point.value), [255, null, 258]);
  assert.equal(pace.series[0].points[1].color, "green");
  assert.match(pace.series[0].points[0].label, /800 m/);
  assert.deepEqual(hr.series[0].points.map(point => point.value), [164, null, 168]);
  assert.deepEqual(drift.series[0].points.map(point => point.value), [142, 158]);
});

test("runs with no lap breakdown explicitly show chart unavailability", () => {
  const dashboard = runReport({ source: run.source, activity: { ...run.activity, avg_heartrate: 0 } });
  assert.equal(dashboard.metrics.find(item => item.label === "Average heart rate")?.value, "Unavailable");
  assert.ok(dashboard.sections[0].charts.every(chart => chart.series[0].points.length === 0));
  assert.match(dashboard.sections[0].notes.join(" "), /unavailable/);
});

test("result metadata adds a dashboard without modifying or duplicating model-facing JSON", () => {
  const result = reportResult(run, runReport(run));
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(run, null, 2) }]);
  assert.equal(result.structuredContent, undefined);
  assert.equal(result.isError, undefined);
  assert.deepEqual(reportSchema.parse(result._meta?.[REPORT_META_KEY]), runReport(run));
});

test("invalid chart numbers fail explicitly instead of yielding corrupt SVG data", () => {
  const dashboard = runReport(run);
  dashboard.sections[0].charts[0].series[0].points[0].value = Infinity;
  assert.throws(() => reportResult(run, dashboard), /finite|number|Infinity/i);
});

test("pace parsing accepts source formats without treating missing pace as zero", () => {
  assert.equal(paceSeconds("4:05"), 245);
  assert.equal(paceSeconds("4:05 /km"), 245);
  assert.equal(paceSeconds("4:60 /km"), 300);
  for (const value of ["N/A", "", "0:00", "Infinity", "-1:30"]) assert.equal(paceSeconds(value), null);
});

test("sport profiles retain their configured zone boundaries and colours", () => {
  const formatted = formatGarminHeartRateZones([
    { sport: "RUNNING", trainingMethod: "LTHR", zone1Floor: 100, zone2Floor: 120, zone3Floor: 140, zone4Floor: 160, zone5Floor: 180, maxHeartRateUsed: 195 },
    { sport: "CYCLING", zone1Floor: 90, zone2Floor: 110, zone3Floor: 130, zone4Floor: 150, zone5Floor: 170, maxHeartRateUsed: 185 },
  ]);
  const dashboard = reportSchema.parse(zonesReport(formatted));
  assert.deepEqual(dashboard.sections.map(section => section.label), ["RUNNING", "CYCLING"]);
  assert.deepEqual(dashboard.sections[0].charts[0].series[0].points.map(point => [point.low, point.value]), [
    [100, 119], [120, 139], [140, 159], [160, 179], [180, 195],
  ]);
  assert.deepEqual(dashboard.sections[0].charts[0].series[0].points.map(point => point.color), ["blue", "green", "amber", "orange", "red"]);
  assert.match(dashboard.sections[0].notes.join(" "), /not measured time in zones/);
  assert.equal(dashboard.sections[1].charts[0].series[0].points[0].low, 90);
});

test("missing and inverted zones are not plotted as meaningful ranges", () => {
  const dashboard = zonesReport(formatGarminHeartRateZones([
    { sport: "RUNNING", zone1Floor: 150, zone2Floor: 110, maxHeartRateUsed: 190 },
  ]));
  const points = dashboard.sections[0].charts[0].series[0].points;
  assert.equal(points[0].value, null);
  assert.equal(points[0].low, null);
  assert.equal(points[1].value, null, "a missing next-zone floor is not replaced by maximum HR");
  assert.equal(points[2].value, null);
  assert.match(dashboard.sections[0].notes.join(" "), /missing or inconsistent/);
  assert.deepEqual(zonesReport(formatGarminHeartRateZones([])).sections, []);
});

test("trend charts preserve empty weeks, chronological labels, and missing pace/HR", () => {
  const data = {
    period: "Last 3 weeks", total_runs: 2, total_km: "12.0", volume_trend: "increasing",
    weekly_breakdown: [
      { week_of: "2026-08-24", runs: 1, total_km: "5.0", avg_pace: "5:00", avg_heartrate: 140 },
      { week_of: "2026-08-31", runs: 0, total_km: "0.0", avg_pace: "N/A", avg_heartrate: null },
      { week_of: "2026-09-07", runs: 1, total_km: "7.0", avg_pace: "5:05", avg_heartrate: 145 },
    ],
  };
  const dashboard = reportSchema.parse(trendsReport(data));
  assert.deepEqual(dashboard.sections[0].charts[0].series[0].points.map(point => point.value), [5, 0, 7]);
  assert.deepEqual(dashboard.sections[0].charts[1].series[0].points.map(point => point.value), [300, null, 305]);
  assert.deepEqual(dashboard.sections[0].charts[2].series[0].points.map(point => point.value), [140, null, 145]);
  assert.match(dashboard.sections[0].charts[0].description, /partial/);
  assert.equal(reportSchema.parse(trendsReport({ ...data, weekly_breakdown: [] })).sections[0].charts[0].series[0].points.length, 0);
});

test("training load keeps negative balance values and distinct fitness/fatigue series", () => {
  const dashboard = reportSchema.parse(loadReport({
    days: 90, runs_analyzed: 20,
    model: {
      current: { ctl: 30, atl: 45, tsb: -15, acute_chronic_ratio: 1.4, fatigue_risk: "elevated" },
      daily_load: [{ date: "2026-09-08", load: 60, ctl: 30, atl: 45, tsb: -15 }],
    },
  }));
  assert.deepEqual(dashboard.sections[0].charts[0].series.map(series => series.points[0].value), [30, 45]);
  assert.equal(dashboard.sections[0].charts[1].series[0].points[0].value, -15);
  assert.match(dashboard.sections[0].notes[0], /heuristic/);
});

test("readiness shows measured contributions, missing-signal caveats, and signed adjustments", () => {
  const dashboard = reportSchema.parse(readinessReport({
    readiness_score: 62, confidence: "low", recommendation: "moderate_day_recommended",
    components: { sleep: { adjustment: -10 }, load_ratio: { adjustment: 2 } },
  }));
  assert.deepEqual(dashboard.sections[0].charts[0].series[0].points.map(point => point.value), [-10, 2]);
  assert.equal(dashboard.metrics.find(metric => metric.label === "Confidence")?.value, "low");
  assert.match(dashboard.sections[0].notes.join(" "), /not medical clearance/);
});

test("race dashboard uses adjusted split targets and preserves partial kilometre labels", () => {
  const dashboard = reportSchema.parse(raceReport({
    race: { distance_label: "Half Marathon", goal_time: "1h 45m", goal_pace: "4:59 /km", goal_source: "user goal", feasibility_assessment: "Realistic" },
    adjustments: { adjusted_time: "1h 50m", adjusted_pace: "5:13 /km" },
    pacing_strategy: "Negative split",
    km_splits: [
      { km: 1, target_pace: "5:20 /km", phase: "Start", notes: "Easy start" },
      { km: "21-21.1", target_pace: "4:55 /km", phase: "Kick", notes: "Final stretch" },
    ],
    race_day_tips: ["Familiar breakfast"],
  }));
  assert.equal(dashboard.metrics.length, 4);
  assert.equal(dashboard.sections[0].charts[0].series[0].points[0].value, 320);
  assert.match(dashboard.sections[0].charts[0].series[0].points[1].label, /21-21.1/);
  assert.ok(dashboard.sections[0].notes.includes("Familiar breakfast"));
});

test("weekly dashboard shows coach notes and both source week totals", () => {
  const dashboard = reportSchema.parse(weeklyReport({
    period: { start: "2026-09-07", end_exclusive: "2026-09-14" },
    this_week: { runs: 1, total_km: 7, avg_pace: "5:20", hard_sessions: 0 },
    previous_week: { runs: 3, total_km: 22, avg_pace: "5:15", hard_sessions: 1 },
    plan_adherence: "no planned workouts found",
    coach_notes: ["Protect recovery days"],
  }));
  assert.deepEqual(dashboard.sections[0].charts[0].series[0].points.map(point => point.value), [22, 7]);
  assert.deepEqual(dashboard.sections[0].notes, ["Protect recovery days"]);
});

test("activity detail formatter connects to the same run dashboard", () => {
  const formatted = formatGarminActivityDetails({
    activityId: 1, activityName: "Easy run", activityTypeDTO: { typeKey: "running" },
    summaryDTO: {
      startTimeLocal: "2026-09-08T10:00:00", distance: 5000, duration: 1800,
      movingDuration: 1750, averageSpeed: 2.8, elevationGain: 0,
      averageHR: 140, maxHR: 150, calories: 300, averageRunCadence: 170,
    },
  }, { activityId: 1 });
  const dashboard = reportSchema.parse(activityReport(formatted));
  assert.equal(dashboard.title, "Easy run");
  assert.equal(dashboard.metrics.find(metric => metric.label === "Distance")?.value, "5");
  assert.equal(dashboard.metrics.find(metric => metric.label === "Moving time")?.value, formatted.moving_duration);
});
