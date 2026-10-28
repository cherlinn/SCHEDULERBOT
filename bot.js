require('dotenv').config({ override: true });
const { Client, GatewayIntentBits, EmbedBuilder, ChannelType, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const cron = require('node-cron');
const db = require('./database');
const { notifyDepartmentOfOpenTasks, buildOpenTasksEmbed, buildPaginationRow } = require('./notifications');

console.log(
  `[Boot] cwd=${process.cwd()} envTokenPresent=${Boolean(process.env.DISCORD_TOKEN)} GUILD_ID=${process.env.GUILD_ID || 'none'} DEV_GUILD_ID=${process.env.DEV_GUILD_ID || 'none'}`
);

const DEV_GUILD_ID = process.env.DEV_GUILD_ID;
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID;
const BOT_MANAGER_ID = process.env.BOT_MANAGER_ID;
const LEADERSHIP_ROLE_ID = process.env.LEADERSHIP_ROLE_ID || null;
const CONTRIBUTOR_ROLE_ID = '1415128027712454819';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// Bot startup
client.once('clientReady', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  
  await db.initializeDatabase();
  console.log('✅ Database initialized');

  await deploySlashCommands();
  
  client.user.setActivity('discord.gg/noobia', { type: 0 });

  if (DEV_GUILD_ID && STATUS_CHANNEL_ID) {
    try {
      const guild = await client.guilds.fetch(DEV_GUILD_ID);
      const channel = await guild.channels.fetch(STATUS_CHANNEL_ID);
      if (channel && channel.isTextBased()) {
        await channel.send('────────────────────────\nService now online.');
        console.log('Status message sent to channel.');
      }
    } catch (err) {
      console.error('Failed to send status message:', err);
    }
  }
  
  // Every minute: cheap local check. Only talks to Discord when a notification is actually due.
  cron.schedule('* * * * *', () => runExclusive('notify', checkAndNotifyOpenTasks));

  // Every 10 minutes: re-sync thread data from Discord and send inactivity reminders.
  cron.schedule('*/10 * * * *', () => runExclusive('sync', syncThreadsAndRemind));

  // Catch up on anything that changed while the bot was offline (includes the last-message check).
  runExclusive('sync', () => syncThreadsAndRemind({ syncActivity: true }));

  cron.schedule('5 0 1 * *', async () => {
    await archiveMonthlyPoints();
  });
});

client.on('threadCreate', async (thread) => {
  try {
    const category = thread.parent?.parent;
    if (!category) return;
    
    const parentChannel = thread.parent;
    const openTagId = parentChannel?.availableTags?.find(t => t.name.toLowerCase() === 'open')?.id;
    const claimedTagId = parentChannel?.availableTags?.find(t => t.name.toLowerCase() === 'claimed')?.id;
    
    const hasOpenTag = openTagId ? (thread.appliedTags?.includes(openTagId) || false) : false;
    const hasClaimedTag = claimedTagId ? (thread.appliedTags?.includes(claimedTagId) || false) : false;
    
    if (hasOpenTag) {
      await db.updateThread(
        thread.id,
        thread.parentId,
        category.id,
        thread.name,
        'Open'
      );
    } else if (hasClaimedTag) {
      await db.updateThread(
        thread.id,
        thread.parentId,
        category.id,
        thread.name,
        'Claimed'
      );
      await db.setInitialThreadActivity(thread.id);
    }
  } catch (error) {
    console.error('Error in threadCreate event:', error);
  }
});

client.on('threadUpdate', async (oldThread, newThread) => {
  try {
    const category = newThread.parent?.parent;
    if (!category) return;
    
    const parentChannel = newThread.parent;
    const openTagId = parentChannel?.availableTags?.find(t => t.name.toLowerCase() === 'open')?.id;
    const claimedTagId = parentChannel?.availableTags?.find(t => t.name.toLowerCase() === 'claimed')?.id;
    
    const hadOpenTag = openTagId ? (oldThread.appliedTags?.includes(openTagId) || false) : false;
    const hadClaimedTag = claimedTagId ? (oldThread.appliedTags?.includes(claimedTagId) || false) : false;
    const hasOpenTag = openTagId ? (newThread.appliedTags?.includes(openTagId) || false) : false;
    const hasClaimedTag = claimedTagId ? (newThread.appliedTags?.includes(claimedTagId) || false) : false;
    
    if (!hadOpenTag && hasOpenTag) {
      await db.updateThread(
        newThread.id,
        newThread.parentId,
        category.id,
        newThread.name,
        'Open'
      );
    }
    
    if (hasClaimedTag) {
      await db.updateThread(
        newThread.id,
        newThread.parentId,
        category.id,
        newThread.name,
        'Claimed'
      );
      await db.setInitialThreadActivity(newThread.id);
    } else if (hadClaimedTag && !hasClaimedTag) {
      await db.updateThread(
        newThread.id,
        newThread.parentId,
        category.id,
        newThread.name,
        'Completed'
      );
    }
  } catch (error) {
    console.error('Error in threadUpdate event:', error);
  }
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    
    if (message.channel.isThread()) {
      await db.updateThreadActivity(message.channel.id);
    }
  } catch (error) {
    console.error('Error in messageCreate event:', error);
  }
});

function isAdmin(interaction) {
  return interaction.user.id === BOT_MANAGER_ID || interaction.member?.permissions.has('Administrator') || interaction.member?.roles.cache.some(role => role.name === 'Admin');
}

