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
import { spendCredit, markIntroSeen, publicUser, getUser } from "./users.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "30mb" }));

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
app.get("/api/me", (req, res) => {
  const u = currentUser(req);
  res.json({ authConfigured, user: publicUser(u) });
});

// Mark the onboarding intro as seen so it doesn't show again.
app.post("/api/intro-seen", requireUser, (req, res) => {
  markIntroSeen(req.user.id);
  res.json({ ok: true });
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

// 2. Browser saves its FreeModel API key + model choice for this session.
app.post("/api/session/config", (req, res) => {
  const link = requireWebSession(req, res);
  if (!link) return;
  const { apiKey, model } = req.body || {};
  if (typeof apiKey === "string" && apiKey.trim()) link.apiKey = apiKey.trim();
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

  link.history.push(buildUserMessage(message, attachments));

  try {
    const { thinking, reply, actions, truncated, salvaged } = await runChat({
      apiKey: link.apiKey,
      model: link.model,
      history: link.history,
      thinkMode,
      mode,
      context: link.context,
      onThinking: (chunk) => send("thinking", { chunk }),
      onStatus: (s) => send("status", { status: s }),
    });
    // Store a plain-text version in history to keep future turns small.
    link.history.push({ role: "assistant", content: reply });
    const queuedIds = actions.length ? queueActions(link, actions) : [];
    // Charge one credit for the successful generation.
    const { credits } = spendCredit(user.id);
    send("done", {
      thinking, reply, actions, queued: queuedIds.length,
      truncated, salvaged, credits,
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
    const { thinking, reply, actions } = await runChat({
      apiKey: link.apiKey, model: link.model, history: link.history,
      context: link.context,
    });
    link.history.push({ role: "assistant", content: reply });
    const queued = actions.length ? queueActions(link, actions) : [];
    let credits;
    if (owner) credits = spendCredit(owner.id).credits;
    res.json({ thinking, reply, actions, queued: queued.length, credits });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// === STATIC SITE ===========================================================
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FreeModel-Roblox bridge running on http://localhost:${PORT}`);
});
