const API = ""; // same origin as the server
const $ = (id) => document.getElementById(id);
const state = { linkId: null, linked: false, pollTimer: null, resultTimer: null, attachments: [], credits: null, user: null, mode: "build", webSearch: false, convoId: null, sending: false, abortCtrl: null, userStopped: false, abortShown: false, undoPoint: 0 };

// ---- auth gate ------------------------------------------------------------
// On load: ask who we are. Show the login screen until authenticated, then
// reveal the app and (on first login) the onboarding intro.
async function init() {
  let me;
  try { me = await get("/api/me"); }
  catch { me = { authConfigured: false, user: null }; }

  if (!me.user) {
    // Not logged in — show the gate.
    const params = new URLSearchParams(location.search);
    if (params.get("login") === "failed") {
      const note = $("authNote");
      note.textContent = "Login failed or was cancelled. Try again.";
      note.classList.add("err");
    }
    if (!me.authConfigured) {
      const note = $("authNote");
      note.textContent = "Discord login isn't configured yet. See SETUP.md.";
      note.classList.add("err");
      $("loginBtn").addEventListener("click", (e) => e.preventDefault());
    }
    $("authGate").hidden = false;
    return;
  }

  // Logged in — populate account, reveal the app.
  state.user = me.user;
  setCredits(me.user.credits);
  $("userName").textContent = me.user.globalName || me.user.username;
  const av = me.user.avatar
    ? `https://cdn.discordapp.com/avatars/${me.user.id}/${me.user.avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${(Number(me.user.id) >> 22) % 6}.png`;
  $("userAvatar").src = av;
  $("authGate").hidden = true;
  $("shell").hidden = false;

  // Show active role badges under the account name.
  renderRoleBadges(me.user.roles);

  // Populate the model dropdown from the server (honors gating).
  await loadModelList();

  if (!me.user.seenIntro) showIntro();

  // Auto-resume the most recent conversation so memory feels continuous
  // across page reloads. New chat button still clears this.
  try {
    const { conversations } = await get("/api/conversations");
    if (Array.isArray(conversations) && conversations.length) {
      const top = conversations[0];
      if (top && top.count > 0) {
        await loadConversation(top.id);
      }
    }
  } catch { /* if history fails, just start fresh */ }

  // Poll for new changelog entries since the user last checked.
  checkChangelogDot();
}

function showIntro() { $("introModal").hidden = false; }
function renderRoleBadges(roles) {
  const el = $("roleBadges"); if (!el) return;
  el.innerHTML = "";
  if (roles) {
    if (roles.admin) { const b = document.createElement("span"); b.className = "role-badge admin"; b.textContent = "ADMIN"; el.appendChild(b); }
    if (roles.tester) { const b = document.createElement("span"); b.className = "role-badge tester"; b.textContent = "TESTER"; el.appendChild(b); }
  }
}
async function loadModelList() {
  try {
    const { models } = await get("/api/models");
    const sel = $("model");
    sel.innerHTML = "";
    for (const m of models || []) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.label}${m.gated ? " (tester)" : ""}`;
      if (m.gated) opt.disabled = true;
      sel.appendChild(opt);
    }
  } catch { /* silently keep the existing options */ }
}
async function checkChangelogDot() {
  try {
    const { entries } = await get("/api/changelog");
    if (entries.length) {
      const latest = entries[0].at;
      if (latest > (state.user?.lastChangelogSeenAt || 0)) {
        $("changelogBtn").classList.add("dot");
      }
    }
  } catch {}
}

// ---- account info block — add role badges row -------------------------------
function addRoleRow() {
  const account = $("account");
  const row = document.createElement("div");
  row.id = "roleBadges";
  row.style.cssText = "display:flex;gap:4px;margin-top:2px;";
  account.querySelector(".account-text")?.appendChild(row);
}
addRoleRow();

// ---- changelog drawer -------------------------------------------------------
$("changelogBtn").addEventListener("click", async () => {
  openDrawer("changelogDrawer");
  const list = $("changelogList");
  list.innerHTML = '<div class="drawer-empty">Loading…</div>';
  try {
    const { entries } = await get("/api/changelog");
    if (!entries.length) { list.innerHTML = '<div class="drawer-empty">No entries yet.</div>'; return; }
    list.innerHTML = "";
    for (const e of entries) {
      const div = document.createElement("div");
      div.className = "changelog-entry";
      const scopeTag = e.scope === "plugin" ? "Plugin" : e.scope === "website" ? "Website" : "Both";
      div.innerHTML =
        `<div class="chead"><span class="ctitle">${escapeHtml(e.title)}</span><span class="cscope cscope-${e.scope}">${scopeTag}</span></div>
         <div class="cbody">${escapeHtml(e.body || "")}</div>
         <div class="cmeta">${timeAgo(e.at)} · by ${escapeHtml(e.author || "admin")}</div>`;
      list.appendChild(div);
    }
    // Mark as seen so the dot goes away.
    if (entries[0].at > (state.user?.lastChangelogSeenAt || 0)) {
      try { await post("/api/changelog/seen", { at: entries[0].at }); } catch {}
      $("changelogBtn").classList.remove("dot");
    }
  } catch (e) { list.innerHTML = `<div class="drawer-empty">Couldn't load: ${escapeHtml(e.message)}</div>`; }
});
$("introClose").addEventListener("click", async () => {
  $("introModal").hidden = true;
  try { await post("/api/intro-seen", {}); } catch { /* non-critical */ }
});
$("helpBtn").addEventListener("click", () => { $("introModal").hidden = false; });
$("logoutBtn").addEventListener("click", async () => {
  try { await post("/auth/logout", {}); } catch { /* ignore */ }
  location.reload();
});