function hasLeadershipAccess(interaction) {
  if (isAdmin(interaction)) return true;

  return LEADERSHIP_ROLE_ID ? interaction.member?.roles.cache.has(LEADERSHIP_ROLE_ID) || false : false;
}

function hasContributorAccess(interaction) {
  if (isAdmin(interaction)) return true;

  const contributorRole = interaction.guild?.roles.cache.get(CONTRIBUTOR_ROLE_ID);
  return Boolean(contributorRole && interaction.member?.roles.highest.position >= contributorRole.position);
}

function getThreadDepartmentId(interaction) {
  if (!interaction.channel?.isThread?.()) return null;
  return interaction.channel.parent?.parent?.id || interaction.channel.parent?.parentId || null;
}

async function resolveDepartmentFromIdentifier(identifier) {
  if (!identifier) return null;

  const departments = await db.getAllDepartments();
  const normalized = identifier.trim().toLowerCase();

  return departments.find((department) => {
    return department.category_id === identifier || department.category_name.trim().toLowerCase() === normalized;
  }) || null;
}

function formatPointEntry(rank, row) {
  return `${rank}. <@${row.user_id}>: ${row.points} points`;
}

const LEADERBOARD_PAGE_SIZE = 10;
const leaderboardPaginationSessions = new Map();

function buildLeaderboardEmbed(title, rows, page, totalPages, rankOffset = 0, footerNote = null) {
  const embed = new EmbedBuilder()
    .setColor('#42b451')
    .setTitle(title)
    .setFooter({ text: footerNote ? `Page ${page}/${totalPages} • ${footerNote}` : `Page ${page}/${totalPages}` })
    .setTimestamp();

  if (rows.length === 0) {
    embed.setDescription('No points recorded yet.');
    return embed;
  }

  const description = rows
    .map((row, index) => formatPointEntry(rankOffset + index + 1, row))
    .join('\n');

  embed.setDescription(description);
  return embed;
}

function buildPointAdjustmentEmbed(actionVerb, totalPoints, recipientId, actorId, sign = '➕') {
  const embed = new EmbedBuilder().setColor(actionVerb === 'removed' ? '#d94a4a' : '#42b451');
  const preposition = actionVerb === 'removed' ? 'from' : 'to';
  embed.setDescription(`${sign}<@${actorId}>: ${actionVerb} **${totalPoints}** points ${preposition} <@${recipientId}>`);
  return embed;
}

const DISCORD_MESSAGE_LIMIT = 2000;
const TEXT_PAGE_CONTENT_LIMIT = 1850;
const PAGINATION_TTL_MS = 10 * 60 * 1000;
const textPaginationSessions = new Map();

function splitTextIntoPages(text, limit = TEXT_PAGE_CONTENT_LIMIT) {
  if (!text) return [''];
  if (text.length <= limit) return [text];

  const lines = text.split('\n');
  const pages = [];
  let current = '';

  for (const line of lines) {
    if (line.length > limit) {
      if (current.length > 0) {
        pages.push(current);
        current = '';
      }

      for (let i = 0; i < line.length; i += limit) {
        pages.push(line.slice(i, i + limit));
      }
      continue;
    }

    const candidate = current.length > 0 ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      pages.push(current);
      current = line;
    }
  }

  if (current.length > 0) pages.push(current);
  return pages;
}

function buildTextPaginationRow(sessionId, page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`text_page:first:${sessionId}:${page}`)
      .setLabel('<<')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`text_page:prev:${sessionId}:${page}`)
      .setLabel('<')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`text_page:next:${sessionId}:${page}`)
      .setLabel('>')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages),
    new ButtonBuilder()
      .setCustomId(`text_page:last:${sessionId}:${page}`)
      .setLabel('>>')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages)
  );
}

function buildTextPageContent(pageText, page, totalPages) {
  const footer = `\n\n(Page ${page}/${totalPages})`;
  const trimmedPageText = pageText.length + footer.length > DISCORD_MESSAGE_LIMIT
    ? pageText.slice(0, DISCORD_MESSAGE_LIMIT - footer.length)
    : pageText;
  return `${trimmedPageText}${footer}`;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function buildLeaderboardPaginationRow(sessionId, page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`leaderboard_page:first:${sessionId}:${page}`)
      .setLabel('⏮ First')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`leaderboard_page:prev:${sessionId}:${page}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`leaderboard_page:next:${sessionId}:${page}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
    new ButtonBuilder()
      .setCustomId(`leaderboard_page:last:${sessionId}:${page}`)
      .setLabel('⏭ Last')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages)
  );
}

function buildLeaderboardPages(title, rows, footerNote = null) {
  const chunks = chunkArray(rows, LEADERBOARD_PAGE_SIZE);
  if (chunks.length === 0) {
    return [buildLeaderboardEmbed(title, [], 1, 1, 0, footerNote)];
  }

  return chunks.map((chunk, index) => {
    const page = index + 1;
    return buildLeaderboardEmbed(title, chunk, page, chunks.length, index * LEADERBOARD_PAGE_SIZE, footerNote);
  });
}

function buildDepartmentLeaderboardPages(scope, departmentName, rows, footerNote = null) {
  const scopeLabel = scope === 'all_time' ? 'All-time' : 'Monthly';
  return buildLeaderboardPages(`📊 ${departmentName} ${scopeLabel} Leaderboard`, rows, footerNote);
}

