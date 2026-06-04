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
  setDiscordRoles, setManualRole, effectiveRoles,
} from "./users.js";
import {
  setApiKey, listApiKeyNames, addChangelog, listChangelog, removeChangelog,
  ready as settingsReady,
} from "./settings.js";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
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
const GUILD_ID = process.env.DISCORD_GUILD_ID || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Role names in the Discord server that map to Spider roles. Case-insensitive.
const TESTER_ROLE_NAME = (process.env.DISCORD_TESTER_ROLE || "tester").toLowerCase();
const ADMIN_ROLE_NAME = (process.env.DISCORD_ADMIN_ROLE || "admin").toLowerCase();
const CHANGELOG_CHANNEL_ID = process.env.CHANGELOG_CHANNEL_ID || "";

const isAdmin = (i) =>
  ADMIN_IDS.includes(i.user.id) ||
  i.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
  (i.member && i.member.roles && i.member.roles.cache &&
    i.member.roles.cache.some((r) => r.name.toLowerCase() === ADMIN_ROLE_NAME));

// --- slash command definitions --------------------------------------------
const userOpt = (o) => o.setName("user").setDescription("Which user").setRequired(true);
const amountOpt = (o, desc) => o.setName("amount").setDescription(desc).setRequired(true).setMinValue(1);

const commands = [
  new SlashCommandBuilder()
    .setName("mycredits")
    .setDescription("Check how many Spider generation credits you have left"),
  new SlashCommandBuilder()
    .setName("login")
    .setDescription("Get a link to log in and start building with Spider"),
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
  new SlashCommandBuilder()
    .setName("setapikey")
    .setDescription("Set or rotate an API key at runtime (admins only)")
    .addStringOption((o) => o.setName("name").setDescription("Key name (e.g. KIRO_API_KEY)").setRequired(true)
      .addChoices(
        { name: "DEFAULT_API_KEY (FreeModel)", value: "DEFAULT_API_KEY" },
        { name: "KIRO_API_KEY", value: "KIRO_API_KEY" },
        { name: "LIGHTNING_API_KEY", value: "LIGHTNING_API_KEY" },
      ))
    .addStringOption((o) => o.setName("value").setDescription("New value (leave blank to clear)").setRequired(false)),
  new SlashCommandBuilder()
    .setName("apikeys")
    .setDescription("List which API keys have a runtime override (admins only)"),
  new SlashCommandBuilder()
    .setName("changelog")
    .setDescription("Post a changelog entry (admins only)")
    .addStringOption((o) => o.setName("title").setDescription("Short title").setRequired(true))
    .addStringOption((o) => o.setName("body").setDescription("Details").setRequired(true))
    .addStringOption((o) => o.setName("scope").setDescription("Where it applies").setRequired(false)
      .addChoices(
        { name: "Both", value: "both" },
        { name: "Plugin", value: "plugin" },
        { name: "Website", value: "website" },
      )),
  new SlashCommandBuilder()
    .setName("changeloglist")
    .setDescription("Show the most recent changelog entries"),
  new SlashCommandBuilder()
    .setName("grantrole")
    .setDescription("Grant tester or admin role to a user (admins only)")
    .addUserOption(userOpt)
    .addStringOption((o) => o.setName("role").setDescription("Which role").setRequired(true)
      .addChoices({ name: "tester", value: "tester" }, { name: "admin", value: "admin" })),
  new SlashCommandBuilder()
    .setName("revokerole")
    .setDescription("Revoke a manually-granted role (admins only)")
    .addUserOption(userOpt)
    .addStringOption((o) => o.setName("role").setDescription("Which role").setRequired(true)
      .addChoices({ name: "tester", value: "tester" }, { name: "admin", value: "admin" })),
].map((c) => c.toJSON());

async function registerCommands() {
  if (!CLIENT_ID) {
    console.warn("[bot] could not determine application id — skipping command registration.");
    return;
  }
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`[bot] slash commands registered to guild ${GUILD_ID} (instant)`);
  } else {
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
// GuildMembers is a privileged intent — if the bot isn't approved for it yet
// in the Developer Portal, login throws PrivilegedIntentError. We catch that
// and reconnect without it so the rest of the bot still runs.

let hasGuildMembers = true;
let client;

function buildClient() {
  const intents = hasGuildMembers
    ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages]
    : [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages];
  const partials = hasGuildMembers
    ? [Partials.Channel, Partials.GuildMember]
    : [Partials.Channel];
  return new Client({ intents, partials });
}

// Role sync from Discord member → Spider user store.
async function syncMemberRoles(member) {
  if (!member || member.user?.bot) return;
  await syncUser(member.id);
  const names = member.roles.cache.map((r) => r.name.toLowerCase());
  await setDiscordRoles(member.id, {
    tester: names.includes(TESTER_ROLE_NAME),
    admin: names.includes(ADMIN_ROLE_NAME),
  });
}

// Post a changelog entry to the configured Discord channel. Exported so the
// admin web panel can push entries through the bot.
export async function postChangelog(entry) {
  if (!CHANGELOG_CHANNEL_ID) return false;
  try {
    const ch = await client.channels.fetch(CHANGELOG_CHANNEL_ID);
    if (!ch || !ch.isTextBased()) return false;
    const scopeTag = entry.scope === "plugin" ? "🔌 Plugin"
      : entry.scope === "website" ? "🌐 Website" : "🔌 + 🌐 Both";
    const embed = new EmbedBuilder()
      .setColor(0x00e5ff)
      .setTitle(`🛠 ${entry.title}`)
      .setDescription(entry.body || "(no details)")
      .addFields(
        { name: "Scope", value: scopeTag, inline: true },
        { name: "Author", value: entry.author || "admin", inline: true },
      )
      .setFooter({ text: "Spider · beta" })
      .setTimestamp(new Date(entry.at || Date.now()));
    await ch.send({ embeds: [embed] });
    return true;
  } catch (e) {
    console.error("[bot] postChangelog failed:", e.message);
    return false;
  }
}

