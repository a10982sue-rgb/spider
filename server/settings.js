// Runtime-editable admin state: API key overrides, custom model registry,
// changelog entries. Same dual backend pattern as users.js — Upstash Redis
// when available, otherwise a local JSON file under data/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "settings.json");

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const redisEnabled = !!(REDIS_URL && REDIS_TOKEN);
const REDIS_KEY = "spider:settings";

const DEFAULT_STATE = {
  apiKeys: {},        // name -> string (QWEN_API_KEY)
  changelog: [],      // [{ id, at, title, body, scope, author }]
};

let state = structuredClone(DEFAULT_STATE);

async function redisCmd(cmd) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`Upstash ${r.status}`);
  return (await r.json()).result;
}

let saveTimer = null;
function persist() {
  if (redisEnabled) {
    redisCmd(["SET", REDIS_KEY, JSON.stringify(state)]).catch((e) =>
      console.error("[settings] Redis write failed:", e.message)
    );
  } else {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
      } catch (e) {
        console.error("settings.json write failed:", e.message);
      }
    }, 200);
  }
}

export const ready = (async () => {
  if (redisEnabled) {
    try {
      const raw = await redisCmd(["GET", REDIS_KEY]);
      if (raw) {
        const parsed = JSON.parse(raw);
        state = { ...structuredClone(DEFAULT_STATE), ...parsed };
      }
      console.log(`[settings] loaded from Upstash Redis`);
    } catch (e) {
      console.error("[settings] Redis load failed:", e.message);
    }
  } else {
    try {
      const raw = fs.readFileSync(FILE, "utf8");
      state = { ...structuredClone(DEFAULT_STATE), ...JSON.parse(raw) };
    } catch { /* first run */ }
  }
})();

// --- API key overrides -----------------------------------------------------
// Admin-set keys override env vars at runtime so the operator can rotate them
// without redeploying. envName is the same name used in process.env so the
// resolveKey helper is a drop-in replacement.
export function resolveKey(envName, fallback) {
  const override = state.apiKeys?.[envName];
  if (override && typeof override === "string" && override.trim()) return override.trim();
  return (process.env[envName] || fallback || "").trim();
}
export function setApiKey(envName, value) {
  if (!envName || typeof envName !== "string") return false;
  state.apiKeys = state.apiKeys || {};
  if (value == null || value === "") delete state.apiKeys[envName];
  else state.apiKeys[envName] = String(value);
  persist();
  return true;
}
export function listApiKeyNames() {
  return Object.keys(state.apiKeys || {});
}

// --- Changelog -------------------------------------------------------------
export function listChangelog() {
  return [...(state.changelog || [])].sort((a, b) => b.at - a.at);
}
export function addChangelog({ title, body, scope, author }) {
  const entry = {
    id: crypto.randomBytes(8).toString("hex"),
    at: Date.now(),
    title: String(title || "").trim() || "Untitled update",
    body: String(body || "").trim(),
    scope: ["plugin", "website", "both"].includes(scope) ? scope : "both",
    author: String(author || "admin"),
  };
  state.changelog = state.changelog || [];
  state.changelog.push(entry);
  persist();
  return entry;
}
export function removeChangelog(id) {
  state.changelog = (state.changelog || []).filter((e) => e.id !== id);
  persist();
}
