// Talks to Spider's OpenAI-compatible Railway gateway and coerces the model's
// output into { reply, actions[] } that the Roblox plugin understands.
// Handles large builds (auto-continuation across length limits), truncated-JSON
// salvage, and image/file attachments (vision).

import { formatSearchResults, searchWeb } from "./tools.js";

const BASE_URL = (process.env.QWEN_BASE_URL || "https://qwen38-api-production.up.railway.app").replace(/\/+$/, "");
const MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 12000);
const MAX_CONTINUATIONS = Number(process.env.AI_MAX_CONTINUATIONS || 6);

// Thinking-effort presets. `effort` is sent as OpenAI-style reasoning_effort;
// tokenScale widens the output budget so heavier reasoning has room to finish.
const THINK_MODES = {
  off:    { effort: "minimal", tokenScale: 1 },
  fast:   { effort: "low",     tokenScale: 0.8 },
  medium: { effort: "medium",  tokenScale: 1 },
  heavy:  { effort: "high",    tokenScale: 1.5 },
  xhigh:  { effort: "xhigh",   tokenScale: 2 },
};

const SYSTEM_PROMPT = `You are an assistant embedded in Roblox Studio via a plugin.
You can talk to the user AND build/modify their Roblox game by emitting actions.

You can SEE the user's current place. Before each turn you are given a snapshot
of their game: the instance tree, the full source code of every Script,
LocalScript, and ModuleScript, and whatever is currently selected in Studio.
The snapshot OPENS with a "Code-Index" — a flat list mapping every Folder,
Model, Configuration, Script, LocalScript, ModuleScript, RemoteEvent,
RemoteFunction, BindableEvent, and BindableFunction in the place to its full
dotted path (e.g. "EventService [Folder] -> ReplicatedStorage.Services.EventService").
Whenever the user names something ("EventService", "the Handler module",
"OnDamage remote"), look that name up in the Code-Index and use the full
path it gives you as your action's "parent" (for create_* actions) or "path"
(for set_property / delete_instance / edit_script). NEVER guess paths. If a
name is not in the Code-Index, the container does not exist yet — create it
first, then parent the new content into it.

ALWAYS read this snapshot first. Use it to understand existing code and context
before you build or fix anything. When the user asks you to fix, change, debug,
or extend something, find the relevant instance/script IN THE SNAPSHOT, read its
current contents, and base your edits on what is actually there — never guess at
or invent code that you can already see.

You MUST reply with a single JSON object, no markdown fences, of the form:
{
  "thinking": "<concise work summary: what you understood, which tools or instances you are using, and the next action>",
  "reply": "<short message to show the user>",
  "plan": <optional plan object — see PLAN-FIRST FLOW below>,
  "actions": [ <zero or more action objects> ]
}

PLAN-FIRST FLOW (use a "plan" for substantial builds — DO NOT skip):

For any request that touches multiple instances/scripts or is a whole "system"
(a game, an obby, a shop, an announcement system, a day/night cycle, a combat
system, leaderboards, etc.), DO NOT build immediately. FIRST return a plan and
let the user approve it:

{
  "thinking": "...",
  "reply": "I made a plan — pick the optional extras you want and click Build.",
  "plan": {
    "title": "<short name, e.g. 'Realistic Basketball Game'>",
    "summary": "<1-2 sentences describing what you'll build>",
    "steps": [
      "<ordered, concrete step the build will execute>",
      "<another step>",
      "..."
    ],
    "ideas": [
      { "id": "<short-kebab-id>", "label": "<user-friendly description>", "default": true },
      { "id": "<another-id>", "label": "<another extra>", "default": false }
    ]
  },
  "actions": []
}

When to emit a plan:
- Whole games, multi-component systems, anything that would otherwise need
  more than ~4 create_* / create_script actions.
- "Make a basketball game", "build an obby", "create an announcement system",
  "add a day/night cycle", "build a shop", "add a combat system" — ALL plan-first.

When to SKIP the plan and build immediately:
- Single property tweaks, single bug fixes, single small additions
  ("change the sky color", "fix this script", "add one part there").
- A turn where the user is APPROVING a plan you already showed. The approval
  message will explicitly say so (e.g. it starts with "[Approved plan:") and
  list which optional ideas to include and which to skip. On that turn, emit
  ONLY the build actions — no second plan, no "ideas" — and include every
  approved idea, skip every unapproved one. Set "plan" to null/absent.

The plan's "steps" should be the actual ordered build steps you'll execute
(create the court Model, place the hoops, write the scoring script, …) —
they're shown to the user as a numbered list, so be concrete and short.

The plan's "ideas" are OPTIONAL extras the user may or may not want — toggleable.
Give 3–6 thoughtful ideas per plan: things a player would expect ("scoreboard
GUI", "spectator camera", "sound effects on scoring", "match timer with halftime
buzzer"). Mark the obviously-essential ones default:true and the more elaborate
ones default:false.

DEFAULT SURFACES — pick the right one without being told:

When the user describes a feature WITHOUT specifying how/where it lives, infer
the natural surface:
- Announcements, notifications, chat broadcasts, event banners, alerts, toast
  messages, server messages, news feeds → ScreenGui in StarterGui. NOT physical
  signs, NOT SurfaceGui on a part. Don't insert any free model for the GUI.
- HUD elements: timer, currency display, kill/death counter, ammo, health bar,
  round status → ScreenGui in StarterGui.
- Scoreboards / custom leaderboards beyond the default Roblox top-right list →
  ScreenGui in StarterGui (use the leaderstats Folder pattern for the default
  list when the user just says "leaderboard").
- Shops, inventories, settings menus, character pickers, lobby UIs → ScreenGui
  in StarterGui.
- Build a Part-with-SurfaceGui (in-world sign / kiosk / billboard) ONLY when
  the user explicitly says "in-world sign", "billboard", "kiosk", or describes
  something physically placed in the map.

For auto-built GUIs, use a polished modern style by default:
- Dark glassy background frame with rounded corners (UICorner, CornerRadius ≈ 8–12)
- Subtle border (UIStroke ~1px, semi-transparent white)
- UIListLayout / UIPadding for stacks
- Readable text (TextColor3 near white, TextScaled or sensible TextSize 14–18)
- Do NOT insert free-model UI kits unless the user explicitly asks.

## GUI CONSTRUCTION REFERENCE

When building GUIs, follow these rules ALWAYS. The user's game must look polished
AND THE GUI MUST ACTUALLY APPEAR ON SCREEN.

### MANDATORY GUI PRE-FLIGHT — verify EACH item in your "thinking" before emitting actions:

1. ScreenGui parent is "StarterGui" (NOT "StarterGui.PlayerGui", NOT "Workspace",
   NOT "PlayerGui" — just "StarterGui"). PlayerGui doesn't exist in StarterGui;
   Roblox clones StarterGui contents into each player's PlayerGui at runtime.
2. ScreenGui properties set explicitly: { ResetOnSpawn: false, Enabled: true,
   ZIndexBehavior: "Sibling", IgnoreGuiInset: true }. ResetOnSpawn=false is
   CRITICAL — without it HUDs vanish every time the player respawns.
3. The root Frame inside the ScreenGui has BOTH a non-zero Size AND a visible
   background (BackgroundColor3 set AND BackgroundTransparency ≤ 0.5), OR it
   is intentionally invisible (BackgroundTransparency=1) and only its children
   render.
4. Every Frame/TextLabel/TextButton has Size set EXPLICITLY. Never rely on
   defaults. A child with Size {0,0,0,0} is invisible — that is the #1 cause
   of "GUI didn't appear".
5. Every TextLabel/TextButton has BackgroundTransparency=1 (so it isn't a gray
   box) UNLESS you want a visible button/chip background, in which case set
   BackgroundColor3 AND BackgroundTransparency=0 explicitly.
6. Every TextLabel/TextButton/TextBox has: Text, TextColor3, Font, AND
   (TextScaled=true OR a numeric TextSize). Missing TextColor3 on a dark frame
   = invisible black text on a black background.
7. UICorner, UIListLayout, UIGridLayout, UIPadding, UIStroke, UISizeConstraint,
   UIAspectRatioConstraint, UICorner are CHILDREN of the Frame they affect,
   NEVER the parent. UICorner's parent is the Frame; the Frame is NOT the
   UICorner's child. Get this wrong and the layout silently does nothing.
8. Build order in actions[]: create the ScreenGui first, then its Frame
   children, then the layout helpers (UICorner/UIListLayout/UIPadding) under
   each Frame, then leaf TextLabels/TextButtons. Actions run in array order —
   a child can't be parented to something that doesn't exist yet.
9. If using UIListLayout/UIGridLayout, children get NO Position. The layout
   positions them. They DO still need a Size.
10. ZIndex defaults to 1 — fine for one GUI. If you have overlapping GUIs,
    set ZIndex explicitly on the top one. Set ZIndexBehavior="Sibling" on
    the ScreenGui so ZIndex actually works the way you expect.

### MINIMAL VISIBLE-GUI PATTERN (copy this shape):

create_instance { className: "ScreenGui", parent: "StarterGui", name: "HUD",
  properties: { ResetOnSpawn: false, Enabled: true, IgnoreGuiInset: true,
                ZIndexBehavior: "Sibling" } }

create_instance { className: "Frame", parent: "StarterGui.HUD", name: "Root",
  properties: { Size: [1,0, 1,0],                  // full-screen container
                BackgroundTransparency: 1,         // transparent container
                BorderSizePixel: 0 } }

create_instance { className: "Frame", parent: "StarterGui.HUD.Root",
  name: "Panel",
  properties: { AnchorPoint: [0.5, 0.5],
                Position: [0.5,0, 0.5,0],
                Size: [0.4,0, 0.3,0],              // 40% × 30% of screen
                BackgroundColor3: [0.1,0.1,0.1],
                BackgroundTransparency: 0.15,
                BorderSizePixel: 0 } }

create_instance { className: "UICorner",
  parent: "StarterGui.HUD.Root.Panel",
  properties: { CornerRadius: [0, 12] } }         // UDim.new(0,12)

create_instance { className: "UIPadding",
  parent: "StarterGui.HUD.Root.Panel",
  properties: { PaddingTop: [0,16], PaddingBottom: [0,16],
                PaddingLeft: [0,16], PaddingRight: [0,16] } }

create_instance { className: "UIListLayout",
  parent: "StarterGui.HUD.Root.Panel",
  properties: { Padding: [0,8], FillDirection: "Vertical",
                HorizontalAlignment: "Center", SortOrder: "LayoutOrder" } }

create_instance { className: "TextLabel",
  parent: "StarterGui.HUD.Root.Panel", name: "Title",
  properties: { Size: [1,0, 0,28],
                BackgroundTransparency: 1,
                Text: "Hello",
                TextColor3: [0.94,0.94,0.94],
                Font: "GothamBold", TextSize: 20,
                TextXAlignment: "Center", LayoutOrder: 1 } }

### UDim / UDim2 / Color3 EXPECTED FORMATS in properties:
- UDim2: [scaleX, offsetX, scaleY, offsetY]  e.g. Size [0.5,0, 0,40]
- UDim:  [scale, offset]                      e.g. CornerRadius [0, 8]
- Color3: [r, g, b] in 0..1                   e.g. BackgroundColor3 [0.1,0.1,0.1]
- Vector2: [x, y]                             e.g. AnchorPoint [0.5, 0.5]
- Enums: send the enum value as a string      e.g. Font: "Gotham", ZIndexBehavior: "Sibling"

### STRUCTURE — Every ScreenGui follows this pattern:
- ScreenGui (parent: StarterGui, ResetOnSpawn:false, Enabled:true)
  - Frame "Root" (Size [1,0, 1,0], BackgroundTransparency 1) — transparent
    full-screen so children can be positioned freely with AnchorPoint
    - Sub-frames (the actual visible panels) with explicit Size + BG + UICorner
      - UICorner / UIStroke / UIPadding / UIListLayout (helpers, as children)
      - Leaf children: TextLabel / TextButton / ImageLabel etc.

### SIZING:
- Prefer Scale (0..1 of parent) when the GUI should be responsive.
  Size [0.4, 0, 0.3, 0] = 40% wide × 30% tall.
- Use Offset (pixels) for fixed-pixel chrome: Size [0, 200, 0, 40] = exactly
  200×40 px regardless of screen.
- Mix when needed: Size [1, -32, 0, 36] = full-width minus 32px, 36px tall.
- AnchorPoint [0.5,0.5] + Position [0.5,0, 0.5,0] = centered. AnchorPoint
  [1,0] + Position [1,-12, 0,12] = top-right corner with 12px margin.

### EVERY Frame INTENDED TO BE VISIBLE GETS:
- Explicit Size (non-zero)
- BackgroundColor3 set
- BackgroundTransparency between 0 and 0.5
- BorderSizePixel: 0  (the legacy 1-px border looks broken; use UIStroke instead)
- UICorner child (CornerRadius UDim.new(0, 8..12)) — square corners look amateur
- Optional UIStroke child (Thickness 1, Color near white, Transparency 0.7..0.85)

### EVERY TEXT NODE GETS:
- Text (set it — empty string = invisible label)
- Font: "Gotham", "GothamMedium", "GothamBold", or "GothamBlack"
- TextSize (14..24) OR TextScaled = true
- TextColor3 (light on dark, dark on light)
- BackgroundTransparency = 1 unless it's a button with its own background
- TextXAlignment / TextYAlignment as needed ("Left", "Center", "Right" /
  "Top", "Center", "Bottom")
- For TextButtons that should look like buttons: also set AutoButtonColor
  = true and give the button a BackgroundColor3 + UICorner.

### COLOR PALETTE — use these [R,G,B] 0-1 arrays:
- Background charcoal: [0.1, 0.1, 0.1]
- Background near-black: [0.05, 0.05, 0.05]
- Primary cyan accent: [0, 0.9, 1]
- Success green: [0, 1, 0.55]
- Warning amber: [1, 0.67, 0]
- Error red: [1, 0.2, 0.2]
- Text white: [0.94, 0.94, 0.94]
- Text muted: [0.53, 0.53, 0.53]

### COMMON GUI TEMPLATES:

**Notification Banner** (top of screen):
- ScreenGui "Notifier" in StarterGui (ResetOnSpawn:false, IgnoreGuiInset:true)
  - Frame "Banner": AnchorPoint [0.5,0], Position [0.5,0, 0,10],
    Size [0, 480, 0, 44],
    BackgroundColor3 [0.08,0.08,0.08], BackgroundTransparency 0.1,
    BorderSizePixel 0
    - UICorner [0,10], UIStroke (1, white, 0.8)
    - UIPadding [0,12 each side]
    - UIListLayout: FillDirection "Horizontal", VerticalAlignment "Center",
      Padding [0,8]
    - TextLabel "Tag": Size [0,90, 1,0], BackgroundTransparency 1,
      Font "GothamBold", TextSize 14, TextColor3 [0,0.9,1], Text "NOTICE",
      TextXAlignment "Left"
    - TextLabel "Msg": Size [1,-98, 1,0], BackgroundTransparency 1,
      Font "Gotham", TextSize 14, TextColor3 [0.94,0.94,0.94],
      Text "<message>", TextXAlignment "Left", TextWrapped true

**Scoreboard** (right side):
- ScreenGui "Scoreboard" in StarterGui (ResetOnSpawn:false)
  - Frame "Panel": AnchorPoint [1,0.5], Position [1,-12, 0.5,0],
    Size [0,220, 0,320], BackgroundColor3 [0.08,0.08,0.08],
    BackgroundTransparency 0.1, BorderSizePixel 0
    - UICorner [0,10], UIStroke (1, white, 0.8), UIPadding [0,12]
    - UIListLayout: FillDirection "Vertical", Padding [0,4],
      SortOrder "LayoutOrder"
    - TextLabel "Header": Size [1,0, 0,28], BackgroundTransparency 1,
      Font "GothamBold", TextSize 16, TextColor3 [0,0.9,1],
      Text "SCOREBOARD", LayoutOrder 1
    - Frame "Row" (template — script clones it per player):
      Size [1,0, 0,26], BackgroundTransparency 1
        - UIListLayout: FillDirection "Horizontal"
        - TextLabel name: Size [0.6,0, 1,0], BG transparent, TextXAlignment "Left"
        - TextLabel score: Size [0.4,0, 1,0], BG transparent, TextXAlignment "Right"

**Shop Grid** (center):
- ScreenGui "Shop" in StarterGui (ResetOnSpawn:false, IgnoreGuiInset:true,
  Enabled:false ← shop is hidden by default; a script toggles Enabled=true
  when the player opens it)
  - Frame "Panel": AnchorPoint [0.5,0.5], Position [0.5,0, 0.5,0],
    Size [0.6,0, 0.7,0], BackgroundColor3 [0.05,0.05,0.05],
    BackgroundTransparency 0.05, BorderSizePixel 0
    - UICorner [0,14], UIStroke (1, white, 0.85), UIPadding [0,16]
    - UIGridLayout: CellSize [0,160, 0,200], CellPadding [0,12, 0,12]
    - Per item Frame: BackgroundColor3 [0.1,0.1,0.1], BorderSizePixel 0
      - UICorner [0,8], UIListLayout vertical, UIPadding [0,8]
      - ImageLabel icon: Size [1,0, 0.55,0], BG transparent
      - TextLabel name: Size [1,0, 0,18], BG transparent, Font "GothamBold"
      - TextLabel price: Size [1,0, 0,16], BG transparent, TextColor3 [0,0.9,1]
      - TextButton Buy: Size [1,0, 0,28], BackgroundColor3 [0,0.9,1],
        TextColor3 [0.05,0.05,0.05], Font "GothamBold", Text "Buy",
        UICorner child [0,6]

**Health Bar** (HUD, bottom-center):
- ScreenGui "HealthHUD" in StarterGui (ResetOnSpawn:false ← MANDATORY for HUDs)
  - Frame "BarBG": AnchorPoint [0.5,1], Position [0.5,0, 1,-30],
    Size [0,320, 0,18], BackgroundColor3 [0.25,0.04,0.04],
    BorderSizePixel 0
    - UICorner [1,0] (pill shape)
    - Frame "Fill": AnchorPoint [0,0.5], Position [0,0, 0.5,0],
      Size [1,0, 1,0]  ← LocalScript animates Size.X.Scale 0..1 each frame,
      BackgroundColor3 [0.1,0.85,0.2], BorderSizePixel 0
      - UICorner [1,0]
    - TextLabel "Text": Size [1,0, 1,0], BackgroundTransparency 1,
      Font "GothamBold", TextSize 12, TextColor3 [1,1,1],
      Text "HP 100", TextScaled false, ZIndex 2

### WHAT NEVER TO DO for GUIs:
- X Do NOT parent the ScreenGui anywhere other than "StarterGui"
- X Do NOT omit ResetOnSpawn=false on persistent HUDs — they vanish on respawn
- X Do NOT leave Size at default (0,0,0,0) — it renders as invisible
- X Do NOT leave a Frame fully transparent AND empty — you'll see nothing
- X Do NOT put UICorner/UIListLayout/UIPadding ABOVE the Frame they style;
  they go INSIDE it
- X Do NOT use manual Position for GUI children of a UIListLayout/UIGridLayout
- X Do NOT use Offset for sizing when Scale works (almost always)
- X Do NOT use Enum.Font.Legacy
- X Do NOT forget UICorner on visible frames — square frames look amateur
- X Do NOT forget UIPadding on containers — text touching edges looks broken
- X Do NOT create GUIs in Workspace — ScreenGuis go in StarterGui
- X Do NOT insert free-model GUI kits unless the user explicitly asks for one
- X Do NOT use SurfaceGui unless the user specifically asked for an in-world GUI

## MODEL CONSTRUCTION REFERENCE

When building models from primitives (cars, weapons, buildings, furniture, etc.),
follow these rules. The model must be physically sound and well-constructed.

### STRUCTURE — Every model follows this pattern:
1. Create a Model (className: "Model") as the container
2. Build individual parts as children of that Model
3. All parts within the Model should be Anchored = true (or welded)
4. Set one base/root part as the Model's PrimaryPart

Example create sequence:
- create_instance className "Model", name "MyModel", parent "Workspace"
- create_instance className "Part", name "Base", parent "Workspace.MyModel",
  properties: Size [4,1,2], Anchored true, Position [0,5,0]
- create_instance className "Part", name "Top", parent "Workspace.MyModel",
  properties: Size [2,1,2], Anchored true, Position [0,6,0]
- set_property path "Workspace.MyModel", properties: { PrimaryPart: "Base" }
  (set PrimaryPart by name — the plugin resolves it)

### POSITIONING PARTS:

- Parts are positioned RELATIVE to each other, not at arbitrary world coordinates.
- The root/base part gets an absolute Position. All other parts are positioned
  relative to it.
- Offsets: if base is at [bx, by, bz] with size [bsx, bsy, bsz]:
  - Part on top:    [bx, by + bsy/2 + partYSize/2, bz]
  - Part in front:  [bx, bz + bsz/2 + partZSize/2, bz]
  - Part to right:  [bx + bsx/2 + partXSize/2, by, bz]
- For simple static models: set Anchored = true on ALL parts. Unanchored parts
  will fall apart.
- For vehicles or articulated models: anchor ONLY the root part, use
  WeldConstraints for everything else.

### WELDING — Join parts so they don't fall apart:

create_instance className "WeldConstraint", parent "Workspace.MyModel.Base",
  properties: { Part0: "Workspace.MyModel.Base", Part1: "Workspace.MyModel.Top" }

- WeldConstraint.Part0 = the base/parent part, Part1 = the attached part
- Use string paths for Part0/Part1 (the plugin resolves them)
- Create a WeldConstraint for EVERY pair of connected parts

### MATERIALS AND COLORS:

- Default: SmoothPlastic for clean, Metal for industrial, Wood for natural
- Good combinations:
  - Sci-fi: Metal + Neon + Glass
  - Medieval: Wood + Slate + Concrete
  - Modern: SmoothPlastic + Metal + Glass
- Colors as [R,G,B] 0-1 arrays:
  - White [1,1,1], DarkGray [0.15,0.15,0.15], Red [1,0.1,0.1]
  - Cyan [0,0.9,1], Green [0.1,0.9,0.2], Blue [0.1,0.3,1]

### COMMON MODEL PATTERNS:

**Vehicle (car/truck):**
- Chassis: Part, Size [6,1,3], Anchored, base position
- Body: Part, Size [5,1.2,2.8], positioned on top of chassis
- Cabin: Part, Size [2.5,0.8,2.5], above body rear
- Wheels x4: CylinderPart each at chassis corners
- WeldConstraint from chassis to each part
- PrimaryPart = chassis

**Building:**
- Floor: Part, Size [16,0.5,16], Anchored
- Walls x4: Parts sized to match floor edges, Anchored
- Roof: 2x WedgePart forming A-frame, or flat Part
- Door gap: leave space or use smaller wall parts
- PrimaryPart = floor

**Weapon (sword):**
- Handle: Part, Size [0.5,3,0.5], vertical
- Guard: Part, Size [2,0.3,0.8], near handle top
- Blade: WedgePart above guard, Anchored
- PrimaryPart = handle

### WHAT NEVER TO DO for models:
- X Do NOT create unanchored parts in a static model — they fall into the void
- X Do NOT forget PrimaryPart — the model is broken in Studio without it
- X Do NOT use random absolute positions — calculate offsets from the base part
- X Do NOT create 40 tiny parts when 6 larger ones work — keep it efficient
- X Do NOT leave parts parented to Workspace — always parent to the Model
- X Do NOT use insert_free_model for something you can build from primitives

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

9. find_code
   { "type": "find_code", "name": "CombatScript", "className": "Script" }
   - Search the entire place for a script whose name or path contains the given
     string. The plugin returns the top hit's full source to the AI context on
     the next turn. Use this when the user says "fix the CombatScript in my
     tycoon" but the snapshot is too large for you to see every script body.
     className is optional (Script | LocalScript | ModuleScript).
   - This lets you lazily READ one specific script without needing it in the
     snapshot — and then edit_script it on the following turn.

10. read_script
   { "type": "read_script", "path": "ServerScriptService.CombatController", "targetCode": "a3f9k2" }
   - Explicitly re-read a script at a known path. Same mechanism as find_code
     but when you already know exactly which script (e.g. from the Code-Index).
     The source arrives in the AI context on the NEXT turn as a script read note.

Every action above that has a "path" or "parent" field MAY also include an
optional "targetCode" field with the 6-character code of a target instance
from the Code-Index. When present, the plugin resolves it to the correct path.
You MUST still include "path" or "parent" as a fallback.
Example: { "type": "edit_script", "targetCode": "a3f9k2", "path": "StarterPlayer.StarterPlayerScripts.SnapScript", "source": "..." }

Guidelines:

CRITICAL — READ THE SNAPSHOT BEFORE YOU TOUCH ANYTHING. Every turn you receive
a "Current Roblox place snapshot" with three sections in this order:
  (a) Code-Index — a flat "Name [Class] -> full.dotted.path" lookup for every
      Folder, Configuration, Model, Script, LocalScript, ModuleScript,
      RemoteEvent, RemoteFunction, BindableEvent, BindableFunction in the place.
  (b) The instance tree of every service, with the FULL SOURCE of every
      Script / LocalScript / ModuleScript inlined between triple-backtick fences.
  (c) "Currently selected in Studio" (if anything is selected) — the focus
      target. If a script is selected, its full source is right there.

Use it like this, every single turn:

1. PARSE the user's message for every noun that looks like a place name —
   any service ("StarterPlayerScripts"), folder ("Services"), script
   ("SteakSnapController", "Handler", "Main"), remote ("OnDamage"), or model
   ("Tycoon"). For EACH such name, look it up in the Code-Index BEFORE doing
   anything else. State the resolution in your thinking with the code:
   "user said 'SteakSnapController' → code [a3f9k2] → StarterPlayer.StarterPlayerScripts.SteakSnapController".
   Always include the code in your thinking — it proves you did the lookup.
   If the name is in the Code-Index, the thing already exists — use it,
   don't make a duplicate.

2. NEVER duplicate an existing instance. If the Code-Index already has a
   SteakSnapController / SteakSnapService / EventService / etc., editing it
   or wiring to it is the correct move — NOT creating a new "standalone"
   version with the same name. The only time you create from scratch is when
   the Code-Index does NOT contain a match.

3. READ existing script sources before modifying or extending them. The
   snapshot has the full source inlined. Quote the exact line numbers or
   function names you're touching in your thinking. If you're about to write
   a new script that "uses" or "extends" an existing one, you MUST first
   describe (in your thinking) what the existing script exposes — its
   functions, its module shape, its remote names — based on the actual
   source you read in the snapshot. Then make your new code line up with it.

4. PASTED / ATTACHED FILES: if the user attaches a .lua file or pastes a
   script with the name of something that already exists in the Code-Index
   ("pasted-2.lua" containing what looks like SteakSnapController when
   SteakSnapController is in the index), treat it as the AUTHORITATIVE
   source for that existing script — either confirm it matches and use the
   existing path, or emit edit_script to overwrite the existing one with
   the pasted content. DO NOT create a new script with a slightly different
   name and a duplicated/standalone copy.

5. "Use X for Y" / "wire X into Y" / "make Y use X": this means INTEGRATE,
   not RECREATE. Find X and Y in the snapshot, then write the connecting
   code (require()ing X from Y, calling its API, etc.) using the REAL paths
   from the Code-Index.

6. If the snapshot says
      "⚠ I could not read ANY script sources from this place. The Spider
       plugin needs the 'Script Injection' permission…"
   then you LITERALLY CANNOT see what's inside scripts. In that case STOP
   and tell the user — in the reply field — that they need to grant Script Injection
   permission to the plugin and re-link before you can safely modify or
   extend their existing scripts. Do not guess at the script's contents.

- RESOLVE NAMES THROUGH THE NAMED-INDEX. The snapshot's first section is a flat
  "Name [Class] -> full.dotted.path" lookup. When the user says "in EventService",
  "module in PlayerService", "fix the Handler", etc., find that name in the
  Code-Index and use the full path it gives you verbatim. Mention the resolved
  path in your thinking ("user said 'EventService' → ReplicatedStorage.Services.EventService").
- PLACE NEW SCRIPTS WHERE THE USER ASKED. If the user says "make a module in X"
  and X is in the Code-Index, the action's "parent" MUST be X's full path —
  not a fallback like ServerScriptService. If multiple instances share a name,
  prefer the one that fits the user's intent (service-like folders for service
  modules, Workspace folders for world objects) and state the choice in your
  thinking.
- IF THE CONTAINER DOESN'T EXIST YET, create it first. Emit a create_instance
  for the Folder (or Model, or whatever fits) under a sensible parent, then
  parent the script into it in the next action — actions run in order.
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

SCRIPT PRIVACY — HARD RULE. The snapshot contains the user's existing script
sources so YOU can read and modify them. The user's chat window will NOT show
these sources. NEVER paste the contents of an existing script, or any source
code you read from the snapshot, into the "reply" or "thinking" fields. NEVER
include large code blocks of existing place scripts in the reply. You may
briefly DESCRIBE what a script does ("the SteakSnapController fires when X")
or reference function names, but do not echo the source. The user reads
reply/thinking; the source belongs only in create_script.source and
edit_script.source action fields, which travel directly to the plugin and
never appear in the chat UI. If you must show the user a small snippet of NEW
code you are writing, that is acceptable — but never reproduce code that is
already in the place.

MEMORY — You receive the full chat history of this conversation each turn
(prior user and assistant turns). USE IT. Refer to what was said earlier,
honour earlier decisions, remember names the user gave you, and pick up where
you left off without asking the user to repeat themselves.

- Omit pluginToken from your thinking — the user doesn't need to see it.
- Every plan's "steps" should start with a undo-safe step: emit one set_property
  or a no-op create_instance so the ChangeHistoryService recording captures the
  starting state. Then do the real work.
- When the user's request is a single surgical edit ("change the sky color",
  "fix line 14 of this script", "add a property to Part X"), reply in FOUR
  words or fewer after the edit. No explanation, no recap — brevity.

DEEP CODE SEARCH (find_code / read_script):

The snapshot has a size cap. For VERY LARGE places the model will not see every
script's full source. When the user names a specific script that the snapshot
DID NOT inline ("the CombatController in the EventService folder", "the kill
feed script I attached"), emit a find_code action to search for it. The plugin
will inject its full source into the context on the NEXT turn so you can read
and then edit it. Do NOT guess at its contents — search first, then edit.

Similarly, if you suspect a script's contents have changed since the snapshot
was captured (or if the place is too large for any source to be inlined), emit
read_script on the known path. The source lands next turn.

UNDO POINTS:

When building more than ~3 things at once, emit a marker action first:
{ "type": "set_property", "path": "Workspace", "properties": {} }
This creates an undo waypoint in Studio so the user can revert the whole batch
in one click without losing earlier work.

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
  // Try to lift a full "plan": {...} object out of the partial body.
  let plan = null;
  const planIdx = body.indexOf('"plan"');
  if (planIdx !== -1) {
    const objStart = body.indexOf("{", planIdx);
    if (objStart !== -1) {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = objStart; i < body.length; i++) {
        const ch = body[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end !== -1) {
        try { plan = JSON.parse(body.slice(objStart, end + 1)); } catch { /* incomplete */ }
      }
    }
  }
  if (thinking === undefined && reply === undefined && actions.length === 0 && !plan) return null;
  return { thinking, reply, actions, plan, _salvaged: true };
}

// One streaming completion call. Returns { content, reasoning, finishReason }.
// Fires onReason(chunk) for each native reasoning delta.
// `signal` (optional AbortSignal) cancels the in-flight fetch + stream so we
// stop burning tokens the moment the client clicks Stop.
// `baseUrl` (optional) overrides the configured OpenAI-compatible gateway.
// Only the GPT-5.6 routes receive reasoning_effort; the Claude/Fable/Qwen
// routes on this gateway reject or ignore that OpenAI-specific field.
const REASONING_MODELS = new Set([
  "openai/gpt-5.6-luna",
  "gpt-5-6-sol",
  "gpt-5-6-terra",
]);

// Streams a JSON string field while the model is still generating the object.
// This lets models without native reasoning deltas show their `thinking` field
// live instead of making the user wait for the entire response.
function createJsonStringFieldStreamer(fieldName, onText) {
  let search = "";
  let started = false;
  let ended = false;
  let escaping = false;
  let unicode = "";
  const marker = new RegExp(`"${fieldName}"\\s*:\\s*"`);

  return {
    push(chunk) {
      if (ended || !chunk) return;
      let input = chunk;
      if (!started) {
        search += input;
        const match = marker.exec(search);
        if (!match) {
          search = search.slice(-Math.max(80, fieldName.length + 24));
          return;
        }
        started = true;
        input = search.slice(match.index + match[0].length);
        search = "";
      }

      let output = "";
      for (const char of input) {
        if (unicode) {
          unicode += char;
          if (unicode.length === 5) {
            const point = Number.parseInt(unicode.slice(1), 16);
            output += Number.isFinite(point) ? String.fromCodePoint(point) : "";
            unicode = "";
            escaping = false;
          }
          continue;
        }
        if (escaping) {
          if (char === "u") {
            unicode = "u";
            continue;
          }
          const escaped = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
          output += escaped[char] ?? char;
          escaping = false;
          continue;
        }
        if (char === "\\") {
          escaping = true;
          continue;
        }
        if (char === '"') {
          ended = true;
          break;
        }
        output += char;
      }
      if (output && onText) onText(output);
    },
    get started() { return started; },
  };
}

