// index.js
require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  ActivityType,
  SlashCommandBuilder,
  PermissionFlagsBits,
  REST,
  Routes
} = require("discord.js");
const { DateTime } = require("luxon");

// Feature modules
const reservationCommands = require("./features/reservations/commands");
const deathRowCommands = require("./features/deathrow/commands");
const inactivityCommands = require("./features/inactivity/commands");

const DEV_GUILD_ID = process.env.DEV_GUILD_ID;
const NSLA_GUILD_ID = (process.env.NSLA_GUILD_ID || "").trim();
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID;
const BOT_MANAGER_ID = process.env.BOT_MANAGER_ID;
const DEVELOPERS_LIST = process.env.DEVELOPERS_LIST
  ? process.env.DEVELOPERS_LIST.split(",").map(id => id.trim()).filter(Boolean)
  : [];

const systemCommands = [
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop the bot process."),
  new SlashCommandBuilder()
    .setName("start")
    .setDescription("Start the bot process."),
  new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restart the bot process.")
];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------- Weekly Refresh Scheduler ----------
function scheduleWeeklyRefresh() {
  const runRefresh = async () => {
    try {
      if (!NSLA_GUILD_ID) {
        console.warn("Skipping weekly schedule refresh because NSLA_GUILD_ID is not configured.");
        return;
      }

      const guild = client.guilds.cache.get(NSLA_GUILD_ID);
      if (!guild) {
        console.warn(`Skipping weekly schedule refresh because guild ${NSLA_GUILD_ID} is not in cache.`);
        return;
      }

      try {
        await reservationCommands.updateBoard(guild);
      } catch (err) {
        console.error(`Failed to refresh board for guild ${guild.id}:`, err);
      }
      console.log("✅ Weekly schedule refreshed.");
    } catch (err) {
      console.error("Error during weekly refresh:", err);
    }
  };

  const now = DateTime.utc();
  let daysUntilNextMon = (8 - now.weekday) % 7;
  if (daysUntilNextMon === 0) daysUntilNextMon = 7;
  const nextMon = now.plus({ days: daysUntilNextMon }).startOf("day");

  const delay = nextMon.toMillis() - now.toMillis();

  setTimeout(() => {
    runRefresh();
    setInterval(runRefresh, 7 * 24 * 60 * 60 * 1000);
  }, delay);

  console.log(`Scheduled weekly refresh at ${nextMon.toISO()} (UTC), in ${Math.round(delay/1000)}s`);
}

function scheduleDailyInactivityExpirationSweep() {
  const runSweep = async () => {
    try {
      await inactivityCommands.processInactivityExpirations(client);
    } catch (err) {
      console.error("Failed to process inactivity expirations:", err);
    }
  };

  const scheduleNext = () => {
    const nowUtc = DateTime.utc();
    let nextRunUtc = nowUtc.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });

    if (nowUtc >= nextRunUtc) {
      nextRunUtc = nextRunUtc.plus({ days: 1 });
    }

    const delay = Math.max(1000, Math.round(nextRunUtc.toMillis() - nowUtc.toMillis()));
    console.log(`Scheduled inactivity expiration sweep at ${nextRunUtc.toISO()} (UTC), in ${Math.round(delay / 1000)}s`);

    setTimeout(async () => {
      await runSweep();
      scheduleNext();
    }, delay);
  };

  scheduleNext();
}

function scheduleReservationExpirationSweep() {
  let sweepRunning = false;

  const runSweep = async () => {
    if (sweepRunning) return;
    sweepRunning = true;

    try {
      await reservationCommands.processReservationExpirations(client);
    } catch (err) {
      console.error("Failed to process reservation expirations:", err);
    } finally {
      sweepRunning = false;
    }
  };

  runSweep();
  setInterval(runSweep, 60 * 60 * 1000);
}

// ---------- Command Registration ----------
async function registerCommands() {
  const allCommands = [
    ...reservationCommands.commands.map(c => c.toJSON()),
    ...deathRowCommands.commands.map(c => c.toJSON()),
    ...inactivityCommands.commands.map(c => c.toJSON()),
    ...systemCommands.map(c => c.toJSON())
  ];

  if (!NSLA_GUILD_ID) {
    throw new Error("Missing NSLA_GUILD_ID in .env.");
  }

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, NSLA_GUILD_ID),
    { body: allCommands }
  );

  // Remove global commands so operational commands only appear in the configured NSLA guild.
  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: [] }
  );

  console.log(`✅ Slash commands registered for guild ${NSLA_GUILD_ID}.`);
  console.log("✅ Global slash commands cleared.");
}

function canUseControlCommand(interaction) {
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  const isBotManager = BOT_MANAGER_ID && interaction.user.id === BOT_MANAGER_ID;
  const isDeveloper = DEVELOPERS_LIST.includes(interaction.user.id);
  return Boolean(isAdmin || isBotManager || isDeveloper);
}

