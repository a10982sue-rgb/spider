// Persistent per-user conversation history + long-term memory.
//
// Same dual backend as users.js:
//   • Upstash Redis when UPSTASH_REDIS_REST_* are set (survives redeploys).
//   • Local JSON file (data/convos.json) otherwise — for local dev.
//
// Shape per Discord user id:
//   {
//     conversations: [ { id, title, createdAt, updatedAt, messages: [ {role, content, ts} ] } ],
//     memory: [ { id, text, createdAt } ]   // long-term facts the AI should remember
//   }
//
// The in-memory Map is the live source of truth; writes are debounced (file) or
// fire-and-forget per user (Redis). Reads stay synchronous on the hot path.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "convos.json");

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const redisEnabled = !!(REDIS_URL && REDIS_TOKEN);
const REDIS_HASH = "spider:convos"; // field per user id -> JSON of their record

// Caps so storage / model context stay sane.
const MAX_CONVOS = 50;          // keep the most recent N conversations per user
const MAX_MSGS_PER_CONVO = 400; // trim oldest messages beyond this
const MAX_MEMORY = 100;         // remembered facts per user

const newId = () => crypto.randomBytes(8).toString("hex");

let store = new Map(); // userId -> record

async function redisCmd(cmd) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`Upstash ${r.status}`);
  return (await r.json()).result;
}

function blankRecord() {
  return { conversations: [], memory: [] };
}

// --- load / persist --------------------------------------------------------
async function refresh(userId) {
  if (!redisEnabled) return;
  try {
    const json = await redisCmd(["HGET", REDIS_HASH, String(userId)]);
    if (json) store.set(String(userId), JSON.parse(json));
  } catch (e) {
    console.error("[convos] Redis refresh failed:", e.message);
  }
}

let saveTimer = null;
function saveFileDebounced() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(store), null, 2));
    } catch (e) {
      console.error("convos.json write failed:", e.message);
    }
  }, 200);
}

function persist(userId) {
  const rec = store.get(String(userId));
  if (redisEnabled) {
    if (!rec) return;
    redisCmd(["HSET", REDIS_HASH, String(userId), JSON.stringify(rec)]).catch((e) =>
      console.error("[convos] Redis write failed:", e.message)
    );
  } else {
    saveFileDebounced();
  }
}

export const ready = (async () => {
  if (redisEnabled) {
    try {
      const flat = (await redisCmd(["HGETALL", REDIS_HASH])) || [];
      for (let i = 0; i < flat.length; i += 2) {
        try { store.set(flat[i], JSON.parse(flat[i + 1])); } catch {}
      }
      console.log(`[convos] loaded ${store.size} record(s) from Upstash Redis`);
    } catch (e) {
      console.error("[convos] Redis load failed, starting empty:", e.message);
      store = new Map();
    }
  } else {
    try {
      store = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, "utf8"))));
    } catch {
      store = new Map();
    }
    console.log("[convos] using local file store (data/convos.json)");
  }
})();

// --- internal helpers ------------------------------------------------------
function getRecord(userId) {
  const id = String(userId);
  let rec = store.get(id);
  if (!rec) { rec = blankRecord(); store.set(id, rec); }
  return rec;
}

const titleFrom = (text) => {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t ? (t.length > 48 ? t.slice(0, 48) + "…" : t) : "New chat";
};

export { redisEnabled };

// --- conversations (public API) -------------------------------------------

// Summaries for the history list (no message bodies).
export async function listConversations(userId) {
  await refresh(userId);
  const rec = store.get(String(userId));
  if (!rec) return [];
  return rec.conversations
    .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, count: c.messages.length }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// Full conversation (with messages), or null.
export async function getConversation(userId, convoId) {
  await refresh(userId);
  const rec = store.get(String(userId));
  if (!rec) return null;
  return rec.conversations.find((c) => c.id === convoId) || null;
}

// Create a new, empty conversation and return it.
export async function createConversation(userId, title) {
  await refresh(userId);
  const rec = getRecord(userId);
  const now = Date.now();
  const convo = { id: newId(), title: title || "New chat", createdAt: now, updatedAt: now, messages: [] };
  rec.conversations.unshift(convo);
  // Trim to the most recent MAX_CONVOS.
  if (rec.conversations.length > MAX_CONVOS) rec.conversations.length = MAX_CONVOS;
  persist(userId);
  return convo;
}

export async function deleteConversation(userId, convoId) {
  await refresh(userId);
  const rec = store.get(String(userId));
  if (!rec) return false;
  const before = rec.conversations.length;
  rec.conversations = rec.conversations.filter((c) => c.id !== convoId);
  if (rec.conversations.length === before) return false;
  persist(userId);
  return true;
}

// Append a message to a conversation (creating one if convoId is missing/unknown).
// Returns the conversation id used. Auto-titles from the first user message.
export async function appendMessage(userId, convoId, message) {
  await refresh(userId);
  const rec = getRecord(userId);
  let convo = convoId && rec.conversations.find((c) => c.id === convoId);
  if (!convo) {
    convo = { id: newId(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    rec.conversations.unshift(convo);
    if (rec.conversations.length > MAX_CONVOS) rec.conversations.length = MAX_CONVOS;
  }
  convo.messages.push({ ...message, ts: Date.now() });
  if (convo.messages.length > MAX_MSGS_PER_CONVO) {
    convo.messages.splice(0, convo.messages.length - MAX_MSGS_PER_CONVO);
  }
  if ((convo.title === "New chat" || !convo.title) && message.role === "user") {
    const text = typeof message.content === "string"
      ? message.content
      : (Array.isArray(message.content) ? (message.content.find((p) => p.type === "text")?.text || "") : "");
    convo.title = titleFrom(text);
  }
  convo.updatedAt = Date.now();
  persist(userId);
  return convo.id;
}

// --- long-term memory ------------------------------------------------------

export async function getMemory(userId) {
  await refresh(userId);
  const rec = store.get(String(userId));
  return rec ? rec.memory.slice() : [];
}

export async function addMemory(userId, text) {
  const clean = (text || "").toString().trim();
  if (!clean) return null;
  await refresh(userId);
  const rec = getRecord(userId);
  // De-dupe identical facts.
  if (rec.memory.some((m) => m.text === clean)) return rec.memory;
  rec.memory.unshift({ id: newId(), text: clean.slice(0, 2000), createdAt: Date.now() });
  if (rec.memory.length > MAX_MEMORY) rec.memory.length = MAX_MEMORY;
  persist(userId);
  return rec.memory;
}

export async function deleteMemory(userId, memId) {
  await refresh(userId);
  const rec = store.get(String(userId));
  if (!rec) return false;
  const before = rec.memory.length;
  rec.memory = rec.memory.filter((m) => m.id !== memId);
  if (rec.memory.length === before) return false;
  persist(userId);
  return true;
}
