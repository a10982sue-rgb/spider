// Spider Discord bot — credit management + login-link onboarding.
//
// Two ways to run:
//   • Standalone:  npm run bot   (a dedicated process / Render worker)
//   • Embedded:    the web server imports startBot() and runs it in-process,
//     so a single free Render web service runs both the site and the bot.
//
// Requires env: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID
// Optional:     ADMIN_IDS (comma-separated Discord user ids allowed to grant),
//               PUBLIC_URL (where the website is hosted, for the login link).
//
// It shares the user store with the web server, so credit changes are live.
import {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, PermissionFlagsBits,
} from "discord.js";
import { pathToFileURL } from "node:url";
import {
  syncUser, grantCredits, setCredits, grantAll, allUsers, reloadAll,
  STARTING_CREDITS, ready as usersReady,
} from "./users.js";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
// The bot can live in its OWN Discord application, separate from the one used
// for website login. Its application id is taken from (in order): an explicit
// DISCORD_BOT_CLIENT_ID, the id decoded from the bot token itself (always the
// bot's real app), or — last resort — the shared DISCORD_CLIENT_ID.
// The token-derived id MUST win over DISCORD_CLIENT_ID: when the bot and login
// are different apps, registering to the login app's id throws 20012 ("not
// authorized to perform this action on this application").
function appIdFromToken(token) {
  try {
    return Buffer.from(String(token).split(".")[0], "base64").toString("utf8");
  } catch {
    return "";
  }
}
const CLIENT_ID =
  process.env.DISCORD_BOT_CLIENT_ID ||
  (TOKEN ? appIdFromToken(TOKEN) : "") ||
  process.env.DISCORD_CLIENT_ID;
// Optional: register commands to one guild for INSTANT availability (global
// commands can take up to an hour to propagate). Set to your server id.
const GUILD_ID = process.env.DISCORD_GUILD_ID || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const isAdmin = (i) =>
  ADMIN_IDS.includes(i.user.id) ||
  i.memberPermissions?.has(PermissionFlagsBits.Administrator);

// --- slash command definitions --------------------------------------------
// A user option used by all the admin credit commands.
const userOpt = (o) => o.setName("user").setDescription("Which user").setRequired(true);
const amountOpt = (o, desc) => o.setName("amount").setDescription(desc).setRequired(true).setMinValue(1);

const commands = [
  // --- everyone ---
  new SlashCommandBuilder()
    .setName("mycredits")
    .setDescription("Check how many Spider generation credits you have left"),

  new SlashCommandBuilder()
    .setName("login")
    .setDescription("Get a link to log in and start building with Spider"),

  // --- admin: flat credit commands (the ones you asked for) ---
  new SlashCommandBuilder()
    .setName("addcredits")
    .setDescription("Add credits to a user (admins only)")
    .addUserOption(userOpt)
    .addIntegerOption((o) => amountOpt(o, "How many to add")),

  new SlashCommandBuilder()
    .setName("removecredits")
    .setDescription("Remove credits from a user (admins only)")
    .addUserOption(userOpt)
    .addIntegerOption((o) => amountOpt(o, "How many to remove")),

  new SlashCommandBuilder()
    .setName("setcredits")
    .setDescription("Set a user's credits to an exact value (admins only)")
    .addUserOption(userOpt)
    .addIntegerOption((o) => o.setName("amount").setDescription("Exact value").setRequired(true).setMinValue(0)),

  new SlashCommandBuilder()
    .setName("checkcredits")
    .setDescription("Check another user's credits (admins only)")
    .addUserOption(userOpt),

  new SlashCommandBuilder()
    .setName("resetcredits")
    .setDescription("Reset a user's credits to the starting amount (admins only)")
    .addUserOption(userOpt),

  new SlashCommandBuilder()
    .setName("grantall")
    .setDescription("Give credits to EVERY registered user (admins only)")
    .addIntegerOption((o) => amountOpt(o, "How many to add to everyone")),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Show Spider usage stats (admins only)"),
].map((c) => c.toJSON());