// ---- credits --------------------------------------------------------------
function setCredits(n) {
  if (n === null || n === undefined) return;
  state.credits = n;
  const low = n <= 3;
  $("creditsNum").textContent = n;
  $("creditsBadgeNum").textContent = n;
  $("creditsLine").classList.toggle("low", low);
  $("creditsBadge").classList.toggle("low", low);
  // Block sending when out of credits — but never override the live Stop state.
  if (!state.sending) {
    const out = n <= 0;
    $("sendBtn").disabled = out;
  }
  $("chatInput").placeholder = n <= 0
    ? "Out of credits — ask an admin to top you up."
    : state.mode === "model"
      ? "Describe a model to create…  (e.g. a wooden cart, a sci-fi door)"
      : "Describe what to build…  (Shift + Enter for a new line)";
}

// ---- step 1: session start (no API key needed) ----------------------------
$("saveKey").addEventListener("click", async () => {
  const model = $("model").value;
  const status = $("keyStatus");

  setStatus(status, "Starting session…");
  try {
    if (!state.linkId) {
      const s = await post("/api/session/start", {});
      state.linkId = s.linkId;
      showCode(s.code);
    }
    await post("/api/session/config", { linkId: state.linkId, model });
    setStatus(status, "Session started. Now link the plugin →", "ok");
    unlock("step-link");
    startStatusPolling();
  } catch (e) {
    setStatus(status, e.message, "err");
  }
});

function showCode(code) {
  $("pairCode").textContent = code.split("").join(" ");
  $("linkStatus").textContent = "Waiting for the plugin…";
}

// ---- step 2: poll for link status ----------------------------------------
function startStatusPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    try {
      const s = await get(`/api/session/status?linkId=${state.linkId}`);
      if (s.credits !== null && s.credits !== undefined) setCredits(s.credits);
      if (s.linked && !state.linked) {
        state.linked = true;
        clearInterval(state.pollTimer); state.pollTimer = null;
        const who = s.roblox
          ? `Linked to ${s.roblox.userName}${s.roblox.userId ? ` (#${s.roblox.userId})` : ""}`
          : "Linked";
        setStatus($("linkStatus"), who, "ok");
        $("whoLinked").textContent = who + " — building in this place.";
        $("whoLinked").classList.add("live");
        $("connDot").classList.add("on");
        $("connText").textContent = "Connected";
        unlock("step-chat");
        startResultPolling();
        $("chatInput").focus();
      }
    } catch { /* keep trying */ }
  }, 1500);
}

