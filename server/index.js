import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLink, getLink, getLinkByCode, getLinkByToken,
  confirmLink, queueActions, drainQueue, setContext, appendContextNote,
} from "./store.js";
import {
  runChat, isAvailableModel, isModelGated, modelCost, streamOnce,
  listAvailableModels,
} from "./ai.js";
import {
  registerAuthRoutes, requireUser, currentUser, authConfigured,
} from "./auth.js";
import {
  spendCredit, markIntroSeen, publicUser, getUser, syncUser,
  ready as usersReady, effectiveRoles, setManualRole, allUsers, reloadAll,
  markChangelogSeen,
} from "./users.js";
import {
  ready as convosReady,
  listConversations, getConversation, createConversation, deleteConversation,
  appendMessage,
} from "./convos.js";
import {
  ready as settingsReady, resolveKey, setApiKey, listApiKeyNames,
  listChangelog, addChangelog, removeChangelog,
} from "./settings.js";

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
  const user = currentUser(req);
  const { model } = req.body || {};
  // Gateway key is server-side only and can be rotated without changing the UI.
  link.apiKey = resolveKey("QWEN_API_KEY", "");
  if (typeof model === "string" && model.trim()) {
    const requested = model.trim();
    if (!isAvailableModel(requested)) {
      return res.status(400).json({ error: `Unknown model '${requested}'.` });
    }
    // Block gated models unless the user has the tester role.
    if (isModelGated(requested)) {
      const roles = user ? effectiveRoles(user) : { tester: false, admin: false };
      if (!roles.tester) {
        return res.status(403).json({ error: `Model '${requested}' is restricted to testers.` });
      }
    }
    link.model = requested;
  }
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