function buildAllDepartmentLeaderboardPages(scope, departmentRows) {
  const scopeLabel = scope === 'all_time' ? 'All-time' : 'Monthly';
  const grouped = new Map();

  for (const row of departmentRows) {
    if (!grouped.has(row.department_id)) {
      grouped.set(row.department_id, {
        name: row.department_name,
        rows: []
      });
    }

    grouped.get(row.department_id).rows.push(row);
  }

  const departments = Array.from(grouped.values());
  const pages = [];

  departments.forEach((group, index) => {
    const footerNote = index < departments.length - 1 ? 'More departments on next page...' : null;
    pages.push(...buildDepartmentLeaderboardPages(scope, group.name, group.rows, footerNote));
  });

  return pages;
}

async function applyPointAdjustment(interaction, actionType) {
  const recipient = interaction.options.getUser('user', true);
  const totalPoints = interaction.options.getInteger('points', true);
  if (totalPoints == null) {
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor('#d94a4a')
        .setDescription('Missing points value.')
      ]
    });
    return;
  }

  const departmentIdentifier = interaction.options.getString('department', true);

  const explicitDepartment = await resolveDepartmentFromIdentifier(departmentIdentifier);
  const threadDepartmentId = getThreadDepartmentId(interaction);
  const departmentId = explicitDepartment?.category_id || threadDepartmentId || null;
  const department = departmentId ? await db.getDepartment(departmentId) : explicitDepartment;
  const departmentName = department?.category_name || departmentIdentifier || interaction.channel?.parent?.name || 'Unassigned';
  const recipientDisplayName = interaction.guild?.members.cache.get(recipient.id)?.displayName || recipient.displayName || recipient.username;
  const awardedByName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
  const multiplier = actionType === 'remove' ? -1 : 1;
  const actionWord = actionType === 'remove' ? 'removed' : 'added';
  const logAction = actionType === 'remove' ? 'Remove Points' : 'Add Points';
  const sign = actionType === 'remove' ? '➖' : '➕';

  const currentBalance = await db.getPointBalance(recipient.id, departmentId);
  if (actionType === 'remove' && totalPoints > currentBalance.points) {
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor('#d94a4a')
        .setDescription(`➖<@${interaction.user.id}>: cannot remove **${totalPoints}** points from <@${recipient.id}> because they only have **${currentBalance.points}** points in **${departmentName}**`)
      ]
    });
    return;
  }

  const signedPoints = totalPoints * multiplier;

  await db.recordPointAward({
    userId: recipient.id,
    userDisplayName: recipientDisplayName,
    awardedById: interaction.user.id,
    awardedByName,
    points: signedPoints,
    departmentId,
    departmentName,
    note: null
  });

  await interaction.reply({
    embeds: [buildPointAdjustmentEmbed(actionWord, totalPoints, recipient.id, interaction.user.id, sign)]
  });

  await logAdminAction(
    client,
    logAction,
    `Recipient: <@${recipient.id}>\nTotal points: ${signedPoints}\nDepartment: ${departmentName}`,
    interaction.user
  );
}

async function replyWithLeaderboardPagination(interaction, pages) {
  const sessionId = Math.random().toString(36).slice(2, 10);
  const expiresAt = Date.now() + PAGINATION_TTL_MS;
  leaderboardPaginationSessions.set(sessionId, {
    userId: interaction.user.id,
    pages,
    expiresAt
  });

  setTimeout(() => {
    leaderboardPaginationSessions.delete(sessionId);
  }, PAGINATION_TTL_MS).unref?.();

  const page = 1;
  const totalPages = pages.length;
  const row = buildLeaderboardPaginationRow(sessionId, page, totalPages);

  await interaction.reply({
    embeds: [pages[0]],
    components: [row]
  });
}

async function replyWithPagination(interaction, content, options = {}) {
  const pages = splitTextIntoPages(content);
  const flags = options.flags ?? 0;

  if (pages.length <= 1) {
    await interaction.reply({ content: pages[0], flags });
    return;
  }

  const sessionId = Math.random().toString(36).slice(2, 10);
  const expiresAt = Date.now() + PAGINATION_TTL_MS;
  textPaginationSessions.set(sessionId, {
    userId: interaction.user.id,
    pages,
    flags,
    expiresAt
  });

  setTimeout(() => {
    textPaginationSessions.delete(sessionId);
  }, PAGINATION_TTL_MS).unref?.();

  const page = 1;
  const totalPages = pages.length;
  const row = buildTextPaginationRow(sessionId, page, totalPages);
  await interaction.reply({
    content: buildTextPageContent(pages[0], page, totalPages),
    components: [row],
    flags
  });
}

async function logAdminAction(client, action, details, user) {
  try {
    const logsChannelId = await db.getLogsChannel();
    if (!logsChannelId) return;
    
    const logsChannel = await client.channels.fetch(logsChannelId);
    if (!logsChannel) return;
    
    const embed = new EmbedBuilder()
      .setColor('#131313')
      .setTitle('📋 Admin Action Log')
      .addFields(
        { name: 'Action', value: action, inline: false },
        { name: 'Details', value: details, inline: false },
        { name: 'Performed by', value: `<@${user.id}>`, inline: true },
        { name: 'Timestamp', value: new Date().toLocaleString(), inline: true }
      );
    
    await logsChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error logging admin action:', error);
  }
}

