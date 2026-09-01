import {
  CycleContext,
  EvidenceStrength,
  LifeStage,
  WomenDailyLog,
} from "./types.js";

export interface WearableRecoveryData {
  sleep_score?: number | null;
  sleep_duration_hours?: number | null;
  hrv_last_night?: number | null;
  hrv_baseline?: number | null;
  resting_hr?: number | null;
  resting_hr_baseline?: number | null;
  body_battery_change?: number | null;
  acute_chronic_load_ratio?: number | null;
}

export interface TrainingContextResult {
  status: "green" | "yellow" | "orange" | "red" | "insufficient_data";
  planned_session: string;
  suggested_adjustment: {
    volume_reduction_percent: [number, number];
    intensity_reduction_percent: [number, number];
    options: string[];
  };
  contributors: Array<{
    signal: string;
    value: string | number;
    impact: "supportive" | "neutral" | "caution" | "strong_caution" | "stop";
    rationale: string;
    evidence_strength: EvidenceStrength;
  }>;
  confidence: "moderate" | "low" | "insufficient";
  cycle_context: {
    phase: CycleContext["phase"];
    confidence: CycleContext["confidence"];
    changed_recommendation: false;
  };
  safety_notes: string[];
}

export function buildTrainingContext(
  cycle: CycleContext,
  dailyLog: WomenDailyLog | null,
  wearable: WearableRecoveryData,
  plannedSession: "rest" | "easy" | "moderate" | "hard" | "race"
): TrainingContextResult {
  const contributors: TrainingContextResult["contributors"] = [];
  const safetyNotes = [...cycle.medical_follow_up_flags];
  let cautionPoints = 0;
  let usableSignals = 0;

  const symptoms = dailyLog?.symptoms ?? [];
  const symptomNames = new Set(
    symptoms.map((symptom) => symptom.name.trim().toLowerCase().replace(/\s+/g, "_"))
  );
  const stopSymptoms = [
    "chest_pain",
    "fainting",
    "syncope",
    "severe_pelvic_pain",
    "shortness_of_breath_at_rest",
  ].filter((name) => symptomNames.has(name));
  const bleedingEmergency =
    dailyLog?.period_flow === "very_heavy" &&
    (symptomNames.has("dizziness") || symptomNames.has("fainting"));

  if (stopSymptoms.length || bleedingEmergency) {
    contributors.push({
      signal: "medical_red_flag",
      value: [...stopSymptoms, ...(bleedingEmergency ? ["very_heavy_bleeding_with_dizziness"] : [])].join(", "),
      impact: "stop",
      rationale: "These symptoms need medical assessment rather than an automated training decision.",
      evidence_strength: "strong_consensus",
    });
    return {
      status: "red",
      planned_session: plannedSession,
      suggested_adjustment: {
        volume_reduction_percent: [100, 100],
        intensity_reduction_percent: [100, 100],
        options: ["Do not start the planned session; seek appropriate medical assessment."],
      },
      contributors: withCycleContributor(contributors, cycle),
      confidence: "moderate",
      cycle_context: cycleSummary(cycle),
      safety_notes: safetyNotes,
    };
  }

  if (dailyLog?.overall_symptom_severity != null) {
    usableSignals++;
    const severity = dailyLog.overall_symptom_severity;
    const points = severity >= 7 ? 3 : severity >= 4 ? 1 : 0;
    cautionPoints += points;
    contributors.push({
      signal: "self_reported_symptoms",
      value: `${severity}/10`,
      impact: points >= 3 ? "strong_caution" : points ? "caution" : "neutral",
      rationale: "Current symptoms are more actionable than a calendar phase estimate.",
      evidence_strength: "strong_consensus",
    });
  }

  cautionPoints += addFivePointSignal(
    contributors,
    "fatigue",
    dailyLog?.fatigue,
    "Higher self-reported fatigue supports reducing training demand.",
    false
  );
  usableSignals += dailyLog?.fatigue != null ? 1 : 0;
  cautionPoints += addFivePointSignal(
    contributors,
    "energy",
    dailyLog?.energy,
    "Low self-reported energy supports a more conservative session.",
    true
  );
  usableSignals += dailyLog?.energy != null ? 1 : 0;
  cautionPoints += addFivePointSignal(
    contributors,
    "sleep_quality",
    dailyLog?.sleep_quality,
    "Poor perceived sleep quality can impair recovery and performance.",
    true
  );
  usableSignals += dailyLog?.sleep_quality != null ? 1 : 0;

  if (wearable.sleep_score != null) {
    usableSignals++;
    const points = wearable.sleep_score < 50 ? 2 : wearable.sleep_score < 65 ? 1 : 0;
    cautionPoints += points;
    contributors.push({
      signal: "garmin_sleep_score",
      value: wearable.sleep_score,
      impact: points === 2 ? "strong_caution" : points ? "caution" : "neutral",
      rationale: "Sleep score is a supporting recovery signal, not a diagnosis.",
      evidence_strength: "moderate",
    });
  }

  if (wearable.sleep_duration_hours != null) {
    usableSignals++;
    const points =
      wearable.sleep_duration_hours < 6
        ? 2
        : wearable.sleep_duration_hours < 7
        ? 1
        : 0;
    cautionPoints += points;
    contributors.push({
      signal: "sleep_duration",
      value: `${wearable.sleep_duration_hours.toFixed(1)} hours`,
      impact: points === 2 ? "strong_caution" : points ? "caution" : "neutral",
      rationale: "Short sleep is a supporting reason to reduce demand.",
      evidence_strength: "moderate",
    });
  }

  if (
    wearable.hrv_last_night != null &&
    wearable.hrv_baseline != null &&
    wearable.hrv_baseline > 0
  ) {
    usableSignals++;
    const ratio = wearable.hrv_last_night / wearable.hrv_baseline;
    const points = ratio < 0.8 ? 2 : ratio < 0.9 ? 1 : 0;
    cautionPoints += points;
    contributors.push({
      signal: "hrv_vs_personal_baseline",
      value: `${Math.round(ratio * 100)}%`,
      impact: points === 2 ? "strong_caution" : points ? "caution" : "neutral",
      rationale:
        "HRV is interpreted against the personal baseline. Menstrual-cycle HRV shifts are small and confounded.",
      evidence_strength: "moderate",
    });
  }

  if (
    wearable.resting_hr != null &&
    wearable.resting_hr_baseline != null
  ) {
    usableSignals++;
    const difference = wearable.resting_hr - wearable.resting_hr_baseline;
    const points = difference >= 8 ? 2 : difference >= 5 ? 1 : 0;
    cautionPoints += points;
    contributors.push({
      signal: "resting_hr_vs_personal_baseline",
      value: `${difference >= 0 ? "+" : ""}${difference.toFixed(0)} bpm`,
      impact: points === 2 ? "strong_caution" : points ? "caution" : "neutral",
      rationale: "An elevated resting heart rate can support a recovery-day decision.",
      evidence_strength: "moderate",
    });
  }

  if (wearable.body_battery_change != null) {
    usableSignals++;
    const points =
      wearable.body_battery_change <= 0
        ? 2
        : wearable.body_battery_change < 10
        ? 1
        : 0;
    cautionPoints += points;
    contributors.push({
      signal: "overnight_body_battery_change",
      value: wearable.body_battery_change,
      impact: points === 2 ? "strong_caution" : points ? "caution" : "neutral",
      rationale: "Garmin Body Battery is proprietary and is used only as supporting context.",
      evidence_strength: "limited",
    });
  }

  if (wearable.acute_chronic_load_ratio != null) {
    usableSignals++;
    const ratio = wearable.acute_chronic_load_ratio;
    const points = ratio > 1.5 ? 2 : ratio > 1.3 ? 1 : 0;
    cautionPoints += points;
    contributors.push({
      signal: "acute_chronic_load_ratio",
      value: ratio,
      impact: points === 2 ? "strong_caution" : points ? "caution" : "neutral",
      rationale:
        "Recent load change is contextual only; this ratio does not independently predict injury.",
      evidence_strength: "limited",
    });
  }

  if (usableSignals === 0) {
    return {
      status: "insufficient_data",
      planned_session: plannedSession,
      suggested_adjustment: {
        volume_reduction_percent: [0, 0],
        intensity_reduction_percent: [0, 0],
        options: [
          "Log current symptoms/energy or provide recovery data before estimating training readiness.",
          "Use the warm-up as a check and avoid changing training solely because of estimated cycle phase.",
        ],
      },
      contributors: withCycleContributor(contributors, cycle),
      confidence: "insufficient",
      cycle_context: cycleSummary(cycle),
      safety_notes: safetyNotes,
    };
  }

  const status =
    cautionPoints >= 6 ? "orange" : cautionPoints >= 3 ? "yellow" : "green";
  const adjustment =
    status === "orange"
      ? {
          volume_reduction_percent: [20, 40] as [number, number],
          intensity_reduction_percent: [15, 30] as [number, number],
          options: [
            "Swap a hard session for easy aerobic work, technique, mobility, or rest.",
            "If training, keep it conversational and stop if symptoms worsen.",
          ],
        }
      : status === "yellow"
      ? {
          volume_reduction_percent: [0, 15] as [number, number],
          intensity_reduction_percent: [0, 15] as [number, number],
          options: [
            plannedSession === "hard" || plannedSession === "race"
              ? "Start with an extended easy warm-up, then keep, reduce, or swap the session based on how you respond."
              : "Proceed conservatively and reassess during the warm-up.",
            "Prioritize fueling, fluids, and recovery rather than forcing preset targets.",
          ],
        }
      : {
          volume_reduction_percent: [0, 0] as [number, number],
          intensity_reduction_percent: [0, 0] as [number, number],
          options: [
            "No adjustment is indicated by the available recovery and symptom data.",
            "Proceed as planned if the warm-up feels normal.",
          ],
        };

  return {
    status,
    planned_session: plannedSession,
    suggested_adjustment: adjustment,
    contributors: withCycleContributor(contributors, cycle),
    confidence: usableSignals >= 5 ? "moderate" : "low",
    cycle_context: cycleSummary(cycle),
    safety_notes: safetyNotes,
  };
}

