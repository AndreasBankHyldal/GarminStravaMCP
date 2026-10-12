import { z } from "zod";

const num = z.number().finite().nullable();
const date = z.object({ iso: z.string(), human: z.string(), day_of_week: z.string(), days_ago: z.number() });

export const tssSourceSchema = z.enum(["garmin", "power", "heart_rate", "duration_estimate"]);
export type TssSource = z.infer<typeof tssSourceSchema>;
export const ftpSourceSchema = z.enum(["user", "activity", "garmin", "estimated_from_20min", "unavailable"]);
export type FtpSource = z.infer<typeof ftpSourceSchema>;

const powerZone = z.object({
  zone: z.number(), label: z.string(), min_w: z.number(), max_w: num,
  min_percent_ftp: z.number(), max_percent_ftp: num,
});
const powerCurvePoint = z.object({ duration_s: z.number(), label: z.string(), watts: z.number(), w_per_kg: num });

const rangeSummary = {
  time_seconds: z.number(), distance_m: num, avg_speed_kmh: num,
  avg_power_w: num, normalized_power_w: num, max_power_w: num,
  avg_heartrate: num, max_heartrate: num, avg_cadence_rpm: num,
  elevation_gain_m: num, elevation_loss_m: num, avg_grade_percent: num,
};

export const rideAnalysisSchema = z.object({
  source: z.literal("garmin"),
  activity_id: z.number(),
  activity: z.object({
    name: z.string(), type: z.string(), date,
    indoor: z.boolean(), e_bike: z.boolean(),
    distance_km: num, moving_time: z.string(), elapsed_time: z.string(), moving_time_seconds: z.number(),
    avg_speed_kmh: num, max_speed_kmh: num,
    elevation_gain_m: num, elevation_loss_m: num,
    avg_heartrate: num, max_heartrate: num, avg_cadence_rpm: num,
    calories: num, avg_temperature_c: num,
    training_effect: num, anaerobic_training_effect: num, training_load: num,
  }),
  power: z.object({
    available: z.boolean(),
    avg_w: num, max_w: num, normalized_w: num, variability_index: num,
    intensity_factor: num, tss: num, tss_source: tssSourceSchema.nullable(), work_kj: num,
    ftp_w: num, ftp_source: ftpSourceSchema,
    weight_kg: num, avg_w_per_kg: num, normalized_w_per_kg: num, ftp_w_per_kg: num,
    coverage_percent: z.number(),
    garmin_reported: z.object({ avg_w: num, max_w: num, normalized_w: num, tss: num, intensity_factor: num }),
  }),
  power_curve: z.array(powerCurvePoint),
  power_zones: z.array(powerZone.extend({ seconds: z.number(), percent: z.number() })).nullable(),
  heart_rate_zones: z.object({
    profile: z.string(),
    zones: z.array(z.object({ zone: z.number(), label: z.string(), min_bpm: num, max_bpm: num, seconds: z.number(), percent: z.number() })),
  }).nullable(),
  cadence: z.object({
    avg_pedaling_rpm: num, max_rpm: num, coasting_percent: num,
    distribution: z.array(z.object({ range: z.string(), seconds: z.number(), percent: z.number() })),
  }).nullable(),
  efficiency: z.object({
    efficiency_factor: num,
    first_half: z.object({ avg_power_w: num, avg_heartrate: num }),
    second_half: z.object({ avg_power_w: num, avg_heartrate: num }),
    first_half_efficiency: num, second_half_efficiency: num,
    decoupling_percent: num, assessment: z.string(),
  }).nullable(),
  segments: z.object({
    basis: z.enum(["distance", "time"]), segment_size: z.number(),
    items: z.array(z.object({
      index: z.number(), start_km: num, end_km: num, start_minute: num, is_partial: z.boolean(), ...rangeSummary,
    })),
  }),
  climbs: z.array(z.object({
    index: z.number(), start_km: num, end_km: num, length_m: z.number(), elevation_gain_m: z.number(),
    avg_grade_percent: num, max_grade_200m_percent: num, category: z.string(), time_seconds: z.number(),
    avg_speed_kmh: num, vam_m_per_h: z.number(), avg_power_w: num, normalized_power_w: num,
    avg_w_per_kg: num, avg_heartrate: num, avg_cadence_rpm: num,
  })),
  laps: z.array(z.object({
    lap: z.number(), intensity: z.string().nullable(), distance_km: z.number(), duration: z.string(),
    avg_speed_kmh: num, avg_power_w: num, normalized_power_w: num, max_power_w: num,
    avg_heartrate: num, max_heartrate: num, avg_cadence_rpm: num, elevation_gain_m: num,
  })),
  data_quality: z.object({
    status: z.enum(["complete", "partial", "summary_only"]),
    recorded_seconds: z.number(), excluded_pause_seconds: z.number(), max_sample_gap_seconds: num,
    coverage_percent: z.object({
      power: z.number(), heart_rate: z.number(), cadence: z.number(), speed: z.number(), elevation: z.number(),
    }),
    warnings: z.array(z.string()),
  }),
  notes: z.array(z.string()),
});
export type RideAnalysis = z.infer<typeof rideAnalysisSchema>;

