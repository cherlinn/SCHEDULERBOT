// features/inactivity/db.js
const db = require("../../db");

// ========== Inactivity Notices ==========
function createInactivityNotice(data) {
  const stmt = db.prepare(`
    INSERT INTO inactivity_notices (
      guild_id,
      user_id,
      username,
      reason,
      start_date,
      end_date,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const now = Math.floor(Date.now() / 1000);
  const result = stmt.run(
    data.guild_id,
    data.user_id,
    data.username,
    data.reason,
    data.start_date || null,
    data.end_date || null,
    now
  );

  return result.lastInsertRowid;
}

function getInactivityNotice(guildId, userId) {
  return db.prepare(`
    SELECT * FROM inactivity_notices 
    WHERE guild_id = ? AND user_id = ?
  `).get(guildId, userId);
}

function getInactivityNoticeByUsername(guildId, username) {
  return db.prepare(`
    SELECT * FROM inactivity_notices 
    WHERE guild_id = ? AND username = ?
  `).get(guildId, username);
}

function getAllInactivityNotices(guildId) {
  return db.prepare(`
    SELECT * FROM inactivity_notices 
    WHERE guild_id = ?
    ORDER BY created_at DESC
  `).all(guildId);
}

function getExpiredInactivityNotices(guildId, nowUnix) {
  return db.prepare(`
    SELECT * FROM inactivity_notices
    WHERE guild_id = ?
      AND end_date IS NOT NULL
      AND end_date <= ?
    ORDER BY end_date ASC
  `).all(guildId, nowUnix);
}

function deleteExpiredInactivityNotices(guildId, nowUnix) {
  return db.prepare(`
    DELETE FROM inactivity_notices
    WHERE guild_id = ?
      AND end_date IS NOT NULL
      AND end_date <= ?
  `).run(guildId, nowUnix);
}

function getGuildIdsWithInactivityNotices() {
  return db.prepare(`
    SELECT DISTINCT guild_id
    FROM inactivity_notices
  `).all().map(row => row.guild_id);
}

function deleteInactivityNotice(guildId, userId) {
  return db.prepare(`
    DELETE FROM inactivity_notices 
    WHERE guild_id = ? AND user_id = ?
  `).run(guildId, userId);
}

function deleteInactivityNoticeByUsername(guildId, username) {
  return db.prepare(`
    DELETE FROM inactivity_notices 
    WHERE guild_id = ? AND username = ?
  `).run(guildId, username);
}

module.exports = {
  createInactivityNotice,
  getInactivityNotice,
  getInactivityNoticeByUsername,
  getAllInactivityNotices,
  getExpiredInactivityNotices,
  deleteExpiredInactivityNotices,
  getGuildIdsWithInactivityNotices,
  deleteInactivityNotice,
  deleteInactivityNoticeByUsername
};
