import { getDb } from "../db/database.js";
import {
  CycleDataSource,
  CycleEvent,
  CycleEventType,
  WomenDailyLog,
  WomenHealthProfile,
} from "./types.js";

type ProfileUpdate = Partial<WomenHealthProfile> & Pick<WomenHealthProfile, "life_stage">;

interface DailyLogRow extends Omit<WomenDailyLog, "symptoms"> {
  symptoms_json: string;
  updated_at: string;
}

export function getWomenHealthProfile(): WomenHealthProfile | null {
  const row = getDb()
    .prepare(
      `SELECT life_stage, contraception_type, typical_cycle_length_days,
              typical_period_length_days, updated_at
       FROM women_health_profile WHERE id = 1`
    )
    .get() as WomenHealthProfile | undefined;
  return row ?? null;
}

export function saveWomenHealthProfile(update: ProfileUpdate): WomenHealthProfile {
  const current = getWomenHealthProfile();
  const profile: WomenHealthProfile = {
    life_stage: update.life_stage,
    contraception_type:
      update.contraception_type !== undefined
        ? update.contraception_type
        : current?.contraception_type ?? null,
    typical_cycle_length_days:
      update.typical_cycle_length_days !== undefined
        ? update.typical_cycle_length_days
        : current?.typical_cycle_length_days ?? null,
    typical_period_length_days:
      update.typical_period_length_days !== undefined
        ? update.typical_period_length_days
        : current?.typical_period_length_days ?? null,
  };

  getDb()
    .prepare(
      `INSERT INTO women_health_profile (
         id, life_stage, contraception_type, typical_cycle_length_days,
         typical_period_length_days
       ) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         life_stage = excluded.life_stage,
         contraception_type = excluded.contraception_type,
         typical_cycle_length_days = excluded.typical_cycle_length_days,
         typical_period_length_days = excluded.typical_period_length_days,
         updated_at = datetime('now')`
    )
    .run(
      profile.life_stage,
      profile.contraception_type,
      profile.typical_cycle_length_days,
      profile.typical_period_length_days
    );

  return getWomenHealthProfile()!;
}

export function addCycleEvent(event: CycleEvent): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO women_cycle_events
       (event_date, event_type, source, notes) VALUES (?, ?, ?, ?)`
    )
    .run(event.event_date, event.event_type, event.source, event.notes ?? null);
  return result.changes > 0;
}

export function deleteCycleEvent(
  eventDate: string,
  eventType: CycleEventType,
  source?: CycleDataSource
): number {
  const result = source
    ? getDb()
        .prepare(
          "DELETE FROM women_cycle_events WHERE event_date = ? AND event_type = ? AND source = ?"
        )
        .run(eventDate, eventType, source)
    : getDb()
        .prepare("DELETE FROM women_cycle_events WHERE event_date = ? AND event_type = ?")
        .run(eventDate, eventType);
  return result.changes;
}

export function getCycleEvents(
  eventType?: CycleEventType,
  startDate?: string,
  endDate?: string
): CycleEvent[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (eventType) {
    clauses.push("event_type = ?");
    params.push(eventType);
  }
  if (startDate) {
    clauses.push("event_date >= ?");
    params.push(startDate);
  }
  if (endDate) {
    clauses.push("event_date <= ?");
    params.push(endDate);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return getDb()
    .prepare(
      `SELECT id, event_date, event_type, source, notes
       FROM women_cycle_events ${where}
       ORDER BY event_date ASC, id ASC`
    )
    .all(...params) as CycleEvent[];
}

export function getPeriodStartDates(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT event_date
       FROM women_cycle_events
       WHERE event_type = 'period_start'
       ORDER BY event_date ASC`
    )
    .all() as Array<{ event_date: string }>;
  return rows.map((row) => row.event_date);
}

export function getWomenDailyLog(date: string): WomenDailyLog | null {
  const row = getDb()
    .prepare("SELECT * FROM women_daily_logs WHERE date = ?")
    .get(date) as DailyLogRow | undefined;
  return row ? mapDailyLog(row) : null;
}

export function saveWomenDailyLog(update: WomenDailyLog): WomenDailyLog {
  const current = getWomenDailyLog(update.date);
  const merged: WomenDailyLog = {
    date: update.date,
    period_flow:
      update.period_flow !== undefined ? update.period_flow : current?.period_flow,
    symptoms: update.symptoms !== undefined ? update.symptoms : current?.symptoms,
    overall_symptom_severity:
      update.overall_symptom_severity !== undefined
        ? update.overall_symptom_severity
        : current?.overall_symptom_severity,
    energy: update.energy !== undefined ? update.energy : current?.energy,
    fatigue: update.fatigue !== undefined ? update.fatigue : current?.fatigue,
    soreness: update.soreness !== undefined ? update.soreness : current?.soreness,
    sleep_quality:
      update.sleep_quality !== undefined
        ? update.sleep_quality
        : current?.sleep_quality,
    stress: update.stress !== undefined ? update.stress : current?.stress,
    motivation:
      update.motivation !== undefined ? update.motivation : current?.motivation,
    perceived_performance:
      update.perceived_performance !== undefined
        ? update.perceived_performance
        : current?.perceived_performance,
    session_rpe:
      update.session_rpe !== undefined ? update.session_rpe : current?.session_rpe,
    notes: update.notes !== undefined ? update.notes : current?.notes,
  };

  getDb()
    .prepare(
      `INSERT INTO women_daily_logs (
         date, period_flow, symptoms_json, overall_symptom_severity, energy,
         fatigue, soreness, sleep_quality, stress, motivation,
         perceived_performance, session_rpe, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         period_flow = excluded.period_flow,
         symptoms_json = excluded.symptoms_json,
         overall_symptom_severity = excluded.overall_symptom_severity,
         energy = excluded.energy,
         fatigue = excluded.fatigue,
         soreness = excluded.soreness,
         sleep_quality = excluded.sleep_quality,
         stress = excluded.stress,
         motivation = excluded.motivation,
         perceived_performance = excluded.perceived_performance,
         session_rpe = excluded.session_rpe,
         notes = excluded.notes,
         updated_at = datetime('now')`
    )
    .run(
      update.date,
      merged.period_flow ?? null,
      JSON.stringify(merged.symptoms ?? []),
      merged.overall_symptom_severity ?? null,
      merged.energy ?? null,
      merged.fatigue ?? null,
      merged.soreness ?? null,
      merged.sleep_quality ?? null,
      merged.stress ?? null,
      merged.motivation ?? null,
      merged.perceived_performance ?? null,
      merged.session_rpe ?? null,
      merged.notes ?? null
    );

  return getWomenDailyLog(update.date)!;
}

export function getWomenDailyLogs(startDate: string, endDate: string): WomenDailyLog[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM women_daily_logs
       WHERE date >= ? AND date <= ?
       ORDER BY date ASC`
    )
    .all(startDate, endDate) as DailyLogRow[];
  return rows.map(mapDailyLog);
}

function mapDailyLog(row: DailyLogRow): WomenDailyLog {
  return {
    date: row.date,
    period_flow: row.period_flow,
    symptoms: JSON.parse(row.symptoms_json) as WomenDailyLog["symptoms"],
    overall_symptom_severity: row.overall_symptom_severity,
    energy: row.energy,
    fatigue: row.fatigue,
    soreness: row.soreness,
    sleep_quality: row.sleep_quality,
    stress: row.stress,
    motivation: row.motivation,
    perceived_performance: row.perceived_performance,
    session_rpe: row.session_rpe,
    notes: row.notes,
  };
}
