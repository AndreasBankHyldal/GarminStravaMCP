/** Garmin cycling activity types (road, gravel, MTB, indoor, virtual, e-bike…), excluding motorcycling. */
export function isCyclingType(typeKey?: string | null): boolean {
  const key = (typeKey ?? "").toLowerCase();
  if (!key || /motor|moto/.test(key)) return false;
  return /cycl|bik|bmx|spin|virtual_ride/.test(key);
}

export const isIndoorRide = (typeKey?: string | null) => /indoor|virtual|trainer|spin/.test((typeKey ?? "").toLowerCase());
export const isEbike = (typeKey?: string | null) => /e_?bike/.test((typeKey ?? "").toLowerCase());

const CYCLING_FILTER_TERMS = new Set(["cycling", "cycle", "biking", "bike", "ride", "riding"]);

/** Activity-type filter: generic ride terms match every cycling type; anything else is a substring match. */
export function matchesActivityTypeFilter(typeKey: string | undefined | null, filter: string): boolean {
  const term = filter.trim().toLowerCase();
  if (CYCLING_FILTER_TERMS.has(term)) return isCyclingType(typeKey);
  return (typeKey ?? "").toLowerCase().includes(term);
}