// ---- composer: model-mode toggle -----------------------------------------
$("modelBtn").addEventListener("click", () => {
  state.mode = state.mode === "model" ? "build" : "model";
  const on = state.mode === "model";
  $("modelBtn").setAttribute("aria-pressed", on ? "true" : "false");
  if (state.credits > 0) {
    $("chatInput").placeholder = on
      ? "Describe a model to create…  (e.g. a wooden cart, a sci-fi door)"
      : "Describe what to build…  (Shift + Enter for a new line)";
  }
  $("chatInput").focus();
});

// Web search toggle
$("webSearchBtn").addEventListener("click", () => {
  state.webSearch = !state.webSearch;
  $("webSearchBtn").setAttribute("aria-pressed", state.webSearch ? "true" : "false");
  flash(state.webSearch ? "Web search enabled" : "Web search disabled");
  $("chatInput").focus();
});

// Animate button — coming soon
$("animateBtn").addEventListener("click", () => {
  flash("🎬 Live Animation Creator is coming soon — upload a video, AI maps the motion to your R15 rig.");
});

// Optimize prompt drawer
$("optimizeBtn").addEventListener("click", () => {
  const current = $("chatInput").value.trim();
  if (current) $("optimizeInput").value = current;
  openDrawer("optimizeDrawer");
  $("optimizeInput").focus();
});

// ---- composer: attachments ------------------------------------------------
$("attachBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (e) => {
  for (const file of e.target.files) addAttachment(file);
  e.target.value = ""; // allow re-selecting the same file
});

// Pasting: images become attachments; a large blob of text (e.g. a pasted
// script) becomes a file attachment instead of flooding the input box.
const PASTE_AS_FILE_CHARS = 600; // longer than this -> attach instead of inline
$("chatInput").addEventListener("paste", (e) => {
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const f = item.getAsFile();
      if (f) addAttachment(f);
      return;
    }
  }
  const text = e.clipboardData?.getData("text/plain") || "";
  const looksLikeCode = /\n/.test(text) && /[{};()=]|local |function |end\b/.test(text);
  if (text.length > PASTE_AS_FILE_CHARS && looksLikeCode) {
    e.preventDefault();
    const blob = new File([text], `pasted-${pasteCount++}.lua`, { type: "text/plain" });
    addAttachment(blob);
    flash("Pasted script attached as a file so it doesn't fill the box.");
  }
});
let pasteCount = 1;

const MAX_FILE = 18 * 1024 * 1024; // 18MB
function addAttachment(file) {
  if (file.size > MAX_FILE) { flash(`"${file.name}" is too large (max 18MB).`); return; }
  const isImage = file.type.startsWith("image/");
  const reader = new FileReader();
  reader.onload = () => {
    const att = isImage
      ? { kind: "image", name: file.name, dataUrl: reader.result }
      : { kind: "text", name: file.name, text: reader.result };
    state.attachments.push(att);
    renderAttachments();
  };
  if (isImage) reader.readAsDataURL(file);
  else reader.readAsText(file);
}

function renderAttachments() {
  const row = $("attachRow");
  row.innerHTML = "";
  state.attachments.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = "thumb";
    chip.innerHTML = a.kind === "image"
      ? `<img src="${a.dataUrl}" alt="" /><span class="name">${escapeHtml(a.name)}</span>`
      : `<span>📄</span><span class="name">${escapeHtml(a.name)}</span>`;
    const x = document.createElement("span");
    x.className = "x"; x.textContent = "✕";
    x.onclick = () => { state.attachments.splice(i, 1); renderAttachments(); };
    chip.appendChild(x);
    row.appendChild(chip);
  });
}

// ---- composer: textarea behavior + chips ----------------------------------
const input = $("chatInput");
input.addEventListener("input", autoGrow);
function autoGrow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 240) + "px"; }
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chatForm").requestSubmit(); }
});
document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => { input.value = chip.textContent; autoGrow(); input.focus(); });
});

// ---- chat submit ----------------------------------------------------------
$("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.sending) return; // the form's Send button is repurposed as Stop while sending
  const text = input.value.trim();
  const atts = state.attachments.slice();
  if (!text && atts.length === 0) return;

  input.value = ""; autoGrow();
  state.attachments = []; renderAttachments();
  await sendChat(text, null, atts);
});

