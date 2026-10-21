// features/deathrow/commands.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");
const deathRowDb = require("./db");

const APPEAL_LINK = "https://discord.gg/kHBJyQGWqh";
const LEADERSHIP_ROLE_ID = "1437453267486638142";
const BOT_MANAGER_ID = (process.env.BOT_MANAGER_ID || "").trim();
const DEVELOPERS_LIST = (process.env.DEVELOPERS_LIST || "")
  .split(",")
  .map(id => id.trim())
  .filter(Boolean);
const CONFIG_PAGE_PREFIX = "deathrow_config_page";

function normalizeRoleId(input) {
  if (!input) return null;
  const match = input.match(/\d+/);
  return match ? match[0] : null;
}

function buildConfigPages(current) {
  const fields = [
    { name: "Death Row Channel", value: current?.death_row_channel_id ? `<#${current.death_row_channel_id}>` : "Not set", inline: false },
    { name: "Life Row Channel", value: current?.life_row_channel_id ? `<#${current.life_row_channel_id}>` : "Not set", inline: false },
    {
      name: "Ping Role",
      value: (current?.ping_role_id || current?.death_row_role_id || current?.life_row_role_id)
        ? `<@&${current.ping_role_id || current.death_row_role_id || current.life_row_role_id}>`
        : "Not set",
      inline: false
    },
    { name: "Action Log Channel", value: current?.action_log_channel_id ? `<#${current.action_log_channel_id}>` : "Not set", inline: false },
    { name: "Inactivity Notice Channel", value: current?.inactivity_notice_channel_id ? `<#${current.inactivity_notice_channel_id}>` : "Not set", inline: false },
    { name: "LoA Role", value: current?.loa_role_id ? `<@&${current.loa_role_id}>` : "Not set", inline: false }
  ];

  const pageSize = 5;
  const pages = [];
  for (let i = 0; i < fields.length; i += pageSize) {
    pages.push(fields.slice(i, i + pageSize));
  }

  return pages.map((pageFields, idx) => {
    return new EmbedBuilder()
      .setTitle("Current Bot Configs")
      .setColor(0x8b0000)
      .addFields(...pageFields)
      .setFooter({ text: `Page ${idx + 1} of ${pages.length}` });
  });
}

