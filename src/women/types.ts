export const LIFE_STAGES = [
  "naturally_cycling",
  "hormonal_contraception",
  "perimenopause",
  "postmenopause",
  "pregnant",
  "postpartum",
  "unknown",
] as const;

export type LifeStage = (typeof LIFE_STAGES)[number];
export type CycleEventType = "period_start" | "period_end" | "positive_lh_test";
export type CycleDataSource = "user_input" | "garmin_unofficial_api";
export type CyclePhase =
  | "menstruation"
  | "follicular"
  | "periovulatory"
  | "luteal"
  | "unknown";

export interface WomenHealthProfile {
  life_stage: LifeStage;
  contraception_type: string | null;
  typical_cycle_length_days: number | null;
  typical_period_length_days: number | null;
  updated_at?: string;
}

export interface CycleEvent {
  id?: number;
  event_date: string;
  event_type: CycleEventType;
  source: CycleDataSource;
  notes?: string | null;
}

export interface SymptomLog {
  name: string;
  severity: number;
}

export interface WomenDailyLog {
  date: string;
  period_flow?: "none" | "spotting" | "light" | "moderate" | "heavy" | "very_heavy" | null;
  symptoms?: SymptomLog[];
  overall_symptom_severity?: number | null;
  energy?: number | null;
  fatigue?: number | null;
  soreness?: number | null;
  sleep_quality?: number | null;
  stress?: number | null;
  motivation?: number | null;
  perceived_performance?: number | null;
  session_rpe?: number | null;
  notes?: string | null;
}

export interface CycleContext {
  target_date: string;
  phase: CyclePhase;
  cycle_day: number | null;
  phase_probabilities: Record<CyclePhase, number>;
  predicted_next_period: {
    earliest: string;
    most_likely: string;
    latest: string;
  } | null;
  estimated_ovulation_window: {
    earliest: string;
    latest: string;
  } | null;
  confidence: "moderate" | "low" | "unreliable";
  data_basis: string[];
  assumptions: string[];
  medical_follow_up_flags: string[];
  phase_based_training_rule: "none";
}

export type EvidenceStrength = "strong_consensus" | "moderate" | "limited";
