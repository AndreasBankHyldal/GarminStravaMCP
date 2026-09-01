import Database from "better-sqlite3";
import { config } from "../config.js";
import fs from "node:fs";
import path from "node:path";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_cache (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK(source IN ('strava', 'garmin')),
      name TEXT,
      type TEXT,
      start_date TEXT,
      distance_meters REAL,
      duration_seconds REAL,
      avg_pace_per_km REAL,
      avg_heartrate REAL,
      max_heartrate REAL,
      elevation_gain REAL,
      calories REAL,
      raw_json TEXT,
      fetched_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS training_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      goal TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS planned_workouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      workout_type TEXT NOT NULL,
      description TEXT,
      target_distance_km REAL,
      target_duration_minutes REAL,
      target_pace_per_km TEXT,
      intensity TEXT CHECK(intensity IN ('easy', 'moderate', 'tempo', 'threshold', 'interval', 'race')),
      completed INTEGER DEFAULT 0,
      actual_activity_id TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS garmin_workout_sync (
      planned_workout_id INTEGER PRIMARY KEY REFERENCES planned_workouts(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
      garmin_workout_id TEXT NOT NULL,
      last_workout_hash TEXT NOT NULL,
      scheduled_date TEXT NOT NULL,
      last_sync_status TEXT NOT NULL DEFAULT 'scheduled',
      synced_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS women_health_profile (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      life_stage TEXT NOT NULL CHECK(life_stage IN (
        'naturally_cycling',
        'hormonal_contraception',
        'perimenopause',
        'postmenopause',
        'pregnant',
        'postpartum',
        'unknown'
      )),
      contraception_type TEXT,
      typical_cycle_length_days INTEGER,
      typical_period_length_days INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS women_cycle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_date TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN (
        'period_start',
        'period_end',
        'positive_lh_test'
      )),
      source TEXT NOT NULL CHECK(source IN ('user_input', 'garmin_unofficial_api')),
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(event_date, event_type, source)
    );

    CREATE TABLE IF NOT EXISTS women_daily_logs (
      date TEXT PRIMARY KEY,
      period_flow TEXT CHECK(period_flow IN (
        'none',
        'spotting',
        'light',
        'moderate',
        'heavy',
        'very_heavy'
      )),
      symptoms_json TEXT NOT NULL DEFAULT '[]',
      overall_symptom_severity INTEGER CHECK(overall_symptom_severity BETWEEN 0 AND 10),
      energy INTEGER CHECK(energy BETWEEN 1 AND 5),
      fatigue INTEGER CHECK(fatigue BETWEEN 1 AND 5),
      soreness INTEGER CHECK(soreness BETWEEN 1 AND 5),
      sleep_quality INTEGER CHECK(sleep_quality BETWEEN 1 AND 5),
      stress INTEGER CHECK(stress BETWEEN 1 AND 5),
      motivation INTEGER CHECK(motivation BETWEEN 1 AND 5),
      perceived_performance INTEGER CHECK(perceived_performance BETWEEN 1 AND 5),
      session_rpe REAL CHECK(session_rpe BETWEEN 0 AND 10),
      notes TEXT,
      source TEXT NOT NULL DEFAULT 'user_input' CHECK(source = 'user_input'),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_activity_cache_source ON activity_cache(source);
    CREATE INDEX IF NOT EXISTS idx_activity_cache_date ON activity_cache(start_date);
    CREATE INDEX IF NOT EXISTS idx_planned_workouts_plan ON planned_workouts(plan_id);
    CREATE INDEX IF NOT EXISTS idx_planned_workouts_date ON planned_workouts(date);
    CREATE INDEX IF NOT EXISTS idx_garmin_sync_plan ON garmin_workout_sync(plan_id);
    CREATE INDEX IF NOT EXISTS idx_women_cycle_event_date ON women_cycle_events(event_date);
    CREATE INDEX IF NOT EXISTS idx_women_daily_log_date ON women_daily_logs(date);
  `);
}