// Core send pipeline — used by both the form submit AND the plan "Build it"
// button. `displayText` lets the plan-approval flow send a verbose message
// to the AI while showing the user a clean short bubble.
async function sendChat(text, displayText, attachments) {
  const atts = Array.isArray(attachments) ? attachments : [];
  if (!text && atts.length === 0) return;

  const empty = $("emptyState"); if (empty) empty.remove();
  addMsg("user", displayText || text, 0, atts);

  const think = addThinking();
  const statusEl = addStatusLine();

  const ctrl = new AbortController();
  state.abortCtrl = ctrl;
  setSendingState(true);

  try {
    await streamChat(text, atts, $("thinkMode").value, {
      signal: ctrl.signal,
      onThinking: (chunk) => think.append(chunk),
      onStatus: (s) => statusEl.set(s),
      onAborted: () => {
        think.finish(); // keep the partial thinking visible, collapsed
        statusEl.remove();
        // Only show "Stopped" when the user actually clicked Stop. If the
        // server sent `aborted` for some other reason, this is silent —
        // the catch block will surface a real error if there is one.
        if (state.userStopped && !state.abortShown) {
          addMsg("sys", "⏸ Stopped.");
          state.abortShown = true;
        }
      },
      onDone: ({ reply, plan, queued, thinking, truncated, salvaged, credits, convoId }) => {
        think.finish(thinking);
        statusEl.remove();
        if (plan) {
          addPlanCard(plan, reply);
        } else {
          addMsg("ai", reply, queued, null, { truncated, salvaged });
        }
        if (credits !== undefined) setCredits(credits);
        if (convoId) state.convoId = convoId;
      },
      onError: (msg) => { think.remove(); statusEl.remove(); addMsg("sys", "Error: " + msg); },
    });
  } catch (err) {
    // AbortError means the fetch was cancelled. We only show "Stopped" when
    // WE were the ones who triggered it (via the Stop button) — otherwise
    // the connection dropped for some other reason and the user should see
    // a real error, not a misleading "Stopped" toast.
    if (err && err.name === "AbortError") {
      think.finish();
      statusEl.remove();
      if (state.abortShown) {
        // user clicked Stop — onAborted may have already added the message
      } else if (state.userStopped) {
        addMsg("sys", "⏸ Stopped.");
        state.abortShown = true;
      } else {
        addMsg("sys", "Connection lost.");
      }
    } else {
      think.remove(); statusEl.remove();
      addMsg("sys", "Error: " + (err.message || err));
    }
  } finally {
    state.abortCtrl = null;
    state.abortShown = false;
    state.userStopped = false;
    setSendingState(false);
    input.focus();
  }
}

// Swap the Send button into Stop mode (and back). When sending, the button
// ignores form submit and becomes a click-to-abort control.
const SEND_HTML = '<span>Send</span><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
const STOP_HTML = '<span>Stop</span><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

function setSendingState(sending) {
  state.sending = sending;
  const btn = $("sendBtn");
  if (sending) {
    btn.classList.add("stopping");
    btn.innerHTML = STOP_HTML;
    btn.type = "button";
    btn.disabled = false;
    btn.title = "Stop generating";
    btn.onclick = stopCurrent;
  } else {
    btn.classList.remove("stopping");
    btn.innerHTML = SEND_HTML;
    btn.type = "submit";
    btn.title = "Send";
    btn.onclick = null;
    btn.disabled = state.credits !== null && state.credits <= 0;
  }
}

function stopCurrent() {
  if (!state.abortCtrl) return;
  state.userStopped = true;
  state.abortShown = true;
  try { state.abortCtrl.abort(); } catch {}
}

// Read the SSE stream and dispatch events.
async function streamChat(message, attachments, thinkMode, { onThinking, onStatus, onDone, onError, onAborted, signal }) {
  const r = await fetch(API + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ linkId: state.linkId, message, attachments, thinkMode, mode: state.mode, webSearch: state.webSearch, convoId: state.convoId }),
    signal,
  });
  if (!r.ok || !r.body) {
    const data = await r.json().catch(() => ({}));
    return onError(data.error || `HTTP ${r.status}`);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const block of parts) {
      let event = "message", data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let payload; try { payload = JSON.parse(data); } catch { continue; }
      if (event === "thinking") onThinking(payload.chunk || "");
      else if (event === "status") onStatus(payload.status || "");
      else if (event === "done") onDone(payload);
      else if (event === "aborted") onAborted && onAborted();
      else if (event === "error") onError(payload.error || "stream error");
    }
  }
}