function buildConfigPaginationRow(page, totalPages) {
  const firstDisabled = page <= 1;
  const lastDisabled = page >= totalPages;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CONFIG_PAGE_PREFIX}:first:${page}`)
      .setEmoji("⏮️")
      .setLabel("First")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(firstDisabled),
    new ButtonBuilder()
      .setCustomId(`${CONFIG_PAGE_PREFIX}:previous:${page}`)
      .setEmoji("⬅️")
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(firstDisabled),
    new ButtonBuilder()
      .setCustomId(`${CONFIG_PAGE_PREFIX}:next:${page}`)
      .setEmoji("➡️")
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(lastDisabled),
    new ButtonBuilder()
      .setCustomId(`${CONFIG_PAGE_PREFIX}:last:${page}`)
      .setEmoji("⏭️")
      .setLabel("Last")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(lastDisabled)
  );
}

function getConfigPagePayload(current, requestedPage = 1) {
  const pages = buildConfigPages(current);
  const totalPages = pages.length;
  const page = Math.min(Math.max(1, requestedPage), totalPages);

  return {
    embeds: [pages[page - 1]],
    components: [buildConfigPaginationRow(page, totalPages)]
  };
}

const commands = [
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("[DEV] Configure channels and roles.")
    .addStringOption(o => o.setName("death_row_channel_id").setDescription("Death row log channel ID").setRequired(false))
    .addStringOption(o => o.setName("life_row_channel_id").setDescription("Life row log channel ID").setRequired(false))
    .addStringOption(o => o.setName("ping_role_id").setDescription("Role ID (or mention) to ping for death/life row logs").setRequired(false))
    .addStringOption(o => o.setName("action_log_channel_id").setDescription("Action log channel ID (for forwarding death/life row records)").setRequired(false))
    .addStringOption(o => o.setName("inactivity_notice_channel_id").setDescription("Channel ID for inactivity expiry notifications").setRequired(false))
    .addStringOption(o => o.setName("loa_role_id").setDescription("Role ID (or mention) for active inactivity notices").setRequired(false)),

  new SlashCommandBuilder()
    .setName("death_row")
    .setDescription("Ban a user from ALL servers the bot is also in.")
    .addStringOption(o => o.setName("user_id").setDescription("User ID to ban from all servers").setRequired(true))
    .addStringOption(o => o.setName("roblox_username").setDescription("Roblox username").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason for the ban").setRequired(true))
    .addBooleanOption(o => o.setName("appealable").setDescription("Whether this ban can be appealed or not").setRequired(false)),

  new SlashCommandBuilder()
    .setName("life_row")
    .setDescription("Unban a user from ALL servers the bot is also in.")
    .addStringOption(o => o.setName("user_id").setDescription("User ID to unban from all servers").setRequired(true))
    .addStringOption(o => o.setName("roblox_username").setDescription("Roblox username").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason for the unban").setRequired(true)),
];

async function checkNSLAPermissions(interaction, guild, user) {
  const TEST_MODE = process.env.TEST_MODE === "true";
  
  if (!TEST_MODE) {
    const member = await guild.members.fetch(user.id);
    const leadershipRole = guild.roles.cache.get(LEADERSHIP_ROLE_ID);
    
    if (!leadershipRole || !member.roles.highest || member.roles.highest.position < leadershipRole.position) {
      return { allowed: false, message: "You don't have the required role to use this command." };
    }
  }
  
  return { allowed: true };
}

async function fetchUserInfo(client, userId) {
  try {
    const user = await client.users.fetch(userId);
    return { user, userTag: user.tag };
  } catch (err) {
    console.warn(`Could not fetch user ${userId}:`, err.message);
    return { user: null, userTag: `Unknown User (${userId})` };
  }
}

function checkCommandChannel(interaction, commandName) {
  const TEST_MODE = process.env.TEST_MODE === "true";
  if (TEST_MODE) return { allowed: true };

  const settings = deathRowDb.getDeathRowSettings(interaction.guild.id);

  if (!settings) {
    return {
      allowed: false,
      message: "Death row system not configured! Use `/config` first."
    };
  }

  if (commandName === "death_row") {
    if (!settings.death_row_channel_id) {
      return {
        allowed: false,
        message: "Death row channel is not configured! Use `/config death_row_channel_id:<channel-id>`."
      };
    }

    if (interaction.channelId !== settings.death_row_channel_id) {
      return {
        allowed: false,
        message: `You may use this command in <#${settings.death_row_channel_id}> only.`
      };
    }
  }

  if (commandName === "life_row") {
    if (!settings.life_row_channel_id) {
      return {
        allowed: false,
        message: "Life row channel is not configured! Use `/config life_row_channel_id:<channel-id>`."
      };
    }

    if (interaction.channelId !== settings.life_row_channel_id) {
      return {
        allowed: false,
        message: `You may use this command in <#${settings.life_row_channel_id}> only.`
      };
    }
  }

  return { allowed: true };
}

function canUseConfigCommand(interaction) {
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  const isBotManager = BOT_MANAGER_ID && interaction.user.id === BOT_MANAGER_ID;
  const isDeveloper = DEVELOPERS_LIST.includes(interaction.user.id);
  return Boolean(isAdmin || isBotManager || isDeveloper);
}

