--!nonstrict
-- FreeModel AI — Roblox Studio plugin
-- Links to the FreeModel × Roblox website and lets the AI build in your game.
--
-- Install: put this file in your Studio Plugins folder
--   (Studio: right-click in the Explorer's Plugins, or use the menu
--    Plugins ▸ Plugins Folder, then drop this .lua file in).
-- It will appear as a toolbar button "FreeModel AI".

local HttpService = game:GetService("HttpService")
local StudioService = game:GetService("StudioService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Selection = game:GetService("Selection")
local InsertService = game:GetService("InsertService")

local SETTINGS_URL = "FreeModel_BackendUrl"
local SETTINGS_TOKEN = "FreeModel_PluginToken"

local backendUrl = (plugin:GetSetting(SETTINGS_URL) or "http://localhost:3000"):gsub("/+$", "")
local pluginToken = plugin:GetSetting(SETTINGS_TOKEN) -- set after linking
local polling = false

-- ===========================================================================
-- UI
-- ===========================================================================
local toolbar = plugin:CreateToolbar("FreeModel AI")
local button = toolbar:CreateButton("FreeModel AI", "Open the AI builder", "rbxassetid://0")
button.ClickableWhenViewportHidden = true

local widget = plugin:CreateDockWidgetPluginGui(
	"FreeModelAI",
	DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 340, 520, 300, 360)
)
widget.Title = "FreeModel AI"

local function make(class, props, parent)
	local o = Instance.new(class)
	for k, v in pairs(props) do o[k] = v end
	if parent then o.Parent = parent end
	return o
end

local root = make("Frame", {
	Size = UDim2.fromScale(1, 1),
	BackgroundColor3 = Color3.fromRGB(13, 17, 23),
	BorderSizePixel = 0,
}, widget)
make("UIPadding", {
	PaddingTop = UDim.new(0, 12), PaddingBottom = UDim.new(0, 12),
	PaddingLeft = UDim.new(0, 12), PaddingRight = UDim.new(0, 12),
}, root)
make("UIListLayout", {
	Padding = UDim.new(0, 8), SortOrder = Enum.SortOrder.LayoutOrder,
}, root)

local function label(text, size, color, order)
	return make("TextLabel", {
		Text = text, Font = Enum.Font.GothamMedium, TextSize = size or 14,
		TextColor3 = color or Color3.fromRGB(230, 237, 243),
		TextXAlignment = Enum.TextXAlignment.Left, TextWrapped = true,
		BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, size and size + 6 or 20),
		AutomaticSize = Enum.AutomaticSize.Y, LayoutOrder = order or 0,
	}, root)
end

local function textbox(placeholder, order)
	local box = make("TextBox", {
		PlaceholderText = placeholder, Text = "", ClearTextOnFocus = false,
		Font = Enum.Font.Gotham, TextSize = 14, TextColor3 = Color3.fromRGB(230, 237, 243),
		PlaceholderColor3 = Color3.fromRGB(120, 130, 140),
		BackgroundColor3 = Color3.fromRGB(22, 27, 34), BorderColor3 = Color3.fromRGB(42, 49, 64),
		Size = UDim2.new(1, 0, 0, 34), TextXAlignment = Enum.TextXAlignment.Left,
		LayoutOrder = order or 0,
	}, root)
	make("UIPadding", { PaddingLeft = UDim.new(0, 8), PaddingRight = UDim.new(0, 8) }, box)
	make("UICorner", { CornerRadius = UDim.new(0, 6) }, box)
	return box
end

local function btn(text, order, color)
	local b = make("TextButton", {
		Text = text, Font = Enum.Font.GothamBold, TextSize = 14,
		TextColor3 = Color3.fromRGB(255, 255, 255),
		BackgroundColor3 = color or Color3.fromRGB(226, 35, 26),
		Size = UDim2.new(1, 0, 0, 36), AutoButtonColor = true, LayoutOrder = order or 0,
	}, root)
	make("UICorner", { CornerRadius = UDim.new(0, 6) }, b)
	return b
end

label("FreeModel AI", 20, Color3.fromRGB(255, 255, 255), 1)
local statusLabel = label("Not linked.", 12, Color3.fromRGB(139, 148, 158), 2)

label("Backend URL", 12, Color3.fromRGB(139, 148, 158), 3)
local urlBox = textbox("http://localhost:3000", 4)
urlBox.Text = backendUrl