export interface NutritionInput {
  body_mass_kg: number;
  daily_training_load: "light" | "moderate" | "high" | "very_high";
  session_duration_minutes: number;
  session_intensity: "easy" | "moderate" | "hard" | "race";
  hours_before_session?: number;
  rapid_recovery_needed?: boolean;
  sweat_rate_liters_per_hour?: number;
  hot_or_humid?: boolean;
  life_stage?: LifeStage;
  low_energy_availability_concern?: boolean;
}

export function buildNutritionTargets(input: NutritionInput) {
  const carbByLoad: Record<NutritionInput["daily_training_load"], [number, number]> = {
    light: [3, 5],
    moderate: [5, 7],
    high: [6, 10],
    very_high: [8, 12],
  };
  const carbPerKg = carbByLoad[input.daily_training_load];
  const proteinPerKg: [number, number] = [1.2, 2];
  const mealProteinPerKg: [number, number] = [0.25, 0.4];
  const duringCarbs =
    input.session_duration_minutes < 45
      ? [0, 0]
      : input.session_duration_minutes <= 75
      ? [0, 30]
      : input.session_duration_minutes <= 150
      ? [30, 60]
      : [60, 90];
  const hydration = input.sweat_rate_liters_per_hour
    ? [
        round(input.sweat_rate_liters_per_hour * 0.6, 2),
        round(input.sweat_rate_liters_per_hour * 0.9, 2),
      ]
    : [0.4, 0.8];
  const cautions: string[] = [
    "Targets are starting ranges; gastrointestinal tolerance and the session's actual demands take priority.",
    "Avoid gaining body mass during exercise from over-drinking; fluid needs vary substantially.",
  ];

  if (input.low_energy_availability_concern) {
    cautions.unshift(
      "Possible low energy availability: prioritize adequate total energy and professional assessment; do not use these targets to restrict intake or pursue weight loss."
    );
  }
  if (input.life_stage === "pregnant" || input.life_stage === "postpartum") {
    cautions.unshift(
      "Pregnancy/postpartum energy and hydration needs require individualized advice from a qualified perinatal clinician or sports dietitian."
    );
  }

  return {
    daily: {
      carbohydrate_g_per_kg: carbPerKg,
      carbohydrate_g: multiplyRange(carbPerKg, input.body_mass_kg),
      protein_g_per_kg: proteinPerKg,
      protein_g: multiplyRange(proteinPerKg, input.body_mass_kg),
      fat: "At least 20% of total energy; avoid chronically low-fat or low-energy diets.",
    },
    before_session:
      input.session_duration_minutes >= 60
        ? {
            carbohydrate_g_per_kg: [1, 4],
            carbohydrate_g: multiplyRange([1, 4], input.body_mass_kg),
            timing: "1-4 hours before; choose within the range based on time available and GI tolerance.",
          }
        : {
            carbohydrate_g_per_kg: [0, 1],
            carbohydrate_g: multiplyRange([0, 1], input.body_mass_kg),
            timing: "Optional for a short session if normal meals already cover energy needs.",
          },
    during_session: {
      carbohydrate_g_per_hour: duringCarbs,
      note:
        input.session_duration_minutes > 150
          ? "Use multiple-transportable carbohydrate sources and practice this intake in training."
          : "Water and carbohydrate needs depend on intensity, prior fueling, and tolerance.",
    },
    recovery: {
      protein_g_per_kg_per_meal: mealProteinPerKg,
      protein_g_per_meal: multiplyRange(mealProteinPerKg, input.body_mass_kg),
      rapid_recovery_carbohydrate:
        input.rapid_recovery_needed
          ? {
              g_per_kg_per_hour: [1, 1.2],
              grams_per_hour: multiplyRange([1, 1.2], input.body_mass_kg),
              duration: "First 4 hours when rapid glycogen restoration is necessary.",
            }
          : null,
    },
    hydration: {
      starting_fluid_liters_per_hour: hydration,
      basis: input.sweat_rate_liters_per_hour
        ? "60-90% of the supplied sweat-rate estimate."
        : "General starting range because no personal sweat rate was supplied.",
      heat_note: input.hot_or_humid
        ? "Heat/humidity increases fluid and cooling needs. Menstrual phase does not replace a personal sweat-rate plan."
        : null,
    },
    evidence: {
      general_sports_nutrition: "strong_consensus",
      female_specific_or_cycle_adjustments: "limited",
      phase_based_macro_change: "not_applied",
    },
    cautions,
  };
}

