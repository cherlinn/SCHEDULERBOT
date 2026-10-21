// features/reservations/commands.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const { DateTime } = require("luxon");
const { TZ, getWeekWindowET, toUnixUTC } = require("./time");
const { buildScheduleEmbed } = require("./render");
const reservationDb = require("./db");
const BOT_MANAGER_ID = (process.env.BOT_MANAGER_ID || "").trim();
const NSLA_GUILD_ID = (process.env.NSLA_GUILD_ID || "").trim();
const DEVELOPERS_LIST = (process.env.DEVELOPERS_LIST || "")
  .split(",")
  .map(id => id.trim())
  .filter(Boolean);

const RESERVATION_COMMANDS = new Set([
  "setboard",
  "schedule",
  "reserve",
  "edit",
  "list",
  "cancel"
]);

const MAX_DURATION_MINUTES = 480; // 8 hours
const MAX_TITLE_LENGTH = 100;
const MAX_DIVISION_LENGTH = 20;
const RESERVATION_TZ_ALIASES = {
  ET: "America/New_York",
  EST: "America/New_York",
  EDT: "America/New_York",
  CT: "America/Chicago",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  MT: "America/Denver",
  MST: "America/Denver",
  MDT: "America/Denver",
  PT: "America/Los_Angeles",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  GMT: "Etc/UTC"
};

async function updateBoard(guild) {
  const settings = reservationDb.getSettings(guild.id);
  if (!settings?.board_channel_id || !settings?.board_message_id) return;

  reservationDb.cleanupExpiredReservations(guild.id);

  const channel = await guild.channels.fetch(settings.board_channel_id);
  const msg = await channel.messages.fetch(settings.board_message_id);

  const { weekStart, weekEnd } = getWeekWindowET();
  const reservations = reservationDb.getReservationsForCurrentWeek(guild.id, weekStart, weekEnd);
  const upcoming = reservationDb.getFutureReservations(guild.id, weekEnd);
  const embed = buildScheduleEmbed(reservations, upcoming);

  await msg.edit({ embeds: [embed] });
}

function resolveReservationTimezone(timezoneInput) {
  if (!timezoneInput) return { valid: true, zone: TZ };

  const raw = String(timezoneInput).trim();
  if (!raw) return { valid: true, zone: TZ };

  const alias = RESERVATION_TZ_ALIASES[raw.toUpperCase()];
  const normalized = alias || raw.replace(/\s+/g, "_");
  const probe = DateTime.now().setZone(normalized);

  if (!probe.isValid) {
    return {
      valid: false,
      error: "❌ Invalid timezone. Use an IANA timezone like `America/New_York`, `Europe/London`, or `Asia/Manila`."
    };
  }

  return { valid: true, zone: normalized };
}

