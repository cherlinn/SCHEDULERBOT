// features/inactivity/commands.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits
} = require("discord.js");
const { DateTime } = require("luxon");
const inactivityDb = require("./db");
const deathRowDb = require("../deathrow/db");

const BOT_MANAGER_ID = (process.env.BOT_MANAGER_ID || "").trim();
const DEVELOPERS_LIST = (process.env.DEVELOPERS_LIST || "")
  .split(",")
  .map(id => id.trim())
  .filter(Boolean);

const ITEMS_PER_PAGE = 5;
const PAGINATION_PREFIX = "inactivity_page";
const INACTIVITY_CUTOFF_ZONE = "UTC";
const INACTIVITY_CUTOFF_HOUR = 12;

function parseDate(dateString) {
  if (!dateString) return null;
  const parsed = DateTime.fromFormat(dateString, "d/M/yyyy", { zone: INACTIVITY_CUTOFF_ZONE });
  if (!parsed.isValid) return null;

  return Math.floor(
    parsed
      .set({ hour: INACTIVITY_CUTOFF_HOUR, minute: 0, second: 0, millisecond: 0 })
      .toUTC()
      .toSeconds()
  );
}

function formatDate(unixTimestamp) {
  if (!unixTimestamp) return "Unknown";
  return `<t:${unixTimestamp}:F>`;
}

function toUserLabel(notice) {
  return `${notice.username} (<@${notice.user_id}>)`;
}

function extractDiscordUserId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  const mentionMatch = trimmed.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];
  if (/^\d{17,20}$/.test(trimmed)) return trimmed;
  return null;
}

function normalizeUsername(input) {
  return String(input || "").trim().toLowerCase();
}

function findNoticeByTarget(guildId, target) {
  const value = String(target || "").trim();
  if (!value) return null;

  const userId = extractDiscordUserId(value);
  if (userId) {
    return inactivityDb.getInactivityNotice(guildId, userId) || null;
  }

  const normalizedTarget = normalizeUsername(value);
  const notices = inactivityDb.getAllInactivityNotices(guildId);
  return notices.find(n => normalizeUsername(n.username) === normalizedTarget) || null;
}

function canManageOtherNotices(interaction) {
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  const isBotManager = BOT_MANAGER_ID && interaction.user.id === BOT_MANAGER_ID;
  const isDeveloper = DEVELOPERS_LIST.includes(interaction.user.id);
  return Boolean(isAdmin || isBotManager || isDeveloper);
}

function getNowUnix() {
  return Math.floor(Date.now() / 1000);
}

function isNoticeActiveAt(notice, unixNow) {
  const hasStarted = !notice.start_date || notice.start_date <= unixNow;
  const notEnded = !notice.end_date || notice.end_date > unixNow;
  return hasStarted && notEnded;
}

async function addLoaRoleToUser(guild, userId) {
  const settings = deathRowDb.getDeathRowSettings(guild.id) || {};
  const loaRoleId = settings.loa_role_id;
  if (!loaRoleId) return;

  try {
    const member = await guild.members.fetch(userId);
    if (!member.roles.cache.has(loaRoleId)) {
      await member.roles.add(loaRoleId, "[Inactivity] Notice created");
    }
  } catch (err) {
    console.error(`Failed to add LoA role for user ${userId} in guild ${guild.id}:`, err.message);
  }
}

async function removeLoaRoleFromUser(guild, userId) {
  const settings = deathRowDb.getDeathRowSettings(guild.id) || {};
  const loaRoleId = settings.loa_role_id;
  if (!loaRoleId) return;

  try {
    const member = await guild.members.fetch(userId);
    if (member.roles.cache.has(loaRoleId)) {
      await member.roles.remove(loaRoleId, "[Inactivity] Notice removed or expired");
    }
  } catch (err) {
    console.error(`Failed to remove LoA role for user ${userId} in guild ${guild.id}:`, err.message);
  }
}

