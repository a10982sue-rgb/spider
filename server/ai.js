// Talks to FreeModel's OpenAI-compatible endpoint and coerces the model's
// output into { reply, actions[] } that the Roblox plugin understands.
// Handles large builds (auto-continuation across length limits), truncated-JSON
// salvage, and image/file attachments (vision).

const BASE_URL = process.env.FREEMODEL_BASE_URL || "https://api.freemodel.dev";
const MAX_TOKENS = Number(process.env.FREEMODEL_MAX_TOKENS || 16000);
const MAX_CONTINUATIONS = Number(process.env.FREEMODEL_MAX_CONTINUATIONS || 6);

// Thinking-effort presets. `effort` is sent as OpenAI-style reasoning_effort;
// tokenScale widens the output budget so heavier reasoning has room to finish.
const THINK_MODES = {
  off:    { effort: "minimal", tokenScale: 1 },
  medium: { effort: "medium",  tokenScale: 1 },
  heavy:  { effort: "high",    tokenScale: 1.5 },
  xhigh:  { effort: "xhigh",   tokenScale: 2 },
};

const SYSTEM_PROMPT = `You are an assistant embedded in Roblox Studio via a plugin.
You can talk to the user AND build/modify their Roblox game by emitting actions.

You can SEE the user's current place. Before each turn you are given a snapshot
of their game: the instance tree, the full source code of every Script,
LocalScript, and ModuleScript, and whatever is currently selected in Studio.
ALWAYS read this snapshot first. Use it to understand existing code and context
before you build or fix anything. When the user asks you to fix, change, debug,
or extend something, find the relevant instance/script IN THE SNAPSHOT, read its
current contents, and base your edits on what is actually there — never guess at
or invent code that you can already see.

You MUST reply with a single JSON object, no markdown fences, of the form:
{
  "thinking": "<your step-by-step reasoning: what the user wants, which instances you will create or change, and why>",
  "reply": "<short message to show the user>",
  "actions": [ <zero or more action objects> ]
}

Action types (one "type" field each):

1. create_instance
   { "type": "create_instance", "className": "Part",
     "parent": "Workspace",            // path under game, e.g. "Workspace" or "Workspace.MyModel"
     "name": "MyPart",
     "properties": { "Size": [4,1,2], "Position": [0,5,0], "Anchored": true,
                     "Color": [1,0,0], "Material": "Neon", "Transparency": 0.0 } }
   - Vector3 / Color3 are given as [x,y,z] number arrays.
   - Only set properties valid for that className.

2. set_property
   { "type": "set_property", "path": "Workspace.MyPart",
     "properties": { "Anchored": true, "Size": [6,1,6] } }

3. delete_instance
   { "type": "delete_instance", "path": "Workspace.MyPart" }

4. create_script
   { "type": "create_script", "scriptClass": "Script",   // Script | LocalScript | ModuleScript
     "parent": "ServerScriptService", "name": "Main",
     "source": "print('hello')" }

5. edit_script
   { "type": "edit_script", "path": "ServerScriptService.Main",
     "source": "<the COMPLETE new source for this existing script>" }
   - Use this to fix or change a script that already exists in the snapshot.
   - "source" REPLACES the whole script, so emit the full corrected file, not a diff.

6. insert_free_model
   { "type": "insert_free_model", "assetId": 1234567,   // a Roblox catalog asset id
     "parent": "Workspace", "name": "Tree" }            // name is optional (renames the insert)
   - Use when the user asks to INSERT/ADD an existing free model / asset from the
     Roblox library. Prefer a concrete assetId when you know one or the user gives
     a catalog link (extract the number from it).
   - If you only have a description and no id, you MAY instead provide a "query":
     { "type": "insert_free_model", "query": "low poly tree", "parent": "Workspace" }
     and the plugin will search the library and insert the best free match.
   - Every inserted model is automatically virus-scanned: malicious scripts
     (backdoors, remote loadstring, obfuscated requires) are disabled/stripped or
     deleted before it lands. You don't need to scan it yourself.

7. insert_free_audio
   { "type": "insert_free_audio", "assetId": 1234567,   // a Roblox audio asset id
     "parent": "Workspace.Part", "name": "Sound" }      // parent can be any instance
   - Use when the user asks to add sound effects or music from the Roblox library.
   - Creates a Sound instance with the SoundId set to the asset.
   - If you only have a description: { "type": "insert_free_audio", "query": "explosion sound", "parent": "Workspace" }

8. insert_free_animation
   { "type": "insert_free_animation", "assetId": 1234567,  // a Roblox animation asset id
     "parent": "Workspace.Humanoid", "name": "Dance" }     // parent should be a Humanoid or AnimationController
   - Use when the user asks to add animations from the Roblox library.
   - Creates an Animation instance with AnimationId set to the asset.
   - If you only have a description: { "type": "insert_free_animation", "query": "dance animation", "parent": "Workspace.Character.Humanoid" }

9. remember
   { "type": "remember", "text": "<a concise fact worth keeping long-term>" }
   - Use to save durable facts ACROSS conversations: what you built for this user,
     their preferences, names/paths of key systems, decisions you made. Saved
     facts are shown back to you at the top of every future chat.
   - Remember sparingly and concretely (e.g. "Built a basketball game with a
     ServerScriptService.Hoop scoring script and a StarterGui scoreboard").
     Don't remember trivia or anything the user asked you to forget.

Guidelines:
- ALWAYS consult the place snapshot first. The snapshot includes the FULL source
  of every Script/LocalScript/ModuleScript and the whole instance tree. When you
  need to find something — a function, a remote, a variable, a part, where a bug
  lives — SEARCH the snapshot's script sources and instance tree yourself and
  read what's actually there. Cite the exact path (e.g. ServerScriptService.Main)
  in your thinking. Do NOT ask the user where something is or what a script says
  if it is present in the snapshot — find it. Only ask the user when the
  information genuinely isn't anywhere in the snapshot.
- To fix a bug, locate the offending script in the snapshot, read its source, and
  emit edit_script with the full corrected source. To modify an instance you can
  see, use set_property.
- To MODEL something from scratch (a car, a house, a sword), BUILD it out of
  create_instance parts/meshes grouped under one Model (create the Model first
  with create_instance className "Model", then parent parts to it by path). Use
  insert_free_model only to pull in an existing library asset the user asked for.
- For large requests (whole games, complex systems) emit as many actions as
  needed — prefer create_script with complete, working Luau for game logic, and
  create_instance for the scene. Do NOT abbreviate or leave TODOs; write the
  full implementation. The system stitches long replies together automatically.
- Build order matters: create parents/containers before their children.
- Use real Roblox class names, property names, and service names.
- If the user attached images, use them as visual reference for what to build.
- If the user is just chatting, return an empty actions array.
- Output ONLY the JSON object. No markdown fences, comments, or trailing commas.`;