// Attach all event listeners to `client`. Call this after every client rebuild.
function registerHandlers() {
  client.once("clientReady", (c) => {
    console.log(`[bot] logged in as ${c.user.tag}`);
    if (!hasGuildMembers) return;
    for (const g of c.guilds.cache.values()) {
      g.members.fetch().then((members) => {
        for (const m of members.values()) syncMemberRoles(m).catch(() => {});
      }).catch(() => {});
    }
  });

  if (hasGuildMembers) {
    client.on("guildMemberUpdate", (oldM, newM) => {
      syncMemberRoles(newM).catch((e) => console.error("[bot] role sync:", e.message));
    });
    client.on("guildMemberAdd", (m) => {
      syncMemberRoles(m).catch(() => {});
    });
  }

  client.on("interactionCreate", async (i) => {
    if (!i.isChatInputCommand()) return;
    const cmd = i.commandName;
    try {
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

      const ADMIN_CMDS = [
        "addcredits", "removecredits", "setcredits", "checkcredits", "resetcredits",
        "grantall", "stats",
        "setapikey", "apikeys",
        "changelog", "changeloglist",
        "grantrole", "revokerole",
      ];
      if (ADMIN_CMDS.includes(cmd) && !isAdmin(i)) {
        return i.reply({ ephemeral: true, content: "⛔ Only admins can use this command." });
      }

      if (cmd === "setapikey") {
        const name = i.options.getString("name");
        const value = i.options.getString("value") || "";
        setApiKey(name, value);
        const masked = value ? `${value.slice(0, 6)}…${value.slice(-4)} (len=${value.length})` : "(cleared)";
        return i.reply({ ephemeral: true, content: `✅ Set **${name}** = \`${masked}\`. New chats use it immediately.` });
      }
      if (cmd === "apikeys") {
        const names = listApiKeyNames();
        const body = names.length
          ? names.map((n) => `• \`${n}\` — runtime override active`).join("\n")
          : "_No runtime overrides — server env vars are in effect._";
        return i.reply({ ephemeral: true, embeds: [
          new EmbedBuilder().setColor(0x00e5ff).setTitle("🔐 API key overrides").setDescription(body),
        ] });
      }
      if (cmd === "changelog") {
        const title = i.options.getString("title");
        const body = i.options.getString("body");
        const scope = i.options.getString("scope") || "both";
        const entry = addChangelog({ title, body, scope, author: i.user.username });
        await postChangelog(entry).catch(() => {});
        return i.reply({ ephemeral: true, content: `✅ Posted changelog **${title}**${CHANGELOG_CHANNEL_ID ? " and broadcast to #changelog." : " (no channel configured — set CHANGELOG_CHANNEL_ID)."}` });
      }
      if (cmd === "changeloglist") {
        const all = listChangelog().slice(0, 10);
        if (!all.length) return i.reply({ ephemeral: true, content: "_No changelog entries yet._" });
        const lines = all.map((e) => `**${e.title}** _(${e.scope})_ — <t:${Math.floor(e.at / 1000)}:R>\n${e.body}`).join("\n\n");
        return i.reply({ ephemeral: true, embeds: [
          new EmbedBuilder().setColor(0x00e5ff).setTitle("📜 Recent changelog").setDescription(lines.slice(0, 3900)),
        ] });
      }
      if (cmd === "grantrole" || cmd === "revokerole") {
        const target = i.options.getUser("user");
        const role = i.options.getString("role");
        await syncUser(target.id);
        const roles = await setManualRole(target.id, role, cmd === "grantrole");
        if (!roles) {
          return i.reply({ ephemeral: true, content: `**${target.username}** hasn't logged into Spider yet, so they have no account.` });
        }
        const active = `tester=${roles.tester}, admin=${roles.admin}`;
        return i.reply({ ephemeral: true, content: `✅ ${cmd === "grantrole" ? "Granted" : "Revoked"} **${role}** for ${target.username}. Effective: \`${active}\`.` });
      }
      if (cmd === "grantall") {
        const amount = i.options.getInteger("amount");
        await i.deferReply({ ephemeral: true });
        await reloadAll();
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
      // Per-user admin commands
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
          const now = await grantCredits(target.id, -amount);
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

  client.on("messageCreate", async (msg) => {
    if (msg.author.bot || msg.guild) return;
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
}

// --- build initial client + attach handlers --------------------------------
client = buildClient();
registerHandlers();

// --- start the bot ---------------------------------------------------------
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
    await settingsReady;
    try {
      await client.login(TOKEN);
    } catch (loginErr) {
      const msg = loginErr.message || String(loginErr);
      if (msg.includes("Used privileged") || msg.includes("GUILD_MEMBERS") || loginErr.code === "PrivilegedIntentError") {
        console.warn("[bot] GuildMembers intent not enabled — role sync from Discord will be unavailable.");
        console.warn("[bot]     Enable it at https://discord.com/developers/applications → Bot → Privileged Gateway Intents.");
        hasGuildMembers = false;
        await client.destroy();
        client = buildClient();
        registerHandlers();
        await client.login(TOKEN);
      } else {
        throw loginErr;
      }
    }
    await registerCommands();
    return true;
  } catch (e) {
    console.error("[bot] startup failed:", e);
    return false;
  }
}

// If run directly (`node server/bot.js` / `npm run bot`), start immediately.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  startBot().then((ok) => { if (!ok) process.exit(1); });
}