label("Pairing code (from the website)", 12, Color3.fromRGB(139, 148, 158), 5)
local codeBox = textbox("123456", 6)
local linkBtn = btn("Link this place", 7)
local unlinkBtn = btn("Unlink", 8, Color3.fromRGB(48, 54, 70))

label("Chat", 12, Color3.fromRGB(139, 148, 158), 9)
local logScroll = make("ScrollingFrame", {
	Size = UDim2.new(1, 0, 0, 180), BackgroundColor3 = Color3.fromRGB(22, 27, 34),
	BorderColor3 = Color3.fromRGB(42, 49, 64), CanvasSize = UDim2.new(),
	AutomaticCanvasSize = Enum.AutomaticSize.Y, ScrollBarThickness = 6, LayoutOrder = 10,
}, root)
make("UICorner", { CornerRadius = UDim.new(0, 6) }, logScroll)
make("UIPadding", { PaddingTop = UDim.new(0,6), PaddingBottom = UDim.new(0,6), PaddingLeft = UDim.new(0,8), PaddingRight = UDim.new(0,8) }, logScroll)
make("UIListLayout", { Padding = UDim.new(0, 6), SortOrder = Enum.SortOrder.LayoutOrder }, logScroll)

local chatBox = textbox("Ask the AI to build something…", 11)
local sendBtn = btn("Send", 12, Color3.fromRGB(59, 130, 246))

-- ===========================================================================
-- Logging helpers
-- ===========================================================================
local logOrder = 0
local function logLine(text, color)
	logOrder += 1
	make("TextLabel", {
		Text = text, Font = Enum.Font.Gotham, TextSize = 13,
		TextColor3 = color or Color3.fromRGB(200, 208, 218),
		TextXAlignment = Enum.TextXAlignment.Left, TextWrapped = true,
		BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y, LayoutOrder = logOrder,
	}, logScroll)
end
local function setStatus(text, color)
	statusLabel.Text = text
	statusLabel.TextColor3 = color or Color3.fromRGB(139, 148, 158)
end

-- ===========================================================================
-- HTTP helpers
-- ===========================================================================
local function request(method, path, body)
	local opts = {
		Url = backendUrl .. path,
		Method = method,
		Headers = { ["Content-Type"] = "application/json" },
	}
	if pluginToken then opts.Headers["Authorization"] = "Bearer " .. pluginToken end
	if body ~= nil then opts.Body = HttpService:JSONEncode(body) end

	local ok, res = pcall(function() return HttpService:RequestAsync(opts) end)
	if not ok then return nil, tostring(res) end
	local data = nil
	if res.Body and #res.Body > 0 then
		local decoded, derr = pcall(function() return HttpService:JSONDecode(res.Body) end)
		if decoded then data = derr end
	end
	if not res.Success then
		local msg = (data and data.error) or ("HTTP " .. res.StatusCode)
		return nil, msg
	end
	return data
end

-- ===========================================================================
-- Place snapshot — lets the AI SEE the game: instance tree + every script's
-- full source + the current selection. Sent to /api/context before chats and
-- on a periodic refresh so the model can read existing code and context.
-- ===========================================================================
-- Services worth showing the AI. Order matters only for readability.
local SNAPSHOT_SERVICES = {
	"Workspace", "Lighting", "ReplicatedFirst", "ReplicatedStorage",
	"ServerScriptService", "ServerStorage", "StarterGui", "StarterPack",
	"StarterPlayer", "SoundService", "Teams",
}

local MAX_NODES = 1500        -- stop walking after this many instances
local MAX_SCRIPT_CHARS = 12000 -- per-script source cap
local MAX_DEPTH = 12

-- Classes that get a flat Named-Index entry at the top of the snapshot. Picks
-- user-named containers, every script, every remote/bindable — the things the
-- AI is most likely to be asked about by name ("EventService", "Handler",
-- "OnDamage"). Anything else stays in the tree but isn't indexed by name.
local INDEX_CLASSES = {
	Folder = true, Configuration = true, Model = true,
	Script = true, LocalScript = true, ModuleScript = true,
	RemoteEvent = true, RemoteFunction = true,
	BindableEvent = true, BindableFunction = true,
}

-- Build a `game.Service.Child…` path so the AI can target it in actions.
local function instancePath(inst)
	local parts = {}
	local node = inst
	while node and node ~= game do
		table.insert(parts, 1, node.Name)
		node = node.Parent
	end
	return table.concat(parts, ".")
end

