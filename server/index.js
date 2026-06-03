import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLink, getLink, getLinkByCode, getLinkByToken,
  confirmLink, queueActions, drainQueue, setContext,
} from "./store.js";
import { runChat, runChatLightning, streamOnce } from "./ai.js";
import {
  registerAuthRoutes, requireUser, currentUser, authConfigured,
} from "./auth.js";
import { spendCredit, markIntroSeen, publicUser, getUser, syncUser, ready as usersReady } from "./users.js";
import {
  ready as convosReady,
  listConversations, getConversation, createConversation, deleteConversation,
  appendMessage,
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

// The browser never needs to see script bodies — the plugin polls actions with
// its own bearer token and applies them directly. Strip `source` (and a few
// near-aliases) from anything we send back over the SSE stream, plus any
// fenced code blocks that show up in the reply/thinking text. This is the
// privacy boundary: the AI reads sources, the user does not.
function redactActionsForBrowser(actions) {
  if (!Array.isArray(actions)) return [];
  return actions.map((a) => {
    if (!a || typeof a !== "object") return a;
    const copy = { ...a };
    // Keep the metadata the UI uses for the "N actions queued" tag — drop bodies.
    for (const k of ["source", "script", "code", "lua", "luaSource", "newSource"]) {
      if (k in copy) delete copy[k];
    }
    // Hide the actual asset id from the browser for free-model inserts — it
    // gets resolved server-side and the user doesn't need to scrape it.
    if (copy.properties && typeof copy.properties === "object") {
      copy.properties = { ...copy.properties };
      for (const k of ["Source", "ScriptSource"]) delete copy.properties[k];
    }
    return copy;
  });
}

// Redact any fenced code block from a reply/thinking string. The system
// prompt forbids echoing place scripts, but enforce it on the wire too.
function redactCodeBlocks(text) {
  if (typeof text !== "string" || !text) return text;
  // ```lang\n...``` → "[code omitted — sent to Studio]"
  return text.replace(/```[a-zA-Z0-9_-]*\n[\s\S]*?```/g, "[code omitted — sent to Studio]");
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

  // Abort propagation: if the browser closes the SSE connection before we've
  // finished writing, we abort the upstream FreeModel fetch so it stops
  // burning tokens. Subscribe only to `res` (not `req`) — req.close can fire
  // unrelated to client disconnect after Express finishes reading the body.
  // `res.writableEnded` lets us distinguish "client closed early" from "we
  // called res.end() ourselves at the end of the handler".
  const ctrl = new AbortController();
  const onResClose = () => {
    if (!res.writableEnded && !ctrl.signal.aborted) ctrl.abort();
  };
  res.on("close", onResClose);

  const userMsg = buildUserMessage(message, attachments);

  // Build history from the user's persistent conversation (survives restarts).
  let history = [];
  if (convoId) {
    const convo = await getConversation(user.id, convoId);
    if (convo) history = convo.messages.map((m) => ({ role: m.role, content: m.content }));
  }
  history.push(userMsg);

  // Streaming-redactor for the live "thinking" feed: drop anything between
  // triple-backtick fences so a model that misbehaves and starts pasting
  // place-script source mid-reasoning never reaches the browser.
  let fenceOpen = false;
  let pending = ""; // partial-fence buffer at the tail of each chunk
  const safeStreamThinking = (chunk) => {
    if (!chunk) return;
    let buf = pending + chunk;
    pending = "";
    let out = "";
    while (buf.length) {
      const idx = buf.indexOf("```");
      if (idx === -1) {
        // No fence in the remaining buffer. Hold the last 2 chars in case the
        // fence is being split across chunks (``` could arrive in two parts).
        if (!fenceOpen) {
          if (buf.length > 2) { out += buf.slice(0, -2); pending = buf.slice(-2); }
          else { pending = buf; }
        }
        // If a fence is open, drop everything — wait for the close.
        break;
      }
      if (!fenceOpen) {
        out += buf.slice(0, idx);
        out += "[code omitted — sent to Studio]";
        fenceOpen = true;
        buf = buf.slice(idx + 3);
      } else {
        // Inside a fence: skip up to and including the close.
        fenceOpen = false;
        buf = buf.slice(idx + 3);
      }
    }
    if (out) send("thinking", { chunk: out });
  };

  try {
    const chatFn = link.model === "opus-4.8" ? runChatLightning : runChat;
    const { thinking, reply, actions, plan, truncated, salvaged } = await chatFn({
      apiKey: link.apiKey,
      model: link.model,
      history,
      thinkMode,
      mode,
      webSearch,
      context: link.context,
      signal: ctrl.signal,
      onThinking: safeStreamThinking,
      onStatus: (s) => send("status", { status: s }),
    });
    // If a plan was returned, treat this as a "plan-only" turn — don't queue
    // any build actions even if the model accidentally emitted some, because
    // the user hasn't approved yet.
    const buildActions = plan ? [] : actions.filter((a) => a && a.type);

    // Persist the turn to the user's conversation. Store the user-safe
    // reply (with code blocks redacted) so reloaded history matches what the
    // user saw the first time.
    convoId = await appendMessage(user.id, convoId, userMsg);
    await appendMessage(user.id, convoId, { role: "assistant", content: redactCodeBlocks(reply) });

    // Keep the ephemeral link.history in sync for the in-Studio plugin chat view.
    link.history = (await getConversation(user.id, convoId))?.messages.map((m) => ({ role: m.role, content: m.content })) || [];

    const queuedIds = buildActions.length ? queueActions(link, buildActions) : [];
    // Charge one credit for the successful generation.
    const { credits } = await spendCredit(user.id);
    // Privacy: the plugin runs these actions with its own token. Strip
    // script bodies (and any fenced code blocks the model snuck into prose)
    // from the browser-facing payload.
    const safeActions = redactActionsForBrowser(buildActions);
    const safeReply = redactCodeBlocks(reply);
    const safeThinking = redactCodeBlocks(thinking);
    send("done", {
      thinking: safeThinking, reply: safeReply, plan, actions: safeActions, queued: queuedIds.length,
      truncated, salvaged, credits, convoId,
    });
  } catch (err) {
    // Only treat as a real user-abort if the signal actually fired or the
    // error is a proper AbortError. Don't pattern-match on the error message
    // — upstream errors sometimes contain the word "aborted" by coincidence
    // and we'd incorrectly tell the UI the user stopped.
    const wasAborted = ctrl.signal.aborted || err?.name === "AbortError";
    if (wasAborted) {
      try { send("aborted", { ok: true }); } catch {}
    } else {
      send("error", { error: String(err.message || err) });
    }
  } finally {
    res.off("close", onResClose);
    res.end();
  }
});