async function registerCommands() {
  if (!CLIENT_ID) {
    console.warn("[bot] could not determine application id — skipping command registration.");
    return;
  }
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  if (GUILD_ID) {
    // Guild-scoped: appears in your server immediately.
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`[bot] slash commands registered to guild ${GUILD_ID} (instant)`);
  } else {
    // Global: works everywhere, but can take up to an hour to show up the first time.
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("[bot] global slash commands registered (may take up to ~1h to appear)");
  }
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
  const cmd = i.commandName;
  try {
    // ---- everyone ----
    if (cmd === "login") {
      return i.reply({
        ephemeral: true,
        content:
          "Click below to log in with Discord, then enter your FreeModel API key and " +
          "link the Roblox Studio plugin. You start with " + STARTING_CREDITS + " credits.",
        components: [loginRow()],
      });
    }

    if (cmd === "mycredits") {
      const u = await syncUser(i.user.id);
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

    // ---- everything below is admin-only ----
    const ADMIN_CMDS = ["addcredits", "removecredits", "setcredits", "checkcredits", "resetcredits", "grantall", "stats"];
    if (ADMIN_CMDS.includes(cmd)) {
      if (!isAdmin(i)) {
        return i.reply({ ephemeral: true, content: "⛔ Only admins can use this command." });
      }
    }

    // Bulk + stats don't take a target user.
    if (cmd === "grantall") {
      const amount = i.options.getInteger("amount");
      await i.deferReply({ ephemeral: true }); // may touch many users
      await reloadAll(); // make sure we have every user, not just cached ones
      const n = await grantAll(amount);
      return i.editReply(`✅ Added **${amount}** credits to **${n}** user(s).`);
    }

    if (cmd === "stats") {
      await i.deferReply({ ephemeral: true });
      await reloadAll();
      const all = allUsers();
      const total = all.reduce((s, u) => s + (u.credits || 0), 0);
      const broke = all.filter((u) => (u.credits || 0) <= 0).length;
      const top = [...all].sort((a, b) => b.credits - a.credits).slice(0, 5)
        .map((u) => `• ${u.globalName || u.username}: **${u.credits}**`).join("\n") || "—";
      const embed = new EmbedBuilder()
        .setColor(0xff4d3d)
        .setTitle("🕷️ Spider stats")
        .addFields(
          { name: "Registered users", value: String(all.length), inline: true },
          { name: "Credits in circulation", value: String(total), inline: true },
          { name: "Out of credits", value: String(broke), inline: true },
          { name: "Top balances", value: top },
        );
      return i.editReply({ embeds: [embed] });
    }

    // The per-user admin commands all share a target lookup.
    if (["addcredits", "removecredits", "setcredits", "checkcredits", "resetcredits"].includes(cmd)) {
      const target = i.options.getUser("user");
      const u = await syncUser(target.id);
      const who = target.globalName || target.username;
      if (!u) {
        return i.reply({ ephemeral: true, content: `**${who}** hasn't logged into Spider yet, so they have no account.` });
      }
      if (cmd === "checkcredits") {
        return i.reply({ ephemeral: true, embeds: [creditsEmbed(who, u.credits)] });
      }
      if (cmd === "addcredits") {
        const amount = i.options.getInteger("amount");
        const now = await grantCredits(target.id, amount);
        return i.reply({ ephemeral: true, content: `✅ Added **${amount}**. ${who} now has **${now}** credits.` });
      }
      if (cmd === "removecredits") {
        const amount = i.options.getInteger("amount");
        const now = await grantCredits(target.id, -amount); // clamped at 0 in the store
        return i.reply({ ephemeral: true, content: `✅ Removed **${amount}**. ${who} now has **${now}** credits.` });
      }
      if (cmd === "setcredits") {
        const amount = i.options.getInteger("amount");
        const now = await setCredits(target.id, amount);
        return i.reply({ ephemeral: true, content: `✅ Set ${who} to **${now}** credits.` });
      }
      if (cmd === "resetcredits") {
        const now = await setCredits(target.id, STARTING_CREDITS);
        return i.reply({ ephemeral: true, content: `✅ Reset ${who} to **${now}** credits.` });
      }
    }
  } catch (e) {
    console.error("[bot] interaction error:", e);
    const msg = { ephemeral: true, content: "Something went wrong handling that." };
    if (i.deferred) i.editReply(msg.content).catch(() => {});
    else if (!i.replied) i.reply(msg).catch(() => {});
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

// Start the bot. Safe to call from the web server (embedded) or standalone.
// Returns true if it began logging in, false if no token is configured.
let started = false;
export async function startBot() {
  if (started) return true;
  if (!TOKEN) {
    console.warn("[bot] DISCORD_BOT_TOKEN not set — Discord bot disabled. See SETUP.md.");
    return false;
  }
  started = true;
  try {
    await usersReady;
    await registerCommands();
    await client.login(TOKEN);
    return true;
  } catch (e) {
    console.error("[bot] startup failed:", e);
    return false;
  }
}

// If run directly (`node server/bot.js` / `npm run bot`), start immediately and
// treat a missing token as fatal. When imported, do nothing until startBot().
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  startBot().then((ok) => { if (!ok) process.exit(1); });
}
