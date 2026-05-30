// Persistent per-user store: Discord identity + generation credits.
//
// Storage backend, chosen automatically:
//   • If UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set, credits are
//     stored in Upstash Redis — survives redeploys on hosts with ephemeral disks
//     (Render/Railway free tier). This is the production path.
//   • Otherwise it falls back to a local JSON file (data/users.json) — perfect
//     for local development, no setup required.
//
// The in-memory Map stays the live source of truth so the read/spend API stays
// synchronous; writes are debounced and mirrored to the chosen backend.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "users.json");

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const redisEnabled = !!(REDIS_URL && REDIS_TOKEN);
// A Redis HASH keyed by discord id (one field per user). Per-user fields mean
// the web process and the bot process can each update different users — and the
// same user via read-modify-write — without clobbering each other's whole blob.
const REDIS_HASH = "spider:users";

export const STARTING_CREDITS = 20;
export { redisEnabled };

let users = new Map(); // discordId -> user record (in-memory cache)

// --- Upstash Redis REST helpers (command-array form) -----------------------
async function redisCmd(cmd) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`Upstash ${r.status}`);
  return (await r.json()).result;
}

// Pull one user's latest record from Redis into the cache (best-effort).
// Keeps two processes coherent before a read/mutation of that user.
async function refresh(id) {
  if (!redisEnabled) return;
  try {
    const json = await redisCmd(["HGET", REDIS_HASH, String(id)]);
    if (json) users.set(String(id), JSON.parse(json));
  } catch (e) {
    console.error("[users] Redis refresh failed:", e.message);
  }
}

// Persist one user's record (best-effort, fire-and-forget for Redis).
function persist(id) {
  const u = users.get(String(id));
  if (redisEnabled) {
    if (!u) return;
    redisCmd(["HSET", REDIS_HASH, String(id), JSON.stringify(u)]).catch((e) =>
      console.error("[users] Redis write failed:", e.message)
    );
  } else {
    saveFileDebounced();
  }
}

// --- local file backend (dev) ----------------------------------------------
function loadFromFile() {
  try {
    users = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, "utf8"))));
  } catch {
    users = new Map(); // first run, no file yet
  }
}

let saveTimer = null;
function saveFileDebounced() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(users), null, 2));
    } catch (e) {
      console.error("users.json write failed:", e.message);
    }
  }, 200);
}

// Resolves once initial state is loaded. Awaited before serving / bot login.
export const ready = (async () => {
  if (redisEnabled) {
    try {
      // HGETALL returns [field, value, field, value, ...].
      const flat = (await redisCmd(["HGETALL", REDIS_HASH])) || [];
      for (let i = 0; i < flat.length; i += 2) {
        try { users.set(flat[i], JSON.parse(flat[i + 1])); } catch {}
      }
      console.log(`[users] loaded ${users.size} user(s) from Upstash Redis`);
    } catch (e) {
      console.error("[users] Redis load failed, starting empty:", e.message);
      users = new Map();
    }
  } else {
    loadFromFile();
    console.log(`[users] using local file store (data/users.json)`);
  }
})();

// Get a user, creating them with starting credits on first login.
// Get a user, creating them with starting credits on first login.
// Async: refreshes from Redis first so we never recreate (and reset to 20) a
// user that already exists in shared storage but not in this process's cache.
export async function upsertUser({ id, username, globalName, avatar }) {
  id = String(id);
  await refresh(id);
  let u = users.get(id);
  if (!u) {
    u = {
      id,
      username: username || "user",
      globalName: globalName || username || "user",
      avatar: avatar || null,
      credits: STARTING_CREDITS,
      seenIntro: false,
      createdAt: Date.now(),
    };
    users.set(id, u);
  } else {
    // Refresh display fields on each login.
    u.username = username || u.username;
    u.globalName = globalName || u.globalName;
    u.avatar = avatar ?? u.avatar;
  }
  persist(id);
  return u;
}

// Synchronous cache read — used on hot paths (status polling, middleware).
export const getUser = (id) => users.get(String(id)) || null;

// Async cache read that first pulls the latest from Redis. Use where freshness
// matters across processes (page load, before a generation, bot display).
export async function syncUser(id) {
  await refresh(String(id));
  return getUser(id);
}

// Spend one credit. Returns { ok, credits }. ok=false when out of credits.
// Async read-modify-write so concurrent web/bot updates don't clobber.
export async function spendCredit(id) {
  id = String(id);
  await refresh(id);
  const u = users.get(id);
  if (!u) return { ok: false, credits: 0 };
  if (u.credits <= 0) return { ok: false, credits: 0 };
  u.credits -= 1;
  persist(id);
  return { ok: true, credits: u.credits };
}

// Admin / bot helpers.
export async function grantCredits(id, amount) {
  id = String(id);
  await refresh(id);
  const u = users.get(id);
  if (!u) return null;
  u.credits = Math.max(0, u.credits + amount); // clamp so removals can't go negative
  persist(id);
  return u.credits;
}

export async function setCredits(id, amount) {
  id = String(id);
  await refresh(id);
  const u = users.get(id);
  if (!u) return null;
  u.credits = Math.max(0, amount);
  persist(id);
  return u.credits;
}

// Reload the full user set from Redis into the cache (no-op on file backend,
// where the cache is already the whole store). Use before stats / bulk ops so
// users created by another process (the web server) are included.
export async function reloadAll() {
  if (!redisEnabled) return;
  try {
    const flat = (await redisCmd(["HGETALL", REDIS_HASH])) || [];
    const next = new Map();
    for (let k = 0; k < flat.length; k += 2) {
      try { next.set(flat[k], JSON.parse(flat[k + 1])); } catch {}
    }
    users = next;
  } catch (e) {
    console.error("[users] reloadAll failed:", e.message);
  }
}

// Snapshot of all known users (cache view). Used by admin stats / bulk grant.
export function allUsers() {
  return [...users.values()];
}

// Add `amount` credits to EVERY known user. Returns how many were updated.
export async function grantAll(amount) {
  let n = 0;
  for (const u of users.values()) {
    u.credits = Math.max(0, u.credits + amount);
    persist(u.id);
    n++;
  }
  return n;
}

export function markIntroSeen(id) {
  const u = users.get(String(id));
  if (u) { u.seenIntro = true; persist(id); }
}

// Public-safe view of a user for the frontend.
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    globalName: u.globalName,
    avatar: u.avatar,
    credits: u.credits,
    seenIntro: u.seenIntro,
  };
}