// Optimize a rough user prompt into a clearer, more specific Roblox build
// prompt. Fast, free utility — uses think=off, no credit charge.
app.post("/api/optimize", async (req, res) => {
  const link = requireWebSession(req, res);
  if (!link) return;
  if (!link.apiKey) return res.status(400).json({ error: "no API key set for this session" });

  const prompt = (req.body?.prompt || "").toString().trim();
  if (!prompt) return res.status(400).json({ error: "empty prompt" });

  try {
    const { content } = await streamOnce({
      apiKey: link.apiKey,
      model: link.model,
      messages: [
        {
          role: "system",
          content:
            "You are a prompt optimizer for a Roblox Studio AI builder. " +
            "The user will give you a rough idea. Rewrite it into a clearer, more specific prompt " +
            "that will produce a great Roblox build. Follow these rules:\n" +
            "- Add relevant Roblox context (service names, class names, common patterns) where appropriate.\n" +
            "- Structure multi-part requests into numbered steps or clear sections.\n" +
            "- Be specific about what to build, where to place it, and how it should behave.\n" +
            "- Keep it concise — do not over-engineer.\n" +
            "- Return ONLY the improved prompt text. No markdown fences, no JSON wrapper, no preamble.",
        },
        { role: "user", content: `Improve this prompt:\n\n${prompt}` },
      ],
      think: "off",
    });
    const optimized = (content || "").trim() || prompt;
    res.json({ optimized });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
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
    const chatFn = link.model === "opus-4.8" ? runChatLightning : runChat;
    const { thinking, reply, actions } = await chatFn({
      apiKey: link.apiKey, model: link.model, history: link.history,
      context: link.context,
    });
    link.history.push({ role: "assistant", content: reply });
    const buildActions = actions.filter((a) => a && a.type);
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
