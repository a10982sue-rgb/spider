// Simple in-memory store. For production, swap for a real DB.
import crypto from "node:crypto";

const links = new Map();   // linkId -> link record
const codes = new Map();   // pairingCode -> linkId
const tokens = new Map();  // pluginToken -> linkId

const id = () => crypto.randomBytes(16).toString("hex");
const code6 = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

export function createLink() {
  const linkId = id();
  let code;
  do { code = code6(); } while (codes.has(code));

  const link = {
    linkId,
    code,
    codeExpires: Date.now() + 15 * 60 * 1000, // 15 min to pair
    linked: false,
    ownerId: null,         // Discord user id that owns this session (credits)
    roblox: null,          // { userId, userName, placeId }
    pluginToken: null,
    apiKey: null,          // per-link FreeModel key (entered on website)
    model: "gpt-5.5",
    history: [],           // chat messages for the AI
    queue: [],             // pending actions for the plugin
    results: [],           // results reported back by the plugin
    context: null,         // latest place snapshot from the plugin (string)
    contextAt: 0,          // when the snapshot was last updated
    pluginConvoId: null,   // persistent conversation id for plugin chat (survives restarts)
    createdAt: Date.now(),
  };
  links.set(linkId, link);
  codes.set(code, linkId);
  return link;
}

export const getLink = (linkId) => links.get(linkId) || null;

export function getLinkByCode(code) {
  const linkId = codes.get(code);
  if (!linkId) return null;
  const link = links.get(linkId);
  if (!link) return null;
  if (Date.now() > link.codeExpires) return null;
  return link;
}

export const getLinkByToken = (token) => {
  const linkId = tokens.get(token);
  return linkId ? links.get(linkId) || null : null;
};

export function confirmLink(code, roblox) {
  const link = getLinkByCode(code);
  if (!link) return null;
  link.linked = true;
  link.roblox = roblox;
  link.pluginToken = id();
  tokens.set(link.pluginToken, link.linkId);
  codes.delete(code); // one-time use
  return link;
}

export function queueActions(link, actions) {
  const batchId = id();
  const items = actions.map((a, i) => ({
    id: `${batchId}:${i}`,
    ...a,
  }));
  link.queue.push(...items);
  return items.map((x) => x.id);
}

export function drainQueue(link) {
  const items = link.queue;
  link.queue = [];
  return items;
}

// Store the latest place snapshot the plugin captured. Capped so a huge place
// can't blow up memory or the model's context window.
const MAX_CONTEXT = 400_000; // chars
export function setContext(link, context) {
  const text = typeof context === "string" ? context : "";
  link.context = text.length > MAX_CONTEXT
    ? text.slice(0, MAX_CONTEXT) + "\n\n[snapshot truncated]"
    : text;
  link.contextAt = Date.now();
  return link.context.length;
}

// Append a transient note to the current context — used by find_code and
// read_script actions so the AI sees the retrieved script body next turn.
const MAX_CONTEXT_NOTE = 80_000;
export function appendContextNote(link, note) {
  const text = typeof note === "string" ? note : "";
  if (!text) return;
  const existing = link.context ? link.context + "\n\n" + text : text;
  link.context = existing.length > MAX_CONTEXT
    ? existing.slice(existing.length - MAX_CONTEXT) + "\n\n[context truncated — oldest notes dropped]"
    : existing;
  link.contextAt = Date.now();
  return link.context.length;
}
