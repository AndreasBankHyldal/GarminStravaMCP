import {
  CycleContext,
  CyclePhase,
  WomenHealthProfile,
} from "./types.js";

const DAY_MS = 86_400_000;
const PHASES: CyclePhase[] = [
  "menstruation",
  "follicular",
  "periovulatory",
  "luteal",
  "unknown",
];

export function toDateKey(value: string | Date): string {
  const date = typeof value === "string" ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : value;
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${String(value)}`);
  }
  return date.toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  return Math.round(
    (new Date(`${toDateKey(end)}T00:00:00Z`).getTime() -
      new Date(`${toDateKey(start)}T00:00:00Z`).getTime()) /
      DAY_MS
  );
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${toDateKey(date)}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function cycleLengths(periodStarts: string[]): number[] {
  const starts = normalizeStarts(periodStarts);
  const lengths: number[] = [];
  for (let index = 1; index < starts.length; index++) {
    const length = daysBetween(starts[index - 1], starts[index]);
    if (length >= 10 && length <= 365) lengths.push(length);
  }
  return lengths;
}

export function estimateCycleContext(
  profile: WomenHealthProfile | null,
  periodStarts: string[],
  targetDate: string,
  positiveLhTests: string[] = []
): CycleContext {
  const date = toDateKey(targetDate);
  const assumptions = [
    "Calendar estimates cannot confirm ovulation or hormone concentrations.",
    "A luteal phase of approximately 14 days is used only as a population-level estimate.",
    "Menstrual phase alone does not trigger a training adjustment.",
  ];
  const dataBasis: string[] = [];
  const medicalFlags: string[] = [];
  const lifeStage = profile?.life_stage ?? "unknown";

  if (lifeStage !== "naturally_cycling" && lifeStage !== "unknown") {
    const reason =
      lifeStage === "hormonal_contraception"
        ? "Hormonal contraception can suppress endogenous cycling; withdrawal bleeding is not a reliable natural-cycle phase marker."
        : lifeStage === "perimenopause"
        ? "Perimenopausal hormone patterns and cycle timing are often variable."
        : lifeStage === "pregnant" || lifeStage === "postpartum"
        ? "Pregnancy and postpartum training require individualized clinical guidance, not cycle-phase estimation."
        : "Cycle-phase estimation is not applicable after menopause.";
    return unknownContext(date, "unreliable", [reason], assumptions, medicalFlags);
  }

  const starts = normalizeStarts(periodStarts).filter((start) => start <= date);
  if (!starts.length) {
    return unknownContext(
      date,
      "unreliable",
      ["No period start has been recorded on or before the target date."],
      assumptions,
      medicalFlags
    );
  }

  const lengths = cycleLengths(starts);
  const personalMedian = lengths.length ? median(lengths) : null;
  const cycleLength = Math.round(
    personalMedian ?? profile?.typical_cycle_length_days ?? 28
  );
  const periodLength = profile?.typical_period_length_days ?? 5;
  const latestStart = starts[starts.length - 1];
  const cycleDay = daysBetween(latestStart, date) + 1;
  const observedRange =
    lengths.length >= 2 ? Math.max(...lengths) - Math.min(...lengths) : null;
  const persistentAtypical =
    lengths.filter((length) => length < 24 || length > 38).length >= 2;
  const profileAtypical =
    profile?.typical_cycle_length_days != null &&
    (profile.typical_cycle_length_days < 24 ||
      profile.typical_cycle_length_days > 38);

  dataBasis.push(`Latest recorded period start: ${latestStart}.`);
  if (lifeStage === "unknown") {
    assumptions.push(
      "Reproductive life stage is unknown; this estimate assumes natural cycling and may be inapplicable with hormonal contraception."
    );
  }
  if (lengths.length) {
    dataBasis.push(
      `${lengths.length} observed cycle interval(s); median ${personalMedian} days${
        observedRange !== null ? `; range ${observedRange} days` : ""
      }.`
    );
  } else if (profile?.typical_cycle_length_days) {
    dataBasis.push(
      `User-reported typical cycle length: ${profile.typical_cycle_length_days} days.`
    );
  } else {
    dataBasis.push("No personal interval history; a 28-day population default was used.");
  }

  if (persistentAtypical) {
    medicalFlags.push(
      "Multiple recorded cycles fall outside the typical adult 24-38 day range; consider routine clinical evaluation."
    );
  }
  if (profileAtypical) {
    medicalFlags.push(
      "The reported usual cycle length falls outside the typical adult 24-38 day range; consider routine clinical evaluation if this persists."
    );
  }
  if (observedRange !== null && observedRange > 9) {
    medicalFlags.push(
      "Recorded cycle length varies by more than 9 days; calendar phase estimates are unreliable."
    );
  }
  if (cycleDay >= 90) {
    medicalFlags.push(
      "No period start has been recorded for at least 90 days; if this is unexplained, seek clinical evaluation and consider pregnancy where relevant."
    );
  }

  let confidence: CycleContext["confidence"] =
    lengths.length >= 3 && (observedRange ?? 99) <= 7 ? "moderate" : "low";
  if (lifeStage === "unknown") confidence = "low";
  if (
    persistentAtypical ||
    profileAtypical ||
    (observedRange !== null && observedRange > 9) ||
    cycleDay >= 90
  ) {
    confidence = "unreliable";
  }
  if (confidence === "unreliable") {
    return {
      ...unknownContext(date, confidence, dataBasis, assumptions, medicalFlags),
      cycle_day: cycleDay,
    };
  }

  const observedMin =
    lengths.length >= 2 ? Math.min(...lengths) : cycleLength - 3;
  const observedMax =
    lengths.length >= 2 ? Math.max(...lengths) : cycleLength + 3;
  const earliestNext = addDays(latestStart, Math.max(15, observedMin));
  const likelyNext = addDays(latestStart, cycleLength);
  const latestNext = addDays(latestStart, Math.min(90, observedMax));
  const ovulationEarliest = addDays(earliestNext, -16);
  const ovulationLatest = addDays(latestNext, -12);
  const latestLhTest = normalizeStarts(positiveLhTests)
    .filter((testDate) => testDate >= latestStart && testDate <= date)
    .at(-1);
  if (latestLhTest) {
    dataBasis.push(
      `Positive urinary LH test recorded on ${latestLhTest}; this supports an approaching ovulation window but does not confirm ovulation.`
    );
    if (lifeStage === "naturally_cycling") confidence = "moderate";
  }

  if (date > addDays(latestNext, 7)) {
    return {
      ...unknownContext(
        date,
        "unreliable",
        dataBasis,
        assumptions,
        medicalFlags
      ),
      cycle_day: cycleDay,
      predicted_next_period: {
        earliest: earliestNext,
        most_likely: likelyNext,
        latest: latestNext,
      },
      estimated_ovulation_window: {
        earliest: ovulationEarliest,
        latest: ovulationLatest,
      },
    };
  }

  const phase =
    cycleDay <= periodLength
      ? "menstruation"
      : latestLhTest
      ? date <= addDays(latestLhTest, 2)
        ? "periovulatory"
        : "luteal"
      : classifyEstimatedPhase(date, latestStart, likelyNext, periodLength);

  return {
    target_date: date,
    phase,
    cycle_day: cycleDay,
    phase_probabilities: phaseProbabilities(phase, confidence),
    predicted_next_period: {
      earliest: earliestNext,
      most_likely: likelyNext,
      latest: latestNext,
    },
    estimated_ovulation_window: latestLhTest
      ? {
          earliest: latestLhTest,
          latest: addDays(latestLhTest, 2),
        }
      : {
          earliest: ovulationEarliest,
          latest: ovulationLatest,
        },
    confidence,
    data_basis: dataBasis,
    assumptions,
    medical_follow_up_flags: medicalFlags,
    phase_based_training_rule: "none",
  };
}

export function classifyCompletedCyclePhase(
  targetDate: string,
  cycleStart: string,
  nextCycleStart: string,
  periodLengthDays = 5
): CyclePhase {
  const date = toDateKey(targetDate);
  const start = toDateKey(cycleStart);
  const next = toDateKey(nextCycleStart);
  if (date < start || date >= next) return "unknown";

  const cycleDay = daysBetween(start, date) + 1;
  if (cycleDay <= periodLengthDays) return "menstruation";

  const estimatedOvulation = addDays(next, -14);
  if (date >= addDays(estimatedOvulation, -1) && date <= addDays(estimatedOvulation, 1)) {
    return "periovulatory";
  }
  return date < estimatedOvulation ? "follicular" : "luteal";
}

function classifyEstimatedPhase(
  targetDate: string,
  cycleStart: string,
  predictedNext: string,
  periodLengthDays: number
): CyclePhase {
  const cycleDay = daysBetween(cycleStart, targetDate) + 1;
  if (cycleDay <= periodLengthDays) return "menstruation";
  const estimatedOvulation = addDays(predictedNext, -14);
  if (
    targetDate >= addDays(estimatedOvulation, -1) &&
    targetDate <= addDays(estimatedOvulation, 1)
  ) {
    return "periovulatory";
  }
  return targetDate < estimatedOvulation ? "follicular" : "luteal";
}

function phaseProbabilities(
  phase: CyclePhase,
  confidence: CycleContext["confidence"]
): Record<CyclePhase, number> {
  const result = Object.fromEntries(PHASES.map((name) => [name, 0])) as Record<
    CyclePhase,
    number
  >;
  if (phase === "unknown" || confidence === "unreliable") {
    result.unknown = 1;
    return result;
  }

  const primary = confidence === "moderate" ? 0.65 : 0.5;
  result[phase] = primary;
  result.unknown = confidence === "moderate" ? 0.1 : 0.25;
  const neighbors = adjacentPhases(phase);
  const remainder = 1 - result[phase] - result.unknown;
  for (const neighbor of neighbors) {
    result[neighbor] = +(remainder / neighbors.length).toFixed(3);
  }
  const total = Object.values(result).reduce((sum, value) => sum + value, 0);
  result[neighbors[neighbors.length - 1]] += +(1 - total).toFixed(3);
  return result;
}

function adjacentPhases(phase: CyclePhase): CyclePhase[] {
  switch (phase) {
    case "menstruation":
      return ["follicular", "luteal"];
    case "follicular":
      return ["menstruation", "periovulatory"];
    case "periovulatory":
      return ["follicular", "luteal"];
    case "luteal":
      return ["periovulatory", "menstruation"];
    default:
      return ["unknown"];
  }
}

function unknownContext(
  targetDate: string,
  confidence: "low" | "unreliable",
  dataBasis: string[],
  assumptions: string[],
  medicalFlags: string[]
): CycleContext {
  return {
    target_date: targetDate,
    phase: "unknown",
    cycle_day: null,
    phase_probabilities: {
      menstruation: 0,
      follicular: 0,
      periovulatory: 0,
      luteal: 0,
      unknown: 1,
    },
    predicted_next_period: null,
    estimated_ovulation_window: null,
    confidence,
    data_basis: dataBasis,
    assumptions,
    medical_follow_up_flags: medicalFlags,
    phase_based_training_rule: "none",
  };
}

function normalizeStarts(periodStarts: string[]): string[] {
  return [...new Set(periodStarts.map(toDateKey))].sort();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
