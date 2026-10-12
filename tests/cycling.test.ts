import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { GarminActivity, GarminActivityChart, GarminActivityDetails } from "../src/garmin/client.js";
import { buildCyclingWorkout, buildStructuredWorkout } from "../src/garmin/client.js";
import { formatGarminActivity } from "../src/garmin/format.js";
import {
  bestAveragePower, detectClimbs, normalizedPower, powerZones, readRideStream, rideSegments, timeInPowerZones,
} from "../src/cycling/stream.js";
import { matchesActivityTypeFilter } from "../src/cycling/activity-type.js";
import {
  analyzeGarminRide, buildCyclingEventStrategy, buildCyclingFitness, buildCyclingTrends, buildPowerProfile,
  isCyclingType, rideTss, summarizeRide, type CyclingApi,
} from "../src/cycling/analysis.js";
import { rideAnalysisSchema } from "../src/cycling/schema.js";
import { registerCyclingTools } from "../src/cycling/tools.js";
import { captureToolResult, identifyReportTool } from "../src/presentation/capture.js";
import { DASHBOARD_URI, REPORT_META_KEY, reportSchema } from "../src/presentation/model.js";
import { rideReport } from "../src/presentation/cycling.js";

const descriptors = [
  ["sumDistance", "meter"], ["sumElapsedDuration", "second"], ["sumMovingDuration", "second"],
  ["directHeartRate", "bpm"], ["directBikeCadence", "rpm"], ["directCorrectedElevation", "meter"],
  ["directPower", "watt"], ["directSpeed", "mps"], ["directAirTemperature", "celsius"],
] as const;

function chart(rows: Array<Array<number | null>>): GarminActivityChart {
  return {
    metricDescriptors: descriptors.map(([key, unit], metricsIndex) => ({ key, metricsIndex, unit: { key: unit, factor: 1 } })),
    activityDetailMetrics: rows.map(metrics => ({ metrics })),
  };
}

/** One hour at 10 m/s: flat, a 2 km climb at 5 % from km 10, then flat. 200 W then 250 W. */
function syntheticRide(seconds = 3600) {
  const rows: Array<Array<number | null>> = [];
  for (let t = 0; t < seconds; t++) {
    const distance = t * 10;
    const elevation = distance < 10_000 ? 100 : distance < 12_000 ? 100 + (distance - 10_000) * 0.05 : 200;
    const power = t < seconds / 2 ? 200 : 250;
    const heartRate = t < seconds / 2 ? 140 : 150;
    const cadence = t % 10 === 0 ? 0 : 90;
    rows.push([distance, t, t, heartRate, cadence, elevation, power, 10, 18]);
  }
  return chart(rows);
}

const rideDetails: GarminActivityDetails = {
  activityId: 7, activityName: "Synthetic hill ride", activityTypeDTO: { typeKey: "road_biking" },
  summaryDTO: {
    startTimeLocal: "2026-10-07T10:00:00", distance: 35_990, duration: 3600, movingDuration: 3599,
    averageSpeed: 10, elevationGain: 100, elevationLoss: 0, averageHR: 145, maxHR: 150, calories: 800,
    averageRunCadence: 0, averagePower: 225, maxPower: 250, normalizedPower: 228, trainingStressScore: 80,
  },
};

function fakeApi(overrides: Partial<CyclingApi> = {}): CyclingApi {
  return {
    getActivityDetails: async () => rideDetails,
    getActivitySplits: async () => ({ activityId: 7, lapDTOs: [] }),
    getActivityChart: async () => syntheticRide(),
    getHeartRateZones: async () => [{ sport: "CYCLING", zone1Floor: 100, zone2Floor: 120, zone3Floor: 140, zone4Floor: 155, zone5Floor: 170, maxHeartRateUsed: 190, lactateThresholdHeartRateUsed: 160 }],
    getCyclingFtp: async () => 250,
    getUserSettings: async () => ({ userData: { weight: 75_000 } }),
    getAllActivities: async () => [],
    ...overrides,
  };
}

