// Discord OAuth2 login + signed session cookies (HMAC, no external deps).
import crypto from "node:crypto";
import { upsertUser, getUser } from "./users.js";

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const REDIRECT_URI =
  process.env.DISCORD_REDIRECT_URI || "http://localhost:3000/auth/callback";
const SESSION_SECRET =
  process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me";
const SCOPE = "identify";

// In production (HTTPS), cookies must be Secure or browsers may drop them.
// We infer "production" from an https redirect URI or NODE_ENV.
const SECURE_COOKIE =
  REDIRECT_URI.startsWith("https://") || process.env.NODE_ENV === "production";
const COOKIE_FLAGS =
  `HttpOnly; SameSite=Lax; Path=/` + (SECURE_COOKIE ? "; Secure" : "");

export const authConfigured = !!(CLIENT_ID && CLIENT_SECRET);

if (!authConfigured) {
  console.warn(
    "[auth] DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET not set — login will be unavailable. See SETUP.md."
  );
}
if (SESSION_SECRET === "dev-only-insecure-secret-change-me" && SECURE_COOKIE) {
  console.warn("[auth] SESSION_SECRET is the insecure default in production — set a real one!");
}

// --- signed cookie (value.signature, base64url) ---------------------------
function sign(value) {
  const mac = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(value)
    .digest("base64url");
  return `${value}.${mac}`;
}

function verify(signed) {
  if (typeof signed !== "string" || !signed.includes(".")) return null;
  const idx = signed.lastIndexOf(".");
  const value = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(value)
    .digest("base64url");
  // constant-time compare
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

const COOKIE = "spider_sess";
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSession(res, discordId) {
  const token = sign(`${discordId}|${Date.now()}`);
  const week = 7 * 24 * 60 * 60;
  res.set(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; ${COOKIE_FLAGS}; Max-Age=${week}`
  );
}

function clearSession(res) {
  res.set("Set-Cookie", `${COOKIE}=; ${COOKIE_FLAGS}; Max-Age=0`);
}

// Returns the logged-in user record, or null.
export function currentUser(req) {
  const cookies = parseCookies(req);
  const signed = cookies[COOKIE];
  if (!signed) return null;
  const value = verify(signed);
  if (!value) return null;
  const discordId = value.split("|")[0];
  return getUser(discordId);
}

// Express middleware: 401 unless logged in. Attaches req.user.
export function requireUser(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "not logged in" });
  req.user = u;
  next();
}

// --- OAuth flow ------------------------------------------------------------
// In-memory CSRF state tokens (short-lived).
const states = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of states) if (now - t > 10 * 60 * 1000) states.delete(k);
}, 60 * 1000).unref?.();

export function registerAuthRoutes(app) {
  // Kick off login: redirect to Discord's consent screen.
  app.get("/auth/login", (req, res) => {
    if (!authConfigured) {
      return res
        .status(503)
        .send("Discord login is not configured. See SETUP.md.");
    }
    const state = crypto.randomBytes(16).toString("hex");
    states.set(state, Date.now());
    const url = new URL("https://discord.com/api/oauth2/authorize");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  // Discord redirects back here with ?code&state.
  app.get("/auth/callback", async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state || !states.has(state)) {
      return res.redirect("/?login=failed");
    }
    states.delete(state);
    try {
      // Exchange the code for an access token.
      const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: "authorization_code",
          code: String(code),
          redirect_uri: REDIRECT_URI,
        }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
      const token = await tokenRes.json();

      // Fetch the user's Discord identity.
      const meRes = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (!meRes.ok) throw new Error(`identity fetch failed (${meRes.status})`);
      const me = await meRes.json();

      const user = upsertUser({
        id: me.id,
        username: me.username,
        globalName: me.global_name,
        avatar: me.avatar,
      });
      setSession(res, user.id);
      res.redirect("/");
    } catch (e) {
      console.error("[auth] callback error:", e.message);
      res.redirect("/?login=failed");
    }
  });

  app.post("/auth/logout", (req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });
}
