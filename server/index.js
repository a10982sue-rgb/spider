import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLink, getLink, getLinkByCode, getLinkByToken,
  confirmLink, queueActions, drainQueue, setContext,
} from "./store.js";
import { runChat } from "./ai.js";
import {
  registerAuthRoutes, requireUser, currentUser, authConfigured,
} from "./auth.js";
import { spendCredit, markIntroSeen, publicUser, getUser, syncUser, ready as usersReady } from "./users.js";
import {
  ready as convosReady,
  listConversations, getConversation, createConversation, deleteConversation,
  appendMessage, getMemory, addMemory, deleteMemory,
} from "./convos.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "30mb" }));

// Security headers to establish trust and prevent false positive phishing flags
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("X-XSS-Protection", "1; mode=block");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
});

// CORS so the plugin (and a separately-hosted page) can call us.
// Note: credentials (cookies) require a specific origin, but the plugin uses a
// bearer token (not cookies), so wildcard CORS is fine for those routes.
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Discord OAuth login/callback/logout routes.
registerAuthRoutes(app);

// === AUTH / ACCOUNT ========================================================

// Who am I? Frontend calls this on load to decide login vs app.
app.get("/api/me", async (req, res) => {
  const u = currentUser(req);
  // Pull the freshest credit count from shared storage (bot may have changed it).
  if (u) await syncUser(u.id);
  res.json({ authConfigured, user: publicUser(currentUser(req)) });
});

// Mark the onboarding intro as seen so it doesn't show again.
app.post("/api/intro-seen", requireUser, (req, res) => {
  markIntroSeen(req.user.id);
  res.json({ ok: true });
});

// === CONVERSATION HISTORY (per Discord user, persistent) ===================

// List the user's past conversations (summaries only).
app.get("/api/conversations", requireUser, async (req, res) => {
  res.json({ conversations: await listConversations(req.user.id) });
});

// Get one conversation with its full message history.
app.get("/api/conversations/:id", requireUser, async (req, res) => {
  const convo = await getConversation(req.user.id, req.params.id);
  if (!convo) return res.status(404).json({ error: "not found" });
  res.json({ conversation: convo });
});

// Start a fresh conversation.
app.post("/api/conversations", requireUser, async (req, res) => {
  const convo = await createConversation(req.user.id, req.body?.title);
  res.json({ conversation: convo });
});

// Delete a conversation.
app.delete("/api/conversations/:id", requireUser, async (req, res) => {
  const ok = await deleteConversation(req.user.id, req.params.id);
  res.json({ ok });
});

// === LONG-TERM MEMORY ======================================================

app.get("/api/memory", requireUser, async (req, res) => {
  res.json({ memory: await getMemory(req.user.id) });
});

app.post("/api/memory", requireUser, async (req, res) => {
  const text = (req.body?.text || "").toString();
  if (!text.trim()) return res.status(400).json({ error: "empty memory" });
  const memory = await addMemory(req.user.id, text);
  res.json({ ok: true, memory });
});

app.delete("/api/memory/:id", requireUser, async (req, res) => {
  const ok = await deleteMemory(req.user.id, req.params.id);
  res.json({ ok });
});