async function expireNoticesForGuild(guild, client) {
  if (!guild) return 0;

  const nowUnix = getNowUnix();
  const expiredNotices = inactivityDb.getExpiredInactivityNotices(guild.id, nowUnix);
  if (expiredNotices.length === 0) return 0;

  inactivityDb.deleteExpiredInactivityNotices(guild.id, nowUnix);

  for (const notice of expiredNotices) {
    await removeLoaRoleFromUser(guild, notice.user_id);
  }

  const settings = deathRowDb.getDeathRowSettings(guild.id) || {};
  const noticeChannelId = settings.inactivity_notice_channel_id;
  if (!noticeChannelId) return expiredNotices.length;

  try {
    const channel = await client.channels.fetch(noticeChannelId);
    if (!channel?.isSendable?.()) return expiredNotices.length;

    const sections = expiredNotices.map(notice => {
      const lines = [toUserLabel(notice)];
      lines.push(`• Start: ${formatDate(notice.start_date)}`);
      lines.push(`• End: ${formatDate(notice.end_date)}`);
      lines.push(`• Reason: ${notice.reason}`);
      return lines.join("\n");
    });

    const MAX_DESC_LEN = 3800;
    const batches = [];
    let currentBatch = [];
    let currentLen = 0;

    for (const section of sections) {
      const separatorLen = currentBatch.length > 0 ? 2 : 0;
      const nextLen = currentLen + separatorLen + section.length;
      if (nextLen > MAX_DESC_LEN && currentBatch.length > 0) {
        batches.push(currentBatch.join("\n\n"));
        currentBatch = [section];
        currentLen = section.length;
      } else {
        currentBatch.push(section);
        currentLen = nextLen;
      }
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch.join("\n\n"));
    }

    for (let i = 0; i < batches.length; i++) {
      const isMulti = batches.length > 1;
      const embed = new EmbedBuilder()
        .setColor(0x2e8b57)
        .setTitle(isMulti ? `⏰  Inactivity Notices Ended (${i + 1}/${batches.length})` : "⏰  Inactivity Notices Ended")
        .setDescription(batches[i])
        .setFooter({ text: `Total ended: ${expiredNotices.length}` });

      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error(`Failed to send inactivity expiry notifications for guild ${guild.id}:`, err.message);
  }

  return expiredNotices.length;
}

async function grantLoaRolesForActiveNotices(guild) {
  if (!guild) return 0;

  const nowUnix = getNowUnix();
  const notices = inactivityDb.getAllInactivityNotices(guild.id);
  const activeNotices = notices.filter(notice => isNoticeActiveAt(notice, nowUnix));

  for (const notice of activeNotices) {
    await addLoaRoleToUser(guild, notice.user_id);
  }

  return activeNotices.length;
}

async function processInactivityExpirations(client) {
  const guildIds = inactivityDb.getGuildIdsWithInactivityNotices();
  for (const guildId of guildIds) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    await expireNoticesForGuild(guild, client);
    await grantLoaRolesForActiveNotices(guild);
  }
}