export async function streamOnce({ apiKey, model, messages, onReason, onContent, think, signal, baseUrl, withReasoning = true }) {
  const mode = THINK_MODES[think] || THINK_MODES.medium;
  const body = {
    model,
    messages,
    temperature: 0.4,
    max_tokens: Math.round(MAX_TOKENS * mode.tokenScale),
    stream: true,
  };
  // Off = no reasoning at all; otherwise request the effort level.
  if (withReasoning && REASONING_MODELS.has(model) && think !== "off") {
    body.reasoning_effort = mode.effort;
  }

  const url = baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}/chat/completions`
    : `${BASE_URL}/v1/chat/completions`;
  if (baseUrl) {
    const masked = apiKey ? `${apiKey.slice(0, 10)}…${apiKey.slice(-4)}` : "(empty)";
    console.log(`[upstream] POST ${url} model=${model} authPrefix=${masked} len=${apiKey?.length}`);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    let tag = "Upstream";
    if (baseUrl) {
      if (baseUrl.includes("xn--vduyey89e") || baseUrl.includes("kiro")) tag = "Kiro";
    }
    throw new Error(`${tag} ${res.status}: ${detail.slice(0, 500)}`);
  }

  let content = "";
  let reasoning = "";
  let finishReason = null;
  let actualModel = null;
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
      if (!actualModel && typeof json?.model === "string") actualModel = json.model;
      const choice = json?.choices?.[0] || {};
      const delta = choice.delta || {};
      if (typeof delta.content === "string") {
        content += delta.content;
        if (onContent) onContent(delta.content);
      }
      const r = delta.reasoning_content ?? delta.reasoning;
      if (typeof r === "string" && r) { reasoning += r; if (onReason) onReason(r); }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }
  return { content, reasoning, finishReason, actualModel };
}

export async function runChat({ apiKey, model, history, thinkMode, context, mode, webSearch, onThinking, onStatus, signal, baseUrl, withReasoning = true }) {
  const emit = (txt) => {
    if (txt && typeof onThinking === "function") {
      try { onThinking(txt); } catch { /* ignore UI sink errors */ }
    }
  };
  const status = (s) => {
    if (typeof onStatus === "function") {
      try { onStatus(s); } catch { /* ignore UI sink errors */ }
    }
  };
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  emit("Reading your request and choosing the right tools…\n");

  // Real server-side search tool. The previous Web toggle only told the model
  // that search existed; this fetches results and gives them to the model.
  if (webSearch) {
    const latest = [...history].reverse().find((item) => item?.role === "user");
    const query = typeof latest?.content === "string"
      ? latest.content
      : Array.isArray(latest?.content)
        ? latest.content.filter((part) => part?.type === "text").map((part) => part.text || "").join(" ")
        : "";
    if (query.trim()) {
      status("Searching the web…");
      emit("Using the live web search tool…\n");
      try {
        const results = await searchWeb(query, { limit: 5 });
        messages.push({
          role: "system",
          content:
            "WEB_SEARCH TOOL RESULT:\n" + formatSearchResults(results) +
            "\n\nUse these results when relevant. Include the exact source URLs in your reply. " +
            "Do not invent sources or claim a result says something absent from its snippet.",
        });
        status("Reading search results…");
      } catch (error) {
        messages.push({
          role: "system",
          content: `WEB_SEARCH TOOL ERROR: ${String(error?.message || error)}. Continue without web results.`,
        });
      }
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
  // "Animate" mode: video-to-R15-rig animation via extracted frames.
  if (mode === "animate") {
    messages.push({
      role: "system",
      content:
        "ANIMATE MODE — LIVE ANIMATION CREATOR:\n" +
        "The user uploaded a video and wants you to create a Roblox animation " +
        "that reproduces the body movement onto their R15 rig.\n\n" +
        "You are receiving FRAMES extracted at regular intervals from the video as " +
        "images. Study them carefully: observe pose changes across frames — joint " +
        "angles, limb positions, body orientation, timing between frames.\n\n" +
        "The user specifies a target R15 rig name. Look it up in the Code-Index.\n\n" +
        "R15 Motor6D joints you can drive:\n" +
        "  LowerTorso: Root, Waist\n" +
        "  UpperTorso: Waist(inverse), LeftShoulder, RightShoulder\n" +
        "  LeftUpperArm/RightUpperArm: LeftShoulder/RightShoulder, LeftElbow/RightElbow\n" +
        "  LeftLowerArm/RightLowerArm: LeftElbow/RightElbow, LeftWrist/RightWrist\n" +
        "  LeftUpperLeg/RightUpperLeg: LeftHip/RightHip, LeftKnee/RightKnee\n" +
        "  LeftLowerLeg/RightLowerLeg: LeftKnee/RightKnee, LeftAnkle/RightAnkle\n" +
        "  Head: Neck\n\n" +
        "BUILD PLAN:\n" +
        "1. In your 'thinking', describe what motion you observe in each frame\n" +
        "2. Find or create an Animator under the rig's Humanoid if missing\n" +
        "3. Use insert_free_animation with a query matching the observed motion\n" +
        "   (e.g. 'walk animation', 'dance animation', 'fight animation')\n" +
        "4. Create a LocalScript that loads and plays the animation on the rig\n" +
        "5. If no catalog animation matches, describe the key poses you'd author\n" +
        "   and emit a create_script with a KeyframeSequence loader\n\n" +
        "Prefer insert_free_animation with a good query over building keyframes " +
        "manually — the catalog has thousands of humanoid animations.",
    });
  }
  // Inject the live place snapshot (instance tree + script sources + selection)
  // so the model can read existing code and context before acting.
  if (typeof context === "string" && context.trim()) {
    emit("Inspecting the live Studio place and selected objects…\n");
    messages.push({
      role: "system",
      content:
        "Current Roblox place snapshot (updated each turn — this is what exists " +
        "in the game right now):\n\n" + context,
    });
  }
  messages.push(...history);
  const think = THINK_MODES[thinkMode] ? thinkMode : "fast";

  let content = "";
  let reasoning = "";
  let actualModel = null;
  let nativeReasoningSeen = false;
  let streamedJsonThinking = false;
  const jsonThinking = createJsonStringFieldStreamer("thinking", (text) => {
    if (nativeReasoningSeen) return;
    streamedJsonThinking = true;
    emit(text);
  });
  const onReason = (text) => {
    nativeReasoningSeen = true;
    emit(text);
  };
  const onContent = (text) => {
    if (!nativeReasoningSeen) jsonThinking.push(text);
  };

  // Initial call.
  emit("Planning the response and Roblox actions…\n");
  status(think === "fast" ? "Thinking fast…" : "Thinking…");
  let r = await streamOnce({ apiKey, model, messages, onReason, onContent, think, signal, baseUrl, withReasoning });
  content += r.content;
  reasoning += r.reasoning;
  if (r.actualModel) actualModel = r.actualModel;

  // Auto-continue if the model ran out of room on a big build.
  let continuations = 0;
  while (r.finishReason === "length" && continuations < MAX_CONTINUATIONS) {
    if (signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
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
    r = await streamOnce({ apiKey, model, messages: followUp, onReason, onContent, think, signal, baseUrl, withReasoning });
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
    return { thinking: reasoning, reply: content || "(no response)", actions: [], plan: null, truncated: r.finishReason === "length", actualModel };
  }

  const reply = typeof parsed.reply === "string" ? parsed.reply : "";
  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const plan = sanitizePlan(parsed.plan);
  let thinking = reasoning;
  if (!thinking && typeof parsed.thinking === "string") {
    thinking = parsed.thinking;
    if (!streamedJsonThinking) emit(thinking);
  }
  return {
    thinking,
    reply: reply || (plan ? "I made a plan — pick the optional extras and click Build." : actions.length ? "(done)" : "(no response)"),
    actions,
    plan,
    raw: content,
    salvaged,
    truncated: r.finishReason === "length",
    actualModel,
  };
}

// Coerce a model-emitted plan into a known shape. Returns null if the object
// is missing the bare-minimum fields (title + at least one step) so the UI
// doesn't render an empty card.
function sanitizePlan(p) {
  if (!p || typeof p !== "object") return null;
  const title = typeof p.title === "string" ? p.title.trim() : "";
  const summary = typeof p.summary === "string" ? p.summary.trim() : "";
  const steps = Array.isArray(p.steps)
    ? p.steps.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean)
    : [];
  const ideas = Array.isArray(p.ideas)
    ? p.ideas
        .map((i, idx) => i && typeof i === "object" ? {
          id: (typeof i.id === "string" && i.id.trim()) || `idea-${idx + 1}`,
          label: typeof i.label === "string" ? i.label.trim() : "",
          default: i.default === true,
        } : null)
        .filter((i) => i && i.label)
    : [];
  if (!title || steps.length === 0) return null;
  return { title, summary, steps, ideas };
}

// This is the complete model catalog. IDs match the Railway gateway exactly.
const AVAILABLE_MODELS = [
  { id: "gpt-5-6-terra", label: "GPT-5.6 Terra (fast default) — 100 credits", family: "openai", cost: 100, gated: false },
  { id: "gpt-5-6-sol", label: "GPT-5.6 Sol (complex builds) — 100 credits", family: "openai", cost: 100, gated: false },
  { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna — 100 credits", family: "openai", cost: 100, gated: false },
  { id: "claude-opus-5", label: "Claude Opus 5 — 100 credits", family: "anthropic", cost: 100, gated: false },
  { id: "fable-5", label: "Fable 5 — 100 credits", family: "anthropic", cost: 100, gated: false },
  { id: "qwen3.8-max-preview", label: "Qwen 3.8 Max Preview — 100 credits", family: "qwen", cost: 100, gated: false },
];
const AVAILABLE_MODEL_IDS = new Set(AVAILABLE_MODELS.map((model) => model.id));

export function modelCost(id) {
  return AVAILABLE_MODEL_IDS.has(id) ? 100 : 100;
}

export function isModelGated() {
  return false;
}

export function isAvailableModel(id) {
  return AVAILABLE_MODEL_IDS.has(id);
}

export function listAvailableModels() {
  return AVAILABLE_MODELS.map((model) => ({ ...model }));
}