function activity(id: number, daysAgo: number, extra: Partial<GarminActivity> = {}, now = new Date("2026-10-12T12:00:00")): GarminActivity {
  const date = new Date(now.getTime() - daysAgo * 86_400_000);
  const local = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} 09:00:00`;
  return {
    activityId: id, activityName: `Ride ${id}`, activityType: { typeKey: "road_biking" }, startTimeLocal: local,
    distance: 40_000, duration: 3600, movingDuration: 3600, averageSpeed: 40_000 / 3600, maxSpeed: 15,
    averageHR: 140, maxHR: 170, calories: 900, elevationGain: 300, ...extra,
  };
}

test("recognises cycling activity types without matching motorcycling", () => {
  for (const type of ["cycling", "road_biking", "gravel_cycling", "mountain_biking", "indoor_cycling", "virtual_ride", "e_bike_mountain", "bmx"]) {
    assert.equal(isCyclingType(type), true, type);
  }
  for (const type of ["running", "motorcycling", "walking", "lap_swimming", undefined]) assert.equal(isCyclingType(type), false, String(type));
  for (const filter of ["cycling", "Bike", "ride"]) {
    assert.ok(["road_biking", "virtual_ride", "e_bike_fitness", "indoor_cycling"].every(type => matchesActivityTypeFilter(type, filter)), filter);
    assert.equal(matchesActivityTypeFilter("running", filter), false);
  }
  assert.equal(matchesActivityTypeFilter("trail_running", "running"), true, "other filters keep substring matching");
  assert.equal(matchesActivityTypeFilter("road_biking", "road"), true);
});

test("resamples to 1 Hz, excludes long pauses and computes Coggan power metrics", () => {
  const stream = readRideStream(syntheticRide());
  assert.equal(stream.seconds, 3600);
  assert.equal(stream.excludedPauseSeconds, 0);
  assert.equal(normalizedPower(Array(600).fill(200)), 200);
  const surges = Array.from({ length: 1200 }, (_, i) => Math.floor(i / 30) % 2 ? 400 : 0);
  assert.ok(normalizedPower(surges)! > 250, "surging raises NP above the 200 W average");
  assert.equal(bestAveragePower(stream.series.power, 60), 250);
  assert.equal(bestAveragePower(stream.series.power, 3600), 225);
  assert.equal(bestAveragePower(stream.series.power, 7200), null);

  const paused = readRideStream(chart([[0, 0, 0, 140, 90, 0, 200, 5, 18], [5, 1, 1, 140, 90, 0, 200, 5, 18], [10, 61, 2, 140, 90, 0, 200, 5, 18], [15, 62, 3, 140, 90, 0, 200, 5, 18]]));
  assert.equal(paused.excludedPauseSeconds, 59);
  assert.equal(paused.seconds, 4);
  assert.match(paused.warnings.join(" "), /paused time/);
});

test("builds whole-watt Coggan zones and time in zone", () => {
  assert.deepEqual(powerZones(250).map(zone => [zone.min_w, zone.max_w]), [[0, 137], [138, 187], [188, 225], [226, 262], [263, 300], [301, 375], [376, null]]);
  const zones = timeInPowerZones([100, 200, 250, 250, null, 400], 250);
  assert.deepEqual(zones.map(zone => zone.seconds), [1, 0, 1, 2, 0, 0, 1]);
  assert.equal(zones.reduce((sum, zone) => sum + zone.percent, 0), 100);
});

test("detects a sustained climb and splits the ride into distance segments", () => {
  const stream = readRideStream(syntheticRide());
  const climbs = detectClimbs(stream, 75);
  assert.equal(climbs.length, 1);
  const [climb] = climbs;
  assert.ok(Math.abs(climb.elevation_gain_m - 100) <= 6, `gain ${climb.elevation_gain_m}`);
  assert.ok(Math.abs(climb.avg_grade_percent! - 5) <= 0.6, `grade ${climb.avg_grade_percent}`);
  assert.ok(climb.start_km! >= 9.7 && climb.start_km! <= 10.3, `start ${climb.start_km}`);
  assert.equal(climb.avg_power_w, 200);
  assert.equal(climb.avg_w_per_kg, 2.67);
  assert.ok(climb.vam_m_per_h > 1600 && climb.vam_m_per_h < 1900);

  const segments = rideSegments(stream, 5);
  assert.equal(segments.basis, "distance");
  assert.equal(segments.items.length, 8);
  assert.deepEqual(segments.items.slice(0, 2).map(item => item.distance_m), [5000, 5000]);
  assert.equal(segments.items[0].avg_speed_kmh, 36);
  assert.equal(segments.items.at(-1)!.is_partial, true);
  assert.ok(segments.items[2].elevation_gain_m! >= 98.5 && segments.items[2].elevation_gain_m! <= 100);

  const noisy = readRideStream(chart(Array.from({ length: 600 }, (_, t) => [t * 8, t, t, 140, 90, 50 + (t % 2 ? 1 : -1) * 0.6, 200, 8, 18])));
  const flat = rideSegments(noisy, 5).items[0];
  assert.equal(flat.elevation_gain_m, 0, "±0.6 m altitude noise is not counted as climbing");
  assert.equal(flat.elevation_loss_m, 0);

  const indoor = rideSegments({ ...stream, available: { ...stream.available, distance: false } }, 5);
  assert.equal(indoor.basis, "time");
  assert.equal(indoor.items.length, 6);
});

test("analyzes a Garmin ride end to end with FTP, zones, decoupling and dashboard", async () => {
  const analysis = rideAnalysisSchema.parse(await analyzeGarminRide(7, {}, fakeApi()));
  assert.equal(analysis.activity.avg_speed_kmh, 36);
  assert.equal(analysis.power.ftp_w, 250);
  assert.equal(analysis.power.ftp_source, "garmin");
  assert.equal(analysis.power.avg_w, 225);
  assert.equal(analysis.power.tss_source, "power");
  assert.ok(analysis.power.intensity_factor! > 0.9 && analysis.power.intensity_factor! < 0.93);
  assert.ok(Math.abs(analysis.power.tss! - 100 * analysis.power.intensity_factor! ** 2) < 1.5);
  assert.equal(analysis.power.weight_kg, 75);
  assert.equal(analysis.power.garmin_reported.tss, 80);
  assert.equal(analysis.power_zones!.reduce((sum, zone) => sum + zone.seconds, 0), 3600);
  assert.equal(analysis.heart_rate_zones!.profile, "CYCLING");
  assert.equal(analysis.heart_rate_zones!.zones.find(zone => zone.zone === 3)!.seconds, 3600);
  assert.ok(analysis.efficiency!.decoupling_percent! < 0, "more power per beat in the second half");
  assert.equal(analysis.cadence!.avg_pedaling_rpm, 90);
  assert.equal(analysis.cadence!.coasting_percent, 10);
  assert.equal(analysis.climbs.length, 1);
  assert.equal(analysis.data_quality.status, "complete");

  const override = await analyzeGarminRide(7, { ftp_watts: 300, weight_kg: 70 }, fakeApi());
  assert.equal(override.power.ftp_source, "user");
  assert.equal(override.power.normalized_w_per_kg, round(override.power.normalized_w! / 70));

  const report = reportSchema.parse(rideReport(analysis));
  assert.ok(report.sections.some(section => section.id === "climbs"));
  assert.ok(report.sections.some(section => section.charts.some(c => c.id === "power-zones")));
  const captured = captureToolResult("analyze_ride_performance", JSON.stringify(analysis));
  assert.deepEqual(captured._meta?.[REPORT_META_KEY], report);
  assert.equal(identifyReportTool("garmin-analyze_ride_performance"), "analyze_ride_performance");
  assert.equal(identifyReportTool("functions.garmin-get_cycling_power_profile"), "get_cycling_power_profile");
});

function round(value: number) {
  return +value.toFixed(2);
}

test("ride analysis degrades to summary data and rejects runs", async () => {
  const summaryOnly = await analyzeGarminRide(7, {}, fakeApi({ getActivityChart: async () => { throw new Error("404"); } }));
  assert.equal(summaryOnly.data_quality.status, "summary_only");
  assert.equal(summaryOnly.power.normalized_w, 228);
  assert.equal(summaryOnly.power.tss, 80);
  assert.equal(summaryOnly.power.tss_source, "garmin");
  assert.deepEqual(summaryOnly.segments.items, []);
  reportSchema.parse(rideReport(summaryOnly));

  const noPower = await analyzeGarminRide(7, {}, fakeApi({
    getActivityDetails: async () => ({ ...rideDetails, summaryDTO: { ...rideDetails.summaryDTO, averagePower: undefined, maxPower: undefined, normalizedPower: undefined, trainingStressScore: undefined } }),
    getActivityChart: async () => {
      const ride = syntheticRide();
      for (const row of ride.activityDetailMetrics!) row.metrics[6] = null;
      return ride;
    },
  }));
  assert.equal(noPower.power.available, false);
  assert.equal(noPower.power.tss_source, "heart_rate");
  assert.equal(noPower.power.tss, 82.1, "moving hours × (145 / 160 LTHR)² × 100");
  assert.equal(noPower.power.intensity_factor, null);
  assert.ok(!noPower.notes.some(note => /Normalized power/.test(note)));
  assert.ok(noPower.notes.some(note => /heart-rate estimate/.test(note)));
  assert.equal(noPower.power_zones, null);
  assert.match(noPower.data_quality.warnings.join(" "), /No power meter data/);
  reportSchema.parse(rideReport(noPower));

  await assert.rejects(
    analyzeGarminRide(7, {}, fakeApi({ getActivityDetails: async () => ({ ...rideDetails, activityTypeDTO: { typeKey: "running" } }) })),
    /not a ride/,
  );
});

test("resolves TSS by source priority and models cycling fitness", () => {
  const ctx = { ftp: 250, thresholdHr: 160 };
  assert.deepEqual(rideTss(summarizeRide(activity(1, 0, { trainingStressScore: 77 })), ctx), { tss: 77, source: "garmin" });
  assert.equal(rideTss(summarizeRide(activity(1, 0, { normPower: 200 })), ctx).source, "power");
  assert.equal(Math.round(rideTss(summarizeRide(activity(1, 0, { normPower: 250 })), ctx).tss), 100);
  assert.equal(rideTss(summarizeRide(activity(1, 0)), ctx).source, "heart_rate");
  assert.equal(rideTss(summarizeRide(activity(1, 0, { averageHR: 0 })), ctx).source, "duration_estimate");

  const now = new Date("2026-10-12T12:00:00");
  const history = [
    ...Array.from({ length: 60 }, (_, i) => activity(i + 1, i, { trainingStressScore: 100 }, now)),
    { ...activity(999, 1, {}, now), activityType: { typeKey: "running" } },
  ];
  const model = buildCyclingFitness(history, 120, ctx, now);
  assert.equal(model.rides_analyzed, 60);
  assert.equal(model.tss_sources.garmin, 60);
  assert.equal(model.model.daily.length, 42);
  assert.equal(model.model.daily.at(-1)!.tss, 100);
  assert.ok(model.model.current.ctl > 70 && model.model.current.ctl < 100);
  assert.ok(model.model.current.atl > 99);
  assert.ok(model.model.current.tsb < 0);
  assert.equal(captureToolResult("get_cycling_fitness_model", JSON.stringify(model)).isError, undefined);
});

test("summarises weekly cycling trends and ride listings", () => {
  const now = new Date("2026-10-12T12:00:00");
  const history = [
    activity(1, 1, { normPower: 220, avgPower: 200 }, now),
    activity(2, 2, { activityType: { typeKey: "indoor_cycling" }, distance: 30_000 }, now),
    activity(3, 9, {}, now),
    { ...activity(4, 3, {}, now), activityType: { typeKey: "running" } },
  ];
  const trends = buildCyclingTrends(history, 4, { ftp: 250, thresholdHr: 160 }, now);
  assert.equal(trends.total_rides, 3);
  assert.equal(trends.total_km, 110);
  assert.equal(trends.total_hours, 3);
  const weeks = trends.weekly_breakdown.filter(week => week.rides > 0);
  assert.ok(weeks.some(week => week.indoor_rides === 1 && week.outdoor_avg_speed_kmh === 40));
  assert.equal(captureToolResult("get_cycling_trends", JSON.stringify(trends)).isError, undefined);

  const listed = formatGarminActivity(activity(1, 0, { avgPower: 210, normPower: 230, averageBikingCadenceInRevPerMinute: 88 }));
  assert.equal(listed.effort_level, null, "running effort labels do not apply to rides");
  assert.deepEqual(listed.cycling, { speed_kmh: 40, avg_power_w: 210, normalized_power_w: 230, max_power_w: null, tss: null, intensity_factor: null, cadence_rpm: 88 });
  assert.equal("cycling" in formatGarminActivity({ ...activity(2, 0), activityType: { typeKey: "running" } }), false);
});

test("builds a power profile from Garmin best efforts and downloaded streams", async () => {
  const now = new Date();
  let chartCalls = 0;
  const api = fakeApi({
    getCyclingFtp: async () => null,
    getAllActivities: async () => [
      activity(1, 3, { avgPower: 200, maxAvgPower_5: 900, maxAvgPower_60: 400, maxAvgPower_1200: 280, maxAvgPower_3600: 250 }, now),
      activity(2, 10, { avgPower: 210, maxAvgPower_5: 950, maxAvgPower_1200: 260 }, now),
      activity(3, 5, { avgPower: 225 }, now),
      activity(4, 200, { avgPower: 300, maxAvgPower_1200: 400 }, now),
    ],
    getActivityChart: async () => { chartCalls++; return syntheticRide(); },
  });
  const profile = await buildPowerProfile({ days: 90, max_activities: 100, max_stream_rides: 5 }, api);
  assert.equal(profile.rides_analyzed, 3);
  assert.equal(profile.streams_fetched, 1);
  assert.equal(chartCalls, 1);
  const curve = Object.fromEntries(profile.power_curve.map(point => [point.duration_s, point]));
  assert.equal(curve[5].watts, 950);
  assert.equal(curve[5].activity_id, 2);
  assert.equal(curve[60].watts, 400);
  assert.equal(curve[1200].watts, 280);
  assert.equal(curve[1800].activity_id, 3, "computed from the downloaded stream");
  assert.equal(profile.ftp.estimated_w, 266);
  assert.equal(profile.ftp.selected_source, "estimated_from_20min");
  assert.equal(profile.ftp.w_per_kg, 3.55);
  assert.equal(profile.power_zones!.length, 7);
  assert.equal(captureToolResult("get_cycling_power_profile", JSON.stringify(profile)).isError, undefined);
});

test("plans cycling event pacing and fueling from FTP and duration", async () => {
  const strategy = await buildCyclingEventStrategy({ distance_km: 100, event_type: "gran_fondo", goal_duration_hours: 3, elevation_gain_m: 1500, temperature_c: 28 }, fakeApi());
  assert.equal(strategy.ftp.watts, 250);
  assert.deepEqual([strategy.targets.intensity_factor_low, strategy.targets.intensity_factor_high], [0.78, 0.85]);
  assert.deepEqual([strategy.targets.normalized_power_low_w, strategy.targets.normalized_power_high_w], [195, 213]);
  assert.equal(strategy.targets.climb_ceiling_w, 250);
  assert.equal(strategy.targets.heart_rate_ceiling_bpm, 152);
  assert.deepEqual([strategy.fueling.carbs_g_per_hour_low, strategy.fueling.carbs_g_per_hour_high], [60, 90]);
  assert.deepEqual([strategy.fueling.total_carbs_g_low, strategy.fueling.total_carbs_g_high], [180, 270]);
  assert.equal(strategy.fueling.fluid_ml_per_hour_high, 1000);
  assert.equal(strategy.duration.implied_speed_kmh, 33.3);
  assert.equal(captureToolResult("cycling_event_strategy", JSON.stringify(strategy)).isError, undefined);

  const estimated = await buildCyclingEventStrategy({ distance_km: 80, event_type: "road_race" }, fakeApi({
    getCyclingFtp: async () => null,
    getAllActivities: async () => [activity(1, 5, { maxAvgPower_1200: 300 }), activity(2, 8)],
  }));
  assert.equal(estimated.ftp.source, "estimated_from_20min");
  assert.equal(estimated.duration.hours, 2);
  assert.match(estimated.duration.source, /median moving speed 40 km\/h/);
  assert.ok(!estimated.tips.some(tip => /None of your recent rides recorded power/.test(tip)));
  const heartRateOnly = await buildCyclingEventStrategy({ distance_km: 80, event_type: "gran_fondo" }, fakeApi({
    getAllActivities: async () => [activity(1, 5), activity(2, 8)],
  }));
  assert.match(heartRateOnly.tips[0], /None of your recent rides recorded power/);
});

test("builds Garmin cycling workouts without changing running payloads", () => {
  const cycling = buildCyclingWorkout("Sweet spot", "", [
    { type: "warmup", duration_seconds: 600 },
    { type: "interval", duration_seconds: 720, repeat: 3, target: { type: "power", low: 230.4, high: 220 } },
    { type: "recovery", duration_seconds: 300, target: { type: "cadence", low: 85, high: 95 } },
    { type: "cooldown", duration_seconds: 600, target: { type: "heart_rate", low: 110, high: 130 } },
  ]);
  assert.deepEqual(cycling.sportType, { sportTypeId: 2, sportTypeKey: "cycling" });
  const repeat = cycling.workoutSegments[0].workoutSteps[1];
  assert.equal(repeat.type, "RepeatGroupDTO");
  if (repeat.type !== "RepeatGroupDTO") return;
  assert.equal(repeat.numberOfIterations, 3);
  assert.deepEqual(repeat.workoutSteps[0].targetType, { workoutTargetTypeId: 2, workoutTargetTypeKey: "power.zone" });
  assert.deepEqual([repeat.workoutSteps[0].targetValueOne, repeat.workoutSteps[0].targetValueTwo], [220, 230]);
  assert.equal(repeat.workoutSteps[1].targetType.workoutTargetTypeKey, "cadence");
  assert.equal(cycling.workoutSegments[0].workoutSteps[2].type === "ExecutableStepDTO" && cycling.workoutSegments[0].workoutSteps[2].targetType.workoutTargetTypeKey, "heart.rate.zone");

  const running = buildStructuredWorkout("Intervals", "", [
    { type: "interval", distance_meters: 800, repeat: 4, target_pace_min_per_km: 5, target_pace_max_per_km: 4.5 },
    { type: "recovery", duration_seconds: 120 },
  ]);
  assert.deepEqual(running.sportType, { sportTypeId: 1, sportTypeKey: "running" });
  const runRepeat = running.workoutSegments[0].workoutSteps[0];
  if (runRepeat.type !== "RepeatGroupDTO") throw new Error("expected repeat");
  assert.equal(runRepeat.workoutSteps[0].targetType.workoutTargetTypeKey, "pace.zone");
  assert.equal(runRepeat.workoutSteps[0].targetValueOne, 1000 / 270);
  assert.equal(runRepeat.workoutSteps[1].targetType.workoutTargetTypeKey, "no.target");
});

test("registers cycling dashboards and converts %FTP workout targets", async () => {
  const server = new McpServer({ name: "cycling-test", version: "1" });
  const created: unknown[] = [];
  registerCyclingTools(server, fakeApi(), {
    addStructuredWorkout: async (payload) => { created.push(payload); return { workoutId: 99 }; },
    getCyclingFtp: async () => 280,
  });
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    for (const name of ["analyze_ride_performance", "get_cycling_power_profile", "get_cycling_trends", "get_cycling_fitness_model", "cycling_event_strategy"]) {
      assert.deepEqual(tools.find(tool => tool.name === name)?._meta?.ui, { resourceUri: DASHBOARD_URI }, name);
    }
    assert.equal(tools.find(tool => tool.name === "garmin_add_cycling_workout")?._meta, undefined);

    const ride = await client.callTool({ name: "analyze_ride_performance", arguments: { activity_id: 7 } });
    assert.equal(ride.isError, undefined);
    assert.ok(ride._meta?.[REPORT_META_KEY]);

    const workout = await client.callTool({ name: "garmin_add_cycling_workout", arguments: {
      name: "Threshold", steps: [{ type: "interval", duration_seconds: 600, target: { type: "power_percent_ftp", low: 95, high: 105 } }],
    } });
    assert.equal(workout.isError, undefined);
    const body = JSON.parse((workout.content as Array<{ text: string }>)[0].text);
    assert.equal(body.workout_id, 99);
    assert.deepEqual(body.steps[0].target, { type: "power", low: 266, high: 294 });
    assert.equal(created.length, 1);

    const invalid = await client.callTool({ name: "analyze_ride_performance", arguments: {} });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
