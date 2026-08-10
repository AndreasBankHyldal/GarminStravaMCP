import {
  GarminActivity,
  GarminActivityDetails,
  GarminActivitySplits,
  GarminLap,
} from "./client.js";
import {
  analyzeLaps,
  classifyEffort,
  classifyHRZone,
  enrichDate,
  formatDuration,
  LapLike,
  speedToPacePerKm,
} from "../utils.js";

export function getGarminMovingSpeed(activity: {
  distance?: number;
  movingDuration?: number;
  averageMovingSpeed?: number;
  averageSpeed?: number;
}): number {
  if (activity.averageMovingSpeed && activity.averageMovingSpeed > 0) {
    return activity.averageMovingSpeed;
  }
  if (
    activity.distance &&
    activity.distance > 0 &&
    activity.movingDuration &&
    activity.movingDuration > 0
  ) {
    return activity.distance / activity.movingDuration;
  }
  return activity.averageSpeed ?? 0;
}

export function formatGarminActivity(activity: GarminActivity) {
  const movingSpeed = getGarminMovingSpeed(activity);
  const paceSecPerKm = movingSpeed > 0 ? 1000 / movingSpeed : 0;
  return {
    id: activity.activityId,
    source: "garmin",
    name: activity.activityName,
    type: activity.activityType?.typeKey ?? "unknown",
    date: enrichDate(activity.startTimeLocal),
    distance_km: activity.distance ? +(activity.distance / 1000).toFixed(2) : 0,
    duration: formatDuration(activity.duration ?? 0),
    moving_duration: formatDuration(activity.movingDuration ?? 0),
    pace_per_km: speedToPacePerKm(movingSpeed),
    effort_level: paceSecPerKm > 0 ? classifyEffort(paceSecPerKm) : null,
    elevation_gain_m: activity.elevationGain ?? 0,
    avg_heartrate: activity.averageHR ?? null,
    max_heartrate: activity.maxHR ?? null,
    hr_zone: activity.averageHR ? classifyHRZone(activity.averageHR) : null,
    calories: activity.calories ?? null,
    cadence_spm: activity.averageRunningCadenceInStepsPerMinute ?? null,
    vo2max: activity.vO2MaxValue ?? null,
  };
}

export function garminLapToLapLike(lap: GarminLap): LapLike {
  return {
    name: lap.intensityType,
    distance: lap.distance ?? 0,
    moving_time: lap.movingDuration ?? lap.duration ?? 0,
    average_speed: lap.averageMovingSpeed ?? lap.averageSpeed ?? 0,
    average_heartrate: lap.averageHR,
    max_heartrate: lap.maxHR,
    lap_index: lap.lapIndex,
  };
}

function summarizeActiveIntervals(laps: GarminLap[]): string | null {
  const groups = new Map<number, { distance: number; time: number; count: number }>();

  for (const lap of laps) {
    const speed = lap.averageMovingSpeed ?? lap.averageSpeed;
    if (lap.intensityType !== "ACTIVE" || speed <= 0) continue;
    const bucket = Math.round(lap.distance / 100) * 100;
    const group = groups.get(bucket) ?? { distance: 0, time: 0, count: 0 };
    group.distance += lap.distance;
    group.time += lap.movingDuration ?? lap.duration;
    group.count += 1;
    groups.set(bucket, group);
  }

  const parts = [...groups.entries()]
    .filter(([, group]) => group.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([distance, group]) => {
      const distanceLabel =
        distance % 1000 === 0 ? `${distance / 1000}km` : `${distance}m`;
      return `${group.count}×${distanceLabel} @ ${
        speedToPacePerKm(group.distance / group.time)
      }/km`;
    });

  return parts.length ? parts.join(" + ") : null;
}

export function hasGarminIntervalStructure(
  activity: GarminActivityDetails,
  laps: GarminLap[]
): boolean {
  return (
    activity.metadataDTO?.hasIntensityIntervals === true ||
    laps.some((lap) => lap.intensityType === "RECOVERY")
  );
}

export function formatGarminActivityDetails(
  activity: GarminActivityDetails,
  splits: GarminActivitySplits
) {
  const summary = activity.summaryDTO;
  const movingSpeed = getGarminMovingSpeed(summary);
  const paceSecPerKm = movingSpeed > 0 ? 1000 / movingSpeed : 0;
  const laps = splits.lapDTOs ?? [];
  const lapAnalysis = analyzeLaps(laps.map(garminLapToLapLike));
  const intervalSummary = hasGarminIntervalStructure(activity, laps)
    ? summarizeActiveIntervals(laps)
    : null;
  if (lapAnalysis && intervalSummary) {
    lapAnalysis.looks_like_interval_workout = true;
    lapAnalysis.interval_summary = intervalSummary;
    lapAnalysis.note =
      "Garmin explicitly marked the work laps as ACTIVE; the interval summary excludes warmup, recovery, and cooldown laps.";
  }

  return {
    id: activity.activityId,
    source: "garmin",
    name: activity.activityName,
    type: activity.activityTypeDTO?.typeKey ?? "unknown",
    date: enrichDate(summary.startTimeLocal),
    distance_km: summary.distance ? +(summary.distance / 1000).toFixed(2) : 0,
    duration: formatDuration(summary.duration ?? 0),
    moving_duration: formatDuration(summary.movingDuration ?? 0),
    moving_time_seconds: summary.movingDuration ?? summary.duration ?? 0,
    pace_per_km: speedToPacePerKm(movingSpeed),
    effort_level: paceSecPerKm > 0 ? classifyEffort(paceSecPerKm) : null,
    elevation_gain_m: summary.elevationGain ?? 0,
    avg_heartrate: summary.averageHR ?? null,
    max_heartrate: summary.maxHR ?? null,
    hr_zone: summary.averageHR ? classifyHRZone(summary.averageHR) : null,
    calories: summary.calories ?? null,
    cadence_spm: summary.averageRunCadence ?? null,
    training_effect: summary.trainingEffect ?? null,
    anaerobic_training_effect: summary.anaerobicTrainingEffect ?? null,
    training_load: summary.activityTrainingLoad ?? null,
    laps: lapAnalysis,
    split_summaries: activity.splitSummaries?.map((split) => ({
      type: split.splitType,
      count: split.noOfSplits,
      distance_km: +(split.distance / 1000).toFixed(2),
      duration: formatDuration(split.duration),
      pace_per_km: speedToPacePerKm(split.averageMovingSpeed ?? split.averageSpeed),
      avg_heartrate: split.averageHR ?? null,
      max_heartrate: split.maxHR ?? null,
      cadence_spm: split.averageRunCadence ?? null,
    })) ?? [],
  };
}