// Command handler
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  
  const command = interaction.commandName;
  const contributorCommands = new Set(['leaderboard', 'dep_leaderboards']);
  const leadershipCommands = new Set(['add_points']);
  
  try {
    if (contributorCommands.has(command)) {
      if (!hasContributorAccess(interaction)) {
        await interaction.reply({
          content: 'You must be a contributor to use this command.',
          flags: 64
        });
        return;
      }
    } else if (leadershipCommands.has(command)) {
      if (!hasLeadershipAccess(interaction)) {
        await interaction.reply({
          content: 'You need leadership permissions to use this command.',
          flags: 64
        });
        return;
      }
    } else if (!isAdmin(interaction)) {
      await interaction.reply({
        content: 'You need administrator permissions to use this command.',
        flags: 64
      });
      return;
    }
    
    if (command === 'register_department') {
      const categoryId = interaction.options.getString('category_id');
      const categoryName = interaction.options.getString('department_name');
      const notificationChannel = interaction.options.getChannel('notification_channel');
      const notificationChannelId = notificationChannel.id;
      const role = interaction.options.getRole('role');
      const roleId = role?.id || null;
      
      await db.registerDepartment(categoryId, categoryName, notificationChannelId, roleId);
      
      await interaction.reply({
        content: `Department "${categoryName}" registered successfully!`,
        flags: 64
      });
      
      const roleText = roleId ? `<@&${roleId}> (${roleId})` : 'none';
      await logAdminAction(client, 'Register Department', `Department: ${categoryName}\nCategory ID: ${categoryId}\nNotification Channel: ${notificationChannel.name} (${notificationChannelId})\nRole: ${roleText}`, interaction.user);
    }
    
    else if (command === 'set_notification_interval') {
      const intervalMinutes = interaction.options.getInteger('interval_minutes');
      
      await db.setNotificationInterval(intervalMinutes);
      
      await interaction.reply({
        content: `Notification interval set to **${intervalMinutes} minutes** for all departments!`,
        flags: 64
      });
      
      await logAdminAction(client, 'Set Notification Interval', `Interval: ${intervalMinutes} minutes`, interaction.user);
    }
    
    else if (command === 'set_logs_channel') {
      const logsChannel = interaction.options.getChannel('channel');
      
      await db.setLogsChannel(logsChannel.id);
      
      await interaction.reply({
        content: `Logs channel set to ${logsChannel}!`,
        flags: 64
      });
      
      await logAdminAction(client, 'Set Logs Channel', `Logs Channel: ${logsChannel.name} (${logsChannel.id})`, interaction.user);
    }

    else if (command === 'force_notify') {
      await refreshOpenTasksFromForumTags();

      const departments = await db.getAllDepartments();
      let notified = 0;
      for (const dept of departments) {
        await notifyDepartmentOfOpenTasks(client, dept.category_id);
        notified++;
      }

      await db.updateLastNotificationTime();

      await interaction.reply({
        content: `Forced notification sent to ${notified} department(s).`,
        flags: 64
      });

      await logAdminAction(client, 'Force Notify', `Triggered immediate notifications for ${notified} department(s)`, interaction.user);
    }

    else if (command === 'unregister_department') {
      const categoryId = interaction.options.getString('category_id');
      await db.unregisterDepartment(categoryId);

      await interaction.reply({
        content: `Department with category ID ${categoryId} has been unregistered.`,
        flags: 64
      });

      await logAdminAction(client, 'Unregister Department', `Category ID: ${categoryId}`, interaction.user);
    }

    else if (command === 'force_inactivity_ping') {
      await refreshClaimedTasksFromForumTags();
      
      const inactiveThreads = await db.getInactiveClaimedThreads();
      let pinged = 0;
      
      for (const threadData of inactiveThreads) {
        try {
          const thread = await client.channels.fetch(threadData.thread_id);
          if (thread && thread.isThread()) {
            await thread.send('@here This task is claimed and has been inactive for 14 days. If able, please provide an update.');
            await db.updateThreadReminder(threadData.thread_id);
            pinged++;
          }
        } catch (err) {
          console.error(`Error sending reminder to thread ${threadData.thread_id}:`, err);
        }
      }

      await interaction.reply({
        content: `Pinged ${pinged} inactive claimed thread(s). Found ${inactiveThreads.length} total.`,
        flags: 64
      });

      await logAdminAction(client, 'Force Inactivity Ping', `Pinged ${pinged} inactive claimed thread(s)`, interaction.user);
    }
    
    else if (command === 'debug_status') {
      const interval = await db.getNotificationInterval();
      const logsChannelId = await db.getLogsChannel();
      const departments = await db.getAllDepartments();
      const lastNotificationTime = await db.getLastNotificationTime();

      let timeUntilNextNotification = 'unknown';
      if (lastNotificationTime) {
        const diffMinutes = (Date.now() - lastNotificationTime) / (1000 * 60);
        const minutesRemaining = Math.max(0, Math.ceil(interval - diffMinutes));
        if (minutesRemaining === 0) {
          timeUntilNextNotification = 'next minute';
        } else {
          timeUntilNextNotification = `${minutesRemaining} minute(s)`;
        }
      } else {
        timeUntilNextNotification = 'next minute (no history)';
      }

      const lines = [];
      for (const dept of departments) {
        const open = await db.getOpenThreadsByCategory(dept.category_id);
        const claimed = await db.getClaimedThreadsByCategory(dept.category_id);
        lines.push(`• ${dept.category_name} (cat ${dept.category_id}) — ${open.length} open, ${claimed.length} claimed`);
      }

      const summary = [
        `Bot Version: ${new Date().toISOString()}`,
        `Current Notification Interval: ${interval} minute(s)`,
        `Time until next task notification: ${timeUntilNextNotification}`,
        `Logs Channel: ${logsChannelId ? logsChannelId : 'not set'}`,
        `Departments: ${departments.length}`,
        ...lines
      ].join('\n');

      await replyWithPagination(interaction, `🛠️ Database Status\n${summary}`);
    }

    else if (command === 'restart') {
      await interaction.reply({
        content: '🔄 Restarting bot...',
        flags: 64
      });

      await logAdminAction(client, 'Restart Bot', `Initiated by <@${interaction.user.id}>`, interaction.user);

      if (DEV_GUILD_ID && STATUS_CHANNEL_ID) {
        try {
          const guild = await client.guilds.fetch(DEV_GUILD_ID);
          const channel = await guild.channels.fetch(STATUS_CHANNEL_ID);
          if (channel && channel.isTextBased()) {
            await channel.send(`────────────────────────\nRestarting service.\n\nRestart initiated by <@${interaction.user.id}>.`);
            console.log('Restart message sent to status channel.');
          }
        } catch (err) {
          console.error('Failed to send restart message:', err);
        }
      }

      setTimeout(() => process.exit(2), 500);
    }

    else if (command === 'shutdown') {
      await interaction.reply({
        content: '🛑 Shutting down bot...',
        flags: 64
      });

      await logAdminAction(client, 'Shutdown Bot', `Initiated by <@${interaction.user.id}>`, interaction.user);

      if (DEV_GUILD_ID && STATUS_CHANNEL_ID) {
        try {
          const guild = await client.guilds.fetch(DEV_GUILD_ID);
          const channel = await guild.channels.fetch(STATUS_CHANNEL_ID);
          if (channel && channel.isTextBased()) {
            await channel.send(`────────────────────────\nShutting down service.\n\nShutdown initiated by <@${interaction.user.id}>.`);
            console.log('Shutdown message sent to status channel.');
          }
        } catch (err) {
          console.error('Failed to send shutdown message:', err);
        }
      }

      setTimeout(() => process.exit(0), 500);
    }

    else if (command === 'list_claimed') {
      const departments = await db.getAllDepartments();
      const lines = [];

      for (const dept of departments) {
        const claimed = await db.getClaimedThreadsByCategory(dept.category_id);
        if (claimed.length > 0) {
          lines.push(`\n**${dept.category_name}** (${claimed.length} claimed):`);
          for (const thread of claimed) {
            const lastMsg = thread.last_message_timestamp ? new Date(thread.last_message_timestamp).toLocaleString() : 'Never';
            const lastReminder = thread.last_reminder_timestamp ? new Date(thread.last_reminder_timestamp).toLocaleString() : 'None';
            lines.push(`  • \`${thread.title}\` (Last msg: ${lastMsg}, Last reminder: ${lastReminder})`);
          }
        }
      }

      const content = lines.length > 0 
        ? `📋 **All Claimed Tasks**\n${lines.join('\n')}`
        : '📋 **All Claimed Tasks**\nNo claimed tasks at the moment.';

      await replyWithPagination(interaction, content, { flags: 0 });
    }

    else if (command === 'refresh_threads_now') {
      await interaction.reply({
        content: '🔄 Refreshing thread data from Discord...',
        flags: 64
      });

      try {
        const openOk = await refreshOpenTasksFromForumTags({ syncActivity: true });
        const claimedOk = await refreshClaimedTasksFromForumTags({ syncActivity: true });

        if (!openOk || !claimedOk) {
          await interaction.editReply({
            content: '⚠️ Refresh ran into errors talking to Discord. Check the bot logs and try again.'
          });
          return;
        }
        
        await interaction.editReply({
          content: 'Thread data refreshed successfully!'
        });

        await logAdminAction(client, 'Thread Refresh', `Initiated by <@${interaction.user.id}>`, interaction.user);

      } catch (error) {
        console.error('Error refreshing threads:', error);
        await interaction.editReply({
          content: `Error refreshing threads: ${error.message}`
        });
      }
    }

    else if (command === 'notification_preview') {
      const departments = await db.getAllDepartments();
      const lines = [];

      for (const dept of departments) {
        const open = await db.getOpenThreadsByCategory(dept.category_id);
        if (open.length > 0) {
          lines.push(`\n**${dept.category_name}** (${open.length} open):`);
          for (const thread of open) {
            lines.push(`  • \`${thread.title}\``);
          }
        }
      }

      const interval = await db.getNotificationInterval();
      const lastNotificationTime = await db.getLastNotificationTime();
      let timeUntilNext = 'Next minute (no history)';
      if (lastNotificationTime) {
        const diffMinutes = (Date.now() - lastNotificationTime) / (1000 * 60);
        const minutesRemaining = Math.max(0, Math.ceil(interval - diffMinutes));
        timeUntilNext = minutesRemaining === 0 ? 'Now' : `${minutesRemaining} minute(s)`;
      }

      const content = lines.length > 0 
        ? `📬 **Notification Preview**\n⏱️ Next notification in: ${timeUntilNext}\n${lines.join('\n')}`
        : `📬 **Notification Preview**\n⏱️ Next notification in: ${timeUntilNext}\n\nNo open tasks to notify about.`;

      await replyWithPagination(interaction, content, { flags: 64 });
    }

    else if (command === 'add_points') {
      await applyPointAdjustment(interaction, 'add');
    }

    else if (command === 'remove_points') {
      await applyPointAdjustment(interaction, 'remove');
    }

    else if (command === 'leaderboard') {
      const scope = interaction.options.getString('scope') || 'monthly';
      const rows = await db.getPointLeaderboard({ scope });
      const title = scope === 'all_time' ? '📈 All-time Point Leaderboard' : '📈 Monthly Point Leaderboard';
      const pages = rows.length > 0
        ? buildLeaderboardPages(title, rows)
        : [buildLeaderboardEmbed(
            title,
            [],
            1,
            1
          ).setDescription(scope === 'monthly'
            ? 'No points recorded yet this month. Try setting the scope to all-time.'
            : 'No points recorded yet.')];

      await replyWithLeaderboardPagination(interaction, pages);
    }

    else if (command === 'dep_leaderboards') {
      const scope = interaction.options.getString('scope') || 'monthly';
      const departmentIdentifier = interaction.options.getString('department');

      if (departmentIdentifier) {
        const department = await resolveDepartmentFromIdentifier(departmentIdentifier);
        if (!department) {
          console.error(`Could not find department with identifier: ${departmentIdentifier}`);
          await interaction.reply({
            content: 'Could not find that department. Use the department category ID or exact department name.',
            flags: 64
          });
          return;
        }

        const rows = await db.getPointLeaderboard({ scope, departmentId: department.category_id });
        const pages = rows.length > 0
          ? buildDepartmentLeaderboardPages(scope, department.category_name, rows)
          : [buildLeaderboardEmbed(
              `📊 ${department.category_name} ${scope === 'all_time' ? 'All-time' : 'Monthly'} Leaderboard`,
              [],
              1,
              1
            ).setDescription(scope === 'monthly'
              ? 'No points recorded yet this month. Try setting the scope to all-time.'
              : 'No points recorded yet.')];
        await replyWithLeaderboardPagination(interaction, pages);
        return;
      }

      const rows = await db.getDepartmentPointLeaderboard({ scope });
      if (rows.length === 0) {
        await interaction.reply({
          embeds: [buildLeaderboardEmbed('📊 Department Leaderboards', [], 1, 1)],
        });
        return;
      }

      const pages = buildAllDepartmentLeaderboardPages(scope, rows);
      await replyWithLeaderboardPagination(interaction, pages);
    }

  } catch (error) {
    console.error('Error handling interaction:', error);
    await interaction.reply({
      content: 'An error occurred! Please try again later.',
      flags: 64
    }).catch(() => {});
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    const id = interaction.customId || '';
    if (id.startsWith('open_tasks:')) {
      const [, action, categoryId, pageStr] = id.split(':');
      const currentPage = parseInt(pageStr || '1', 10) || 1;

      const openThreads = await db.getOpenThreadsByCategory(categoryId);
      const dept = await db.getDepartment(categoryId);
      const departmentName = dept?.category_name || 'department';
      if (!openThreads || openThreads.length === 0) {
        await interaction.update({ components: [], embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('📋 Open Tasks Available').setDescription('No open tasks found.').setTimestamp()] });
        return;
      }

      const { totalPages, page: newPage } = buildOpenTasksEmbed(openThreads, currentPage, interaction.guildId, departmentName);
      
      let pageNum = newPage;
      if (action === 'first') pageNum = 1;
      else if (action === 'prev') pageNum = Math.max(1, newPage - 1);
      else if (action === 'next') pageNum = Math.min(totalPages, newPage + 1);
      else if (action === 'last') pageNum = totalPages;

      const { embed: newEmbed } = buildOpenTasksEmbed(openThreads, pageNum, interaction.guildId, departmentName);
      const row = buildPaginationRow(pageNum, totalPages, categoryId);

      await interaction.update({ embeds: [newEmbed], components: [row] });
      return;
    }

    if (id.startsWith('text_page:')) {
      const [, action, sessionId, pageStr] = id.split(':');
      const session = textPaginationSessions.get(sessionId);

      if (!session || session.expiresAt < Date.now()) {
        textPaginationSessions.delete(sessionId);
        await interaction.reply({
          content: 'This pagination session expired. Please run the command again.',
          flags: 64
        }).catch(() => {});
        return;
      }

      if (session.userId !== interaction.user.id) {
        await interaction.reply({
          content: 'Only the command invoker can use these pagination buttons.',
          flags: 64
        }).catch(() => {});
        return;
      }

      const currentPage = parseInt(pageStr || '1', 10) || 1;
      const totalPages = session.pages.length;
      let pageNum = currentPage;

      if (action === 'first') pageNum = 1;
      else if (action === 'prev') pageNum = Math.max(1, currentPage - 1);
      else if (action === 'next') pageNum = Math.min(totalPages, currentPage + 1);
      else if (action === 'last') pageNum = totalPages;

      const row = buildTextPaginationRow(sessionId, pageNum, totalPages);
      await interaction.update({
        content: buildTextPageContent(session.pages[pageNum - 1], pageNum, totalPages),
        components: [row]
      });
      return;
    }

    if (id.startsWith('leaderboard_page:')) {
      const [, action, sessionId, pageStr] = id.split(':');
      const session = leaderboardPaginationSessions.get(sessionId);

      if (!session || session.expiresAt < Date.now()) {
        leaderboardPaginationSessions.delete(sessionId);
        await interaction.reply({
          content: 'This leaderboard session expired. Please run the command again.',
          flags: 64
        }).catch(() => {});
        return;
      }

      if (session.userId !== interaction.user.id) {
        await interaction.reply({
          content: 'Only the command invoker can use these leaderboard buttons.',
          flags: 64
        }).catch(() => {});
        return;
      }

      const currentPage = parseInt(pageStr || '1', 10) || 1;
      const totalPages = session.pages.length;
      let pageNum = currentPage;

      if (action === 'first') pageNum = 1;
      else if (action === 'prev') pageNum = Math.max(1, currentPage - 1);
      else if (action === 'next') pageNum = Math.min(totalPages, currentPage + 1);
      else if (action === 'last') pageNum = totalPages;

      const row = buildLeaderboardPaginationRow(sessionId, pageNum, totalPages);
      await interaction.update({
        embeds: [session.pages[pageNum - 1]],
        components: [row]
      });
      return;
    }

    return;
  } catch (error) {
    console.error('Error handling pagination button:', error);
  }
});

