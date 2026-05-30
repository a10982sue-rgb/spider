// Persistent per-user store: Discord identity + generation credits.
// Backed by a JSON file on disk so credits survive restarts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "users.json");

export const STARTING_CREDITS = 20;

let users = new Map(); // discordId -> user record

function load() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const obj = JSON.parse(raw);
    users = new Map(Object.entries(obj));
  } catch {
    users = new Map(); // first run, no file yet
  }
}

let saveTimer = null;
function save() {
  // Debounced write so a burst of credit changes doesn't thrash the disk.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const obj = Object.fromEntries(users);
      fs.writeFileSync(FILE, JSON.stringify(obj, null, 2));
    } catch (e) {
      console.error("users.json write failed:", e.message);
    }
  }, 200);
}

load();

// Get a user, creating them with starting credits on first login.
export function upsertUser({ id, username, globalName, avatar }) {
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
  save();
  return u;
}

export const getUser = (id) => users.get(id) || null;

// Spend one credit. Returns { ok, credits }. ok=false when out of credits.
export function spendCredit(id) {
  const u = users.get(id);
  if (!u) return { ok: false, credits: 0 };
  if (u.credits <= 0) return { ok: false, credits: 0 };
  u.credits -= 1;
  save();
  return { ok: true, credits: u.credits };
}

// Admin / bot helpers.
export function grantCredits(id, amount) {
  const u = users.get(id);
  if (!u) return null;
  u.credits += amount;
  save();
  return u.credits;
}

export function setCredits(id, amount) {
  const u = users.get(id);
  if (!u) return null;
  u.credits = Math.max(0, amount);
  save();
  return u.credits;
}

export function markIntroSeen(id) {
  const u = users.get(id);
  if (u) { u.seenIntro = true; save(); }
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
