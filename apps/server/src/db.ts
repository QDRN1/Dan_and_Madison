import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH ?? "./data/qdrn-radar.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db: Database.Database = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS enrichment_cache (
    hex        TEXT NOT NULL,
    callsign   TEXT NOT NULL DEFAULT '',
    data       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (hex, callsign)
  );

  -- One row per (aircraft, day) so we can compute daily + all-time stats cheaply.
  CREATE TABLE IF NOT EXISTS sightings (
    hex         TEXT NOT NULL,
    day         TEXT NOT NULL,          -- YYYY-MM-DD (local)
    flight      TEXT,
    type_code   TEXT,
    type_name   TEXT,
    operator    TEXT,
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    max_dist_nm REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (hex, day)
  );
  CREATE INDEX IF NOT EXISTS idx_sightings_day ON sightings(day);

  CREATE TABLE IF NOT EXISTS flagged (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    hex       TEXT NOT NULL,
    flight    TEXT,
    type_name TEXT,
    operator  TEXT,
    reason    TEXT NOT NULL,
    at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_flagged_at ON flagged(at);

  -- Farthest aircraft tracked per bearing bucket, with the time it was set so
  -- the coverage footprint reflects a rolling recent window (last 24h).
  DROP TABLE IF EXISTS coverage;
  DROP TABLE IF EXISTS coverage_daily;
  CREATE TABLE IF NOT EXISTS coverage_range (
    bucket     INTEGER PRIMARY KEY,
    dist_nm    REAL NOT NULL,
    lat        REAL NOT NULL,
    lon        REAL NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Achievement unlocks (badges in the Achievements tab). Most are repeatable
  -- ("you joined the Mile High Club 3 times"); a few are one-shots.
  CREATE TABLE IF NOT EXISTS achievements (
    id        TEXT PRIMARY KEY,
    count     INTEGER NOT NULL DEFAULT 0,
    first_at  INTEGER,
    last_at   INTEGER
  );

  -- Faster sighting queries for the popout lists.
  CREATE INDEX IF NOT EXISTS idx_sightings_dist ON sightings(max_dist_nm DESC);
`);

// Lazy column adds — older DBs predate the route columns. ALTER TABLE ADD COLUMN
// errors if the column already exists, so we probe pragma_table_info first.
function ensureColumn(table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
ensureColumn("sightings", "origin_icao", "TEXT");
ensureColumn("sightings", "dest_icao", "TEXT");
ensureColumn("sightings", "route_source", "TEXT");
db.exec(`CREATE INDEX IF NOT EXISTS idx_sightings_operator ON sightings(operator);`);

const getStmt = db.prepare<[string]>("SELECT value FROM settings WHERE key = ?");
const setStmt = db.prepare<[string, string]>(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

export function getSetting(key: string): string | undefined {
  const row = getStmt.get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  setStmt.run(key, value);
}