function createPaginationRow(page, totalPages) {
  const firstDisabled = page <= 1;
  const lastDisabled = page >= totalPages;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PAGINATION_PREFIX}:first:${page}`)
      .setEmoji("⏮️")
      .setLabel("First")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(firstDisabled),
    new ButtonBuilder()
      .setCustomId(`${PAGINATION_PREFIX}:previous:${page}`)
      .setEmoji("⬅️")
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(firstDisabled),
    new ButtonBuilder()
      .setCustomId(`${PAGINATION_PREFIX}:next:${page}`)
      .setEmoji("➡️")
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(lastDisabled),
    new ButtonBuilder()
      .setCustomId(`${PAGINATION_PREFIX}:last:${page}`)
      .setEmoji("⏭️")
      .setLabel("Last")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(lastDisabled)
  );
}

function buildNoticesPage(guildId, requestedPage = 1) {
  const allNotices = inactivityDb.getAllInactivityNotices(guildId);

  if (allNotices.length === 0) {
    const emptyEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📋 Inactivity Notices (0)")
      .setDescription("No active inactivity notices.")
      .setFooter({ text: "Page 1 of 1" });

    return {
      embeds: [emptyEmbed],
      components: [createPaginationRow(1, 1)]
    };
  }

  const totalPages = Math.max(1, Math.ceil(allNotices.length / ITEMS_PER_PAGE));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const startIdx = (page - 1) * ITEMS_PER_PAGE;
  const pageNotices = allNotices.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  const noticeLines = pageNotices.map(notice => {
    const parts = [toUserLabel(notice)];
    parts.push(`• Start: ${formatDate(notice.start_date)}`);
    if (notice.end_date) parts.push(`• End: ${formatDate(notice.end_date)}`);
    parts.push(`• Reason: ${notice.reason}`);
    return parts.join("\n");
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📋 Inactivity Notices (${allNotices.length})`)
    .setDescription(noticeLines.join("\n\n"))
    .setFooter({ text: `Page ${page} of ${totalPages}` });

  return {
    embeds: [embed],
    components: [createPaginationRow(page, totalPages)]
  };
}

