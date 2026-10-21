// render.js
const { EmbedBuilder } = require("discord.js");
const { DateTime } = require("luxon");
const { TZ, getWeekWindowET, unixToDiscordFull } = require("./time");

function weekdayName(n) {
  return ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"][n];
}

function buildScheduleEmbed(reservations, upcoming = []) {
  const { weekStart, weekEnd } = getWeekWindowET();

  const header = `SCHEDULE WEEK OF ${weekStart.toFormat("MM/dd")} - ${weekEnd.minus({ days: 1 }).toFormat("MM/dd")}`;

  // Group by weekday in ET
  const byDay = Array.from({ length: 7 }, () => []);
  for (const r of reservations) {
    const dtET = DateTime.fromSeconds(r.start_utc, { zone: "utc" }).setZone(TZ);
    // Luxon weekday: Mon=1..Sun=7 → index 0..6
    const idx = dtET.weekday - 1;
    byDay[idx].push({ ...r, dtET });
  }

  // Sort each day by start time
  for (const dayList of byDay) {
    dayList.sort((a, b) => a.start_utc - b.start_utc);
  }

  let desc = "";
  desc += `**${header}**\n`;
  desc += `All events reserved in this embed take priority over events hosted at an immediate moment or events that conflict after a spot was reserved.\n`;
  desc += `If you would like to reserve an event for longer than 1 hour, please input the time in minutes under the optional duration field. Events reserved up to 4 weeks ahead are displayed below.\n`;
  desc += `The schedule is automatically refreshed every Monday.\n`;
  desc += `\n**RESERVATION FORMAT**\n`;
  desc += `ID\nDIVISION, HOST\nEVENT NAME/TYPE\nTIME\n`;

  for (let i = 0; i < 7; i++) {
    desc += `\n**${weekdayName(i)} --------------------------------------**\n`;
    if (byDay[i].length === 0) {
      desc += `No events reserved for this date.\n`;
      continue;
    }

    for (const r of byDay[i]) {
      desc += `ID: ${r.id}\n`;
      desc += `${r.division}, ${r.host_display}\n`;
      desc += `${r.title}\n`;

      const start = r.start_utc;
      const end = r.start_utc + r.duration_min * 60;
      desc += `<t:${start}:F> – <t:${end}:t>\n`;

    }
  }
  // Upcoming reservations (next N weeks)
  desc += `\n**UPCOMING --------------------------------------**\n`;
  if (!upcoming || upcoming.length === 0) {
    desc += `No upcoming reservations.\n`;
  } else {
    for (const r of upcoming) {
      const dtET = DateTime.fromSeconds(r.start_utc, { zone: "utc" }).setZone(TZ);
      const weekOf = dtET.minus({ days: dtET.weekday - 1 }).toFormat("MM/dd");
      desc += `ID: ${r.id}\nWeek of ${weekOf} - ${r.division}, ${r.host_display}\n`;
      desc += `${r.title}\n`;

      const start = r.start_utc;
      const end = r.start_utc + r.duration_min * 60;
      desc += `<t:${start}:F> – <t:${end}:t>\n`;
    }
  }

  return new EmbedBuilder()
    .setTitle("NOOBIC STRATOCRACY LEADERSHIP ASSEMBLAGE")
    .setColor(0x6E1919)
    .setDescription(desc)
    .setFooter({ text: "Use /reserve to book. Use /cancel to remove. Times shown in your local Discord timezone." });
}

module.exports = { buildScheduleEmbed };