// Poll for plugin execution results.
function startResultPolling() {
  state.resultTimer = setInterval(async () => {
    try {
      const r = await get(`/api/results?linkId=${state.linkId}`);
      for (const res of r.results || []) {
        const ok = res.ok !== false;
        addResult(`${ok ? "✓" : "✕"} ${res.summary || res.type || "action"}${res.error ? " — " + res.error : ""}`, ok);
      }
    } catch { /* ignore */ }
  }, 1500);
}

// ---- ui helpers -----------------------------------------------------------
function addMsg(kind, text, queued, attachments, meta) {
  const div = document.createElement("div");
  div.className = "msg " + kind;
  if (text) div.textContent = text;
  if (attachments && attachments.length) {
    const imgs = attachments.filter((a) => a.kind === "image");
    if (imgs.length) {
      const wrap = document.createElement("div"); wrap.className = "imgs";
      imgs.forEach((a) => { const im = document.createElement("img"); im.src = a.dataUrl; wrap.appendChild(im); });
      div.appendChild(wrap);
    }
    const files = attachments.filter((a) => a.kind === "text");
    if (files.length) {
      const tag = document.createElement("div"); tag.className = "actions-tag";
      tag.textContent = "📄 " + files.map((f) => f.name).join(", ");
      div.appendChild(tag);
    }
  }
  if (queued) {
    const tag = document.createElement("div");
    tag.className = "actions-tag";
    tag.textContent = `→ sent ${queued} action${queued > 1 ? "s" : ""} to Studio`;
    div.appendChild(tag);
  }
  if (meta && meta.truncated) {
    const w = document.createElement("span"); w.className = "warn-tag";
    w.textContent = "⚠ Hit the length limit — the build may be partial. Ask me to continue.";
    div.appendChild(w);
  } else if (meta && meta.salvaged) {
    const w = document.createElement("span"); w.className = "warn-tag";
    w.textContent = "⚠ Recovered a malformed response; some actions may be missing.";
    div.appendChild(w);
  }
  $("chat").appendChild(div);
  $("chat").scrollTop = $("chat").scrollHeight;
}

function addResult(text, ok) {
  const div = document.createElement("div");
  div.className = "msg sys act-result " + (ok ? "ok" : "err");
  div.textContent = text;
  $("chat").appendChild(div);
  $("chat").scrollTop = $("chat").scrollHeight;
}

function addStatusLine() {
  const div = document.createElement("div");
  div.className = "status-line"; div.style.display = "none";
  $("chat").appendChild(div);
  return {
    set(s) { div.textContent = s; div.style.display = s ? "block" : "none"; $("chat").scrollTop = $("chat").scrollHeight; },
    remove() { div.remove(); },
  };
}

function addThinking() {
  const wrap = document.createElement("div");
  wrap.className = "msg think";
  const head = document.createElement("div");
  head.className = "think-head";
  head.innerHTML = '<span class="dot"></span> Thinking…';
  const body = document.createElement("div");
  body.className = "think-body";
  wrap.appendChild(head); wrap.appendChild(body);
  $("chat").appendChild(wrap);
  $("chat").scrollTop = $("chat").scrollHeight;

  let text = "";
  head.addEventListener("click", () => { if (wrap.classList.contains("done")) wrap.classList.toggle("collapsed"); });
  return {
    append(chunk) { text += chunk; body.textContent = text; $("chat").scrollTop = $("chat").scrollHeight; },
    finish(finalText) {
      if (finalText && !text) { text = finalText; body.textContent = finalText; }
      if (!text) { wrap.remove(); return; }
      head.innerHTML = '💭 Thought process <span class="caret">▸</span>';
      wrap.classList.add("done", "collapsed");
    },
    remove() { wrap.remove(); },
  };
}