// Prevents a slow run from overlapping with the next tick of the same job.
// If a run hangs past the timeout, the lock is released so later runs aren't blocked forever.
const JOB_TIMEOUT_MS = 5 * 60 * 1000;
const runningJobs = new Map();
async function runExclusive(name, fn) {
  if (runningJobs.has(name)) return;

  const token = Symbol(name);
  runningJobs.set(name, token);

  const timer = setTimeout(() => {
    if (runningJobs.get(name) === token) {
      console.warn(`[Cron] Job "${name}" has been running for over ${JOB_TIMEOUT_MS / 1000}s. Releasing its lock so the next run can start.`);
      runningJobs.delete(name);
    }
  }, JOB_TIMEOUT_MS);

  try {
    await fn();
  } catch (error) {
    console.error(`[Cron] Job "${name}" failed:`, error);
  } finally {
    clearTimeout(timer);
    // Only release the lock if it still belongs to this run (a timed-out run must not free a newer one).
    if (runningJobs.get(name) === token) runningJobs.delete(name);
  }
}

async function checkAndNotifyOpenTasks() {
  try {
    const shouldNotify = await db.shouldNotify();
    if (!shouldNotify) return;

    // Refresh right before sending so the notification reflects the current forum state.
    // If Discord can't be reached, skip: nothing is marked as sent, so this retries next minute.
    const refreshed = await refreshOpenTasksFromForumTags();
    if (!refreshed) {
      console.warn('Skipping notification: could not refresh open tasks from Discord. Will retry next minute.');
      return;
    }

    const departments = await db.getAllDepartments();

    for (const dept of departments) {
      await notifyDepartmentOfOpenTasks(client, dept.category_id);
    }

    await db.updateLastNotificationTime();
  } catch (error) {
    console.error('Error in checkAndNotifyOpenTasks:', error);
  }
}