// --- helpers ---------------------------------------------------------------
const bearer = (req) => (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();

function requireWebSession(req, res) {
  const linkId = req.get("x-link-id") || req.body?.linkId;
  const link = linkId && getLink(linkId);
  if (!link) { res.status(404).json({ error: "unknown session" }); return null; }
  return link;
}

function requirePlugin(req, res) {
  const link = getLinkByToken(bearer(req));
  if (!link) { res.status(401).json({ error: "invalid plugin token" }); return null; }
  return link;
}

// Build a chat message from text + attachments. Images become vision parts
// (OpenAI multimodal format); text files are inlined into the prompt so any
// model — vision-capable or not — can use their contents.
function buildUserMessage(message, attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  const images = list.filter((a) => a && a.kind === "image" && a.dataUrl);
  const files = list.filter((a) => a && a.kind === "text" && typeof a.text === "string");

  let text = message || "";
  for (const f of files) {
    const body = f.text.slice(0, 100_000); // guard huge pastes
    text += `\n\n--- Attached file: ${f.name || "file"} ---\n${body}\n--- end of ${f.name || "file"} ---`;
  }

  if (images.length === 0) {
    return { role: "user", content: text };
  }
  // Multimodal content array.
  const content = [{ type: "text", text: text || "(see attached image)" }];
  for (const img of images) {
    content.push({ type: "image_url", image_url: { url: img.dataUrl } });
  }
  return { role: "user", content };
}

// === WEBSITE FLOW ==========================================================

// 1. Browser starts a session, gets a pairing code to type into the plugin.
//    Requires login so the session is owned by a Discord user (for credits).
app.post("/api/session/start", requireUser, (req, res) => {
  const link = createLink();
  link.ownerId = req.user.id; // tie this session to the logged-in user
  res.json({ linkId: link.linkId, code: link.code, codeExpires: link.codeExpires });
});

// 2. Browser saves model choice for this session (API key is now default).
app.post("/api/session/config", (req, res) => {
  const link = requireWebSession(req, res);
  if (!link) return;
  const { model } = req.body || {};
  // Default API key for all users
  link.apiKey = process.env.DEFAULT_API_KEY || "fe_oa_48604b790ac5e4f74ac0877a184737d54192da7c78427c0a";
  if (typeof model === "string" && model.trim()) link.model = model.trim();
  res.json({ ok: true, model: link.model, hasKey: !!link.apiKey });
});

// 3. Browser polls to see whether the plugin has paired.
app.get("/api/session/status", (req, res) => {
  const link = getLink(req.query.linkId);
  if (!link) return res.status(404).json({ error: "unknown session" });
  const owner = link.ownerId ? getUser(link.ownerId) : null;
  res.json({
    linked: link.linked,
    roblox: link.roblox,
    hasKey: !!link.apiKey,
    model: link.model,
    pending: link.queue.length,
    credits: owner ? owner.credits : null,
  });
});

// === PLUGIN PAIRING ========================================================

// Plugin confirms a code shown on the website, sending its Studio identity.
app.post("/api/link/confirm", (req, res) => {
  const { code, userId, userName, placeId } = req.body || {};
  if (!code) return res.status(400).json({ error: "code required" });
  const found = getLinkByCode(code);
  if (!found) return res.status(404).json({ error: "invalid or expired code" });
  const link = confirmLink(code, {
    userId: userId ?? null,
    userName: userName ?? "Unknown",
    placeId: placeId ?? null,
  });
  res.json({
    pluginToken: link.pluginToken,
    linkId: link.linkId,
    user: link.roblox,
  });
});

// === CHAT ==================================================================

// Browser sends a chat message. Streamed via SSE so the UI can show the
// model's live "thinking" before the final reply + queued actions.
app.post("/api/chat", async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "not logged in" });
  const link = requireWebSession(req, res);
  if (!link) return;
  if (!link.apiKey) return res.status(400).json({ error: "no API key set for this session" });
  if (!link.linked) return res.status(400).json({ error: "Roblox plugin not linked yet" });
  if (user.credits <= 0) {
    return res.status(402).json({ error: "out of credits", credits: 0 });
  }

  const message = (req.body?.message || "").toString();
  const attachments = req.body?.attachments;
  const thinkMode = (req.body?.thinkMode || "medium").toString();
  const mode = (req.body?.mode || "build").toString();
  const webSearch = req.body?.webSearch === true;
  let convoId = (req.body?.convoId || "").toString() || null;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if (!message.trim() && !hasAttachments) return res.status(400).json({ error: "empty message" });

  // Open the SSE stream.
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const userMsg = buildUserMessage(message, attachments);

  // Build history from the user's persistent conversation (survives restarts),
  // and pull their long-term memory to give the model continuity.
  let history = [];
  if (convoId) {
    const convo = await getConversation(user.id, convoId);
    if (convo) history = convo.messages.map((m) => ({ role: m.role, content: m.content }));
  }
  history.push(userMsg);
  const memory = await getMemory(user.id);

  try {
    const { thinking, reply, actions, truncated, salvaged } = await runChat({
      apiKey: link.apiKey,
      model: link.model,
      history,
      thinkMode,
      mode,
      memory,
      webSearch,
      context: link.context,
      onThinking: (chunk) => send("thinking", { chunk }),
      onStatus: (s) => send("status", { status: s }),
    });
    // Separate "remember" actions (saved to memory) from build actions (queued).
    const remembers = actions.filter((a) => a && a.type === "remember");
    const buildActions = actions.filter((a) => a && a.type !== "remember");
    for (const r of remembers) { try { await addMemory(user.id, r.text); } catch {} }

    // Persist the turn to the user's conversation.
    convoId = await appendMessage(user.id, convoId, userMsg);
    await appendMessage(user.id, convoId, { role: "assistant", content: reply });

    // Keep the ephemeral link.history in sync for the in-Studio plugin chat view.
    link.history = (await getConversation(user.id, convoId))?.messages.map((m) => ({ role: m.role, content: m.content })) || [];

    const queuedIds = buildActions.length ? queueActions(link, buildActions) : [];
    // Charge one credit for the successful generation.
    const { credits } = await spendCredit(user.id);
    send("done", {
      thinking, reply, actions: buildActions, queued: queuedIds.length,
      truncated, salvaged, credits, convoId,
      remembered: remembers.map((r) => r.text),
    });
  } catch (err) {
    send("error", { error: String(err.message || err) });
  } finally {
    res.end();
  }
});