// Render the AI's structured build plan. The user picks which optional ideas
// to include via checkboxes, then "Build it" sends an approval message that
// embeds the full plan + selections so the AI can execute it on the next turn.
function addPlanCard(plan, intro) {
  const ideas = Array.isArray(plan.ideas) ? plan.ideas : [];
  const steps = Array.isArray(plan.steps) ? plan.steps : [];

  const wrap = document.createElement("div");
  wrap.className = "msg ai plan-card";

  const introHtml = intro ? `<div class="plan-intro">${escapeHtml(intro)}</div>` : "";
  const summaryHtml = plan.summary ? `<div class="plan-summary">${escapeHtml(plan.summary)}</div>` : "";
  const stepsHtml = steps.length
    ? `<div class="plan-section-h">📋 Build steps</div>
       <ol class="plan-steps">${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>`
    : "";
  const ideasHtml = ideas.length
    ? `<div class="plan-section-h">✨ Optional extras — tick the ones you want</div>
       <div class="plan-ideas">${ideas.map((i, idx) => `
         <label class="plan-idea">
           <input type="checkbox" data-idx="${idx}" ${i.default ? "checked" : ""}/>
           <span class="plan-idea-label">${escapeHtml(i.label || "")}</span>
         </label>
       `).join("")}</div>`
    : "";

  wrap.innerHTML = `
    ${introHtml}
    <div class="plan-head">
      <span class="plan-emoji">🛠️</span>
      <div class="plan-title">${escapeHtml(plan.title || "Plan")}</div>
    </div>
    ${summaryHtml}
    ${stepsHtml}
    ${ideasHtml}
    <div class="plan-actions">
      <button class="primary plan-build" type="button">🚀 Build it</button>
      <button class="ghost plan-cancel" type="button">Cancel</button>
    </div>
  `;

  const buildBtn = wrap.querySelector(".plan-build");
  const cancelBtn = wrap.querySelector(".plan-cancel");

  buildBtn.addEventListener("click", () => {
    // Lock the card so the user can't double-fire.
    buildBtn.disabled = true; cancelBtn.disabled = true;
    buildBtn.textContent = "Building…";
    wrap.classList.add("approved");
    wrap.querySelectorAll(".plan-idea input").forEach((cb) => { cb.disabled = true; });

    // Collect user's choices.
    const include = [], skip = [];
    wrap.querySelectorAll(".plan-idea input").forEach((cb) => {
      const idx = Number(cb.dataset.idx);
      const i = ideas[idx];
      if (!i) return;
      (cb.checked ? include : skip).push(i);
    });

    // Verbose approval message for the AI (full context — it doesn't need to
    // remember its own plan structure).
    const lines = [
      `[Approved plan: "${plan.title || "Plan"}"]`,
      "",
      "Execute these steps, in order:",
      ...steps.map((s, i) => `${i + 1}. ${s}`),
    ];
    if (include.length) {
      lines.push("", "Include these optional ideas (build them too):");
      for (const i of include) lines.push(`- ${i.label}`);
    }
    if (skip.length) {
      lines.push("", "Skip these (user unchecked them — do NOT build):");
      for (const i of skip) lines.push(`- ${i.label}`);
    }
    lines.push("", "Emit the full set of build actions now. Do NOT return another plan.");
    const fullMsg = lines.join("\n");

    const extras = include.length ? ` + ${include.length} extra${include.length > 1 ? "s" : ""}` : "";
    const display = `✓ Build the plan${extras}`;
    sendChat(fullMsg, display, []);
  });

  cancelBtn.addEventListener("click", () => {
    wrap.remove();
    addMsg("sys", "Plan cancelled. Tell me what to change.");
    input.focus();
  });

  $("chat").appendChild(wrap);
  $("chat").scrollTop = $("chat").scrollHeight;
}

function unlock(id) { $(id).classList.remove("locked"); }
function setStatus(el, msg, cls) { el.textContent = msg; el.className = "status" + (cls ? " " + cls : ""); }
function flash(msg) { const s = $("keyStatus"); setStatus(s, msg, "err"); setTimeout(() => setStatus(s, ""), 4000); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

// ---- drawers (history) ----------------------------------------------------
function openDrawer(id) { $(id).hidden = false; $("drawerScrim").hidden = false; }
function closeDrawers() {
  $("historyDrawer").hidden = true;
  $("optimizeDrawer").hidden = true;
  $("drawerScrim").hidden = true;
}
$("drawerScrim").addEventListener("click", closeDrawers);
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => { $(b.dataset.close).hidden = true; $("drawerScrim").hidden = true; })
);