async function syncThreadsAndRemind({ syncActivity = false } = {}) {
  await refreshOpenTasksFromForumTags({ syncActivity });
  await checkInactiveClaimedThreads({ syncActivity });
}

async function checkInactiveClaimedThreads({ syncActivity = false } = {}) {
  try {
    const refreshed = await refreshClaimedTasksFromForumTags({ syncActivity });
    if (!refreshed) {
      console.warn('Skipping inactivity reminders: could not refresh claimed tasks from Discord.');
      return;
    }
    
    const inactiveThreads = await db.getInactiveClaimedThreads();
    
    for (const threadData of inactiveThreads) {
      try {
        const thread = await client.channels.fetch(threadData.thread_id);
        if (thread && thread.isThread()) {
          await thread.send('@here This task is claimed and has been inactive for 14 days. If able, please provide an update.');
          await db.updateThreadReminder(threadData.thread_id);
        }
      } catch (err) {
        console.error(`Error sending reminder to thread ${threadData.thread_id}:`, err);
      }
    }
  } catch (error) {
    console.error('Error in checkInactiveClaimedThreads:', error);
  }
}

async function archiveMonthlyPoints() {
  try {
    const archive = await db.archivePreviousMonthLeaderboard();
    const logsChannelId = await db.getLogsChannel();

    if (logsChannelId) {
      try {
        const channel = await client.channels.fetch(logsChannelId);
        if (channel && channel.isTextBased()) {
          const archiveEmbed = buildLeaderboardEmbed(
            `🗓️ Monthly Points Archive • ${archive.periodKey}`,
            archive.payload.monthly,
            1,
            1
          );

          archiveEmbed.setFooter({ text: 'Monthly leaderboard archived automatically' });

          await channel.send({
            embeds: [archiveEmbed],
            allowedMentions: { parse: [] }
          });
        }
      } catch (err) {
        console.error('Failed to send monthly points archive:', err);
      }
    }
  } catch (error) {
    console.error('Error archiving monthly points:', error);
  }
}