export interface EnergyAvailabilityInput {
  age_years: number;
  energy_intake_kcal: number;
  exercise_energy_expenditure_kcal: number;
  fat_free_mass_kg: number;
  intake_uncertainty_percent?: number;
  exercise_uncertainty_percent?: number;
  fat_free_mass_uncertainty_percent?: number;
}

export function estimateEnergyAvailability(input: EnergyAvailabilityInput) {
  const estimate =
    (input.energy_intake_kcal - input.exercise_energy_expenditure_kcal) /
    input.fat_free_mass_kg;
  const intakeError = (input.intake_uncertainty_percent ?? 20) / 100;
  const exerciseError = (input.exercise_uncertainty_percent ?? 20) / 100;
  const ffmError = (input.fat_free_mass_uncertainty_percent ?? 5) / 100;
  const low =
    (input.energy_intake_kcal * (1 - intakeError) -
      input.exercise_energy_expenditure_kcal * (1 + exerciseError)) /
    (input.fat_free_mass_kg * (1 + ffmError));
  const high =
    (input.energy_intake_kcal * (1 + intakeError) -
      input.exercise_energy_expenditure_kcal * (1 - exerciseError)) /
    (input.fat_free_mass_kg * (1 - ffmError));

  const heuristicBand =
    estimate < 30
      ? "below_legacy_30_threshold"
      : estimate < 45
      ? "between_legacy_30_and_45_references"
      : "at_or_above_legacy_45_reference";
  const isMinor = input.age_years < 18;
  return {
    estimate_kcal_per_kg_ffm_day: isMinor ? null : round(estimate, 1),
    uncertainty_range: isMinor ? null : [round(low, 1), round(high, 1)],
    heuristic_band: isMinor ? "not_interpreted_for_minor" : heuristicBand,
    formula:
      "(dietary energy intake - exercise energy expenditure) / fat-free mass",
    interpretation: [
      "This is an imprecise educational estimate, not a RED-S diagnosis.",
      "The IOC RED-S consensus discourages diagnosing low energy availability from one universal cutoff.",
      "The 30 and 45 kcal/kg FFM/day values are historical reference points, not pass/fail thresholds.",
      ...(input.age_years < 18
        ? ["For athletes under 18, discuss energy availability and menstrual concerns with a qualified clinician."]
        : []),
    ],
  };
}

