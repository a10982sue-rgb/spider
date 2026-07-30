# Spider × Roblox

An AI builder for Roblox Studio. Chat on a website (or inside Studio) and a
model from Spider's Railway gateway creates and edits things in your Roblox
game in real time.

```
Browser (website)  ──►  Backend bridge (Node)  ◄──  Roblox Studio plugin
   chat + model           holds key, talks to            executes the AI's
                          Railway gateway                 build actions
```

## Why a backend?

A Roblox Studio plugin can't receive inbound connections, and a browser can't
talk to Studio directly. The small Node server in `server/` is the relay. It
also holds the gateway API key so it never ships to the browser or plugin.

## 1. Run the backend

You need Node 18+ (for built-in `fetch`).

```bash
cd spider
npm install
npm start
# → Spider bridge running on http://localhost:3000
```

Optional environment variables:

| Var                       | Default                     | Purpose                                   |
|---------------------------|-----------------------------|-------------------------------------------|
| `PORT`                    | `3000`                      | Port for the site + API                   |
| `QWEN_API_KEY`            | —                           | Railway gateway key (required)             |
| `QWEN_BASE_URL`           | Railway gateway URL         | OpenAI-compatible endpoint base            |
| `AI_MAX_TOKENS`           | `16000`                     | Max output tokens per generation           |
| `AI_MAX_CONTINUATIONS`    | `6`                         | How many times to auto-continue big builds |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | —           | Discord OAuth login (required for access) |
| `DISCORD_REDIRECT_URI`    | `http://localhost:3000/auth/callback` | OAuth redirect back to the site  |
| `SESSION_SECRET`          | (insecure dev default)      | Signs the login session cookie            |
| `DISCORD_BOT_TOKEN` / `ADMIN_IDS` / `PUBLIC_URL` | —        | For the credit-management bot (`npm run bot`) |

The server calls `POST {QWEN_BASE_URL}/v1/chat/completions` — the same
shape ChatGPT SDK / Cursor / ChatBox use, so any OpenAI-ecosystem base URL works.

## Login & credits (Discord)

Access is gated behind **Discord login**, and each user gets **20 generation
credits** (1 spent per successful build, shared between the website and the
in-Studio chat). A companion **Discord bot** (`npm run bot`) lets admins grant or
reset credits (`/credits grant @user 20`) and lets users check their balance
(`/mycredits`) or DM the bot for a login link.

**Setup:** follow **[SETUP.md](SETUP.md)** to create the Discord app, get the
OAuth credentials + bot token, and set the env vars above. Until they're set, the
site shows a "login not configured" notice. Credits persist in `data/users.json`.

## 2. Open the website

Go to <http://localhost:3000> and **log in with Discord**. First-time users see a
short intro explaining the flow; you can reopen it anytime with the **?** button.

1. Pick one of Spider's configured models, then click **Start session**. The
   shared gateway key stays on the server and is never sent to the browser.
2. A **6-digit pairing code** appears in step 2.

## 3. Install & link the Roblox plugin

1. In Roblox Studio: **Plugins ▸ Plugins Folder**.
2. Click **Download Studio plugin** on the Spider website and copy the
   downloaded `SpiderAI.server.lua` into that folder.
3. Back in Studio, click **Plugins ▸ FreeModel AI** (or restart Studio). A panel
   docks on the right.
4. Confirm the **Backend URL** matches your server (`http://localhost:3000`).
5. Type the **6-digit code** from the website and click **Link this place**.

> Studio blocks HTTP requests from plugins until you allow it. The first call
> triggers a permission prompt — choose **Allow** for your backend's domain. For
> `localhost` you may need Studio's *"Allow HTTP requests"* on the plugin.

Once linked, the website's step 3 unlocks and shows your linked Studio user.

## 4. Build with AI

Type into the chat on the website **or** the plugin's own chat box. Examples:

- "Make a red neon platform 20 studs wide floating at height 15."
- "Add a script to ServerScriptService that prints when a player joins."
- "Delete the part named OldBlock in Workspace."
- "Turn the selected part into glass and double its size." *(describe it by name)*
- "Make a complete realistic basketball game." *(big builds work — see below)*

The AI replies and emits **actions**; the plugin executes them inside a single
undoable step (Ctrl+Z reverts the whole build). Results (✓/✕) stream back to
whichever chat you used.

### Attach images & files

Click 📎 in the composer (or paste/drag an image) to attach references:

- **Images** are sent to the model as vision input — "build this layout" with a
  screenshot, "match this color scheme", etc. Needs a vision-capable model.
- **Text/code files** (`.lua`, `.txt`, `.json`, `.md`, `.csv` …) are inlined
  into the prompt so the AI can read and use them. Max 18 MB per file.

### Large builds (whole games)

Big requests can exceed a single response's token limit. The bridge handles this
automatically: it sets a high `max_tokens`, and if the model still stops early
(`finish_reason: "length"`) it **auto-continues** the generation and stitches the
parts together (up to `AI_MAX_CONTINUATIONS` times). You'll see a
"Generating more…" status while it works.

If a response is still cut off or comes back malformed, the server **salvages**
every complete action it can recover and flags the message with a ⚠ note, so a
partial build still applies and you can just say "continue" to finish it.

### The AI can see your place

The plugin sends a live **snapshot** of your game to the model before each turn:
the instance tree across the main services, the **full source of every script**
(`Script`/`LocalScript`/`ModuleScript`), and whatever you have selected in
Studio. So you can say "fix the bug in my movement script" or "why doesn't the
selected part work" and the AI reads the actual code instead of guessing.

