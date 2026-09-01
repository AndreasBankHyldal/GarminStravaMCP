import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateCycleContext,
} from "../src/women/cycle.js";
import {
  buildNutritionTargets,
  buildTrainingContext,
  estimateEnergyAvailability,
  screenTrainingHealth,
} from "../src/women/guidance.js";
import { inspectSensitiveGarminDocument } from "../src/women/garmin.js";
import { WomenHealthProfile } from "../src/women/types.js";

const naturalProfile: WomenHealthProfile = {
  life_stage: "naturally_cycling",
  contraception_type: null,
  typical_cycle_length_days: 28,
  typical_period_length_days: 5,
};

test("cycle estimate uses personal history but never creates a training rule", () => {
  const result = estimateCycleContext(
    naturalProfile,
    ["2026-06-01", "2026-06-29", "2026-07-27", "2026-08-24"],
    "2026-09-01"
  );

  assert.equal(result.phase, "follicular");
  assert.equal(result.cycle_day, 9);
  assert.equal(result.confidence, "moderate");
  assert.equal(result.phase_based_training_rule, "none");
  assert.equal(
    Object.values(result.phase_probabilities).reduce((sum, value) => sum + value, 0),
    1
  );
});

test("hormonal contraception disables natural phase estimation", () => {
  const result = estimateCycleContext(
    { ...naturalProfile, life_stage: "hormonal_contraception" },
    ["2026-08-24"],
    "2026-09-01"
  );

  assert.equal(result.phase, "unknown");
  assert.equal(result.confidence, "unreliable");
  assert.equal(result.phase_probabilities.unknown, 1);
});

test("positive LH test supports a periovulatory estimate without claiming confirmation", () => {
  const result = estimateCycleContext(
    naturalProfile,
    ["2026-08-01"],
    "2026-08-15",
    ["2026-08-14"]
  );

  assert.equal(result.phase, "periovulatory");
  assert.equal(result.confidence, "moderate");
  assert.match(result.data_basis.join(" "), /does not confirm ovulation/);
});

test("repeated atypical cycles suppress the phase estimate", () => {
  const result = estimateCycleContext(
    { ...naturalProfile, typical_cycle_length_days: null },
    ["2026-04-01", "2026-05-11", "2026-06-21", "2026-08-01"],
    "2026-08-10"
  );

  assert.equal(result.phase, "unknown");
  assert.equal(result.confidence, "unreliable");
  assert.match(result.medical_follow_up_flags.join(" "), /24-38 day range/);
});

test("phase alone cannot produce a green readiness decision", () => {
  const cycle = estimateCycleContext(
    naturalProfile,
    ["2026-08-24"],
    "2026-09-01"
  );
  const result = buildTrainingContext(cycle, null, {}, "hard");

  assert.equal(result.status, "insufficient_data");
  assert.equal(result.cycle_context.changed_recommendation, false);
});

test("medical red-flag symptoms stop the automated training recommendation", () => {
  const cycle = estimateCycleContext(
    naturalProfile,
    ["2026-08-24"],
    "2026-09-01"
  );
  const result = buildTrainingContext(
    cycle,
    {
      date: "2026-09-01",
      period_flow: "very_heavy",
      symptoms: [{ name: "dizziness", severity: 8 }],
    },
    {},
    "hard"
  );

  assert.equal(result.status, "red");
  assert.deepEqual(result.suggested_adjustment.volume_reduction_percent, [100, 100]);
});

test("nutrition targets follow workload rather than cycle phase", () => {
  const result = buildNutritionTargets({
    body_mass_kg: 60,
    daily_training_load: "high",
    session_duration_minutes: 180,
    session_intensity: "hard",
    rapid_recovery_needed: true,
  });

  assert.deepEqual(result.daily.carbohydrate_g, [360, 600]);
  assert.deepEqual(result.during_session.carbohydrate_g_per_hour, [60, 90]);
  assert.deepEqual(
    result.recovery.rapid_recovery_carbohydrate?.grams_per_hour,
    [60, 72]
  );
  assert.equal(result.evidence.phase_based_macro_change, "not_applied");
});

test("energy availability is uncertainty-aware and withheld for minors", () => {
  const adult = estimateEnergyAvailability({
    age_years: 30,
    energy_intake_kcal: 2400,
    exercise_energy_expenditure_kcal: 600,
    fat_free_mass_kg: 45,
  });
  const minor = estimateEnergyAvailability({
    age_years: 16,
    energy_intake_kcal: 2400,
    exercise_energy_expenditure_kcal: 600,
    fat_free_mass_kg: 45,
  });

  assert.equal(adult.estimate_kcal_per_kg_ffm_day, 40);
  assert.equal(adult.heuristic_band, "between_legacy_30_and_45_references");
  assert.equal(minor.estimate_kcal_per_kg_ffm_day, null);
  assert.equal(minor.uncertainty_range, null);
});

test("health screen escalates dangerous heavy bleeding", () => {
  const result = screenTrainingHealth({
    age_years: 28,
    life_stage: "naturally_cycling",
    soaking_protection_hourly_for_two_hours: true,
    dizziness: true,
    high_endurance_volume: true,
    persistent_fatigue: true,
  });

  assert.equal(result.triage, "urgent_medical_assessment");
  assert.match(result.urgent_flags.join(" "), /heavy bleeding/i);
  assert.ok(result.iron_risk_indicators.length >= 2);
});

test("opaque Garmin reproductive data is probed without declaring period starts", () => {
  const result = inspectSensitiveGarminDocument(
    {
      cycle: {
        startDate: "2026-08-24",
        generatedDate: "2026-09-01",
      },
    },
    false
  );

  assert.equal(result.date_candidates.length, 2);
  assert.equal(result.date_candidates[0].confidence, "unverified");
  assert.match(result.interpretation, /not confirmed period starts/);
  assert.equal(result.raw_document, undefined);
});