// Plugin pings this on boot with its stored token to make sure the server
// still recognizes it. Fixes the "shows Linked even when it's not" bug — a
// 401 here makes the plugin clear its stored token and go to the unlinked
// state instead of pretending it's connected.
app.post("/api/link/verify", (req, res) => {
  const link = getLinkByToken(bearer(req));
  if (!link) return res.status(401).json({ error: "invalid plugin token" });
  res.json({
    ok: true,
    linkId: link.linkId,
    user: link.roblox,
    model: link.model,
    hasKey: !!link.apiKey,
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
  const roles = effectiveRoles(user);
  // Re-check gating in case the user swapped models mid-session.
  if (isModelGated(link.model) && !roles.tester) {
    return res.status(403).json({ error: `Model '${link.model}' is restricted to testers.` });
  }
  const cost = modelCost(link.model);
  // Testers don't pay credits.
  if (!roles.tester && user.credits < cost) {
    return res.status(402).json({ error: `not enough credits — this model costs ${cost}`, credits: user.credits, cost });
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
  // finished writing, we abort the upstream model fetch so it stops
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
    const { thinking, reply, actions, plan, truncated, salvaged } = await runChat({
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
    // Prepend an undo-point action before every build batch so the user
    // can revert the entire AI turn in one Studio undo step.
    const buildActions = plan ? [] : actions.filter((a) => a && a.type);
    if (buildActions.length > 1) {
      buildActions.unshift({ type: "set_property", path: "Workspace", properties: {} });
    }

    // Persist the turn to the user's conversation. Store the user-safe
    // reply (with code blocks redacted) so reloaded history matches what the
    // user saw the first time.
    convoId = await appendMessage(user.id, convoId, userMsg);
    await appendMessage(user.id, convoId, { role: "assistant", content: redactCodeBlocks(reply) });

    // Keep the ephemeral link.history in sync for the in-Studio plugin chat view.
    link.history = (await getConversation(user.id, convoId))?.messages.map((m) => ({ role: m.role, content: m.content })) || [];

    const queuedIds = buildActions.length ? queueActions(link, buildActions) : [];
    // Charge per-model credits for the successful generation — unless the user
    // is a tester (unlimited).
    let credits = user.credits;
    if (!roles.tester) {
      const r = await spendCredit(user.id, cost);
      credits = r.credits;
    }
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
// When append=true, the context text is APPENDED as a transient note instead of
// replacing the snapshot. Used by find_code/read_script to inject searched
// script bodies into the next chat turn.
app.post("/api/context", (req, res) => {
  const link = requirePlugin(req, res);
  if (!link) return;
  const context = (req.body?.context ?? "").toString();
  const append = req.body?.append === true;
  const size = append
    ? appendContextNote(link, context)
    : setContext(link, context);
  res.json({ ok: true, size });
});

// === MODEL CATALOG / CHANGELOG / ADMIN =====================================

// The only models Spider exposes. IDs map directly to the Railway gateway.
app.get("/api/models", async (_req, res) => {
  res.json({ models: listAvailableModels() });
});

// Public-readable changelog for the UI's "What's new" panel.
app.get("/api/changelog", (req, res) => {
  const scope = (req.query.scope || "").toString();
  const all = listChangelog();
  const filtered = scope ? all.filter((e) => e.scope === scope || e.scope === "both") : all;
  res.json({ entries: filtered });
});

// User acknowledges they've read up to `at`.
app.post("/api/changelog/seen", requireUser, async (req, res) => {
  await markChangelogSeen(req.user.id, Number(req.body?.at) || Date.now());
  res.json({ ok: true });
});

function requireAdmin(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "not logged in" });
  const r = effectiveRoles(u);
  if (!r.admin) return res.status(403).json({ error: "admin only" });
  req.user = u;
  next();
}

// Admin: list / set / delete API keys (rotated at runtime, no redeploy).
app.get("/api/admin/keys", requireAdmin, (req, res) => {
  // Return only the names — never the values.
  const env = ["QWEN_API_KEY"];
  const overridden = listApiKeyNames();
  res.json({ keys: env.map((name) => ({ name, overridden: overridden.includes(name) })) });
});

app.post("/api/admin/keys", requireAdmin, (req, res) => {
  const { name, value } = req.body || {};
  if (!name || typeof name !== "string") return res.status(400).json({ error: "name required" });
  setApiKey(name, typeof value === "string" ? value : "");
  res.json({ ok: true });
});

// Admin: changelog entries (POST broadcasts to the Discord channel as well).
app.post("/api/admin/changelog", requireAdmin, async (req, res) => {
  const { title, body, scope } = req.body || {};
  const entry = addChangelog({ title, body, scope, author: req.user.globalName || req.user.username });
  // Fire-and-forget — push to Discord if the bot is loaded.
  try {
    const mod = await import("./bot.js");
    if (mod.postChangelog) mod.postChangelog(entry).catch(() => {});
  } catch {}
  res.json({ ok: true, entry });
});

app.delete("/api/admin/changelog/:id", requireAdmin, (req, res) => {
  removeChangelog(req.params.id);
  res.json({ ok: true });
});

// Admin: roster + manual role overrides.
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  await reloadAll();
  const list = allUsers().map((u) => ({
    id: u.id, username: u.username, globalName: u.globalName,
    credits: u.credits, roles: effectiveRoles(u),
    discordRoles: u.roles || {}, manualRoles: u.manualRoles || {},
  }));
  res.json({ users: list });
});
app.post("/api/admin/users/:id/role", requireAdmin, async (req, res) => {
  const { role, on } = req.body || {};
  const out = await setManualRole(req.params.id, role, !!on);
  if (!out) return res.status(404).json({ error: "user not found or invalid role" });
  res.json({ ok: true, roles: out });
});

// Plugin can also send a chat message directly (in-Studio chat box).
app.post("/api/plugin/chat", async (req, res) => {
  const link = requirePlugin(req, res);
  if (!link) return;
  if (!link.apiKey) return res.status(400).json({ error: "no API key set on the website yet" });

  // Charge the session owner's credits (same pool as the website).
  const owner = link.ownerId ? getUser(link.ownerId) : null;
  const ownerRoles = owner ? effectiveRoles(owner) : { tester: false, admin: false };
  const cost = modelCost(link.model);
  if (owner && !ownerRoles.tester && owner.credits < cost) {
    return res.status(402).json({ error: `not enough credits — this model costs ${cost}. Top up on the website.`, credits: owner.credits, cost });
  }

  const message = (req.body?.message || "").toString();
  if (!message.trim()) return res.status(400).json({ error: "empty message" });

  // Persist plugin chat to the owner's conversation store so memory survives
  // server restarts and is shared with the browser chat.
  let history = link.history || [];
  if (owner) {
    try {
      link.pluginConvoId = await appendMessage(owner.id, link.pluginConvoId, { role: "user", content: message });
      const convo = await getConversation(owner.id, link.pluginConvoId);
      if (convo) history = convo.messages.map((m) => ({ role: m.role, content: m.content }));
    } catch { /* fall back to ephemeral history */ }
  }
  if (!history.length || history[history.length - 1]?.content !== message) {
    history.push({ role: "user", content: message });
  }
  link.history = history;

  try {
    const { thinking, reply, actions } = await runChat({
      apiKey: link.apiKey, model: link.model, history: link.history,
      context: link.context,
    });
    link.history.push({ role: "assistant", content: reply });
    // Persist the assistant response too.
    if (owner) {
      try {
        link.pluginConvoId = await appendMessage(owner.id, link.pluginConvoId, { role: "assistant", content: reply });
      } catch { /* non-critical */ }
    }
    const buildActions = actions.filter((a) => a && a.type);
    const queued = buildActions.length ? queueActions(link, buildActions) : [];
    let credits;
    if (owner && !ownerRoles.tester) credits = (await spendCredit(owner.id, cost)).credits;
    else if (owner) credits = owner.credits;
    res.json({ thinking, reply, actions: buildActions, queued: queued.length, credits });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// === STATIC SITE ===========================================================
// Always download the plugin directly from the canonical source file so the
// website cannot drift behind the version shipped in this repository.
app.get("/download/plugin", (_req, res) => {
  const pluginPath = path.join(__dirname, "..", "plugin", "FreeModelAI.server.lua");
  res.download(pluginPath, "SpiderAI.server.lua");
});

// allow dotfiles so /.well-known/security.txt is served (trust signal).
app.use(express.static(path.join(__dirname, "..", "public"), { dotfiles: "allow" }));

const PORT = process.env.PORT || 3000;
// Wait for the persistent stores (Redis or file) to load before serving.
Promise.all([usersReady, convosReady, settingsReady]).then(() => {
  app.listen(PORT, () => {
    console.log(`Spider bridge running on http://localhost:${PORT}`);
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