function stripFences(text) {
  if (!text) return "";
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1] : text;
}

function extractJson(text) {
  const raw = stripFences(text);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Salvage a partial/truncated response: pull out whatever fields and complete
// action objects we can, even if the closing braces never arrived. This keeps a
// large build usable when the model stops mid-stream.
function salvageJson(text) {
  const raw = stripFences(text);
  const start = raw.indexOf("{");
  if (start === -1) return null;
  const body = raw.slice(start);

  const grab = (key) => {
    // match "key": "....." up to an unescaped closing quote
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`);
    const m = body.match(re);
    if (!m) return undefined;
    try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
  };

  const actions = [];
  const idx = body.indexOf('"actions"');
  if (idx !== -1) {
    const arrStart = body.indexOf("[", idx);
    if (arrStart !== -1) {
      // Walk the array, collecting each balanced {...} object.
      let depth = 0, objStart = -1, inStr = false, esc = false;
      for (let i = arrStart + 1; i < body.length; i++) {
        const ch = body[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === "{") { if (depth === 0) objStart = i; depth++; }
        else if (ch === "}") {
          depth--;
          if (depth === 0 && objStart !== -1) {
            try { actions.push(JSON.parse(body.slice(objStart, i + 1))); } catch { /* skip incomplete */ }
            objStart = -1;
          }
        } else if (ch === "]" && depth === 0) break;
      }
    }
  }

  const thinking = grab("thinking");
  const reply = grab("reply");
  if (thinking === undefined && reply === undefined && actions.length === 0) return null;
  return { thinking, reply, actions, _salvaged: true };
}

// One streaming completion call. Returns { content, reasoning, finishReason }.
// Fires onReason(chunk) for each native reasoning delta.
async function streamOnce({ apiKey, model, messages, onReason, think }) {
  const mode = THINK_MODES[think] || THINK_MODES.medium;
  const body = {
    model,
    messages,
    temperature: 0.4,
    max_tokens: Math.round(MAX_TOKENS * mode.tokenScale),
    stream: true,
  };
  // Off = no reasoning at all; otherwise request the effort level.
  if (think !== "off") body.reasoning_effort = mode.effort;

  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`FreeModel ${res.status}: ${detail.slice(0, 500)}`);
  }

  let content = "";
  let reasoning = "";
  let finishReason = null;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      const choice = json?.choices?.[0] || {};
      const delta = choice.delta || {};
      if (typeof delta.content === "string") content += delta.content;
      const r = delta.reasoning_content ?? delta.reasoning;
      if (typeof r === "string" && r) { reasoning += r; if (onReason) onReason(r); }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }
  return { content, reasoning, finishReason };
}

export async function runChat({ apiKey, model, history, thinkMode, context, mode, memory, webSearch, onThinking, onStatus }) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  // Web search capability
  if (webSearch) {
    messages.push({
      role: "system",
      content:
        "WEB SEARCH ENABLED: You can search the web for current information when needed. " +
        "If the user asks about recent events, current data, or anything requiring up-to-date " +
        "information, mention in your 'thinking' that you would search for it. For Roblox-specific " +
        "questions (APIs, best practices, asset IDs), web search can help find documentation and resources.",
    });
  }
  // Long-term memory: durable facts the user/AI saved across conversations.
  if (Array.isArray(memory) && memory.length) {
    const facts = memory
      .map((m) => `- ${typeof m === "string" ? m : m.text}`)
      .filter((l) => l.length > 2)
      .join("\n");
    if (facts) {
      messages.push({
        role: "system",
        content:
          "Long-term memory — durable facts about this user and what you've built " +
          "for them in past conversations. Use these for continuity:\n\n" + facts,
      });
    }
  }
  // "Model" mode (the Model button): focus the build on one self-contained Model.
  if (mode === "model") {
    messages.push({
      role: "system",
      content:
        "MODEL MODE: The user wants you to CREATE a single, self-contained Model " +
        "of whatever they describe. First emit a create_instance with className " +
        "\"Model\" (a sensible name) under Workspace, then build all of its parts/" +
        "meshes/unions as children of that Model (parent them by the Model's path). " +
        "Anchor parts, position them relative to each other so the model is " +
        "assembled and sensible, and set a PrimaryPart-worthy base part. Prefer " +
        "building from primitives over inserting library assets unless the user " +
        "explicitly asked to insert an existing free model.",
    });
  }
  // Inject the live place snapshot (instance tree + script sources + selection)
  // so the model can read existing code and context before acting.
  if (typeof context === "string" && context.trim()) {
    messages.push({
      role: "system",
      content:
        "Current Roblox place snapshot (updated each turn — this is what exists " +
        "in the game right now):\n\n" + context,
    });
  }
  messages.push(...history);
  const think = THINK_MODES[thinkMode] ? thinkMode : "medium";

  const emit = (txt) => {
    if (txt && typeof onThinking === "function") {
      try { onThinking(txt); } catch { /* ignore UI sink errors */ }
    }
  };
  const status = (s) => { if (typeof onStatus === "function") { try { onStatus(s); } catch {} } };

  let content = "";
  let reasoning = "";

  // Initial call.
  let r = await streamOnce({ apiKey, model, messages, onReason: emit, think });
  content += r.content;
  reasoning += r.reasoning;

  // Auto-continue if the model ran out of room on a big build.
  let continuations = 0;
  while (r.finishReason === "length" && continuations < MAX_CONTINUATIONS) {
    continuations++;
    status(`Generating more… (part ${continuations + 1})`);
    const followUp = [
      ...messages,
      { role: "assistant", content },
      { role: "user", content:
        "Continue the JSON output from exactly where you stopped. Do not repeat " +
        "any text already sent and do not restart the object — just resume the " +
        "raw characters." },
    ];
    r = await streamOnce({ apiKey, model, messages: followUp, onReason: emit, think });
    content += r.content;
    reasoning += r.reasoning;
  }

  // Parse — try clean JSON first, then salvage a truncated/garbled response.
  let parsed = extractJson(content);
  let salvaged = false;
  if (!parsed || typeof parsed !== "object") {
    parsed = salvageJson(content);
    salvaged = !!parsed;
  }

  if (!parsed) {
    // Not JSON at all — treat the whole thing as a chat reply.
    return { thinking: reasoning, reply: content || "(no response)", actions: [], truncated: r.finishReason === "length" };
  }

  const reply = typeof parsed.reply === "string" ? parsed.reply : "";
  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  let thinking = reasoning;
  if (!thinking && typeof parsed.thinking === "string") {
    thinking = parsed.thinking;
    emit(thinking);
  }
  return {
    thinking,
    reply: reply || (actions.length ? "(done)" : "(no response)"),
    actions,
    raw: content,
    salvaged,
    truncated: r.finishReason === "length",
  };
}