function parseDateTime(dateStr, timeStr, timezone = TZ) {
  const dateMatch = String(dateStr).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!dateMatch) {
    return {
      valid: false,
      error: "❌ Invalid date format.\n" +
             "Use `DD/MM/YYYY` (day first), e.g. `28/03/2026` or `28/3/2026`."
    };
  }

  const day = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const year = Number(dateMatch[3]);

  if (day < 1 || day > 31 || month < 1 || month > 12) {
    return {
      valid: false,
      error: "❌ Invalid date values. Day must be 1-31 and month must be 1-12."
    };
  }

  const normalizedDate = `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;

  const timeFormats = ["HH:mm", "h:mm a"];
  
  let dtLocal = null;
  
  for (const timeFmt of timeFormats) {
    const attempt = DateTime.fromFormat(
      `${normalizedDate} ${timeStr}`,
      `dd/MM/yyyy ${timeFmt}`,
      { zone: timezone }
    );
    if (attempt.isValid) {
      dtLocal = attempt;
      break;
    }
  }
  
  if (!dtLocal || !dtLocal.isValid) {
    return { 
      valid: false, 
      error: "❌ Couldn't parse that date/time.\n" +
             "**Date format:** `DD/MM/YYYY`\n" +
             "**Time formats:** `5:15 PM` (12hr) or `17:15` (24hr)"
    };
  }
  
  const nowUnix = Math.floor(Date.now() / 1000);
  const startUtcCheck = Math.floor(dtLocal.toUTC().toSeconds());
  if (startUtcCheck < nowUnix) {
    return { 
      valid: false, 
      error: "❌ You can't set a time in the past." 
    };
  }
  
  return { valid: true, dateTime: dtLocal };
}

function checkReservationPermission(reservation, userId, memberPermissions) {
  const isOwner = reservation.host_user_id === userId;
  const isAdmin = memberPermissions?.has(PermissionFlagsBits.Administrator);
  
  if (!isOwner && !isAdmin) {
    return { 
      allowed: false, 
      message: "❌ You can only edit/cancel your own reservation(s) unless you're an admin." 
    };
  }
  
  return { allowed: true };
}

function validateReservationInput(division, title, duration) {
  if (division.length > MAX_DIVISION_LENGTH) {
    return { valid: false, error: `❌ Division tag must be ${MAX_DIVISION_LENGTH} characters or less.` };
  }
  
  if (title.length === 0) {
    return { valid: false, error: "❌ Event title cannot be empty." };
  }
  
  if (title.length > MAX_TITLE_LENGTH) {
    return { valid: false, error: `❌ Event title must be ${MAX_TITLE_LENGTH} characters or less.` };
  }
  
  if (duration <= 0) {
    return { valid: false, error: "❌ Duration must be a positive number." };
  }
  
  if (duration > MAX_DURATION_MINUTES) {
    return { valid: false, error: `❌ Duration cannot exceed ${MAX_DURATION_MINUTES} minutes (${MAX_DURATION_MINUTES / 60} hours).` };
  }
  
  return { valid: true };
}

function canUseReservationAdminCommand(interaction) {
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  const isBotManager = BOT_MANAGER_ID && interaction.user.id === BOT_MANAGER_ID;
  const isDeveloper = DEVELOPERS_LIST.includes(interaction.user.id);
  return Boolean(isAdmin || isBotManager || isDeveloper);
}

const commands = [
  new SlashCommandBuilder()
    .setName("setboard")
    .setDescription("Create/set the schedule board message this bot will maintain."),

  new SlashCommandBuilder()
    .setName("schedule")
    .setDescription("Force rerender the current week's schedule board."),

  new SlashCommandBuilder()
    .setName("reserve")
    .setDescription("Reserve an event slot on the schedule.")
    .addStringOption(o => o.setName("division").setDescription("Division tag (e.g., 1NF, NAC)").setRequired(true))
    .addStringOption(o => o.setName("username").setDescription("Roblox username of host(s)").setRequired(true))
    .addStringOption(o => o.setName("title").setDescription("Event name").setRequired(true))
    .addStringOption(o => o.setName("date").setDescription("DD/MM/YYYY").setRequired(true))
    .addStringOption(o => o.setName("time").setDescription("HH:MM AM/PM or HH:MM (e.g., 5:15 PM or 17:15)").setRequired(true))
    .addStringOption(o => o.setName("timezone").setDescription("Timezone for your input (e.g., America/New_York, Asia/Manila, ETC)").setRequired(true))
    .addIntegerOption(o => o.setName("duration").setDescription("Minutes (default 60)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("edit")
    .setDescription("Edit an existing reservation.")
    .addIntegerOption(o => o.setName("id").setDescription("Reservation ID").setRequired(true))
    .addStringOption(o => o.setName("division").setDescription("New division tag").setRequired(false))
    .addStringOption(o => o.setName("username").setDescription("New Roblox username").setRequired(false))
    .addStringOption(o => o.setName("title").setDescription("New event name").setRequired(false))
    .addStringOption(o => o.setName("date").setDescription("New date (DD/MM/YYYY)").setRequired(false))
    .addStringOption(o => o.setName("time").setDescription("New time (12hr or 24hr)").setRequired(false))
    .addStringOption(o => o.setName("timezone").setDescription("Timezone for date/time input (e.g., America/New_York, Asia/Manila, ETC)").setRequired(false))
    .addIntegerOption(o => o.setName("duration").setDescription("New duration in minutes").setRequired(false)),

  new SlashCommandBuilder()
    .setName("list")
    .setDescription("List all your reservations."),

  new SlashCommandBuilder()
    .setName("cancel")
    .setDescription("Cancel a reservation by ID.")
    .addIntegerOption(o => o.setName("id").setDescription("Reservation ID").setRequired(true))
];

async function handleSetboard(interaction) {
  await interaction.deferReply({ flags: 64 });

  if (!canUseReservationAdminCommand(interaction)) {
    await interaction.editReply("❌ You must be an admin or configured dev user to use this command.");
    return;
  }

  const channel = interaction.channel;
  reservationDb.cleanupExpiredReservations(interaction.guild.id);
  const { weekStart, weekEnd } = getWeekWindowET();
  const reservations = reservationDb.getReservationsForCurrentWeek(interaction.guild.id, weekStart, weekEnd);
  const upcoming = reservationDb.getFutureReservations(interaction.guild.id, weekEnd);
  const embed = buildScheduleEmbed(reservations, upcoming);
  const msg = await channel.send({ embeds: [embed] });

  reservationDb.upsertSettings(interaction.guild.id, channel.id, msg.id);

  await interaction.editReply("✅ Schedule board set. I'll keep this message updated automatically.");
}

async function handleSchedule(interaction) {
  await interaction.deferReply({ flags: 64 });

  if (!canUseReservationAdminCommand(interaction)) {
    await interaction.editReply("❌ You must be an admin or configured dev user to use this command.");
    return;
  }

  await updateBoard(interaction.guild);
  await interaction.editReply("✅ Schedule board refreshed.");
}

async function handleReserve(interaction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild;
  const division = interaction.options.getString("division", true).trim();
  const title = interaction.options.getString("title", true).trim();
  const dateStr = interaction.options.getString("date", true).trim();
  const timeStr = interaction.options.getString("time", true).trim();
  const timezoneInput = interaction.options.getString("timezone")?.trim();
  const duration = interaction.options.getInteger("duration") ?? 60;

  const validation = validateReservationInput(division, title, duration);
  if (!validation.valid) {
    await interaction.editReply(validation.error);
    return;
  }

  reservationDb.cleanupExpiredReservations(guild.id);

  const timezoneResolution = resolveReservationTimezone(timezoneInput);
  if (!timezoneResolution.valid) {
    await interaction.editReply(timezoneResolution.error);
    return;
  }

  const parsedDateTime = parseDateTime(dateStr, timeStr, timezoneResolution.zone);
  if (!parsedDateTime.valid) {
    await interaction.editReply(parsedDateTime.error);
    return;
  }

  const startUtc = toUnixUTC(parsedDateTime.dateTime);
  const conflict = reservationDb.conflicts(guild.id, startUtc, duration);

  if (conflict) {
    const conflictStart = `<t:${conflict.start_utc}:F>`;
    await interaction.editReply(
      `❌ Your reservation conflicts with ID ${conflict.id}\n` +
      `${conflict.title} on ${conflictStart}`
    );
    return;
  }

  const hostDisplay = interaction.options.getString("username", true).trim();
  const id = reservationDb.insertReservation({
    guild_id: guild.id,
    division,
    host_user_id: interaction.user.id,
    host_display: hostDisplay,
    title,
    start_utc: startUtc,
    duration_min: duration,
    created_at: Math.floor(Date.now() / 1000)
  });

  await updateBoard(guild);

  await interaction.editReply(
    `Reserved event with ID **${id}** for <t:${startUtc}:F> (${duration} min).\n` +
    `Interpreted your input in timezone **${timezoneResolution.zone}**.\n` +
    `Use this ID to cancel or edit it later if needed.`
  );
}

async function handleCancel(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guild = interaction.guild;
  const id = interaction.options.getInteger("id", true);

  reservationDb.cleanupExpiredReservations(guild.id);

  const r = reservationDb.getReservationById(guild.id, id);
  if (!r) {
    await interaction.editReply("Reservation not found.");
    return;
  }

  const permCheck = checkReservationPermission(r, interaction.user.id, interaction.memberPermissions);
  if (!permCheck.allowed) {
    await interaction.editReply(permCheck.message);
    return;
  }

  reservationDb.deleteReservation(guild.id, id);
  await updateBoard(guild);

  await interaction.editReply(`✅ Canceled event reservation with ID **${id}**.`);
}

async function handleList(interaction) {
  await interaction.deferReply({ flags: 64 });

  reservationDb.cleanupExpiredReservations(interaction.guild.id);
  
  const reservations = reservationDb.getUserReservations(interaction.guild.id, interaction.user.id);
  
  if (reservations.length === 0) {
    const emptyEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📋 Your Reservations")
      .setDescription("You don't have any reservations.")
      .setFooter({ text: "Total: 0" })

    await interaction.editReply({ embeds: [emptyEmbed] });
    return;
  }

  const lines = reservations.map(r => {
    return [
      `**ID ${r.id} - ${r.title}**`,
      `• Division: ${r.division}`,
      `• Host: ${r.host_display}`,
      `• Start: <t:${r.start_utc}:F>`,
      `• Duration: ${r.duration_min} min`
    ].join("\n");
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("📋 Your Reservations")
    .setDescription(lines.join("\n\n"))
    .setFooter({ text: `Total: ${reservations.length}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleEdit(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guild = interaction.guild;
  const id = interaction.options.getInteger("id", true);

  reservationDb.cleanupExpiredReservations(guild.id);
  
  const r = reservationDb.getReservationById(guild.id, id);
  if (!r) {
    await interaction.editReply("Reservation not found.");
    return;
  }
  
  const permCheck = checkReservationPermission(r, interaction.user.id, interaction.memberPermissions);
  if (!permCheck.allowed) {
    await interaction.editReply(permCheck.message);
    return;
  }
  
  const updates = {};
  
  const division = interaction.options.getString("division");
  const username = interaction.options.getString("username");
  const title = interaction.options.getString("title");
  const dateStr = interaction.options.getString("date");
  const timeStr = interaction.options.getString("time");
  const timezoneInput = interaction.options.getString("timezone");
  const duration = interaction.options.getInteger("duration");
  
  if (division) updates.division = division.trim();
  if (username) updates.host_display = username.trim();
  if (title) updates.title = title.trim();
  if (duration) updates.duration_min = duration;
  
  // Validate the new values if provided
  const divisionToValidate = updates.division || r.division;
  const titleToValidate = updates.title || r.title;
  const durationToValidate = updates.duration_min || r.duration_min;
  
  const validation = validateReservationInput(divisionToValidate, titleToValidate, durationToValidate);
  if (!validation.valid) {
    await interaction.editReply(validation.error);
    return;
  }
  
  if (dateStr || timeStr || timezoneInput) {
    const timezoneResolution = resolveReservationTimezone(timezoneInput);
    if (!timezoneResolution.valid) {
      await interaction.editReply(timezoneResolution.error);
      return;
    }

    const baseDateTime = DateTime.fromSeconds(r.start_utc, { zone: "utc" }).setZone(timezoneResolution.zone);
    const finalDateStr = dateStr || baseDateTime.toFormat("dd/MM/yyyy");
    const finalTimeStr = timeStr || baseDateTime.toFormat("HH:mm");
    
    const parsedDateTime = parseDateTime(finalDateStr, finalTimeStr, timezoneResolution.zone);
    if (!parsedDateTime.valid) {
      await interaction.editReply(parsedDateTime.error);
      return;
    }
    
    const newStartUtc = toUnixUTC(parsedDateTime.dateTime);
    const newDuration = duration || r.duration_min;
    
    const conflict = reservationDb.conflicts(guild.id, newStartUtc, newDuration, id);
    
    if (conflict) {
      await interaction.editReply(
        `❌ The new time conflicts with ID ${conflict.id}\n` +
        `${conflict.title} on <t:${conflict.start_utc}:F>`
      );
      return;
    }
    
    updates.start_utc = newStartUtc;
  }
  
  if (Object.keys(updates).length === 0) {
    await interaction.editReply("You didn't provide any fields to update.");
    return;
  }
  
  const success = reservationDb.updateReservation(guild.id, id, updates);
  
  if (!success) {
    await interaction.editReply("Failed to update reservation.");
    return;
  }
  
  await updateBoard(guild);
  
  await interaction.editReply(`Updated reservation ID **${id}**.`);
}

