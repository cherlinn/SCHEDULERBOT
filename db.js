// db.js
const Database = require("better-sqlite3");

const db = new Database("scheduler.sqlite");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  guild_id TEXT PRIMARY KEY,
  board_channel_id TEXT,
  board_message_id TEXT
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  division TEXT NOT NULL,
  host_user_id TEXT NOT NULL,
  host_display TEXT NOT NULL,
  title TEXT NOT NULL,
  start_utc INTEGER NOT NULL,         -- unix seconds
  duration_min INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, id)
);

CREATE INDEX IF NOT EXISTS idx_res_guild_start
ON reservations(guild_id, start_utc);

-- Death Row Tables
CREATE TABLE IF NOT EXISTS death_row_settings (
  guild_id TEXT PRIMARY KEY,
  death_row_channel_id TEXT,          -- Channel where death row executions are logged
  life_row_channel_id TEXT,           -- Channel where life row unbans are logged
  ping_role_id TEXT,                  -- Shared role to ping for death/life row logs
  death_row_role_id TEXT,             -- Role to ping for death row logs
  life_row_role_id TEXT,              -- Role to ping for life row logs
  action_log_channel_id TEXT,         -- Channel for forwarding death/life row records
  inactivity_notice_channel_id TEXT,  -- Channel for inactivity expiry notifications
  loa_role_id TEXT                    -- Role granted while inactivity notice is active
);

CREATE TABLE IF NOT EXISTS death_row_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_user_id TEXT NOT NULL,
  target_username TEXT NOT NULL,
  executor_user_id TEXT NOT NULL,
  executor_display TEXT NOT NULL,
  reason TEXT NOT NULL,
  servers_banned_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_death_row_target
ON death_row_records(target_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_death_row_executor
ON death_row_records(executor_user_id, created_at);

-- Inactivity Notices Table
CREATE TABLE IF NOT EXISTS inactivity_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  reason TEXT NOT NULL,
  start_date INTEGER,                 -- unix seconds (optional)
  end_date INTEGER,                   -- unix seconds (optional)
  created_at INTEGER NOT NULL,
  UNIQUE(guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_inactivity_guild
ON inactivity_notices(guild_id, created_at);
`);

try {
  const drSettings = db.prepare("PRAGMA table_info(death_row_settings)").all();
  const hasLifeRowChannel = drSettings.some(col => col.name === "life_row_channel_id");
  const hasPingRole = drSettings.some(col => col.name === "ping_role_id");
  const hasDeathRowRole = drSettings.some(col => col.name === "death_row_role_id");
  const hasLifeRowRole = drSettings.some(col => col.name === "life_row_role_id");
  const hasActionLogChannel = drSettings.some(col => col.name === "action_log_channel_id");
  const hasInactivityNoticeChannel = drSettings.some(col => col.name === "inactivity_notice_channel_id");
  const hasLoaRole = drSettings.some(col => col.name === "loa_role_id");

  if (!hasLifeRowChannel) {
    db.exec("ALTER TABLE death_row_settings ADD COLUMN life_row_channel_id TEXT;");
    console.log("✅ Added life_row_channel_id to death_row_settings");
  }

  if (!hasDeathRowRole) {
    db.exec("ALTER TABLE death_row_settings ADD COLUMN death_row_role_id TEXT;");
    console.log("✅ Added death_row_role_id to death_row_settings");
  }

  if (!hasLifeRowRole) {
    db.exec("ALTER TABLE death_row_settings ADD COLUMN life_row_role_id TEXT;");
    console.log("✅ Added life_row_role_id to death_row_settings");
  }

  if (!hasPingRole) {
    db.exec("ALTER TABLE death_row_settings ADD COLUMN ping_role_id TEXT;");
    console.log("✅ Added ping_role_id to death_row_settings");
    db.exec(`
      UPDATE death_row_settings
      SET ping_role_id = COALESCE(death_row_role_id, life_row_role_id)
      WHERE (ping_role_id IS NULL OR ping_role_id = '')
    `);
  }

  if (!hasActionLogChannel) {
    db.exec("ALTER TABLE death_row_settings ADD COLUMN action_log_channel_id TEXT;");
    console.log("✅ Added action_log_channel_id to death_row_settings");
  }

  if (!hasInactivityNoticeChannel) {
    db.exec("ALTER TABLE death_row_settings ADD COLUMN inactivity_notice_channel_id TEXT;");
    console.log("✅ Added inactivity_notice_channel_id to death_row_settings");
  }

  if (!hasLoaRole) {
    db.exec("ALTER TABLE death_row_settings ADD COLUMN loa_role_id TEXT;");
    console.log("✅ Added loa_role_id to death_row_settings");
  }
} catch (err) {
  if (!err.message.includes("no such table")) {
    console.warn("⚠️  Death row migration warning:", err.message);
  }
}

module.exports = db;