export const powerProfileSchema = z.object({
  source: z.literal("garmin"),
  period_days: z.number(),
  rides_analyzed: z.number(),
  rides_with_power: z.number(),
  streams_fetched: z.number(),
  weight_kg: num,
  ftp: z.object({
    selected_w: num, selected_source: ftpSourceSchema,
    garmin_w: num, user_w: num, estimated_w: num,
    w_per_kg: num, estimate_basis: z.string().nullable(),
  }),
  power_curve: z.array(z.object({
    duration_s: z.number(), label: z.string(), watts: z.number(), w_per_kg: num,
    percent_ftp: num, activity_id: z.number(), activity_name: z.string(), date: z.string(),
  })),
  power_zones: z.array(powerZone).nullable(),
  notes: z.array(z.string()),
});
export type PowerProfile = z.infer<typeof powerProfileSchema>;

const tssSources = z.object({ garmin: z.number(), power: z.number(), heart_rate: z.number(), duration_estimate: z.number() });

export const cyclingTrendsSchema = z.object({
  source: z.literal("garmin"),
  period: z.string(),
  total_rides: z.number(),
  total_km: z.number(),
  total_hours: z.number(),
  total_elevation_m: z.number(),
  total_tss: z.number(),
  volume_trend: z.string(),
  tss_sources: tssSources,
  weekly_breakdown: z.array(z.object({
    week_of: z.string(), rides: z.number(), indoor_rides: z.number(),
    distance_km: z.number(), moving_hours: z.number(), moving_time: z.string(),
    elevation_m: z.number(), outdoor_avg_speed_kmh: num, avg_power_w: num,
    avg_heartrate: num, tss: z.number(), longest_ride_km: z.number(),
  })),
  notes: z.array(z.string()),
});
export type CyclingTrends = z.infer<typeof cyclingTrendsSchema>;

export const cyclingFitnessSchema = z.object({
  source: z.literal("garmin"),
  days: z.number(),
  rides_analyzed: z.number(),
  ftp_w: num,
  threshold_heartrate_bpm: num,
  tss_sources: tssSources,
  model: z.object({
    current: z.object({
      ctl: z.number(), atl: z.number(), tsb: z.number(),
      ramp_rate_per_week: z.number(), form: z.string(),
    }),
    daily: z.array(z.object({ date: z.string(), tss: z.number(), ctl: z.number(), atl: z.number(), tsb: z.number() })),
  }),
  guidance: z.array(z.string()),
});
export type CyclingFitness = z.infer<typeof cyclingFitnessSchema>;

export const cyclingEventSchema = z.object({
  event: z.object({
    type: z.string(), distance_km: z.number(), elevation_gain_m: num,
    climbing_m_per_km: num, temperature_c: num,
  }),
  duration: z.object({
    hours: num, formatted: z.string().nullable(), implied_speed_kmh: num,
    source: z.string(),
  }),
  ftp: z.object({ watts: num, source: ftpSourceSchema, w_per_kg: num }),
  targets: z.object({
    intensity_factor_low: z.number(), intensity_factor_high: z.number(),
    normalized_power_low_w: num, normalized_power_high_w: num,
    expected_avg_power_w: num, climb_ceiling_w: num,
    heart_rate_ceiling_bpm: num, rationale: z.string(),
  }),
  pacing_phases: z.array(z.object({
    phase: z.string(), portion: z.string(), target_low_w: num, target_high_w: num, guidance: z.string(),
  })),
  energy: z.object({ estimated_work_kj: num, estimated_kcal: num }),
  fueling: z.object({
    carbs_g_per_hour_low: z.number(), carbs_g_per_hour_high: z.number(),
    total_carbs_g_low: num, total_carbs_g_high: num,
    fluid_ml_per_hour_low: z.number(), fluid_ml_per_hour_high: z.number(),
    sodium_mg_per_hour_low: z.number(), sodium_mg_per_hour_high: z.number(),
    plan: z.array(z.string()),
  }),
  tips: z.array(z.string()),
});
export type CyclingEvent = z.infer<typeof cyclingEventSchema>;