local function captureSnapshot()
	local out = {}
	local nodes = 0
	local truncated = false
	local sourceFailures = 0  -- scripts whose .Source we couldn't read (permission)
	local sourcesRead = 0
	local nameIndex = {}      -- name -> { {class=..., path=...}, ... }

	local function indent(d) return string.rep("  ", d) end

	-- Read a script's source, capped. Returns (text, ok). ok=false means the
	-- read errored — almost always the plugin lacking script-injection rights.
	local function readSource(scriptInst)
		local ok, src = pcall(function() return scriptInst.Source end)
		if not ok then return nil, false end
		src = src or ""
		if #src > MAX_SCRIPT_CHARS then
			src = src:sub(1, MAX_SCRIPT_CHARS) .. "\n-- […source truncated…]"
		end
		return src, true
	end

	local function walk(inst, depth)
		if truncated then return end
		for _, child in ipairs(inst:GetChildren()) do
			if nodes >= MAX_NODES then truncated = true; return end
			nodes += 1
			table.insert(out, string.format("%s- %s (%s)", indent(depth), child.Name, child.ClassName))

			-- Index user-named containers / scripts / remotes by name so the AI
			-- can look up "EventService" → full path without walking the tree.
			if INDEX_CLASSES[child.ClassName] then
				local list = nameIndex[child.Name]
				if not list then list = {}; nameIndex[child.Name] = list end
				table.insert(list, { class = child.ClassName, path = instancePath(child) })
			end

			-- Inline the full source of any script so the AI can read/fix it.
			if child:IsA("LuaSourceContainer") then
				local src, ok = readSource(child)
				table.insert(out, string.format('%s  source of %s:', indent(depth), instancePath(child)))
				if ok then
					sourcesRead += 1
					table.insert(out, "```lua")
					table.insert(out, src)
					table.insert(out, "```")
				else
					sourceFailures += 1
					table.insert(out, "  [source unavailable — Script Injection permission not granted]")
				end
			end

			if depth < MAX_DEPTH then walk(child, depth + 1) end
		end
	end

	for _, svcName in ipairs(SNAPSHOT_SERVICES) do
		local okSvc, svc = pcall(function() return game:GetService(svcName) end)
		if okSvc and svc then
			table.insert(out, "## " .. svcName)
			walk(svc, 1)
		end
	end

	-- What the user has selected right now — the AI should focus here. For a
	-- selected script, inline its full source directly so it's front and centre.
	local sel = Selection:Get()
	if #sel > 0 then
		table.insert(out, "\n## Currently selected in Studio")
		for _, inst in ipairs(sel) do
			table.insert(out, string.format("- %s (%s)", instancePath(inst), inst.ClassName))
			if inst:IsA("LuaSourceContainer") then
				local src, ok = readSource(inst)
				if ok then
					table.insert(out, "```lua")
					table.insert(out, src)
					table.insert(out, "```")
				else
					sourceFailures += 1
					table.insert(out, "  [source unavailable — Script Injection permission not granted]")
				end
			end
		end
	end

	-- Build the Named-Index — a flat lookup of every important named instance
	-- in the place. Lets the AI resolve "EventService" → full path in one
	-- read without hunting through the tree.
	if next(nameIndex) then
		local names = {}
		for k in pairs(nameIndex) do table.insert(names, k) end
		table.sort(names)
		local lines = {
			"## Named-Index — full paths of every named container / script / remote.",
			"## When the user refers to one of these by name, use the FULL path below",
			"## as your action's \"parent\" or \"path\". Do not guess paths.",
		}
		for _, n in ipairs(names) do
			local entries = nameIndex[n]
			if #entries == 1 then
				local e = entries[1]
				table.insert(lines, string.format("- %s [%s] -> %s", n, e.class, e.path))
			else
				table.insert(lines, string.format("- %s (%d):", n, #entries))
				for _, e in ipairs(entries) do
					table.insert(lines, string.format("    - [%s] %s", e.class, e.path))
				end
			end
		end
		table.insert(out, 1, "")
		table.insert(out, 1, table.concat(lines, "\n"))
	end

	-- If we couldn't read ANY script sources, the plugin is almost certainly
	-- missing the Script Injection permission. Put a loud banner at the very top
	-- so the AI (and the user, via the log) knows why scripts look empty.
	if sourceFailures > 0 and sourcesRead == 0 then
		table.insert(out, 1,
			"⚠ IMPORTANT: I could not read ANY script sources from this place. The " ..
			"Spider plugin needs the 'Script Injection' permission (also called " ..
			"'Allow script modification'). Tell the user to enable it: Studio → the " ..
			"plugin's permission shield / Plugins tab → allow script injection, then " ..
			"re-link. Until then you cannot see or edit script contents.\n")
	end

	if truncated then
		table.insert(out, "\n[snapshot truncated: place is very large]")
	end
	return table.concat(out, "\n"), sourceFailures, sourcesRead
end

-- Push the current snapshot to the server. Returns ok, err.
local warnedNoScriptPerm = false
local function pushContext()
	if not pluginToken then return false, "not linked" end
	local snapshot, sourceFailures, sourcesRead = captureSnapshot()
	-- Warn once in the log if we can't read any script sources (permission).
	if sourceFailures and sourceFailures > 0 and (sourcesRead or 0) == 0 and not warnedNoScriptPerm then
		warnedNoScriptPerm = true
		logLine("⚠ Can't read script sources — enable the plugin's Script Injection permission, then re-link.", Color3.fromRGB(255, 196, 84))
	end
	local data, err = request("POST", "/api/context", { context = snapshot })
	return data ~= nil, err
end

-- ===========================================================================
-- Virus / backdoor scanner — runs on every inserted free model.
-- Free models on Roblox are a classic malware vector: backdoor require()s,
-- remote loadstring, obfuscated getfenv loops, Discord-webhook exfil, and
-- "anti-lag"/"cleaner" GUI lures. We scan every descendant script and either
-- STRIP the offending lines (and disable the script) or DELETE it outright when
-- it's clearly a pure backdoor. Originals are backed up in a trailing comment.
-- ===========================================================================

-- Patterns that, on their own, mark a script as MALICIOUS (delete-worthy).
-- These have essentially no legitimate use inside a dropped-in free model.
local MALICIOUS_PATTERNS = {
	{ pat = "require%s*%(%s*%d%d%d%d%d+%s*%)", why = "require() of a remote asset id (backdoor)" },
	{ pat = "loadstring%s*%(",                 why = "loadstring (remote code execution)" },
	{ pat = "getfenv%s*%(",                    why = "getfenv (obfuscation/sandbox escape)" },
	{ pat = "setfenv%s*%(",                    why = "setfenv (obfuscation/sandbox escape)" },
	{ pat = "HttpGet%s*%(",                    why = "HttpGet (downloads remote code)" },
	{ pat = "GetObjects%s*%(",                 why = "GetObjects (loads remote assets)" },
	{ pat = "request%s*%(%s*{",                why = "raw http request (exfiltration)" },
	{ pat = "discord%.com/api/webhooks",       why = "Discord webhook (data exfiltration)" },
	{ pat = "discordapp%.com/api/webhooks",    why = "Discord webhook (data exfiltration)" },
}

-- Patterns that are SUSPICIOUS — strip the line + disable, but don't nuke the
-- whole script just for these (they can appear in legitimate code).
local SUSPICIOUS_PATTERNS = {
	{ pat = "MarketplaceService", why = "marketplace prompt (possible scam purchase)" },
	{ pat = "PromptPurchase",     why = "purchase prompt" },
	{ pat = "\\x%x%x",            why = "hex-escaped string (obfuscation)" },
	{ pat = "string%.char%s*%(",  why = "string.char build (possible obfuscation)" },
	{ pat = "\\27Lua",            why = "Lua bytecode blob" },
}

-- Scan one source string. Returns: verdict ("clean"|"strip"|"delete"),
-- cleanedSource, list of reasons.
local function scanSource(src)
	if type(src) ~= "string" or src == "" then return "clean", src, {} end
	local reasons = {}
	local deleteWorthy = false

	for _, rule in ipairs(MALICIOUS_PATTERNS) do
		if string.find(src, rule.pat) then
			deleteWorthy = true
			table.insert(reasons, rule.why)
		end
	end
	for _, rule in ipairs(SUSPICIOUS_PATTERNS) do
		if string.find(src, rule.pat) then
			table.insert(reasons, rule.why)
		end
	end

	if #reasons == 0 then return "clean", src, reasons end

	-- A script that is *mostly* a backdoor (very short + malicious) → delete.
	-- e.g. the classic one-liner `require(1234567).run(...)`.
	if deleteWorthy and #src < 600 then
		return "delete", "", reasons
	end

	-- Otherwise strip the offending lines and neutralize the script.
	local kept, removed = {}, 0
	for line in (src .. "\n"):gmatch("(.-)\n") do
		local bad = false
		for _, rule in ipairs(MALICIOUS_PATTERNS) do
			if string.find(line, rule.pat) then bad = true; break end
		end
		if not bad then
			for _, rule in ipairs(SUSPICIOUS_PATTERNS) do
				if string.find(line, rule.pat) then bad = true; break end
			end
		end
		if bad then
			removed += 1
			table.insert(kept, "-- [Spider removed a suspicious line] " .. line)
		else
			table.insert(kept, line)
		end
	end
	local cleaned = "-- ⚠ Spider virus scan neutralized this script ("
		.. removed .. " line(s) removed). Review before re-enabling.\n"
		.. table.concat(kept, "\n")
	return "strip", cleaned, reasons
end

-- Scan every script under `root`. Mutates the tree in place.
-- Returns a summary string of what was done.
local function scanModelForViruses(root)
	local scripts = {}
	if root:IsA("LuaSourceContainer") then table.insert(scripts, root) end
	for _, d in ipairs(root:GetDescendants()) do
		if d:IsA("LuaSourceContainer") then table.insert(scripts, d) end
	end

	local deleted, stripped, threats = 0, 0, {}
	for _, s in ipairs(scripts) do
		local ok, src = pcall(function() return s.Source end)
		if ok then
			local verdict, cleaned, reasons = scanSource(src)
			if verdict == "delete" then
				deleted += 1
				for _, r in ipairs(reasons) do table.insert(threats, r) end
				logLine("🛡 deleted backdoor script: " .. s:GetFullName(), Color3.fromRGB(248, 81, 73))
				pcall(function() s:Destroy() end)
			elseif verdict == "strip" then
				stripped += 1
				for _, r in ipairs(reasons) do table.insert(threats, r) end
				logLine("🛡 cleaned script: " .. s:GetFullName(), Color3.fromRGB(255, 196, 84))
				pcall(function()
					s.Source = cleaned
					if s:IsA("Script") or s:IsA("LocalScript") then s.Disabled = true end
				end)
			end
		end
	end

	if deleted == 0 and stripped == 0 then
		return string.format("scanned %d script(s) — clean ✓", #scripts)
	end
	-- Dedupe threat reasons for the summary.
	local seen, uniq = {}, {}
	for _, r in ipairs(threats) do if not seen[r] then seen[r] = true; table.insert(uniq, r) end end
	return string.format(
		"🛡 virus scan: deleted %d, cleaned %d of %d script(s). Threats: %s",
		deleted, stripped, #scripts, table.concat(uniq, "; ")
	)
end

-- Search the Roblox creator marketplace (free models) by keyword and return
-- the best free, public asset id — or nil. Uses the toolbox search endpoint
-- Studio itself uses; it can be unavailable, so callers must handle nil.
local function searchFreeModel(query)
	if not query or query == "" then return nil, "empty query" end
	local url = "https://apis.roblox.com/toolbox-service/v1/marketplace/10"
		.. "?keyword=" .. HttpService:UrlEncode(query)
		.. "&limit=12&sortType=Relevance"
	local ok, res = pcall(function()
		return HttpService:RequestAsync({ Url = url, Method = "GET" })
	end)
	if not ok or not res.Success then return nil, "search unavailable" end
	local pok, data = pcall(function() return HttpService:JSONDecode(res.Body) end)
	if not pok or not data or not data.data then return nil, "no results" end
	for _, entry in ipairs(data.data) do
		local id = entry.id or (entry.asset and entry.asset.id)
		if id then return id end
	end
	return nil, "no free model found for '" .. query .. "'"
end

-- ===========================================================================
-- Action executor — turns AI action objects into real Studio instances.
-- ===========================================================================
local function v3(t)
	if typeof(t) == "table" and #t >= 3 then return Vector3.new(t[1], t[2], t[3]) end
	return nil
end
local function c3(t)
	if typeof(t) == "table" and #t >= 3 then return Color3.new(t[1], t[2], t[3]) end
	return nil
end

-- Resolve a dotted path like "Workspace.Model.Part" starting from `game`.
-- Falls back to a global name search if exact resolution fails, so the AI can
-- target instances by name alone (e.g. "EventService.Handler") without
-- knowing where the user keeps them. The service-name shortcut only fires at
-- the first segment so a stray "Lighting" mid-path can't teleport us out.
local function resolvePath(path)
	if not path or path == "" then return workspace end

	local function descendantNamed(root, name)
		for _, d in ipairs(root:GetDescendants()) do
			if d.Name == name then return d end
		end
		return nil
	end

	local function strict(p)
		local node = game
		local first = true
		for part in string.gmatch(p, "[^%.]+") do
			local nxt = node:FindFirstChild(part)
			if not nxt and first then
				local okSvc, svc = pcall(function() return game:GetService(part) end)
				nxt = (okSvc and svc) or nil
			end
			if not nxt then return nil, ("not found: " .. part .. " in " .. p) end
			node = nxt
			first = false
		end
		return node
	end

	local node, err = strict(path)
	if node then return node end

	-- Strict resolution missed. Locate the first segment by NAME anywhere in
	-- the searched services, then walk the rest beneath it. Same set of
	-- services the snapshot exposes, so behaviour matches what the AI was shown.
	local segments = {}
	for part in string.gmatch(path, "[^%.]+") do table.insert(segments, part) end
	if #segments == 0 then return nil, err end

	local first = segments[1]
	local found
	for _, svcName in ipairs(SNAPSHOT_SERVICES) do
		local okSvc, svc = pcall(function() return game:GetService(svcName) end)
		if okSvc and svc then
			if svc.Name == first then found = svc; break end
			local hit = descendantNamed(svc, first)
			if hit then found = hit; break end
		end
	end
	if not found then return nil, ("not found: " .. first .. " in " .. path) end

	local cur = found
	for i = 2, #segments do
		local seg = segments[i]
		local nxt = cur:FindFirstChild(seg) or descendantNamed(cur, seg)
		if not nxt then return nil, ("not found: " .. seg .. " under " .. cur:GetFullName()) end
		cur = nxt
	end
	return cur
end

-- Apply a property table to an instance, coercing vector/color arrays & enums.
local function applyProps(inst, props)
	if typeof(props) ~= "table" then return end
	for key, value in pairs(props) do
		local ok = pcall(function()
			local current = inst[key]
			local tv = typeof(current)
			if tv == "Vector3" and typeof(value) == "table" then
				inst[key] = v3(value)
			elseif tv == "Color3" and typeof(value) == "table" then
				inst[key] = c3(value)
			elseif tv == "EnumItem" and typeof(value) == "string" then
				-- e.g. Material = "Neon" -> Enum.Material.Neon
				local enumName = tostring(current.EnumType)
				inst[key] = (Enum[enumName] :: any)[value]
			else
				inst[key] = value
			end
		end)
		if not ok then
			-- Try a direct assignment as a fallback (covers numbers/bools/strings).
			pcall(function() inst[key] = value end)
		end
	end
end

-- Execute one action. Returns (ok, summary, errMsg).
local function executeAction(a)
	local t = a.type
	if t == "create_instance" then
		local parent, perr = resolvePath(a.parent or "Workspace")
		if not parent then return false, "create_instance", perr end
		local inst = Instance.new(a.className or "Part")
		if a.name then inst.Name = a.name end
		applyProps(inst, a.properties)
		inst.Parent = parent
		Selection:Set({ inst })
		return true, string.format("created %s '%s' in %s", a.className or "Part", inst.Name, a.parent or "Workspace")

	elseif t == "set_property" then
		local inst, ierr = resolvePath(a.path)
		if not inst then return false, "set_property", ierr end
		applyProps(inst, a.properties)
		return true, "updated " .. (a.path or "?")

	elseif t == "delete_instance" then
		local inst, ierr = resolvePath(a.path)
		if not inst then return false, "delete_instance", ierr end
		inst:Destroy()
		return true, "deleted " .. (a.path or "?")

	elseif t == "create_script" then
		local parent, perr = resolvePath(a.parent or "ServerScriptService")
		if not parent then return false, "create_script", perr end
		local cls = a.scriptClass or "Script"
		if cls ~= "Script" and cls ~= "LocalScript" and cls ~= "ModuleScript" then cls = "Script" end
		local s = Instance.new(cls)
		s.Name = a.name or "AIScript"
		s.Source = a.source or ""
		s.Parent = parent
		Selection:Set({ s })
		return true, string.format("created %s '%s' in %s", cls, s.Name, a.parent or "ServerScriptService")

	elseif t == "edit_script" then
		local inst, ierr = resolvePath(a.path)
		if not inst then return false, "edit_script", ierr end
		if not inst:IsA("LuaSourceContainer") then
			return false, "edit_script", (a.path or "?") .. " is not a script"
		end
		local ok, err = pcall(function() inst.Source = a.source or "" end)
		if not ok then return false, "edit_script", tostring(err) end
		Selection:Set({ inst })
		return true, "edited script " .. (a.path or "?")

	elseif t == "insert_free_model" then
		local parent, perr = resolvePath(a.parent or "Workspace")
		if not parent then return false, "insert_free_model", perr end

		-- Resolve an asset id: prefer an explicit id, else search by keyword.
		local assetId = tonumber(a.assetId)
		if not assetId and a.query then
			local found, serr = searchFreeModel(tostring(a.query))
			if not found then return false, "insert_free_model", serr end
			assetId = found
		end
		if not assetId then return false, "insert_free_model", "no assetId or query given" end

		-- Load the asset. LoadAsset returns a Model containing the asset's roots.
		local lok, loaded = pcall(function() return InsertService:LoadAsset(assetId) end)
		if not lok or not loaded then
			return false, "insert_free_model", "could not load asset " .. tostring(assetId)
				.. " (" .. tostring(loaded) .. ")"
		end

		-- SCAN FOR VIRUSES before anything is parented into the live game.
		local scanSummary = scanModelForViruses(loaded)
		logLine(scanSummary, Color3.fromRGB(139, 148, 158))

		-- Unwrap the LoadAsset container: parent its children to the target.
		-- If there is a single child, use it directly (and rename if asked).
		local children = loaded:GetChildren()
		local inserted
		if #children == 1 then
			inserted = children[1]
			if a.name then pcall(function() inserted.Name = a.name end) end
			inserted.Parent = parent
		else
			-- Multiple roots: keep the wrapper as a named Model.
			loaded.Name = a.name or ("InsertedModel_" .. assetId)
			loaded.Parent = parent
			inserted = loaded
		end
		if #children == 1 then loaded:Destroy() end

		Selection:Set({ inserted })
		return true, string.format("inserted free model %s — %s", tostring(assetId), scanSummary)

	elseif t == "insert_free_audio" then
		local parent, perr = resolvePath(a.parent or "Workspace")
		if not parent then return false, "insert_free_audio", perr end

		-- Resolve an asset id: prefer an explicit id, else search by keyword.
		local assetId = tonumber(a.assetId)
		if not assetId and a.query then
			local found, serr = searchFreeModel(tostring(a.query))
			if not found then return false, "insert_free_audio", serr end
			assetId = found
		end
		if not assetId then return false, "insert_free_audio", "no assetId or query given" end

		-- Create a Sound instance with the asset
		local sound = Instance.new("Sound")
		sound.Name = a.name or "Sound"
		sound.SoundId = "rbxassetid://" .. tostring(assetId)
		sound.Parent = parent
		Selection:Set({ sound })
		return true, string.format("inserted audio %s '%s' in %s", tostring(assetId), sound.Name, a.parent or "Workspace")

	elseif t == "insert_free_animation" then
		local parent, perr = resolvePath(a.parent or "Workspace")
		if not parent then return false, "insert_free_animation", perr end

		-- Resolve an asset id: prefer an explicit id, else search by keyword.
		local assetId = tonumber(a.assetId)
		if not assetId and a.query then
			local found, serr = searchFreeModel(tostring(a.query))
			if not found then return false, "insert_free_animation", serr end
			assetId = found
		end
		if not assetId then return false, "insert_free_animation", "no assetId or query given" end

		-- Create an Animation instance with the asset
		local anim = Instance.new("Animation")
		anim.Name = a.name or "Animation"
		anim.AnimationId = "rbxassetid://" .. tostring(assetId)
		anim.Parent = parent
		Selection:Set({ anim })
		return true, string.format("inserted animation %s '%s' in %s", tostring(assetId), anim.Name, a.parent or "Workspace")
	end
	return false, tostring(t), "unknown action type"
end

-- Run a batch of actions inside one undoable recording.
local function runActions(actions)
	if #actions == 0 then return end
	local recording = ChangeHistoryService:TryBeginRecording("FreeModel AI build")
	local results = {}
	for _, a in ipairs(actions) do
		-- pcall guards against malformed actions crashing the whole batch.
		local pok, s, sum, e = pcall(executeAction, a)
		if not pok then
			s, sum, e = false, tostring(a.type), tostring(s)
		end
		table.insert(results, { id = a.id, type = a.type, ok = s, summary = sum, error = e })
		logLine((s and "✓ " or "✕ ") .. tostring(sum) .. (e and (" — " .. e) or ""),
			s and Color3.fromRGB(63, 185, 80) or Color3.fromRGB(248, 81, 73))
	end
	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end
	-- Report results back to the server.
	request("POST", "/api/actions/result", { results = results })
end

-- ===========================================================================
-- Polling loop — pull queued actions while linked.
-- ===========================================================================
local function startPolling()
	if polling then return end
	polling = true
	task.spawn(function()
		local tick = 0
		-- Send a snapshot immediately so the AI can see the place right away.
		pcall(pushContext)
		while polling and pluginToken do
			local data, err = request("GET", "/api/actions/poll")
			if data and data.actions and #data.actions > 0 then
				runActions(data.actions)
				-- The place just changed — refresh the AI's view of it.
				pcall(pushContext)
				tick = 0
			elseif err == "invalid plugin token" then
				setStatus("Link expired. Please re-link.", Color3.fromRGB(248, 81, 73))
				pluginToken = nil
				plugin:SetSetting(SETTINGS_TOKEN, nil)
				polling = false
				break
			end
			-- Periodic refresh (~every 10s) catches edits the user made by hand.
			tick += 1
			if tick >= 7 then pcall(pushContext); tick = 0 end
			task.wait(1.5)
		end
		polling = false
	end)
end

local function refreshLinkedUI()
	if pluginToken then
		setStatus("Linked. Listening for AI actions…", Color3.fromRGB(63, 185, 80))
		startPolling()
	else
		setStatus("Not linked.", Color3.fromRGB(139, 148, 158))
	end
end

-- ===========================================================================
-- Link / unlink
-- ===========================================================================
linkBtn.MouseButton1Click:Connect(function()
	-- Normalize: strip surrounding whitespace and any trailing slashes, so
	-- "https://host/" doesn't become "https://host//api/..." (a 404).
	backendUrl = urlBox.Text:gsub("^%s+", ""):gsub("%s+$", ""):gsub("/+$", "")
	urlBox.Text = backendUrl
	plugin:SetSetting(SETTINGS_URL, backendUrl)

	local code = codeBox.Text:gsub("%D", "")
	if #code < 4 then
		setStatus("Enter the 6-digit code from the website.", Color3.fromRGB(248, 81, 73))
		return
	end

	setStatus("Linking…", Color3.fromRGB(139, 148, 158))
	local userId = StudioService:GetUserId()
	local userName = "Studio User"
	pcall(function() userName = StudioService:GetUserId() and game:GetService("Players"):GetNameFromUserIdAsync(userId) or userName end)

	local data, err = request("POST", "/api/link/confirm", {
		code = code,
		userId = userId,
		userName = userName,
		placeId = game.PlaceId,
	})
	if not data then
		setStatus("Link failed: " .. tostring(err), Color3.fromRGB(248, 81, 73))
		return
	end
	pluginToken = data.pluginToken
	plugin:SetSetting(SETTINGS_TOKEN, pluginToken)
	codeBox.Text = ""
	logLine("Linked to website. The AI can now build here.", Color3.fromRGB(63, 185, 80))
	refreshLinkedUI()
end)

unlinkBtn.MouseButton1Click:Connect(function()
	pluginToken = nil
	polling = false
	plugin:SetSetting(SETTINGS_TOKEN, nil)
	setStatus("Unlinked.", Color3.fromRGB(139, 148, 158))
end)

-- ===========================================================================
-- In-Studio chat (optional — same AI, replies shown here, actions applied)
-- ===========================================================================
local function sendChat()
	local text = chatBox.Text:gsub("^%s+", ""):gsub("%s+$", "")
	if text == "" then return end
	if not pluginToken then
		setStatus("Link first before chatting.", Color3.fromRGB(248, 81, 73))
		return
	end
	chatBox.Text = ""
	logLine("you: " .. text, Color3.fromRGB(120, 170, 255))
	task.spawn(function()
		-- Refresh the AI's view of the place right before it answers.
		pcall(pushContext)
		local data, err = request("POST", "/api/plugin/chat", { message = text })
		if not data then
			logLine("error: " .. tostring(err), Color3.fromRGB(248, 81, 73))
			return
		end
		if type(data.thinking) == "string" and data.thinking ~= "" then
			logLine("💭 " .. data.thinking, Color3.fromRGB(139, 148, 158))
		end
		logLine("ai: " .. tostring(data.reply), Color3.fromRGB(230, 237, 243))
		-- Actions are queued server-side; the poll loop will pick them up.
	end)
end
sendBtn.MouseButton1Click:Connect(sendChat)
chatBox.FocusLost:Connect(function(enter) if enter then sendChat() end end)

-- ===========================================================================
-- Toolbar toggle + boot
-- ===========================================================================
button.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

refreshLinkedUI()