async function sendStatusMessage(message) {
  if (!DEV_GUILD_ID || !STATUS_CHANNEL_ID) return;

  try {
    const guild = await client.guilds.fetch(DEV_GUILD_ID);
    const channel = await guild.channels.fetch(STATUS_CHANNEL_ID);

    if (channel && channel.isTextBased()) {
      await channel.send(message);
    }
  } catch (err) {
    console.error("Failed to send status message:", err);
  }
}

async function handleSystemCommand(interaction) {
  if (!interaction.isChatInputCommand()) return false;

  const { commandName, user } = interaction;
  if (commandName !== "stop" && commandName !== "start" && commandName !== "restart") {
    return false;
  }

  await interaction.deferReply({ flags: 64 });

  if (!canUseControlCommand(interaction)) {
    await interaction.editReply({
      content: "You must be an admin or configured dev user to use this command."
    });
    return true;
  }

  if (commandName === "stop") {
    await interaction.editReply({ content: "🛑 Shutting down bot (clean exit)..." });
    await sendStatusMessage(`────────────────────────\nShutting down service.\n\nStop initiated by <@${user.id}>.`);
    setTimeout(() => process.exit(0), 500);
    return true;
  }

  if (commandName === "start") {
    await interaction.editReply({ content: "▶️ Starting bot..." });
    await sendStatusMessage(`────────────────────────\nStarting service.\n\nStart initiated by <@${user.id}>.`);
    setTimeout(() => process.exit(1), 500);
    return true;
  }

  if (commandName === "restart") {
    await interaction.editReply({ content: "🔄 Restarting bot..." });
    await sendStatusMessage(`────────────────────────\nRestarting service.\n\nRestart initiated by <@${user.id}>.`);
    setTimeout(() => process.exit(1), 500);
    return true;
  }

  return false;
}

// ---------- Interaction Handling ----------
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) {
      const deathRowButtonHandled = await deathRowCommands.handleDeathRowButton(interaction);
      if (deathRowButtonHandled) return;
      const inactivityButtonHandled = await inactivityCommands.handleInactivityButton(interaction);
      if (inactivityButtonHandled) return;
      return;
    }

    const systemHandled = await handleSystemCommand(interaction);
    if (systemHandled) return;

    if (!interaction.isChatInputCommand()) return;

    const guild = interaction.guild;
    if (!guild) return;

    const reservationHandled = await reservationCommands.handleReservationCommand(interaction);
    if (reservationHandled !== false) return;

    const deathRowHandled = await deathRowCommands.handleDeathRowCommand(interaction);
    if (deathRowHandled !== false) return;

    const inactivityHandled = await inactivityCommands.handleInactivityCommand(interaction);
    if (inactivityHandled !== false) return;

  } catch (err) {
    console.error(err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("❌ Something broke! Check bot logs.");
      } else if (interaction.isRepliable()) {
        await interaction.reply({ content: "❌ Something broke! Check bot logs.", flags: 64 });
      }
    } catch (replyErr) {
      console.error("Failed to send interaction error response:", replyErr);
    }
  }
});

client.on("guildMemberRemove", async (member) => {
  try {
    await inactivityCommands.handleInactivityMemberLeave(member);
  } catch (err) {
    console.error("Failed to process inactivity cleanup on member leave:", err);
  }
});

// ---------- Bot Ready ----------
client.once("clientReady", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  console.log(`📊 Serving ${client.guilds.cache.size} guild(s)`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📅 Reservation System: Online");
  console.log("⚖️ Death/Life Row System: Online");
  console.log("💤 Inactivity System: Online");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  client.user.setActivity('discord.gg/noobia', { type: 0 });
  await sendStatusMessage("────────────────────────\nService now online.");
  console.log("✅ Startup status message attempted.");

  if (BOT_MANAGER_ID) {
    console.log(`ℹ️ BOT_MANAGER_ID configured: ${BOT_MANAGER_ID}`);
  }
  if (DEVELOPERS_LIST.length > 0) {
    console.log(`ℹ️ Developers configured: ${DEVELOPERS_LIST.length}`);
  }

  try {
    await inactivityCommands.processInactivityExpirations(client);
  } catch (err) {
    console.error("Failed to process inactivity expirations on startup:", err);
  }

  try {
    await reservationCommands.processReservationExpirations(client);
  } catch (err) {
    console.error("Failed to process reservation expirations on startup:", err);
  }

  scheduleDailyInactivityExpirationSweep();
  scheduleReservationExpirationSweep();

  scheduleWeeklyRefresh();
});

// ---------- Boot ----------
(async () => {
  await registerCommands();
  await client.login(process.env.DISCORD_TOKEN);
})();
