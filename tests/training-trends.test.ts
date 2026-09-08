import assert from "node:assert/strict";
import test from "node:test";
import { buildTrainingTrends } from "../src/analysis/trends.js";

function activity(date: string, type = "running") {
  return { startTimeLocal: date, activityType: { typeKey: type }, distance: 5000, duration: 1500, averageHR: 140 };
}

test("trends keep Monday boundaries, Sundays, and quiet weeks in local time zones", () => {
  const originalTimezone = process.env.TZ;
  try {
    for (const timezone of ["Europe/Copenhagen", "America/Los_Angeles", "Pacific/Auckland"]) {
      process.env.TZ = timezone;
      const data = buildTrainingTrends([
        activity("2026-08-30T23:00:00"),
        activity("2026-09-07T00:30:00"),
        activity("2026-08-20T10:00:00", "cycling"),
        activity("2026-09-09T10:00:00"),
      ], 3, new Date("2026-09-08T12:00:00"));
      assert.deepEqual(data.weekly_breakdown.map(week => week.week_of), [
        "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07",
      ], timezone);
      assert.deepEqual(data.weekly_breakdown.map(week => week.total_km), ["0.0", "5.0", "0.0", "5.0"], timezone);
      assert.equal(data.weekly_breakdown[0].total_activities, 1);
      assert.equal(data.weekly_breakdown[2].avg_pace, "N/A");
      assert.equal(data.weekly_breakdown[2].avg_heartrate, null);
      assert.equal(data.total_runs, 2);
      assert.equal(data.total_km, "10.0");
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test("an empty activity history stays insufficient data rather than a stable fitness claim", () => {
  const data = buildTrainingTrends([], 3, new Date("2026-09-08T12:00:00"));
  assert.equal(data.total_runs, 0);
  assert.equal(data.volume_trend, "insufficient data");
  assert.equal(data.weekly_breakdown.length, 4);
  assert.ok(data.weekly_breakdown.every(week => week.total_km === "0.0"));
});