export interface TrainingHealthScreenInput {
  age_years: number;
  life_stage: LifeStage;
  has_started_menstruating?: boolean;
  days_since_last_period?: number;
  cycle_lengths_days?: number[];
  bleeding_days?: number;
  changes_protection_every_two_hours_or_less?: boolean;
  soaking_protection_hourly_for_two_hours?: boolean;
  chest_pain_during_exercise?: boolean;
  fainted_during_exercise?: boolean;
  severe_pelvic_pain?: boolean;
  pregnancy_possible?: boolean;
  bleeding_during_known_or_possible_pregnancy?: boolean;
  postmenopausal_bleeding?: boolean;
  postcoital_or_intermenstrual_bleeding?: boolean;
  bone_stress_injury_history?: boolean;
  restrictive_eating_or_fear_of_weight_gain?: boolean;
  rapid_or_unintentional_weight_loss?: boolean;
  persistent_fatigue?: boolean;
  breathlessness?: boolean;
  palpitations?: boolean;
  dizziness?: boolean;
  recurrent_illness_or_injury?: boolean;
  unexplained_performance_decline?: boolean;
  vegetarian_or_vegan?: boolean;
  high_endurance_volume?: boolean;
}

export function screenTrainingHealth(input: TrainingHealthScreenInput) {
  const urgent: string[] = [];
  const routine: string[] = [];
  const ironRisk: string[] = [];
  const energyRisk: string[] = [];

  if (input.chest_pain_during_exercise) urgent.push("Chest pain during exercise.");
  if (input.fainted_during_exercise) urgent.push("Fainting during exercise.");
  if (input.bleeding_during_known_or_possible_pregnancy) {
    urgent.push("Bleeding during known or possible pregnancy.");
  }
  if (
    input.soaking_protection_hourly_for_two_hours &&
    (input.dizziness || input.breathlessness || input.chest_pain_during_exercise)
  ) {
    urgent.push("Very heavy bleeding with dizziness, breathlessness, or chest pain.");
  } else if (input.soaking_protection_hourly_for_two_hours) {
    routine.push("Bleeding that soaks protection hourly for two hours needs prompt clinical advice.");
  }
  if (input.severe_pelvic_pain && input.pregnancy_possible) {
    urgent.push("Severe pelvic pain with possible pregnancy.");
  } else if (input.severe_pelvic_pain) {
    routine.push("Severe pelvic pain.");
  }
  if (input.postmenopausal_bleeding) {
    routine.push("Any postmenopausal bleeding needs prompt clinical evaluation.");
  }
  if (input.postcoital_or_intermenstrual_bleeding) {
    routine.push("New post-coital or intermenstrual bleeding needs prompt clinical evaluation.");
  }

  const naturalCycle =
    input.life_stage === "naturally_cycling" || input.life_stage === "unknown";
  if (input.age_years >= 15 && input.has_started_menstruating === false) {
    routine.push("No first menstrual period by age 15.");
  }
  if (naturalCycle && (input.days_since_last_period ?? 0) >= 90) {
    routine.push("No menstrual period for at least 90 days when not otherwise explained.");
  }
  const atypicalCycles = (input.cycle_lengths_days ?? []).filter(
    (length) => length < 24 || length > 38
  );
  if (atypicalCycles.length >= 2) {
    routine.push("Multiple menstrual cycles outside the typical adult 24-38 day range.");
  }
  if ((input.bleeding_days ?? 0) > 7) {
    routine.push("Menstrual bleeding lasting more than 7 days.");
    ironRisk.push("Prolonged menstrual bleeding.");
  }
  if (input.changes_protection_every_two_hours_or_less) {
    routine.push("Menstrual flow requiring protection changes every two hours or less.");
    ironRisk.push("Heavy menstrual bleeding.");
  }
  if (input.bone_stress_injury_history) {
    routine.push("History of bone stress injury or stress fracture.");
    energyRisk.push("Bone stress injury history.");
  }
  if (input.restrictive_eating_or_fear_of_weight_gain) {
    routine.push("Restrictive eating or fear-driven food restriction.");
    energyRisk.push("Possible disordered eating or under-fueling.");
  }
  if (input.rapid_or_unintentional_weight_loss) {
    routine.push("Rapid or unintentional weight loss.");
    energyRisk.push("Recent weight loss.");
  }
  if (input.recurrent_illness_or_injury) {
    energyRisk.push("Recurrent illness or injury.");
  }
  if (input.unexplained_performance_decline) {
    energyRisk.push("Unexplained performance decline.");
  }
  if (input.persistent_fatigue) ironRisk.push("Persistent fatigue.");
  if (input.breathlessness) ironRisk.push("Breathlessness.");
  if (input.palpitations) ironRisk.push("Palpitations.");
  if (input.dizziness) ironRisk.push("Dizziness.");
  if (input.vegetarian_or_vegan) ironRisk.push("Vegetarian or vegan diet.");
  if (input.high_endurance_volume) ironRisk.push("High endurance training volume.");

  if (ironRisk.length >= 2) {
    routine.push(
      "Multiple iron-deficiency risk indicators; ask a clinician about appropriate blood tests such as CBC, ferritin, and transferrin saturation."
    );
  }
  if (energyRisk.length >= 2) {
    routine.push(
      "Multiple possible low-energy-availability/RED-S indicators; seek assessment from a sports-medicine clinician and sports dietitian."
    );
  }
  if (input.age_years < 18 && (routine.length || energyRisk.length)) {
    routine.push(
      "Adolescent athletes with menstrual, bone, or fueling concerns should be assessed by a qualified pediatric/adolescent clinician."
    );
  }
  if (input.life_stage === "pregnant" || input.life_stage === "postpartum") {
    routine.push(
      "Use individualized pregnancy/postpartum guidance from an obstetric or perinatal exercise professional."
    );
  }

  return {
    triage: urgent.length
      ? "urgent_medical_assessment"
      : routine.length
      ? "routine_or_prompt_clinical_review"
      : "no_major_flags_from_answers",
    urgent_flags: unique(urgent),
    clinical_review_flags: unique(routine),
    iron_risk_indicators: unique(ironRisk),
    low_energy_availability_indicators: unique(energyRisk),
    training_guidance: urgent.length
      ? "Do not train until urgently assessed."
      : energyRisk.length >= 2
      ? "Do not pursue calorie restriction or weight loss; prioritize assessment and adequate fueling."
      : "Use symptoms and recovery data to guide training; this screen does not provide medical clearance.",
    limitations: [
      "This is an educational heuristic, not the IOC RED-S CAT2, a validated questionnaire, diagnosis, or medical clearance.",
      "A single energy-availability value or wearable metric cannot diagnose RED-S, iron deficiency, or menstrual dysfunction.",
      "Iron supplements should not be dosed from this tool; test and treat with a clinician.",
    ],
  };
}

