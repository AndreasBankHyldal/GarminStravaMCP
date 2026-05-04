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

    CREATE INDEX IF NOT EXISTS idx_activity_cache_source ON activity_cache(source);
    CREATE INDEX IF NOT EXISTS idx_activity_cache_date ON activity_cache(start_date);
    CREATE INDEX IF NOT EXISTS idx_planned_workouts_plan ON planned_workouts(plan_id);
    CREATE INDEX IF NOT EXISTS idx_planned_workouts_date ON planned_workouts(date);
    CREATE INDEX IF NOT EXISTS idx_garmin_sync_plan ON garmin_workout_sync(plan_id);
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