// Browser can fetch results the plugin reported (success/failure per action).
app.get("/api/results", (req, res) => {
  const link = getLink(req.query.linkId);
  if (!link) return res.status(404).json({ error: "unknown session" });
  const out = link.results;
  link.results = [];
  res.json({ results: out });
});

// === PLUGIN ACTION CHANNEL =================================================

// Plugin long-ish polls for queued actions.
app.get("/api/actions/poll", (req, res) => {
  const link = requirePlugin(req, res);
  if (!link) return;
  const actions = drainQueue(link);
  res.json({ actions });
});

// Plugin reports results of executed actions.
app.post("/api/actions/result", (req, res) => {
  const link = requirePlugin(req, res);
  if (!link) return;
  const results = Array.isArray(req.body?.results) ? req.body.results : [];
  link.results.push(...results.map((r) => ({ ...r, at: Date.now() })));
  res.json({ ok: true });
});

// Plugin uploads a snapshot of the place so the AI can SEE existing instances
// and script sources. Sent before chats and on a periodic refresh.
app.post("/api/context", (req, res) => {
  const link = requirePlugin(req, res);
  if (!link) return;
  const context = (req.body?.context ?? "").toString();
  const size = setContext(link, context);
  res.json({ ok: true, size });
});

// Plugin can also send a chat message directly (in-Studio chat box).
app.post("/api/plugin/chat", async (req, res) => {
  const link = requirePlugin(req, res);
  if (!link) return;
  if (!link.apiKey) return res.status(400).json({ error: "no API key set on the website yet" });

  // Charge the session owner's credits (same pool as the website).
  const owner = link.ownerId ? getUser(link.ownerId) : null;
  if (owner && owner.credits <= 0) {
    return res.status(402).json({ error: "out of credits — top up on the website", credits: 0 });
  }

  const message = (req.body?.message || "").toString();
  if (!message.trim()) return res.status(400).json({ error: "empty message" });
  link.history.push({ role: "user", content: message });

  try {
    const memory = owner ? await getMemory(owner.id) : [];
    const { thinking, reply, actions } = await runChat({
      apiKey: link.apiKey, model: link.model, history: link.history,
      context: link.context, memory,
    });
    link.history.push({ role: "assistant", content: reply });
    // Save any "remember" actions to memory; only ship build actions to plugin.
    const buildActions = actions.filter((a) => a && a.type !== "remember");
    if (owner) {
      for (const r of actions.filter((a) => a && a.type === "remember")) {
        try { await addMemory(owner.id, r.text); } catch {}
      }
    }
    const queued = buildActions.length ? queueActions(link, buildActions) : [];
    let credits;
    if (owner) credits = (await spendCredit(owner.id)).credits;
    res.json({ thinking, reply, actions: buildActions, queued: queued.length, credits });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// === STATIC SITE ===========================================================
// allow dotfiles so /.well-known/security.txt is served (trust signal).
app.use(express.static(path.join(__dirname, "..", "public"), { dotfiles: "allow" }));

const PORT = process.env.PORT || 3000;
// Wait for the persistent stores (Redis or file) to load before serving.
Promise.all([usersReady, convosReady]).then(() => {
  app.listen(PORT, () => {
    console.log(`FreeModel-Roblox bridge running on http://localhost:${PORT}`);
  });
  // Run the Discord bot in-process too, unless explicitly told to run it as a
  // separate service. This lets a single free Render web service host both the
  // site and the bot (Render's free plan doesn't run standalone workers).
  if (process.env.RUN_BOT !== "false" && process.env.DISCORD_BOT_TOKEN) {
    import("./bot.js")
      .then((m) => m.startBot())
      .catch((e) => console.error("[bot] failed to start embedded:", e.message));
  }
});