async function handleReservationCommand(interaction) {
  const { commandName } = interaction;

  if (!RESERVATION_COMMANDS.has(commandName)) {
    return false;
  }

  if (!NSLA_GUILD_ID) {
    await interaction.reply({
      content:
        "NSLA guild is not configured yet. Ask an admin to set `NSLA_GUILD_ID` in the environment.",
      flags: 64
    });
    return true;
  }

  if (interaction.guild?.id !== NSLA_GUILD_ID) {
    await interaction.reply({
      content: "Reservation commands are only available in the NSLA server.",
      flags: 64
    });
    return true;
  }

  switch (commandName) {
    case "setboard":
      return handleSetboard(interaction);
    case "schedule":
      return handleSchedule(interaction);
    case "reserve":
      return handleReserve(interaction);
    case "cancel":
      return handleCancel(interaction);
    case "list":
      return handleList(interaction);
    case "edit":
      return handleEdit(interaction);
    default:
      return false;
  }
}

async function processReservationExpirations(client) {
  const guildIds = reservationDb.getGuildIdsWithReservations();
  for (const guildId of guildIds) {
    const result = reservationDb.cleanupExpiredReservations(guildId);
    if (!result.changes) continue;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    try {
      await updateBoard(guild);
    } catch (err) {
      console.error(`Failed to refresh reservation board after expiring old rows for guild ${guildId}:`, err);
    }
  }
}

module.exports = {
  commands,
  handleReservationCommand,
  updateBoard,
  processReservationExpirations
};