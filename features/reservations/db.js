// features/reservations/db.js
const db = require("../../db");

function getSettings(guildId) {
  return db.prepare("SELECT * FROM settings WHERE guild_id = ?").get(guildId);
}

function upsertSettings(guildId, channelId, messageId) {
  db.prepare(`
    INSERT INTO settings (guild_id, board_channel_id, board_message_id)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      board_channel_id=excluded.board_channel_id,
      board_message_id=excluded.board_message_id
  `).run(guildId, channelId, messageId);
}

function getReservationsForCurrentWeek(guildId, weekStart, weekEnd) {
  const startUnix = Math.floor(weekStart.toUTC().toSeconds());
  const endUnix = Math.floor(weekEnd.toUTC().toSeconds());

  return db.prepare(`
    SELECT * FROM reservations
    WHERE guild_id = ?
      AND start_utc >= ?
      AND start_utc < ?
    ORDER BY start_utc ASC
  `).all(guildId, startUnix, endUnix);
}

function getFutureReservations(guildId, weekEnd, weeks = 4) {
  const startUnix = Math.floor(weekEnd.toUTC().toSeconds());
  const endUnix = Math.floor(weekEnd.plus({ days: 7 * weeks }).toUTC().toSeconds());

  return db.prepare(`
    SELECT * FROM reservations
    WHERE guild_id = ?
      AND start_utc >= ?
      AND start_utc < ?
    ORDER BY start_utc ASC
  `).all(guildId, startUnix, endUnix);
}

function cleanupExpiredReservations(guildId, nowUnix = Math.floor(Date.now() / 1000)) {
  return db.prepare(`
    DELETE FROM reservations
    WHERE guild_id = ?
      AND (start_utc + (duration_min * 60)) <= ?
  `).run(guildId, nowUnix);
}

function getGuildIdsWithReservations() {
  return db.prepare(`
    SELECT DISTINCT guild_id
    FROM reservations
  `).all().map(row => row.guild_id);
}

function deleteReservation(guildId, id) {
  return db.prepare("DELETE FROM reservations WHERE guild_id = ? AND id = ?").run(guildId, id);
}

function getReservationById(guildId, id) {
  return db.prepare("SELECT * FROM reservations WHERE guild_id = ? AND id = ?").get(guildId, id);
}

function getNextAvailableId(guildId, nowUnix = Math.floor(Date.now() / 1000)) {
  const existingIds = db.prepare(
    `SELECT id
     FROM reservations
     WHERE guild_id = ?
       AND (start_utc + (duration_min * 60)) > ?
     ORDER BY id ASC`
  ).all(guildId, nowUnix).map(r => r.id);

  if (existingIds.length === 0) return 0;

  for (let i = 0; i < 100; i++) {
    if (!existingIds.includes(i)) {
      return i;
    }
  }

  throw new Error("All reservation slots (0-99) are full!");
}

function updateReservation(guildId, id, updates) {
  const fields = [];
  const values = [];
  
  if (updates.division !== undefined) {
    fields.push("division = ?");
    values.push(updates.division);
  }
  if (updates.host_display !== undefined) {
    fields.push("host_display = ?");
    values.push(updates.host_display);
  }
  if (updates.title !== undefined) {
    fields.push("title = ?");
    values.push(updates.title);
  }
  if (updates.start_utc !== undefined) {
    fields.push("start_utc = ?");
    values.push(updates.start_utc);
  }
  if (updates.duration_min !== undefined) {
    fields.push("duration_min = ?");
    values.push(updates.duration_min);
  }
  
  if (fields.length === 0) return false;
  
  values.push(guildId, id);
  
  const sql = `UPDATE reservations SET ${fields.join(", ")} WHERE guild_id = ? AND id = ?`;
  const result = db.prepare(sql).run(...values);
  
  return result.changes > 0;
}

function getUserReservations(guildId, userId) {
  return db.prepare(`
    SELECT * FROM reservations
    WHERE guild_id = ? AND host_user_id = ?
    ORDER BY start_utc ASC
  `).all(guildId, userId);
}

function insertReservation(data) {
  cleanupExpiredReservations(data.guild_id);
  const id = getNextAvailableId(data.guild_id);
  
  const stmt = db.prepare(`
    INSERT INTO reservations (id, guild_id, division, host_user_id, host_display, title, start_utc, duration_min, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    id,
    data.guild_id,
    data.division,
    data.host_user_id,
    data.host_display,
    data.title,
    data.start_utc,
    data.duration_min,
    data.created_at
  );
  
  return id;
}

function conflicts(guildId, startUtc, durationMin, excludeId = null) {
  const endUtc = startUtc + durationMin * 60;

  let query = `
    SELECT id, division, host_display, title, start_utc, duration_min
    FROM reservations
    WHERE guild_id = ?
      AND start_utc < ?
  `;
  
  const params = [guildId, endUtc];
  
  if (excludeId !== null) {
    query += ` AND id != ?`;
    params.push(excludeId);
  }

  const rows = db.prepare(query).all(...params);

  for (const r of rows) {
    const rEnd = r.start_utc + r.duration_min * 60;
    if (startUtc < rEnd && r.start_utc < endUtc) {
      return r;
    }
  }
  return null;
}

module.exports = {
  getSettings,
  upsertSettings,
  getReservationsForCurrentWeek,
  getFutureReservations,
  cleanupExpiredReservations,
  getGuildIdsWithReservations,
  deleteReservation,
  getReservationById,
  updateReservation,
  getUserReservations,
  insertReservation,
  conflicts
};