function addFivePointSignal(
  contributors: TrainingContextResult["contributors"],
  signal: string,
  value: number | null | undefined,
  rationale: string,
  lowIsCaution: boolean
): number {
  if (value == null) return 0;
  const points = lowIsCaution
    ? value <= 1
      ? 2
      : value === 2
      ? 1
      : 0
    : value >= 5
    ? 2
    : value === 4
    ? 1
    : 0;
  contributors.push({
    signal: `self_reported_${signal}`,
    value: `${value}/5`,
    impact: points === 2 ? "strong_caution" : points ? "caution" : "neutral",
    rationale,
    evidence_strength: "moderate",
  });
  return points;
}

function withCycleContributor(
  contributors: TrainingContextResult["contributors"],
  cycle: CycleContext
): TrainingContextResult["contributors"] {
  return [
    ...contributors,
    {
      signal: "estimated_cycle_phase",
      value: `${cycle.phase} (${cycle.confidence})`,
      impact: "neutral",
      rationale:
        "Average performance differences by menstrual phase are trivial and evidence quality is low; phase alone does not change the session.",
      evidence_strength: "strong_consensus",
    },
  ];
}

function cycleSummary(cycle: CycleContext): TrainingContextResult["cycle_context"] {
  return {
    phase: cycle.phase,
    confidence: cycle.confidence,
    changed_recommendation: false,
  };
}

function multiplyRange(range: [number, number], multiplier: number): [number, number] {
  return [round(range[0] * multiplier), round(range[1] * multiplier)];
}

function round(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