const commands = [
  new SlashCommandBuilder()
    .setName("inactivity_notice")
    .setDescription("Record an inactivity notice")
    .addStringOption(o => o.setName("username").setDescription("Roblox username").setRequired(true))
    .addStringOption(o => o.setName("start_date").setDescription("Start date (DD/MM/YYYY)").setRequired(true))
    .addStringOption(o => o.setName("end_date").setDescription("End date (DD/MM/YYYY)").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason for inactivity").setRequired(false)),

  new SlashCommandBuilder()
    .setName("show_inactivity_notices")
    .setDescription("Show active inactivity notices")
    .addStringOption(o => o.setName("query").setDescription("Roblox username, @mention, or Discord user ID").setRequired(false)),

  new SlashCommandBuilder()
    .setName("remove_inactivity")
    .setDescription("Remove an inactivity notice")
    .addStringOption(o => o.setName("query").setDescription("Roblox username, @mention, or Discord user ID").setRequired(true))
];

async function handleInactivityCommand(interaction) {
  const { commandName, guild, user, client } = interaction;

  if (commandName !== "inactivity_notice" && commandName !== "show_inactivity_notices" && commandName !== "remove_inactivity") {
    return false;
  }

  await interaction.deferReply();

  await expireNoticesForGuild(guild, client);
  await grantLoaRolesForActiveNotices(guild);

  if (commandName === "inactivity_notice") {
    const username = interaction.options.getString("username");
    const reason = interaction.options.getString("reason") || "No reason provided.";
    const startDateStr = interaction.options.getString("start_date");
    const endDateStr = interaction.options.getString("end_date");

    const existing = inactivityDb.getInactivityNotice(guild.id, user.id)
      || inactivityDb.getInactivityNoticeByUsername(guild.id, username);
    if (existing) {
      return await interaction.editReply({
        content: "❌ You already have an active inactivity notice. Remove it first."
      });
    }

    const startDate = parseDate(startDateStr);
    const endDate = parseDate(endDateStr);

    if (startDateStr && !startDate) {
      return await interaction.editReply({ content: "❌ Invalid `start_date`. Use DD/MM/YYYY." });
    }
    if (endDateStr && !endDate) {
      return await interaction.editReply({ content: "❌ Invalid `end_date`. Use DD/MM/YYYY." });
    }

    inactivityDb.createInactivityNotice({
      guild_id: guild.id,
      user_id: user.id,
      username,
      reason,
      start_date: startDate,
      end_date: endDate
    });

    if (startDate <= getNowUnix()) {
      await addLoaRoleToUser(guild, user.id);
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("💤 Inactivity Notice Recorded")
      .addFields(
        { name: "User", value: `${username} (<@${user.id}>)`, inline: false },
        { name: "Start", value: formatDate(startDate), inline: true },
        { name: "End", value: formatDate(endDate), inline: true },
        { name: "Reason", value: reason, inline: false }
      );
    embed.setTimestamp();

    return await interaction.editReply({ embeds: [embed] });
  }

  if (commandName === "show_inactivity_notices") {
    const query = interaction.options.getString("query") || interaction.options.getString("username");
    if (query) {
      const notice = findNoticeByTarget(guild.id, query);
      if (!notice) {
        return await interaction.editReply({
          content: "❌ No inactivity notice found for that username, mention, or user ID."
        });
      }

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📋 Inactivity Notice")
        .setDescription([
          toUserLabel(notice),
          `• Start: ${formatDate(notice.start_date)}`,
          notice.end_date ? `• End: ${formatDate(notice.end_date)}` : null,
          `• Reason: ${notice.reason}`
        ].filter(Boolean).join("\n"));

      return await interaction.editReply({ embeds: [embed], components: [] });
    }

    return await interaction.editReply(buildNoticesPage(guild.id, 1));
  }

  if (commandName === "remove_inactivity") {
    const query = interaction.options.getString("query") || interaction.options.getString("username");
    if (!query) {
      return await interaction.editReply({
        content: "❌ Please provide a Roblox username, @mention, or Discord user ID."
      });
    }

    const notice = findNoticeByTarget(guild.id, query);
    if (!notice) {
      return await interaction.editReply({
        content: "❌ No inactivity notice found for that username, mention, or user ID."
      });
    }

    const isOwnNotice = notice.user_id === user.id;
    if (!isOwnNotice && !canManageOtherNotices(interaction)) {
      return await interaction.editReply({
        content: "❌ You can only remove your own inactivity notice unless you are an admin or configured dev user."
      });
    }

    inactivityDb.deleteInactivityNotice(guild.id, notice.user_id);
    await removeLoaRoleFromUser(guild, notice.user_id);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("🗑️ Inactivity Notice Removed")
      .setDescription(`Inactivity notice for user <@${notice.user_id}> has been removed.`)
      .setTimestamp();

    return await interaction.editReply({ embeds: [embed] });
  }

  return false;
}

async function handleInactivityMemberLeave(member) {
  if (!member?.guild || !member?.id) return;

  const notice = inactivityDb.getInactivityNotice(member.guild.id, member.id);
  if (!notice) return;

  inactivityDb.deleteInactivityNotice(member.guild.id, member.id);
  console.log(`[Inactivity] Removed inactivity notice for departed member ${member.id} in guild ${member.guild.id}.`);
}

async function handleInactivityButton(interaction) {
  if (!interaction.isButton()) return false;
  if (!interaction.customId.startsWith(`${PAGINATION_PREFIX}:`)) return false;

  await interaction.deferUpdate();

  await expireNoticesForGuild(interaction.guild, interaction.client);
  await grantLoaRolesForActiveNotices(interaction.guild);

  const [, action, currentPageRaw] = interaction.customId.split(":");
  const currentPage = parseInt(currentPageRaw, 10) || 1;

  const allNotices = inactivityDb.getAllInactivityNotices(interaction.guild.id);
  const totalPages = Math.max(1, Math.ceil(allNotices.length / ITEMS_PER_PAGE));

  let targetPage = currentPage;
  if (action === "first") targetPage = 1;
  if (action === "previous") targetPage = Math.max(1, currentPage - 1);
  if (action === "next") targetPage = Math.min(totalPages, currentPage + 1);
  if (action === "last") targetPage = totalPages;

  await interaction.editReply(buildNoticesPage(interaction.guild.id, targetPage));
  return true;
}

module.exports = {
  commands,
  handleInactivityCommand,
  handleInactivityButton,
  processInactivityExpirations,
  handleInactivityMemberLeave
};
