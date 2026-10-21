// features/deathrow/db.js
const db = require("../../db");

// ========== Settings ==========
function getDeathRowSettings(guildId) {
  return db.prepare("SELECT * FROM death_row_settings WHERE guild_id = ?").get(guildId);
}

function upsertDeathRowSettings(guildId, settings) {
  const existing = getDeathRowSettings(guildId) || {};
  
  const stmt = db.prepare(`
    INSERT INTO death_row_settings (
      guild_id, 
      death_row_channel_id,
      life_row_channel_id,
      ping_role_id,
      death_row_role_id,
      life_row_role_id,
      action_log_channel_id,
      inactivity_notice_channel_id,
      loa_role_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      death_row_channel_id=excluded.death_row_channel_id,
      life_row_channel_id=excluded.life_row_channel_id,
      ping_role_id=excluded.ping_role_id,
      death_row_role_id=excluded.death_row_role_id,
      life_row_role_id=excluded.life_row_role_id,
      action_log_channel_id=excluded.action_log_channel_id,
      inactivity_notice_channel_id=excluded.inactivity_notice_channel_id,
      loa_role_id=excluded.loa_role_id
  `);
  
  stmt.run(
    guildId,
    settings.death_row_channel_id !== undefined ? settings.death_row_channel_id : existing.death_row_channel_id,
    settings.life_row_channel_id !== undefined ? settings.life_row_channel_id : existing.life_row_channel_id,
    settings.ping_role_id !== undefined
      ? settings.ping_role_id
      : (existing.ping_role_id || existing.death_row_role_id || existing.life_row_role_id),
    settings.death_row_role_id !== undefined ? settings.death_row_role_id : existing.death_row_role_id,
    settings.life_row_role_id !== undefined ? settings.life_row_role_id : existing.life_row_role_id,
    settings.action_log_channel_id !== undefined ? settings.action_log_channel_id : existing.action_log_channel_id,
    settings.inactivity_notice_channel_id !== undefined ? settings.inactivity_notice_channel_id : existing.inactivity_notice_channel_id,
    settings.loa_role_id !== undefined ? settings.loa_role_id : existing.loa_role_id
  );
}

// ========== Death Row Records ==========
function createDeathRowRecord(data) {
  const stmt = db.prepare(`
    INSERT INTO death_row_records (
      target_user_id,
      target_username,
      executor_user_id,
      executor_display,
      reason,
      servers_banned_count,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  const now = Math.floor(Date.now() / 1000);
  const result = stmt.run(
    data.target_user_id,
    data.target_username,
    data.executor_user_id,
    data.executor_display,
    data.reason,
    data.servers_banned_count || 0,
    now
  );
  
  return result.lastInsertRowid;
}

function getDeathRowRecord(id) {
  return db.prepare("SELECT * FROM death_row_records WHERE id = ?").get(id);
}

function getAllDeathRowRecords(limit = 50) {
  return db.prepare(`
    SELECT * FROM death_row_records 
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

function getUserDeathRowRecords(userId) {
  return db.prepare(`
    SELECT * FROM death_row_records 
    WHERE target_user_id = ?
    ORDER BY created_at DESC
  `).all(userId);
}

module.exports = {
  getDeathRowSettings,
  upsertDeathRowSettings,
  createDeathRowRecord,
  getDeathRowRecord,
  getAllDeathRowRecords,
  getUserDeathRowRecords
};
