import type { GarminActivity } from "../garmin/client.js";
import { formatDuration, speedToPacePerKm, startOfWeek } from "../utils.js";

type TrendActivity = Pick<GarminActivity, "startTimeLocal" | "activityType" | "distance" | "duration" | "averageHR">;

export function buildTrainingTrends(history: TrendActivity[], weeks: number, now = new Date()) {
  const afterDate = new Date(now);
  afterDate.setDate(afterDate.getDate() - weeks * 7);
  const activities = history.filter(activity => {
    const date = new Date(activity.startTimeLocal);
    return date >= afterDate && date <= now;
  });
  const weekKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const weeklyData: Record<string, TrendActivity[]> = {};
  // Empty weeks retain their place on the timeline, including partial end weeks.
  for (const week = startOfWeek(afterDate); week <= now; week.setDate(week.getDate() + 7)) {
    weeklyData[weekKey(week)] = [];
  }
  for (const activity of activities) {
    const key = weekKey(startOfWeek(new Date(activity.startTimeLocal)));
    weeklyData[key].push(activity);
  }
  const weeklyTrends = Object.entries(weeklyData)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, acts]) => {
      const runs = acts.filter(activity => (activity.activityType?.typeKey ?? "").toLowerCase().includes("run"));
      const totalDist = runs.reduce((sum, activity) => sum + (activity.distance ?? 0), 0);
      const totalDuration = runs.reduce((sum, activity) => sum + (activity.duration ?? 0), 0);
      const heartRates = runs.map(run => run.averageHR).filter(hr => Number.isFinite(hr) && hr > 0);
      return {
        week_of: week,
        total_activities: acts.length,
        runs: runs.length,
        total_km: (totalDist / 1000).toFixed(1),
        total_time: formatDuration(totalDuration),
        avg_pace: totalDuration > 0 ? speedToPacePerKm(totalDist / totalDuration) : "N/A",
        avg_heartrate: heartRates.length ? Math.round(heartRates.reduce((sum, hr) => sum + hr, 0) / heartRates.length) : null,
      };
    });
  const allKms = weeklyTrends.map(week => Number(week.total_km));
  const trend = allKms.length >= 2 && weeklyTrends.some(week => week.runs > 0)
    ? allKms[allKms.length - 1] > allKms[0]
      ? "increasing"
      : allKms[allKms.length - 1] < allKms[0]
        ? "decreasing"
        : "stable"
    : "insufficient data";
  return {
    period: `Last ${weeks} weeks`,
    source: "garmin",
    weekly_breakdown: weeklyTrends,
    volume_trend: trend,
    total_runs: weeklyTrends.reduce((sum, week) => sum + week.runs, 0),
    total_km: allKms.reduce((sum, km) => sum + km, 0).toFixed(1),
  };
}