async function handleDeathRowCommand(interaction) {
  const { commandName, guild, user, client } = interaction;

  if (commandName === "config") {
    await interaction.deferReply({ flags: 64 });

    if (!canUseConfigCommand(interaction)) {
      return await interaction.editReply({
        content: "You must be an admin or configured dev user to use this command."
      });
    }

    const settings = deathRowDb.getDeathRowSettings(guild.id) || {};
    const deathRowChannelId = interaction.options.getString("death_row_channel_id");
    const lifeRowChannelId = interaction.options.getString("life_row_channel_id");
    const pingRoleInput = interaction.options.getString("ping_role_id");
    const actionLogChannelId = interaction.options.getString("action_log_channel_id");
    const inactivityNoticeChannelId = interaction.options.getString("inactivity_notice_channel_id");
    const loaRoleInput = interaction.options.getString("loa_role_id");

    let pingRoleId = null;
    if (pingRoleInput !== null) {
      pingRoleId = normalizeRoleId(pingRoleInput);
      if (!pingRoleId) {
        return await interaction.editReply({
          content: "Invalid role format. Use a role ID or role mention like <@&1234567890>."
        });
      }
    }

    let loaRoleId = null;
    if (loaRoleInput !== null) {
      loaRoleId = normalizeRoleId(loaRoleInput);
      if (!loaRoleId) {
        return await interaction.editReply({
          content: "Invalid LoA role format. Use a role ID or role mention like <@&1234567890>."
        });
      }
    }

    const updates = {};
    if (deathRowChannelId !== null) updates.death_row_channel_id = deathRowChannelId;
    if (lifeRowChannelId !== null) updates.life_row_channel_id = lifeRowChannelId;
    if (pingRoleInput !== null) {
      updates.ping_role_id = pingRoleId;
      updates.death_row_role_id = pingRoleId;
      updates.life_row_role_id = pingRoleId;
    }
    if (actionLogChannelId !== null) updates.action_log_channel_id = actionLogChannelId;
    if (inactivityNoticeChannelId !== null) updates.inactivity_notice_channel_id = inactivityNoticeChannelId;
    if (loaRoleInput !== null) updates.loa_role_id = loaRoleId;

    if (Object.keys(updates).length === 0) {
      const current = deathRowDb.getDeathRowSettings(guild.id);
      return await interaction.editReply(getConfigPagePayload(current || {}, 1));
    }

    deathRowDb.upsertDeathRowSettings(guild.id, updates);

    const embed = new EmbedBuilder()
      .setTitle("Config Updated")
      .setColor(0x00ff00);

    if (deathRowChannelId) {
      embed.addFields({ name: "Death Row Channel", value: `<#${deathRowChannelId}>` });
    }
    if (lifeRowChannelId) {
      embed.addFields({ name: "Life Row Channel", value: `<#${lifeRowChannelId}>` });
    }
    if (pingRoleInput !== null) {
      embed.addFields({ name: "Ping Role", value: `<@&${pingRoleId}>` });
    }
    if (actionLogChannelId) {
      embed.addFields({ name: "Action Log Channel", value: `<#${actionLogChannelId}>` });
    }
    if (inactivityNoticeChannelId) {
      embed.addFields({ name: "Inactivity Notice Channel", value: `<#${inactivityNoticeChannelId}>` });
    }
    if (loaRoleInput !== null) {
      embed.addFields({ name: "LoA Role", value: loaRoleId ? `<@&${loaRoleId}>` : "Not set" });
    }

    return await interaction.editReply({ embeds: [embed] });
  }

  if (commandName === "death_row") {
    await interaction.deferReply();

    const permissionCheck = await checkNSLAPermissions(interaction, guild, user);
    if (!permissionCheck.allowed) {
      return await interaction.editReply({ content: permissionCheck.message });
    }

    const channelCheck = checkCommandChannel(interaction, commandName);
    if (!channelCheck.allowed) {
      return await interaction.editReply({ content: channelCheck.message });
    }

    const userId = interaction.options.getString("user_id");
    const reason = interaction.options.getString("reason");
    const robloxUsername = interaction.options.getString("roblox_username");
    const appealable = interaction.options.getBoolean("appealable") ?? true;

    if (!/^\d+$/.test(userId)) {
      return await interaction.editReply({
        content: "Invalid user ID format! User ID must be a number."
      });
    }

    const { user: targetUser, userTag } = await fetchUserInfo(client, userId);

    // Try to DM the user first
    let dmSent = false;
    if (targetUser) {
      try {
        const dmDescription = appealable
          ? `You were banned from the Noobic Stratocracy for reason: ${reason} | You may appeal your ban at: ${APPEAL_LINK}`
          : `You were banned from the Noobic Stratocracy for reason: ${reason} | This ban is not appealable.`;

        const dmEmbed = new EmbedBuilder()
          .setColor(0xff0000)
          .setDescription(dmDescription)

        await targetUser.send({ embeds: [dmEmbed] });
        dmSent = true;
      } catch (err) {
        console.error(`Failed to DM user ${userId}:`, err.message);
      }
    }

    // Ban the user from all servers
    const guilds = client.guilds.cache;
    let successCount = 0;
    let failCount = 0;
    const failedServers = [];

    for (const [guildId, targetGuild] of guilds) {
      try {
        await targetGuild.members.ban(userId, { 
          reason: `[Death Row] ${reason} | Executed by ${user.tag}` 
        });
        successCount++;
      } catch (err) {
        failCount++;
        failedServers.push(`${targetGuild.name} (${err.message})`);
        console.error(`Failed to ban ${userId} from guild ${guildId}:`, err.message);
      }
    }

    // Create database record
    const recordId = deathRowDb.createDeathRowRecord({
      target_user_id: userId,
      target_username: userTag,
      executor_user_id: user.id,
      executor_display: user.tag,
      reason: reason,
      servers_banned_count: successCount
    });

    const deathRowEmbed = new EmbedBuilder()
      .setColor(0x8b0000)
      .setTitle("⚖️ Death Row")
      .addFields(
        { name: "User ID", value: userId, inline: true },
        { name: "Roblox Username", value: robloxUsername, inline: true },
        { name: "Appealable", value: appealable ? "Yes" : "No", inline: true },
        { name: "Reason", value: reason },
        { name: "Servers Banned", value: `${successCount}/${guilds.size}`, inline: true },
        { name: "User Notified", value: dmSent ? "Yes" : "No", inline: true }
      )
      .setTimestamp();
      // .setImage('https://i.pinimg.com/originals/25/cb/2e/25cb2e8922b1ec72857c2bd229d3cb59.gif');

    if (failCount > 0) {
      let failSummary = failedServers.slice(0, 5).join("\n");
      if (failedServers.length > 5) {
        failSummary += `\n... and ${failedServers.length - 5} more`;
      }

      deathRowEmbed.addFields({
        name: `Failed Server Bans (${failCount})`,
        value: `\`\`\`\n${failSummary}\n\`\`\``,
        inline: false
      });
    }

    const currentSettings = deathRowDb.getDeathRowSettings(guild.id) || {};
    const pingRoleId = normalizeRoleId(
      currentSettings.ping_role_id || currentSettings.death_row_role_id || currentSettings.life_row_role_id
    );
    const pingContent = pingRoleId ? `<@&${pingRoleId}>` : undefined;

    await interaction.editReply({
      content: pingContent,
      embeds: [deathRowEmbed],
      allowedMentions: pingRoleId ? { roles: [pingRoleId] } : undefined
    });

    // Forward to action log channel if configured
    if (currentSettings.action_log_channel_id) {
      try {
        const logChannel = await client.channels.fetch(currentSettings.action_log_channel_id);
        if (logChannel?.isSendable?.()) {
          await logChannel.send({ embeds: [deathRowEmbed] });
        }
      } catch (err) {
        console.error(`Failed to forward death row to log channel:`, err.message);
      }
    }

    return true;
  }

  if (commandName === "life_row") {
    await interaction.deferReply();

    const permissionCheck = await checkNSLAPermissions(interaction, guild, user);
    if (!permissionCheck.allowed) {
      return await interaction.editReply({ content: permissionCheck.message });
    }

    const channelCheck = checkCommandChannel(interaction, commandName);
    if (!channelCheck.allowed) {
      return await interaction.editReply({ content: channelCheck.message });
    }

    const userId = interaction.options.getString("user_id");
    const reason = interaction.options.getString("reason");
    const robloxUsername = interaction.options.getString("roblox_username");

    if (!/^\d+$/.test(userId)) {
      return await interaction.editReply({
        content: "Invalid user ID format! User ID must be a number."
      });
    }

    const { user: targetUser, userTag } = await fetchUserInfo(client, userId);

    const guilds = client.guilds.cache;
    let successCount = 0;
    let failCount = 0;
    const failedServers = [];

    for (const [guildId, targetGuild] of guilds) {
      try {
        const bans = await targetGuild.bans.fetch();
        const isBanned = bans.has(userId);

        if (isBanned) {
          await targetGuild.members.unban(userId, `[Life Row] ${reason} | Executed by ${user.tag}`);
          successCount++;
        }
      } catch (err) {
        failCount++;
        failedServers.push(`${targetGuild.name} (${err.message})`);
        console.error(`Failed to unban ${userId} from guild ${guildId}:`, err.message);
      }
    }

    const lifeRowEmbed = new EmbedBuilder()
      .setColor(0x2e8b57)
      .setTitle("🕊️ Life Row")
      .addFields(
        { name: "User ID", value: userId, inline: true },
        { name: "Roblox Username", value: robloxUsername, inline: true },
        { name: "Unbanned From", value: `${successCount} server(s)`, inline: true },
        { name: "Reason", value: reason }
      )
      .setTimestamp();
      // .setImage('https://i.pinimg.com/originals/db/90/83/db9083da4247c63fb204632309cda679.gif');

    if (failCount > 0) {
      let failSummary = failedServers.slice(0, 5).join("\n");
      if (failedServers.length > 5) {
        failSummary += `\n... and ${failedServers.length - 5} more`;
      }

      lifeRowEmbed.addFields({
        name: `Failed Server Unbans (${failCount})`,
        value: `\`\`\`\n${failSummary}\n\`\`\``,
        inline: false
      });
    }

    const currentSettings = deathRowDb.getDeathRowSettings(guild.id) || {};
    const pingRoleId = normalizeRoleId(
      currentSettings.ping_role_id || currentSettings.death_row_role_id || currentSettings.life_row_role_id
    );
    const pingContent = pingRoleId ? `<@&${pingRoleId}>` : undefined;

    await interaction.editReply({
      content: pingContent,
      embeds: [lifeRowEmbed],
      allowedMentions: pingRoleId ? { roles: [pingRoleId] } : undefined
    });

    // Forward to action log channel if configured
    if (currentSettings.action_log_channel_id) {
      try {
        const logChannel = await client.channels.fetch(currentSettings.action_log_channel_id);
        if (logChannel?.isSendable?.()) {
          await logChannel.send({ embeds: [lifeRowEmbed] });
        }
      } catch (err) {
        console.error(`Failed to forward life row to log channel:`, err.message);
      }
    }

    return true;
  }

  return false;
}

async function handleDeathRowButton(interaction) {
  if (!interaction.isButton()) return false;
  if (!interaction.customId.startsWith(`${CONFIG_PAGE_PREFIX}:`)) return false;

  const [, action, currentPageRaw] = interaction.customId.split(":");
  const currentPage = parseInt(currentPageRaw, 10) || 1;
  const current = deathRowDb.getDeathRowSettings(interaction.guild.id) || {};
  const totalPages = Math.max(1, buildConfigPages(current).length);

  let targetPage = currentPage;
  if (action === "first") targetPage = 1;
  if (action === "previous") targetPage = Math.max(1, currentPage - 1);
  if (action === "next") targetPage = Math.min(totalPages, currentPage + 1);
  if (action === "last") targetPage = totalPages;

  await interaction.update(getConfigPagePayload(current, targetPage));
  return true;
}

module.exports = {
  commands,
  handleDeathRowCommand,
  handleDeathRowButton
};