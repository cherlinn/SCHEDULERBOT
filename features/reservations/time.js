// time.js
const { DateTime } = require("luxon");

const TZ = "America/New_York";

function getWeekWindowET(now = DateTime.now().setZone(TZ)) {
  // Luxon: Monday = 1 ... Sunday = 7
  const startOfToday = now.startOf("day");
  const daysSinceMonday = startOfToday.weekday - 1; // Monday -> 0
  const weekStart = startOfToday.minus({ days: daysSinceMonday }).setZone(TZ);
  const weekEnd = weekStart.plus({ days: 7 });
  return { weekStart, weekEnd };
}

function toUnixUTC(dtET) {
  // dtET is Luxon DateTime in ET
  return Math.floor(dtET.toUTC().toSeconds());
}

function unixToDiscordFull(unixSeconds) {
  return `<t:${unixSeconds}:f>`;
}

module.exports = {
  TZ,
  getWeekWindowET,
  toUnixUTC,
  unixToDiscordFull,
};
