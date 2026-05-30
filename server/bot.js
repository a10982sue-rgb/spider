// Spider Discord bot — credit management + login-link onboarding.
//
// Run separately from the web server:   npm run bot
// Requires env: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID
// Optional:     ADMIN_IDS (comma-separated Discord user ids allowed to grant),
//               PUBLIC_URL (where the website is hosted, for the login link).
//
// It shares data/users.json with the web server, so credit changes are live.
import {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, PermissionFlagsBits,
} from "discord.js";
import {
  getUser, grantCredits, setCredits, STARTING_CREDITS,
} from "./users.js";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const PUBLIC_URL = (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

if (!TOKEN || !CLIENT_ID) {
  console.error("[bot] DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required. See SETUP.md.");
  process.exit(1);
}

const isAdmin = (i) =>
  ADMIN_IDS.includes(i.user.id) ||
  i.memberPermissions?.has(PermissionFlagsBits.Administrator);

// --- slash command definitions --------------------------------------------
const commands = [
  new SlashCommandBuilder()
    .setName("mycredits")
    .setDescription("Check how many Spider generation credits you have left"),

  new SlashCommandBuilder()
    .setName("login")
    .setDescription("Get a link to log in and start building with Spider"),

  new SlashCommandBuilder()
    .setName("credits")
    .setDescription("Manage a user's Spider credits (admins only)")
    .addSubcommand((s) =>
      s.setName("check").setDescription("Check a user's credits")
        .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true)))
    .addSubcommand((s) =>
      s.setName("grant").setDescription("Add credits to a user")
        .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
        .addIntegerOption((o) => o.setName("amount").setDescription("How many").setRequired(true)))
    .addSubcommand((s) =>
      s.setName("set").setDescription("Set a user's credits to an exact value")
        .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
        .addIntegerOption((o) => o.setName("amount").setDescription("Value").setRequired(true)))
    .addSubcommand((s) =>
      s.setName("reset").setDescription("Reset a user's credits to the starting amount")
        .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true)))
    .toJSON(),
].map((c) => (c.toJSON ? c.toJSON() : c));

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("[bot] slash commands registered");
}

// --- helpers ---------------------------------------------------------------
function loginRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Log in with Discord")
      .setStyle(ButtonStyle.Link)
      .setURL(`${PUBLIC_URL}/auth/login`)
  );
}

function creditsEmbed(target, credits) {
  return new EmbedBuilder()
    .setColor(0xff4d3d)
    .setTitle("🕷️ Spider credits")
    .setDescription(`**${target}** has **${credits}** / ${STARTING_CREDITS} credits remaining.`);
}

// --- client ----------------------------------------------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

client.once("clientReady", (c) => {
  console.log(`[bot] logged in as ${c.user.tag}`);
});

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    if (i.commandName === "login") {
      return i.reply({
        ephemeral: true,
        content:
          "Click below to log in with Discord, then enter your FreeModel API key and " +
          "link the Roblox Studio plugin. You start with " + STARTING_CREDITS + " credits.",
        components: [loginRow()],
      });
    }

    if (i.commandName === "mycredits") {
      const u = getUser(i.user.id);
      if (!u) {
        return i.reply({
          ephemeral: true,
          content: "You haven't logged in yet — do that first to get your " +
            STARTING_CREDITS + " starting credits.",
          components: [loginRow()],
        });
      }
      return i.reply({ ephemeral: true, embeds: [creditsEmbed(u.globalName || u.username, u.credits)] });
    }

    if (i.commandName === "credits") {
      if (!isAdmin(i)) {
        return i.reply({ ephemeral: true, content: "⛔ Only admins can manage credits." });
      }
      const sub = i.options.getSubcommand();
      const target = i.options.getUser("user");
      const u = getUser(target.id);
      if (!u) {
        return i.reply({ ephemeral: true, content: `${target.username} hasn't logged into Spider yet.` });
      }
      if (sub === "check") {
        return i.reply({ ephemeral: true, embeds: [creditsEmbed(target.username, u.credits)] });
      }
      if (sub === "grant") {
        const amount = i.options.getInteger("amount");
        const now = grantCredits(target.id, amount);
        return i.reply({ ephemeral: true, content: `✅ Granted ${amount}. ${target.username} now has **${now}**.` });
      }
      if (sub === "set") {
        const amount = i.options.getInteger("amount");
        const now = setCredits(target.id, amount);
        return i.reply({ ephemeral: true, content: `✅ Set ${target.username} to **${now}** credits.` });
      }
      if (sub === "reset") {
        const now = setCredits(target.id, STARTING_CREDITS);
        return i.reply({ ephemeral: true, content: `✅ Reset ${target.username} to **${now}** credits.` });
      }
    }
  } catch (e) {
    console.error("[bot] interaction error:", e);
    if (!i.replied && !i.deferred) {
      i.reply({ ephemeral: true, content: "Something went wrong handling that." }).catch(() => {});
    }
  }
});

// DM onboarding: any DM gets the login link.
client.on("messageCreate", async (msg) => {
  if (msg.author.bot || msg.guild) return; // DMs only
  await msg.reply({
    content:
      "👋 Welcome to **Spider** — AI that builds your Roblox game.\n\n" +
      "1. Log in with Discord below\n" +
      "2. Paste your FreeModel API key\n" +
      "3. Link the Studio plugin with the 6-digit code\n" +
      "4. Describe what you want built — you get " + STARTING_CREDITS + " generations.",
    components: [loginRow()],
  }).catch(() => {});
});

registerCommands()
  .then(() => client.login(TOKEN))
  .catch((e) => { console.error("[bot] startup failed:", e); process.exit(1); });