To change existing code it emits an `edit_script` action that replaces the
script's full source; to tweak an instance it can see, it uses `set_property`.
The snapshot refreshes automatically — after every build, when you send a chat,
and on a periodic poll that picks up edits you made by hand. Very large places
are capped (per-script and total) so the context stays manageable. The AI is
told to **search the snapshot** (script sources + instance tree) to find things
itself rather than asking you where code lives.

### Chat history & memory

Everything is tied to your Discord login, so it follows you across devices and
survives restarts:

- **History** — every conversation is saved per user. Hit **History** in the
  chat header to browse past chats and reopen one; **＋ New** starts a fresh
  thread. (Backed by Redis when configured, a local file otherwise.)
- **Memory** — durable facts Spider keeps across *all* your chats: what it built,
  paths of key systems, your preferences. The AI saves these itself with a
  `remember` action (you'll see a "🧠 Remembered…" note), and you can view, add,
  or delete them from the **Memory** panel. Saved facts are injected at the top
  of every future chat for continuity.

### Insert free models (auto virus-scanned)

Ask for an existing asset — "insert a free oak tree", or paste a catalog link —
and the AI emits an `insert_free_model` action. The plugin inserts it via
`InsertService:LoadAsset` (by asset id, or by keyword search when you only give a
description).

**Every inserted model is virus-scanned before it lands.** Free models are a
classic malware vector, so the plugin walks every script in the asset and looks
for backdoors and exfiltration (`require(<id>)` backdoors, remote `loadstring`/
`HttpGet`, `getfenv`/`setfenv` obfuscation, Discord-webhook exfil, bytecode
blobs, scam purchase prompts). When it finds something:

- **Clearly malicious** (a short pure-backdoor script) → the script is **deleted**.
- **Suspicious** → the offending lines are **stripped** and the script is
  **disabled**, with the original kept in a comment so you can review it.

You'll see a "🛡 virus scan" summary in the plugin log saying exactly what was
removed.

### Model button — create a model from scratch

Toggle the **Model** button in the composer and describe a thing ("a wooden
cart", "a sci-fi door"). The AI builds a single self-contained `Model` out of
parts/meshes (grouped, anchored, positioned, with a primary part) rather than
scattering instances around — handy when you want one reusable object instead of
a whole scene.

### Thinking effort

The 🧠 selector in the composer controls how hard the model reasons before
answering (sent as OpenAI-style `reasoning_effort`):

| Mode            | Effort     | Output budget | Use for                                  |
|-----------------|------------|---------------|------------------------------------------|
| Off             | minimal    | 1×            | Quick edits, simple chat                 |
| Medium *(def.)* | medium     | 1×            | Everyday building                        |
| Heavy           | high       | 1.5×          | Complex systems, multi-script logic      |
| X-High (best)   | xhigh      | 2×            | Whole games, the most demanding requests |

Higher modes also widen the token budget so deeper reasoning has room to finish.
Exact support depends on the selected model; unknown levels fall back to medium.

### Watch the AI think

While the model works, a live **Thinking** panel streams its reasoning into the
website chat (token by token, over Server-Sent Events). When the reply lands the
panel collapses into a "💭 Thought process" line you can click to re-expand.

This uses the model's native reasoning tokens when the gateway emits them
(`reasoning` / `reasoning_content` stream deltas). For models that don't, the AI
is also asked to include a `thinking` field in its JSON, which is shown instead.
The in-Studio plugin chat logs the final thought process as a `💭` line (the
Roblox HTTP API can't stream, so it appears once when the reply arrives).

## Supported actions

The model is instructed to emit these action types:

| Type               | What it does                                            |
|--------------------|---------------------------------------------------------|
| `create_instance`  | Create any Instance under a parent path, set properties |
| `set_property`     | Update properties on an existing instance by path       |
| `delete_instance`  | Destroy an instance by path                             |
| `create_script`    | Create a `Script`/`LocalScript`/`ModuleScript` w/ source|
| `edit_script`      | Replace the source of an existing script by path        |
| `insert_free_model`| Insert a library asset by id/keyword, then virus-scan it|

Paths are dotted from `game`, e.g. `Workspace.MyModel.Part`. Vectors and colors
are `[x, y, z]` arrays; enum properties (e.g. `Material`) accept the name string.

## Project layout

```
server/
  index.js   Express app: sessions, pairing, chat, action queue
  store.js   In-memory link/session/queue store
  ai.js      Gateway call + JSON action parsing + system prompt
  auth.js    Discord OAuth login + signed session cookies
  users.js   Persistent per-user store (Discord identity + credits)
  bot.js     Discord bot: credit management + login-link onboarding
public/
  index.html, style.css, app.js   The website UI
plugin/
  FreeModelAI.server.lua           Canonical Studio plugin source
data/
  users.json   Auto-created; per-user credits (gitignored)
```

## Notes & limits

- **State is in memory.** Restarting the server drops all sessions/links.
  Swap `store.js` for a real DB to persist.
- **"Linking" uses a pairing code,** not Roblox OAuth (there's no public OAuth
  for this). The plugin reports the Studio user via `StudioService:GetUserId()`.
- **One person per code.** Codes are single-use and expire after 15 minutes.
- **The bridge is unauthenticated** beyond the per-link plugin token. Run it
  locally, or add auth before exposing it to the internet.
- The AI only knows what you tell it — describe instances by name/path so it can
  target them.