async function deploySlashCommands() {
  try {
    const appId = process.env.CLIENT_ID;
    const guildId = process.env.GUILD_ID;
    const devGuildId = process.env.DEV_GUILD_ID;
    const commands = require('./commands');
    const body = commands.map((cmd) => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    if (guildId) {
      try {
        console.log(`🚀 Deploying GUILD (/) commands to guild ${guildId}...`);
        await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
        console.log('✅ Guild commands deployed');
      } catch (error) {
        console.error(`Failed to deploy to guild ${guildId}:`, error.message);
      }
    }

    if (devGuildId && devGuildId !== guildId) {
      try {
        console.log(`🚀 Deploying DEV GUILD (/) commands to guild ${devGuildId}...`);
        await rest.put(Routes.applicationGuildCommands(appId, devGuildId), { body });
        console.log('✅ Dev guild commands deployed');
      } catch (error) {
        console.error(`Failed to deploy to dev guild ${devGuildId}:`, error.message);
      }
    }

    if (!guildId) {
      console.log('🚀 Deploying GLOBAL (/) commands...');
      await rest.put(Routes.applicationCommands(appId), { body });
      console.log('✅ Global commands deployed (may take up to 1 hour)');
    }
  } catch (error) {
    console.error('Error deploying slash commands:', error);
  }
}

async function refreshOpenTasksFromForumTags({ syncActivity = false } = {}) {
  try {
    const openThreadsInDb = await db.getOpenThreads();
    const openThreadIds = new Set(openThreadsInDb.map(t => t.thread_id));
    const processedThreadIds = new Set();

    for (const guild of client.guilds.cache.values()) {
      let active = null;
      const forumChannels = guild.channels.cache.filter((ch) => ch.type === ChannelType.GuildForum);
      for (const forum of forumChannels.values()) {
        const openTagId = forum.availableTags?.find((t) => t.name?.toLowerCase() === 'open')?.id;
        if (!openTagId) continue;

        if (!active) active = await guild.channels.fetchActiveThreads();
        for (const thread of active.threads.values()) {
          if (thread.parentId !== forum.id) continue;
          const hasOpen = thread.appliedTags?.includes(openTagId);
          const categoryId = forum.parent?.id || forum.parentId || guild.id;

          processedThreadIds.add(thread.id);

          if (hasOpen) {
            await db.updateThread(
              thread.id,
              thread.parentId,
              categoryId,
              thread.name,
              'Open'
            );
            
            try {
              const messages = syncActivity ? await thread.messages.fetch({ limit: 1 }) : null;
              if (messages && messages.size > 0) {
                const lastMsg = messages.first();
                const db_conn = await db.getDatabase();
                db_conn.run(
                  `UPDATE threads SET last_message_timestamp = ? WHERE thread_id = ?`,
                  [lastMsg.createdTimestamp, thread.id],
                  (err) => {
                    db_conn.close();
                  }
                );
              }
            } catch (err) {
            }
          } else if (openThreadIds.has(thread.id)) {
            await db.updateThreadStatus(thread.id, 'Completed');
          }
        }
      }
    }

    for (const threadId of openThreadIds) {
      if (!processedThreadIds.has(threadId)) {
        await db.updateThreadStatus(threadId, 'Completed');
      }
    }
    return true;
  } catch (error) {
    console.error('Error refreshing Open tasks from forum tags:', error);
    return false;
  }
}

async function refreshClaimedTasksFromForumTags({ syncActivity = false } = {}) {
  try {
    const claimedThreadsInDb = await db.getClaimedThreads();
    const claimedThreadIds = new Set(claimedThreadsInDb.map(t => t.thread_id));
    const processedThreadIds = new Set();
    
    for (const guild of client.guilds.cache.values()) {
      let active = null;
      const forumChannels = guild.channels.cache.filter((ch) => ch.type === ChannelType.GuildForum);
      for (const forum of forumChannels.values()) {
        const claimedTagId = forum.availableTags?.find((t) => t.name?.toLowerCase() === 'claimed')?.id;
        if (!claimedTagId) continue;

        if (!active) active = await guild.channels.fetchActiveThreads();
        for (const thread of active.threads.values()) {
          if (thread.parentId !== forum.id) continue;
          const hasClaimed = thread.appliedTags?.includes(claimedTagId);
          const categoryId = forum.parent?.id || forum.parentId || guild.id;
          
          processedThreadIds.add(thread.id);
          
          if (hasClaimed) {
            await db.updateThread(
              thread.id,
              thread.parentId,
              categoryId,
              thread.name,
              'Claimed'
            );
            await db.setInitialThreadActivity(thread.id);
            
            try {
              const messages = syncActivity ? await thread.messages.fetch({ limit: 1 }) : null;
              if (messages && messages.size > 0) {
                const lastMsg = messages.first();
                const db_conn = await db.getDatabase();
                db_conn.run(
                  `UPDATE threads SET last_message_timestamp = ? WHERE thread_id = ?`,
                  [lastMsg.createdTimestamp, thread.id],
                  (err) => {
                    db_conn.close();
                  }
                );
              }
            } catch (err) {
            }
          } else if (claimedThreadIds.has(thread.id)) {
            await db.updateThread(
              thread.id,
              thread.parentId,
              categoryId,
              thread.name,
              'Completed'
            );
          }
        }
      }
    }
    
    for (const threadId of claimedThreadIds) {
      if (!processedThreadIds.has(threadId)) {
        await db.updateThreadStatus(threadId, 'Completed');
      }
    }
    return true;
  } catch (error) {
    console.error('Error refreshing Claimed tasks from forum tags:', error);
    return false;
  }
}

const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const DEBUG_STARTUP = process.env.DEBUG_STARTUP === '1';
if (DEBUG_STARTUP) {
  const preview = DISCORD_TOKEN.length >= 10
    ? `${DISCORD_TOKEN.slice(0, 6)}...${DISCORD_TOKEN.slice(-4)} (len ${DISCORD_TOKEN.length})`
    : `(len ${DISCORD_TOKEN.length})`;
  console.log(`[Boot] tokenPreview=${preview}`);
}
if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is missing or empty. Check your .env or PM2 environment.');
  process.exit(1);
}
const tokenShape = /^[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{20,}$/;
if (!tokenShape.test(DISCORD_TOKEN)) {
  console.warn('[Boot] Warning: DISCORD_TOKEN format looks unusual for a Discord bot token.');
}
client.login(DISCORD_TOKEN);