// New chat: clear the transcript and start a fresh conversation on next send.
$("newChatBtn").addEventListener("click", () => {
  state.convoId = null;
  $("chat").innerHTML = "";
  addMsg("sys", "Started a new chat.");
  input.focus();
});

// ---- chat history ---------------------------------------------------------
$("historyBtn").addEventListener("click", async () => {
  openDrawer("historyDrawer");
  const list = $("historyList");
  list.innerHTML = '<div class="drawer-empty">Loading…</div>';
  try {
    const { conversations } = await get("/api/conversations");
    if (!conversations.length) { list.innerHTML = '<div class="drawer-empty">No conversations yet.</div>'; return; }
    list.innerHTML = "";
    for (const c of conversations) {
      const item = document.createElement("div");
      item.className = "histo" + (c.id === state.convoId ? " active" : "");
      item.innerHTML =
        `<div class="histo-body"><div class="histo-title">${escapeHtml(c.title || "Untitled")}</div>` +
        `<div class="histo-meta">${c.count} message${c.count === 1 ? "" : "s"} · ${timeAgo(c.updatedAt)}</div></div>`;
      const del = document.createElement("button");
      del.className = "histo-del"; del.textContent = "🗑"; del.title = "Delete";
      del.onclick = async (e) => {
        e.stopPropagation();
        try { await del2(`/api/conversations/${c.id}`); } catch {}
        if (state.convoId === c.id) { state.convoId = null; $("chat").innerHTML = ""; }
        item.remove();
        if (!list.children.length) list.innerHTML = '<div class="drawer-empty">No conversations yet.</div>';
      };
      item.appendChild(del);
      item.addEventListener("click", () => loadConversation(c.id));
      list.appendChild(item);
    }
  } catch (e) {
    list.innerHTML = `<div class="drawer-empty">Couldn't load history: ${escapeHtml(e.message)}</div>`;
  }
});

// Load a past conversation into the chat view.
async function loadConversation(id) {
  try {
    const { conversation } = await get(`/api/conversations/${id}`);
    state.convoId = id;
    const chat = $("chat");
    chat.innerHTML = "";
    for (const m of conversation.messages) {
      if (m.role === "user") {
        const text = typeof m.content === "string" ? m.content
          : (Array.isArray(m.content) ? (m.content.find((p) => p.type === "text")?.text || "") : "");
        addMsg("user", text);
      } else {
        addMsg("ai", typeof m.content === "string" ? m.content : "");
      }
    }
    if (!conversation.messages.length) {
      // empty convo — restore the empty state hint
      // (do nothing; redraw on next refresh)
    }
    closeDrawers();
  } catch (e) { flash("Couldn't open that chat: " + e.message); }
}

// ---- optimize drawer logic -------------------------------------------------
$("optimizeRun").addEventListener("click", async () => {
  const prompt = $("optimizeInput").value.trim();
  if (!prompt) return;
  const btn = $("optimizeRun");
  btn.disabled = true;
  btn.textContent = "Optimizing…";
  $("optimizeError").hidden = true;
  $("optimizeResultArea").hidden = true;
  try {
    const { optimized } = await post("/api/optimize", { linkId: state.linkId, prompt });
    $("optimizeOutput").value = optimized;
    $("optimizeResultArea").hidden = false;
  } catch (e) {
    $("optimizeError").textContent = e.message;
    $("optimizeError").hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Optimize";
  }
});

$("optimizeUse").addEventListener("click", () => {
  const optimized = $("optimizeOutput").value.trim();
  if (optimized) {
    $("chatInput").value = optimized;
    autoGrow();
    $("chatInput").focus();
  }
  closeDrawers();
});

// ---- fetch helpers --------------------------------------------------------
async function post(url, body) {
  const r = await fetch(API + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
async function get(url) {
  const r = await fetch(API + url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
async function del2(url) {
  const r = await fetch(API + url, { method: "DELETE" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// Boot.
init();
