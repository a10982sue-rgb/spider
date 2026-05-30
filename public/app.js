const API = ""; // same origin as the server
const $ = (id) => document.getElementById(id);
const state = { linkId: null, linked: false, pollTimer: null, resultTimer: null, attachments: [], credits: null, user: null, mode: "build" };

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

  if (!me.user.seenIntro) showIntro();
}

function showIntro() { $("introModal").hidden = false; }
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
  // Block sending when out of credits.
  const out = n <= 0;
  $("sendBtn").disabled = out;
  $("chatInput").placeholder = out
    ? "Out of credits — ask an admin to top you up."
    : state.mode === "model"
      ? "Describe a model to create…  (e.g. a wooden cart, a sci-fi door)"
      : "Describe what to build…  (Shift + Enter for a new line)";
}

// ---- step 1: key + session ------------------------------------------------
$("saveKey").addEventListener("click", async () => {
  const apiKey = $("apiKey").value.trim();
  const model = $("model").value;
  const status = $("keyStatus");
  if (!apiKey) { setStatus(status, "Enter your FreeModel API key first.", "err"); return; }

  setStatus(status, "Starting session…");
  try {
    if (!state.linkId) {
      const s = await post("/api/session/start", {});
      state.linkId = s.linkId;
      showCode(s.code);
    }
    await post("/api/session/config", { linkId: state.linkId, apiKey, model });
    setStatus(status, "Saved. Now link the plugin →", "ok");
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

// ---- composer: attachments ------------------------------------------------
$("attachBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (e) => {
  for (const file of e.target.files) addAttachment(file);
  e.target.value = ""; // allow re-selecting the same file
});

// Allow pasting an image straight into the input.
$("chatInput").addEventListener("paste", (e) => {
  for (const item of e.clipboardData?.items || []) {
    if (item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) addAttachment(f);
    }
  }
});

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
  const text = input.value.trim();
  const atts = state.attachments.slice();
  if (!text && atts.length === 0) return;

  const empty = $("emptyState"); if (empty) empty.remove();

  addMsg("user", text, 0, atts);
  input.value = ""; autoGrow();
  state.attachments = []; renderAttachments();
  $("sendBtn").disabled = true;

  const think = addThinking();
  const statusEl = addStatusLine();

  try {
    await streamChat(text, atts, $("thinkMode").value, {
      onThinking: (chunk) => think.append(chunk),
      onStatus: (s) => statusEl.set(s),
      onDone: ({ reply, queued, thinking, truncated, salvaged, credits }) => {
        think.finish(thinking);
        statusEl.remove();
        addMsg("ai", reply, queued, null, { truncated, salvaged });
        if (credits !== undefined) setCredits(credits);
      },
      onError: (msg) => { think.remove(); statusEl.remove(); addMsg("sys", "Error: " + msg); },
    });
  } catch (err) {
    think.remove(); statusEl.remove();
    addMsg("sys", "Error: " + err.message);
  } finally {
    $("sendBtn").disabled = false;
    input.focus();
  }
});

// Read the SSE stream and dispatch events.
async function streamChat(message, attachments, thinkMode, { onThinking, onStatus, onDone, onError }) {
  const r = await fetch(API + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ linkId: state.linkId, message, attachments, thinkMode, mode: state.mode }),
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

function unlock(id) { $(id).classList.remove("locked"); }
function setStatus(el, msg, cls) { el.textContent = msg; el.className = "status" + (cls ? " " + cls : ""); }
function flash(msg) { const s = $("keyStatus"); setStatus(s, msg, "err"); setTimeout(() => setStatus(s, ""), 4000); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

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

// Boot.
init();
