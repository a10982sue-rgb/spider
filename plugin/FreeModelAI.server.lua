--!nonstrict
-- Spider AI — Roblox Studio plugin
-- Links to the Spider website and lets the AI build in your game.
-- Version 2.2.1 — accepts full create destinations and slash-separated paths.
--
-- Install: put this file in your Studio Plugins folder
--   (Studio: right-click in the Explorer's Plugins, or use the menu
--    Plugins ▸ Plugins Folder, then drop this .lua file in).

local HttpService = game:GetService("HttpService")
local StudioService = game:GetService("StudioService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Selection = game:GetService("Selection")
local InsertService = game:GetService("InsertService")

local PLUGIN_VERSION = "2.2.1"
local DEFAULT_BACKEND_URL = "https://spider-web-ju2g.onrender.com"
local SETTINGS_URL = "Spider_BackendUrl"
local SETTINGS_TOKEN = "Spider_PluginToken"
local LEGACY_SETTINGS_URL = "FreeModel_BackendUrl"
local LEGACY_SETTINGS_TOKEN = "FreeModel_PluginToken"

-- Preserve existing links when upgrading from the legacy plugin.
local backendUrl = (
	plugin:GetSetting(SETTINGS_URL)
	or plugin:GetSetting(LEGACY_SETTINGS_URL)
	or DEFAULT_BACKEND_URL
):gsub("/+$", "")
local pluginToken = plugin:GetSetting(SETTINGS_TOKEN) or plugin:GetSetting(LEGACY_SETTINGS_TOKEN)
local polling = false
local linkVerified = false -- true only after /api/link/verify returns ok

-- Migrate settings from versions that still used the FreeModel-prefixed keys.
plugin:SetSetting(SETTINGS_URL, backendUrl)
if pluginToken then plugin:SetSetting(SETTINGS_TOKEN, pluginToken) end
plugin:SetSetting(LEGACY_SETTINGS_URL, nil)
plugin:SetSetting(LEGACY_SETTINGS_TOKEN, nil)

local function clearSavedToken()
	plugin:SetSetting(SETTINGS_TOKEN, nil)
	plugin:SetSetting(LEGACY_SETTINGS_TOKEN, nil)
end

-- Instance code system: assigns a stable 6-char code to each indexed instance.
-- path -> code and code -> path. Persists across snapshot calls, cleared on unlink.
local instanceCodeByPath = {}
local instancePathByCode = {}

-- ===========================================================================
-- Color palette — matches the Spider web workspace.
-- ===========================================================================
local C = {
	BG_ROOT    = Color3.fromRGB(7, 9, 13),
	BG_CARD    = Color3.fromRGB(16, 20, 28),
	BG_RAISED  = Color3.fromRGB(23, 28, 38),
	BG_INPUT   = Color3.fromRGB(12, 16, 23),
	BG_BUBBLE_USER = Color3.fromRGB(8, 92, 111),
	BG_BUBBLE_AI   = Color3.fromRGB(18, 24, 33),
	BG_BUBBLE_OK   = Color3.fromRGB(7, 48, 36),
	BG_BUBBLE_ERR  = Color3.fromRGB(56, 20, 25),
	BORDER     = Color3.fromRGB(36, 43, 55),
	BORDER_H   = Color3.fromRGB(69, 83, 102),
	ACCENT     = Color3.fromRGB(103, 232, 249),
	ACCENT_H   = Color3.fromRGB(165, 243, 252),
	ACCENT_DIM = Color3.fromRGB(8, 105, 128),
	TEXT_1     = Color3.fromRGB(247, 249, 252),
	TEXT_2     = Color3.fromRGB(170, 180, 196),
	TEXT_3     = Color3.fromRGB(117, 129, 150),
	SUCCESS    = Color3.fromRGB(16, 185, 129),
	DANGER     = Color3.fromRGB(248, 113, 113),
	WARN       = Color3.fromRGB(245, 158, 11),
}

-- ===========================================================================
-- UI Helpers
-- ===========================================================================
local function make(class, props, parent)
	local o = Instance.new(class)
	for k, v in pairs(props) do o[k] = v end
	if parent then o.Parent = parent end
	return o
end

local function card(props, parent)
	local f = make("Frame", {
		Size = props.Size or UDim2.new(1, 0, 0, 0),
		AutomaticSize = props.AutomaticSize or Enum.AutomaticSize.Y,
		BackgroundColor3 = props.Bg or C.BG_CARD,
		BorderSizePixel = 0,
		LayoutOrder = props.Order or 0,
	}, parent)
	make("UICorner", { CornerRadius = UDim.new(0, 10) }, f)
	make("UIStroke", { Color = C.BORDER, Thickness = 1, Transparency = 0.15 }, f)
	if props.Pad then
		make("UIPadding", {
			PaddingTop = UDim.new(0, props.Pad), PaddingBottom = UDim.new(0, props.Pad),
			PaddingLeft = UDim.new(0, props.Pad), PaddingRight = UDim.new(0, props.Pad),
		}, f)
	end
	if props.List then
		make("UIListLayout", { Padding = UDim.new(0, props.List), SortOrder = Enum.SortOrder.LayoutOrder }, f)
	end
	return f
end

-- ===========================================================================
-- UI Construction
-- ===========================================================================
local toolbar = plugin:CreateToolbar("Spider AI")
local button = toolbar:CreateButton("Spider AI", "Open the AI builder", "rbxassetid://0")
button.ClickableWhenViewportHidden = true

local widget = plugin:CreateDockWidgetPluginGui(
	"SpiderAI",
	DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 370, 650, 320, 460)
)
widget.Title = "Spider AI"

local root = make("ScrollingFrame", {
	Size = UDim2.fromScale(1, 1),
	BackgroundColor3 = C.BG_ROOT,
	BorderSizePixel = 0,
	CanvasSize = UDim2.new(),
	AutomaticCanvasSize = Enum.AutomaticSize.Y,
	ScrollingDirection = Enum.ScrollingDirection.Y,
	ScrollBarThickness = 5,
	ScrollBarImageColor3 = C.BORDER_H,
}, widget)
make("UIPadding", {
	PaddingTop = UDim.new(0, 10), PaddingBottom = UDim.new(0, 10),
	PaddingLeft = UDim.new(0, 10), PaddingRight = UDim.new(0, 10),
}, root)
make("UIListLayout", {
	Padding = UDim.new(0, 10), SortOrder = Enum.SortOrder.LayoutOrder,
}, root)

-- Header card
local headerCard = card({ Order = 1, Pad = 12, List = 4 })
headerCard.Parent = root

make("TextLabel", {
	Text = "SPIDER WORKSPACE", Font = Enum.Font.GothamBold, TextSize = 9,
	TextColor3 = C.ACCENT, TextXAlignment = Enum.TextXAlignment.Left,
	BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 12),
	LayoutOrder = 1,
}, headerCard)

local titleRow = make("Frame", {
	Size = UDim2.new(1, 0, 0, 26), BackgroundTransparency = 1,
	BorderSizePixel = 0, LayoutOrder = 2,
}, headerCard)

make("TextLabel", {
	Text = "Build in Studio", Font = Enum.Font.GothamBold, TextSize = 19,
	TextColor3 = C.TEXT_1, TextXAlignment = Enum.TextXAlignment.Left,
	BackgroundTransparency = 1, Size = UDim2.new(1, -78, 1, 0),
}, titleRow)

local versionBadge = make("TextLabel", {
	Text = "v" .. PLUGIN_VERSION, Font = Enum.Font.GothamBold, TextSize = 9,
	TextColor3 = C.ACCENT, BackgroundColor3 = C.BG_RAISED,
	BorderSizePixel = 0, AnchorPoint = Vector2.new(1, 0.5),
	Position = UDim2.new(1, 0, 0.5, 0), Size = UDim2.new(0, 70, 0, 20),
}, titleRow)
make("UICorner", { CornerRadius = UDim.new(1, 0) }, versionBadge)
make("UIStroke", { Color = C.ACCENT_DIM, Thickness = 1, Transparency = 0.15 }, versionBadge)

make("TextLabel", {
	Text = "Your AI build bridge for Roblox Studio.",
	Font = Enum.Font.Gotham, TextSize = 10.5,
	TextColor3 = C.TEXT_3, TextXAlignment = Enum.TextXAlignment.Left,
	BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 16),
	LayoutOrder = 3,
}, headerCard)

-- Status row: dot + text
local statusRow = make("Frame", {
	Size = UDim2.new(1, 0, 0, 18), BackgroundTransparency = 1,
	BorderSizePixel = 0, LayoutOrder = 4,
}, headerCard)
make("UIListLayout", {
	FillDirection = Enum.FillDirection.Horizontal,
	VerticalAlignment = Enum.VerticalAlignment.Center,
	Padding = UDim.new(0, 6),
	SortOrder = Enum.SortOrder.LayoutOrder,
}, statusRow)

local statusDot = make("Frame", {
	Size = UDim2.new(0, 8, 0, 8),
	BackgroundColor3 = C.TEXT_3,
	BorderSizePixel = 0,
	LayoutOrder = 1,
}, statusRow)
make("UICorner", { CornerRadius = UDim.new(1, 0) }, statusDot)

local statusLabel = make("TextLabel", {
	Text = "Not linked", Font = Enum.Font.Gotham, TextSize = 11,
	TextColor3 = C.TEXT_2, TextXAlignment = Enum.TextXAlignment.Left,
	BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 16),
	LayoutOrder = 2,
}, statusRow)

-- Connection card
local connCard = card({ Order = 2, Pad = 12, List = 7 })
connCard.Parent = root

make("TextLabel", {
	Text = "CONNECT STUDIO", Font = Enum.Font.GothamBold, TextSize = 10,
	TextColor3 = C.TEXT_2, TextXAlignment = Enum.TextXAlignment.Left,
	BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 14),
	LayoutOrder = 1,
}, connCard)
make("TextLabel", {
	Text = "Paste the pairing code shown on the Spider website.",
	Font = Enum.Font.Gotham, TextSize = 10.5,
	TextColor3 = C.TEXT_3, TextXAlignment = Enum.TextXAlignment.Left,
	TextWrapped = true, BackgroundTransparency = 1,
	Size = UDim2.new(1, 0, 0, 28), LayoutOrder = 2,
}, connCard)

local function connLabel(text)
	return make("TextLabel", {
		Text = text, Font = Enum.Font.Gotham, TextSize = 10.5,
		TextColor3 = C.TEXT_3, TextXAlignment = Enum.TextXAlignment.Left,
		BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 14),
		LayoutOrder = 0,
	})
end

local function connInput(placeholder, order)
	local box = make("TextBox", {
		PlaceholderText = placeholder, Text = "", ClearTextOnFocus = false,
		Font = Enum.Font.Gotham, TextSize = 12.5, TextColor3 = C.TEXT_1,
		PlaceholderColor3 = C.TEXT_3,
		BackgroundColor3 = C.BG_INPUT, BorderSizePixel = 0,
		Size = UDim2.new(1, 0, 0, 36), TextXAlignment = Enum.TextXAlignment.Left,
		LayoutOrder = order or 0,
	})
	make("UIPadding", { PaddingLeft = UDim.new(0, 10), PaddingRight = UDim.new(0, 10) }, box)
	make("UICorner", { CornerRadius = UDim.new(0, 8) }, box)
	local stroke = make("UIStroke", { Color = C.BORDER, Thickness = 1, Transparency = 0 }, box)
	box.Focused:Connect(function() stroke.Color = C.ACCENT_DIM end)
	box.FocusLost:Connect(function() stroke.Color = C.BORDER end)
	return box
end

local function connBtn(text, order, accent)
	local baseColor = accent and C.ACCENT or C.BG_RAISED
	local hoverColor = accent and C.ACCENT_H or C.BG_INPUT
	local b = make("TextButton", {
		Text = text, Font = Enum.Font.GothamBold, TextSize = 13,
		TextColor3 = accent and C.BG_ROOT or C.TEXT_1,
		BackgroundColor3 = baseColor, BorderSizePixel = 0,
		Size = UDim2.new(1, 0, 0, 38), AutoButtonColor = false,
		LayoutOrder = order or 0,
	})
	make("UICorner", { CornerRadius = UDim.new(0, 8) }, b)
	make("UIStroke", {
		Color = accent and C.ACCENT_DIM or C.BORDER,
		Thickness = 1, Transparency = accent and 1 or 0,
	}, b)
	b.MouseEnter:Connect(function() b.BackgroundColor3 = hoverColor end)
	b.MouseLeave:Connect(function() b.BackgroundColor3 = baseColor end)
	return b
end

local backendLabel = connLabel("Backend URL")
backendLabel.LayoutOrder = 3
backendLabel.Parent = connCard
local urlBox = connInput(DEFAULT_BACKEND_URL, 4)
urlBox.Text = backendUrl
urlBox.Parent = connCard

local pairingLabel = connLabel("Pairing code (from website)")
pairingLabel.LayoutOrder = 5
pairingLabel.Parent = connCard
local codeBox = connInput("123456", 6)
codeBox.Font = Enum.Font.RobotoMono
codeBox.TextSize = 15
codeBox.TextXAlignment = Enum.TextXAlignment.Center
codeBox.Parent = connCard
local linkBtn = connBtn("Link this place", 7, true)
linkBtn.Parent = connCard
local unlinkBtn = connBtn("Unlink Studio", 8, false)
unlinkBtn.Parent = connCard

-- Chat card
local chatCard = card({ Order = 3, Pad = 12, List = 7 })
chatCard.Parent = root

make("TextLabel", {
	Text = "BUILD CHAT", Font = Enum.Font.GothamBold, TextSize = 10,
	TextColor3 = C.TEXT_2, TextXAlignment = Enum.TextXAlignment.Left,
	BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 14),
	LayoutOrder = 1,
}, chatCard)
make("TextLabel", {
	Text = "Ask Spider to build, edit, or inspect your open place.",
	Font = Enum.Font.Gotham, TextSize = 10.5,
	TextColor3 = C.TEXT_3, TextXAlignment = Enum.TextXAlignment.Left,
	TextWrapped = true, BackgroundTransparency = 1,
	Size = UDim2.new(1, 0, 0, 28), LayoutOrder = 2,
}, chatCard)

local logScroll = make("ScrollingFrame", {
	Size = UDim2.new(1, 0, 0, 180), BackgroundColor3 = C.BG_INPUT,
	BorderSizePixel = 0, CanvasSize = UDim2.new(),
	AutomaticCanvasSize = Enum.AutomaticSize.Y, ScrollBarThickness = 5,
	ScrollBarImageColor3 = C.BORDER_H, LayoutOrder = 3,
}, chatCard)
make("UICorner", { CornerRadius = UDim.new(0, 8) }, logScroll)
make("UIStroke", { Color = C.BORDER, Thickness = 1, Transparency = 0 }, logScroll)
make("UIPadding", { PaddingTop = UDim.new(0,6), PaddingBottom = UDim.new(0,6),
	PaddingLeft = UDim.new(0,8), PaddingRight = UDim.new(0,8) }, logScroll)
make("UIListLayout", { Padding = UDim.new(0, 5), SortOrder = Enum.SortOrder.LayoutOrder }, logScroll)

local chatBox = connInput("Describe what to build...", 4)
chatBox.Parent = chatCard
chatBox.LayoutOrder = 4
local sendBtn = connBtn("Send to Spider", 5, true)
sendBtn.Parent = chatCard

-- ===========================================================================
-- Logging
-- ===========================================================================
local logOrder = 0
local function nextOrder()
	logOrder += 1
	return logOrder
end

local function logMessage(text, kind, color)
	-- kind: "user" | "ai" | "think" | "system" | "action-ok" | "action-err"
	local bg
	if kind == "user" then bg = C.BG_BUBBLE_USER
	elseif kind == "ai" then bg = C.BG_BUBBLE_AI
	elseif kind == "action-ok" then bg = C.BG_BUBBLE_OK
	elseif kind == "action-err" then bg = C.BG_BUBBLE_ERR
	else bg = nil
	end

	local txtColor = color or (kind == "think" and C.TEXT_3 or C.TEXT_1)
	local txtSize = (kind == "system" or kind == "action-ok" or kind == "action-err") and 11 or 12.5
	local align = (kind == "user") and Enum.TextXAlignment.Right or Enum.TextXAlignment.Left
	local isTransparent = (kind == "system" or kind == "think")

	local bubble = make("Frame", {
		Size = UDim2.new(1, -12, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		BackgroundColor3 = bg or C.BG_CARD,
		BackgroundTransparency = isTransparent and 1 or 0,
		BorderSizePixel = 0,
		LayoutOrder = nextOrder(),
	}, logScroll)
	if not isTransparent then
		make("UICorner", { CornerRadius = UDim.new(0, 4) }, bubble)
		make("UIPadding", { PaddingTop = UDim.new(0,5), PaddingBottom = UDim.new(0,5),
			PaddingLeft = UDim.new(0,7), PaddingRight = UDim.new(0,7) }, bubble)
	end

	make("TextLabel", {
		Text = text, Font = Enum.Font.Gotham, TextSize = txtSize,
		TextColor3 = txtColor, TextXAlignment = align,
		TextWrapped = true, BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
	}, bubble)
end

-- Compatibility wrapper for existing logLine calls
local function logLine(text, color)
	logMessage(text, "ai", color)
end

local function setStatus(text, color)
	statusLabel.Text = text
	statusLabel.TextColor3 = color or C.TEXT_2
end

local function setStatusDot(color)
	statusDot.BackgroundColor3 = color or C.TEXT_3
end

-- ===========================================================================
-- Instance code system
-- ===========================================================================
local function getInstanceCode(path)
	if instanceCodeByPath[path] then
		return instanceCodeByPath[path]
	end
	local code
	repeat
		local guid = HttpService:GenerateGUID()
		local cleaned = guid:gsub("-", ""):gsub("[^%w]", "")
		code = cleaned:sub(1, 6):lower()
	until #code == 6 and not instancePathByCode[code]
	instanceCodeByPath[path] = code
	instancePathByCode[code] = path
	return code
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
-- Place snapshot
-- ===========================================================================
local SNAPSHOT_SERVICES = {
	"Workspace", "Lighting", "ReplicatedFirst", "ReplicatedStorage",
	"ServerScriptService", "ServerStorage", "StarterGui", "StarterPack",
	"StarterPlayer", "SoundService", "Teams",
}

local MAX_NODES = 1200
local MAX_SCRIPT_CHARS = 9000
local MAX_DEPTH = 10

local INDEX_CLASSES = {
	Folder = true, Configuration = true, Model = true,
	Script = true, LocalScript = true, ModuleScript = true,
	RemoteEvent = true, RemoteFunction = true,
	BindableEvent = true, BindableFunction = true,
	-- Asset-bearing instances the AI may want to edit by name.
	Animation = true, KeyframeSequence = true,
	Sound = true, ParticleEmitter = true,
	Tool = true, Humanoid = true,
	-- GUI roots — useful to reference by name.
	ScreenGui = true, SurfaceGui = true, BillboardGui = true,
}

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
	local sourceFailures = 0
	local sourcesRead = 0
	local nameIndex = {}

	local function indent(d) return string.rep("  ", d) end

	local function readSource(scriptInst)
		local ok, src = pcall(function() return scriptInst.Source end)
		if not ok then return nil, false end
		src = src or ""
		if #src > MAX_SCRIPT_CHARS then
			src = src:sub(1, MAX_SCRIPT_CHARS) .. "\n-- [...source truncated...]"
		end
		return src, true
	end

	local function walk(inst, depth)
		if truncated then return end
		for _, child in ipairs(inst:GetChildren()) do
			if nodes >= MAX_NODES then truncated = true; return end
			nodes += 1
			local extra = ""

			-- Asset-bearing instances: include key properties so the AI knows
			-- what's inside without needing find_code round-trips.
			if child:IsA("Animation") then
				local aid = pcall(function() return child.AnimationId end)
				extra = string.format(' [AnimationId="%s"]', (aid and aid ~= "") and tostring(aid) or "(empty)")
			elseif child:IsA("Sound") then
				local sid = pcall(function() return child.SoundId end)
				if sid and sid ~= "" then
					local vol = pcall(function() return child.Volume end)
					local loop = pcall(function() return child.Looped end)
					extra = string.format(' [SoundId="%s", Volume=%.1f, Looped=%s]', tostring(sid), tonumber(vol) or 1, tostring(loop))
				end
			elseif child:IsA("Model") then
				local pp = pcall(function() return child.PrimaryPart end)
				if pp then
					local ppName = pcall(function() return pp.Name end)
					extra = string.format(" [PrimaryPart=%s, Children=%d]", ppName and tostring(ppName) or "?", #child:GetChildren())
				else
					extra = string.format(" [Children=%d]", #child:GetChildren())
				end
			elseif child:IsA("Tool") then
				extra = string.format(" [Children=%d]", #child:GetChildren())
			elseif child:IsA("KeyframeSequence") then
				local kfs = pcall(function() return child:GetKeyframes() end)
				if kfs and #kfs > 0 then
					local poses = {}
					for _, kf in ipairs(kfs) do
						table.insert(poses, string.format("%.2f", kf.Time))
					end
					extra = string.format(" [%d keyframes at t=%s]", #kfs, table.concat(poses, ","))
				else
					extra = " [no keyframes]"
				end
			elseif child:IsA("ParticleEmitter") then
				local en = pcall(function() return child.Enabled end)
				local rate = pcall(function() return child.Rate end)
				extra = string.format(" [Enabled=%s, Rate=%s]", tostring(en), tostring(rate))
			end

			table.insert(out, string.format("%s- %s (%s)%s", indent(depth), child.Name, child.ClassName, extra))

			if INDEX_CLASSES[child.ClassName] then
				local list = nameIndex[child.Name]
				if not list then list = {}; nameIndex[child.Name] = list end
				table.insert(list, { class = child.ClassName, path = instancePath(child) })
			end

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

	-- Code-Index: flat lookup of every important named instance with 6-char codes.
	if next(nameIndex) then
		local names = {}
		for k in pairs(nameIndex) do table.insert(names, k) end
		table.sort(names)
		local lines = {
			"## Code-Index — short codes for every notable instance in the place.",
			"## Each entry gives a 6-character code you can use as the 'targetCode'",
			"## field in your actions. Use the code to unambiguously reference an instance.",
			"## The full path is always included as a fallback.",
			"## ",
			"## Asset-bearing instances (Animation, Sound, Model, KeyframeSequence, etc.)",
			"## show their key properties inline in the tree above — look for",
			"## [AnimationId=...], [SoundId=...], [PrimaryPart=...], [N keyframes...]",
			"## annotations next to each entry in the service snapshots.",
		}
		for _, n in ipairs(names) do
			local entries = nameIndex[n]
			if #entries == 1 then
				local e = entries[1]
				local code = getInstanceCode(e.path)
				table.insert(lines, string.format("- [%s] %s (%s) -> %s", code, n, e.class, e.path))
			else
				table.insert(lines, string.format("- %s (%d instances):", n, #entries))
				for _, e in ipairs(entries) do
					local code = getInstanceCode(e.path)
					table.insert(lines, string.format("    - [%s] (%s) %s", code, e.class, e.path))
				end
			end
		end
		table.insert(out, 1, "")
		table.insert(out, 1, table.concat(lines, "\n"))
	end

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

local warnedNoScriptPerm = false
local function pushContext()
	if not pluginToken then return false, "not linked" end
	local snapshot, sourceFailures, sourcesRead = captureSnapshot()
	if sourceFailures and sourceFailures > 0 and (sourcesRead or 0) == 0 and not warnedNoScriptPerm then
		warnedNoScriptPerm = true
		logMessage("⚠ Can't read script sources — enable the plugin's Script Injection permission, then re-link.", "system", C.WARN)
	end
	local data, err = request("POST", "/api/context", { context = snapshot })
	return data ~= nil, err
end

-- ===========================================================================
-- Virus scanner (unchanged)
-- ===========================================================================
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

local SUSPICIOUS_PATTERNS = {
	{ pat = "MarketplaceService", why = "marketplace prompt (possible scam purchase)" },
	{ pat = "PromptPurchase",     why = "purchase prompt" },
	{ pat = "\\x%x%x",            why = "hex-escaped string (obfuscation)" },
	{ pat = "string%.char%s*%(",  why = "string.char build (possible obfuscation)" },
	{ pat = "\\27Lua",            why = "Lua bytecode blob" },
}

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

	if deleteWorthy and #src < 600 then
		return "delete", "", reasons
	end

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
				logMessage("🛡 deleted backdoor: " .. s:GetFullName(), "action-err", C.DANGER)
				pcall(function() s:Destroy() end)
			elseif verdict == "strip" then
				stripped += 1
				for _, r in ipairs(reasons) do table.insert(threats, r) end
				logMessage("🛡 cleaned: " .. s:GetFullName(), "system", C.WARN)
				pcall(function()
					s.Source = cleaned
					if s:IsA("Script") or s:IsA("LocalScript") then s.Disabled = true end
				end)
			end
		end
	end

	if deleted == 0 and stripped == 0 then
		return string.format("scanned %d script(s) — clean", #scripts)
	end
	local seen, uniq = {}, {}
	for _, r in ipairs(threats) do if not seen[r] then seen[r] = true; table.insert(uniq, r) end end
	return string.format(
		"🛡 virus scan: deleted %d, cleaned %d of %d script(s). Threats: %s",
		deleted, stripped, #scripts, table.concat(uniq, "; ")
	)
end

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
-- Action resolver + executor
-- ===========================================================================
local function v3(t)
	if typeof(t) == "table" and #t >= 3 then return Vector3.new(t[1], t[2], t[3]) end
	return nil
end
local function c3(t)
	if typeof(t) == "table" and #t >= 3 then return Color3.new(t[1], t[2], t[3]) end
	return nil
end
local function v2(t)
	if typeof(t) == "table" and #t >= 2 then return Vector2.new(t[1], t[2]) end
	return nil
end
local function cf(t)
	if typeof(t) ~= "table" then return nil end
	if #t >= 12 then
		return CFrame.new(
			t[1], t[2], t[3],
			t[4], t[5], t[6],
			t[7], t[8], t[9],
			t[10], t[11], t[12]
		)
	end
	if #t >= 6 then
		return CFrame.new(t[1], t[2], t[3])
			* CFrame.Angles(math.rad(t[4]), math.rad(t[5]), math.rad(t[6]))
	end
	if #t >= 3 then return CFrame.new(t[1], t[2], t[3]) end
	return nil
end
-- UDim is {scale, offset}. Accept a number too (treated as pure offset).
local function ud(v)
	if typeof(v) == "table" and #v >= 2 then return UDim.new(v[1], v[2]) end
	if typeof(v) == "number" then return UDim.new(0, v) end
	return nil
end
-- UDim2 accepts {sX, oX, sY, oY} OR {{sX,oX},{sY,oY}} OR {sX, sY} (scale-only).
local function ud2(v)
	if typeof(v) ~= "table" then return nil end
	if #v >= 4 and typeof(v[1]) == "number" then
		return UDim2.new(v[1], v[2], v[3], v[4])
	end
	if #v == 2 and typeof(v[1]) == "table" and typeof(v[2]) == "table" then
		return UDim2.new(v[1][1] or 0, v[1][2] or 0, v[2][1] or 0, v[2][2] or 0)
	end
	if #v == 2 and typeof(v[1]) == "number" and typeof(v[2]) == "number" then
		return UDim2.fromScale(v[1], v[2])
	end
	return nil
end

-- Resolve a dotted path starting from game. Falls back to name-based search.
local function resolvePath(path)
	if not path or path == "" then return workspace end
	path = tostring(path):gsub("\\", "."):gsub("/", ".")
		:gsub("^%.+", ""):gsub("%.+$", ""):gsub("%.+", ".")
		:gsub("^game%.", "")

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

-- Resolve a target: try targetCode first (from Code-Index), fall back to
-- parent/path string. Returns (instance, resolvedName, errorString).
local function resolveTarget(action)
	-- Code lookup: if we have a targetCode, look it up in our code table
	if action.targetCode and instancePathByCode[action.targetCode] then
		local p = instancePathByCode[action.targetCode]
		local inst = resolvePath(p)
		if inst then return inst, p, nil end
	end
	-- Fallback: resolve by parent or path string
	local target = action.parent or action.path
	if not target or target == "" then
		return nil, nil, "no targetCode, parent, or path provided"
	end
	local inst, err = resolvePath(target)
	return inst, target, err
end

-- Property-name → datatype hints, for when the live value's typeof() isn't
-- helpful (default values can read as nil/number on some classes). Only
-- properties commonly emitted by the AI are listed.
local PROP_TYPE = {
	-- UDim2
	Size = "UDim2", Position = "UDim2", CanvasSize = "UDim2", CanvasPosition = "UDim2",
	AbsoluteSize = "UDim2", CellSize = "UDim2", CellPadding = "UDim2",
	-- UDim
	CornerRadius = "UDim", PaddingTop = "UDim", PaddingBottom = "UDim",
	PaddingLeft = "UDim", PaddingRight = "UDim", Padding = "UDim",
	-- Color3
	BackgroundColor3 = "Color3", BorderColor3 = "Color3", TextColor3 = "Color3",
	TextStrokeColor3 = "Color3", PlaceholderColor3 = "Color3",
	ImageColor3 = "Color3", Color = "Color3", Color3 = "Color3",
	-- Vector2
	AnchorPoint = "Vector2",
}

-- Properties that expect another Instance cannot accept the string paths used
-- in JSON actions directly. Resolve them against the live place first.
local INSTANCE_REF_PROPS = {
	PrimaryPart = true,
	Part0 = true, Part1 = true,
	Attachment0 = true, Attachment1 = true,
	Adornee = true,
}

local function resolveInstanceReference(owner, value)
	if typeof(value) ~= "string" or value == "" then return nil end
	local resolved = resolvePath(value)
	if resolved then return resolved end
	-- Also accept a child name such as PrimaryPart="Base".
	if owner:IsA("Model") then
		local child = owner:FindFirstChild(value, true)
		if child then return child end
	end
	if owner.Parent then
		local sibling = owner.Parent:FindFirstChild(value, true)
		if sibling then return sibling end
	end
	return nil
end

local function applyProps(inst, props)
	if typeof(props) ~= "table" then return end
	for key, value in pairs(props) do
		local ok = pcall(function()
			local current = inst[key]
			local tv = typeof(current)
			-- Prefer the live property's type; fall back to PROP_TYPE for nil/defaults.
			if tv == "nil" or tv == "number" or tv == "string" or tv == "boolean" then
				if PROP_TYPE[key] then tv = PROP_TYPE[key] end
			end
			if INSTANCE_REF_PROPS[key] and typeof(value) == "string" then
				local ref = resolveInstanceReference(inst, value)
				if not ref then error("instance reference not found: " .. value) end
				inst[key] = ref
			elseif tv == "UDim2" and typeof(value) == "table" then
				inst[key] = ud2(value) or value
			elseif tv == "UDim" and (typeof(value) == "table" or typeof(value) == "number") then
				inst[key] = ud(value) or value
			elseif tv == "Vector2" and typeof(value) == "table" then
				inst[key] = v2(value) or value
			elseif tv == "Vector3" and typeof(value) == "table" then
				inst[key] = v3(value) or value
			elseif tv == "CFrame" and typeof(value) == "table" then
				inst[key] = cf(value) or value
			elseif tv == "Color3" and typeof(value) == "table" then
				inst[key] = c3(value) or value
			elseif typeof(inst[key]) == "EnumItem" and typeof(value) == "string" then
				local enumName = tostring(inst[key].EnumType):gsub("^Enum%.", "")
				local enumType = (Enum :: any)[enumName]
				if not enumType or not enumType[value] then
					error("invalid enum value " .. enumName .. "." .. value)
				end
				inst[key] = enumType[value]
			else
				inst[key] = value
			end
		end)
		if not ok then
			pcall(function() inst[key] = value end)
		end
	end
end

local function executeAction(a)
	local t = a.type
	if t == "create_instance" then
		local parent, parentPath, perr = resolveTarget({ targetCode = a.targetCode, parent = a.parent })
		if not parent then return false, "create_instance", perr end
		local inst = Instance.new(a.className or "Part")
		if a.name then inst.Name = a.name end
		applyProps(inst, a.properties)
		inst.Parent = parent
		Selection:Set({ inst })
		return true, string.format("created %s '%s' in %s", a.className or "Part", inst.Name, parentPath or a.parent or "Workspace")

	elseif t == "set_property" then
		local inst, resolvedPath, ierr = resolveTarget({ targetCode = a.targetCode, path = a.path })
		if not inst then return false, "set_property", ierr end
		applyProps(inst, a.properties)
		return true, "updated " .. (resolvedPath or a.path or "?")

	elseif t == "delete_instance" then
		local inst, resolvedPath, ierr = resolveTarget({ targetCode = a.targetCode, path = a.path })
		if not inst then return false, "delete_instance", ierr end
		inst:Destroy()
		return true, "deleted " .. (resolvedPath or a.path or "?")

	elseif t == "create_script" then
		local cls = a.scriptClass or "Script"
		if cls ~= "Script" and cls ~= "LocalScript" and cls ~= "ModuleScript" then cls = "Script" end
		local defaultParent = "ServerScriptService"
		if cls == "LocalScript" then
			defaultParent = "StarterPlayer.StarterPlayerScripts"
		elseif cls == "ModuleScript" then
			defaultParent = "ReplicatedStorage"
		end
		local requestedParent = tostring(a.parent or a.path or defaultParent)
			:gsub("\\", "."):gsub("/", ".")
			:gsub("^%.+", ""):gsub("%.+$", ""):gsub("%.+", ".")
			:gsub("^game%.", "")
		local scriptName = tostring(a.name or "AIScript")
		local destinationLeaf = requestedParent:match("([^.]+)$")
		if destinationLeaf and destinationLeaf:lower() == scriptName:lower() then
			requestedParent = requestedParent:match("^(.*)%.") or defaultParent
		end
		local parent, parentPath, perr = resolveTarget({
			targetCode = a.targetCode,
			parent = requestedParent,
		})
		if not parent then return false, "create_script", perr end
		local s = Instance.new(cls)
		s.Name = scriptName
		s.Source = a.source or ""
		s.Parent = parent
		Selection:Set({ s })
		return true, string.format("created %s '%s' in %s", cls, s.Name, parentPath or a.parent or "ServerScriptService")

	elseif t == "edit_script" then
		local inst, resolvedPath, ierr = resolveTarget({ targetCode = a.targetCode, path = a.path })
		if not inst then return false, "edit_script", ierr end
		if not inst:IsA("LuaSourceContainer") then
			return false, "edit_script", (resolvedPath or a.path or "?") .. " is not a script"
		end
		local ok, err = pcall(function() inst.Source = a.source or "" end)
		if not ok then return false, "edit_script", tostring(err) end
		Selection:Set({ inst })
		return true, "edited script " .. (resolvedPath or a.path or "?")

	elseif t == "insert_free_model" then
		local parent, parentPath, perr = resolveTarget({ targetCode = a.targetCode, parent = a.parent })
		if not parent then return false, "insert_free_model", perr end

		local assetId = tonumber(a.assetId)
		if not assetId and a.query then
			local found, serr = searchFreeModel(tostring(a.query))
			if not found then return false, "insert_free_model", serr end
			assetId = found
		end
		if not assetId then return false, "insert_free_model", "no assetId or query given" end

		local lok, loaded = pcall(function() return InsertService:LoadAsset(assetId) end)
		if not lok or not loaded then
			return false, "insert_free_model", "could not load asset " .. tostring(assetId)
				.. " (" .. tostring(loaded) .. ")"
		end

		local scanSummary = scanModelForViruses(loaded)
		logMessage(scanSummary, "system", C.TEXT_2)

		local children = loaded:GetChildren()
		local inserted
		if #children == 1 then
			inserted = children[1]
			if a.name then pcall(function() inserted.Name = a.name end) end
			inserted.Parent = parent
		else
			loaded.Name = a.name or ("InsertedModel_" .. assetId)
			loaded.Parent = parent
			inserted = loaded
		end
		if #children == 1 then loaded:Destroy() end

		Selection:Set({ inserted })
		return true, string.format("inserted free model %s — %s", tostring(assetId), scanSummary)

	elseif t == "insert_free_audio" then
		local parent, parentPath, perr = resolveTarget({ targetCode = a.targetCode, parent = a.parent })
		if not parent then return false, "insert_free_audio", perr end

		local assetId = tonumber(a.assetId)
		if not assetId and a.query then
			local found, serr = searchFreeModel(tostring(a.query))
			if not found then return false, "insert_free_audio", serr end
			assetId = found
		end
		if not assetId then return false, "insert_free_audio", "no assetId or query given" end

		local sound = Instance.new("Sound")
		sound.Name = a.name or "Sound"
		sound.SoundId = "rbxassetid://" .. tostring(assetId)
		sound.Parent = parent
		Selection:Set({ sound })
		return true, string.format("inserted audio %s '%s' in %s", tostring(assetId), sound.Name, parentPath or a.parent or "Workspace")

	elseif t == "insert_free_animation" then
		local parent, parentPath, perr = resolveTarget({ targetCode = a.targetCode, parent = a.parent })
		if not parent then return false, "insert_free_animation", perr end

		local assetId = tonumber(a.assetId)
		if not assetId and a.query then
			local found, serr = searchFreeModel(tostring(a.query))
			if not found then return false, "insert_free_animation", serr end
			assetId = found
		end
		if not assetId then return false, "insert_free_animation", "no assetId or query given" end

		local anim = Instance.new("Animation")
		anim.Name = a.name or "Animation"
		anim.AnimationId = "rbxassetid://" .. tostring(assetId)
		anim.Parent = parent
		Selection:Set({ anim })
		return true, string.format("inserted animation %s '%s' in %s", tostring(assetId), anim.Name, parentPath or a.parent or "Workspace")
	end
	return false, tostring(t), "unknown action type"
end

-- ===========================================================================
-- Action batching
-- ===========================================================================
local function runActions(actions)
	if #actions == 0 then return end
	local recording = ChangeHistoryService:TryBeginRecording("Spider AI build")
	local results = {}
	for _, a in ipairs(actions) do
		local pok, s, sum, e = pcall(executeAction, a)
		if not pok then
			s, sum, e = false, tostring(a.type), tostring(s)
		end
		table.insert(results, { id = a.id, type = a.type, ok = s, summary = sum, error = e })
		local kind = s and "action-ok" or "action-err"
		local color = s and C.SUCCESS or C.DANGER
		local prefix = s and "✓" or "✕"
		local text = string.format("%s [%s] %s", prefix, a.type, tostring(sum))
		if e then text = text .. " — " .. e end
		logMessage(text, kind, color)
	end
	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end
	request("POST", "/api/actions/result", { results = results })
end

-- ===========================================================================
-- Polling
-- ===========================================================================
local refreshLinkedUI

local function startPolling()
	if polling then return end
	polling = true
	task.spawn(function()
		local tick = 0
		pcall(pushContext)
		while polling and pluginToken do
			local data, err = request("GET", "/api/actions/poll")
			if data and data.actions and #data.actions > 0 then
				runActions(data.actions)
				pcall(pushContext)
				tick = 0
			elseif err == "invalid plugin token" then
				pluginToken = nil
				linkVerified = false
				clearSavedToken()
				polling = false
				refreshLinkedUI()
				setStatus("Link expired. Paste a new code.", C.DANGER)
				setStatusDot(C.DANGER)
				break
			end
			tick += 1
			if tick >= 7 then pcall(pushContext); tick = 0 end
			task.wait(1.5)
		end
		polling = false
	end)
end

refreshLinkedUI = function()
	if pluginToken and linkVerified then
		setStatus("Linked — listening for actions...", C.SUCCESS)
		setStatusDot(C.SUCCESS)
		startPolling()
	elseif pluginToken and not linkVerified then
		setStatus("Verifying link…", C.WARN)
		setStatusDot(C.WARN)
	else
		setStatus("Not linked", C.TEXT_2)
		setStatusDot(C.TEXT_3)
	end

	local linked = pluginToken ~= nil and linkVerified
	pairingLabel.Visible = not linked
	codeBox.Visible = not linked
	linkBtn.Visible = not linked
	unlinkBtn.Visible = pluginToken ~= nil
end

-- Asks the server whether our stored token is still valid. The plugin used to
-- assume "we have a token therefore we're linked", which left the UI lying as
-- "Linked" after a server restart wiped the token. Now we ALWAYS verify before
-- believing it.
local function verifyStoredLink()
	if not pluginToken then
		linkVerified = false
		refreshLinkedUI()
		return
	end
	setStatus("Verifying link…", C.WARN)
	setStatusDot(C.WARN)
	local data, err = request("POST", "/api/link/verify")
	if data then
		linkVerified = true
		refreshLinkedUI()
	else
		-- 401 / unknown link / server cold-started: the stored token is dead.
		linkVerified = false
		pluginToken = nil
		clearSavedToken()
		instanceCodeByPath = {}
		instancePathByCode = {}
		refreshLinkedUI()
		setStatus("Link expired — paste a new code.", C.DANGER)
		setStatusDot(C.DANGER)
	end
end

-- ===========================================================================
-- Link / unlink
-- ===========================================================================
linkBtn.MouseButton1Click:Connect(function()
	backendUrl = urlBox.Text:gsub("^%s+", ""):gsub("%s+$", ""):gsub("/+$", "")
	urlBox.Text = backendUrl
	plugin:SetSetting(SETTINGS_URL, backendUrl)

	local code = codeBox.Text:gsub("%D", "")
	if #code < 4 then
		setStatus("Enter the 6-digit code from the website.", C.DANGER)
		return
	end

	setStatus("Linking...", C.TEXT_2)
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
		setStatus("Link failed: " .. tostring(err), C.DANGER)
		return
	end
	pluginToken = data.pluginToken
	plugin:SetSetting(SETTINGS_TOKEN, pluginToken)
	linkVerified = true -- we just confirmed; no need to re-verify on the same call
	codeBox.Text = ""
	logMessage("Linked to Spider. AI can now build here.", "system", C.SUCCESS)
	refreshLinkedUI()
end)

unlinkBtn.MouseButton1Click:Connect(function()
	local _, serverError = request("POST", "/api/link/unlink")
	pluginToken = nil
	linkVerified = false
	polling = false
	clearSavedToken()
	-- Clear code tables so old codes don't persist across re-links
	instanceCodeByPath = {}
	instancePathByCode = {}
	refreshLinkedUI()
	if serverError then
		logMessage("Unlinked locally. Server said: " .. tostring(serverError), "system", C.WARN)
	else
		logMessage("Studio unlinked from Spider.", "system", C.TEXT_3)
	end
end)

-- ===========================================================================
-- In-Studio chat
-- ===========================================================================
local function sendChat()
	local text = chatBox.Text:gsub("^%s+", ""):gsub("%s+$", "")
	if text == "" then return end
	if not pluginToken then
		setStatus("Link first before chatting.", C.DANGER)
		return
	end
	chatBox.Text = ""
	logMessage("you: " .. text, "user", C.ACCENT)
	task.spawn(function()
		pcall(pushContext)
		local data, err = request("POST", "/api/plugin/chat", { message = text })
		if not data then
			logMessage("error: " .. tostring(err), "action-err", C.DANGER)
			return
		end
		if type(data.thinking) == "string" and data.thinking ~= "" then
			logMessage("💭 " .. data.thinking, "think", C.TEXT_3)
		end
		logMessage("ai: " .. tostring(data.reply), "ai", C.TEXT_1)
	end)
end
sendBtn.MouseButton1Click:Connect(sendChat)
chatBox.FocusLost:Connect(function(enter) if enter then sendChat() end end)

-- ===========================================================================
-- Code search — when the AI emits a find_code or read_script action, the
-- plugin resolves the target and returns the source so the AI can see it on
-- the very next turn. This lets "edit CombatScript in the tycoon" work.
-- ===========================================================================
local function executeFindCode(a)
	local target = a.target or a.name or ""
	local className = a.className or nil
	local q = target:lower()
	if q == "" then return false, "find_code", "no target name given" end
	local hits = {}
	for p in pairs(instanceCodeByPath) do
		if p:lower():find(q, 1, true) then table.insert(hits, p) end
	end
	if #hits == 0 then
		local function search(inst, depth)
			if depth > 18 then return end
			for _, child in ipairs(inst:GetChildren()) do
				if child.Name:lower():find(q, 1, true) and child:IsA("LuaSourceContainer") then
					if not className or child.ClassName == className then
						table.insert(hits, instancePath(child))
					end
				end
				search(child, depth + 1)
			end
		end
		for _, svcName in ipairs(SNAPSHOT_SERVICES) do
			local oks, s = pcall(function() return game:GetService(svcName) end)
			if oks and s then search(s, 1) end
		end
	end
	if #hits == 0 then return false, "find_code", "no script matching '" .. target .. "'" end
	local inst = resolvePath(hits[1])
	if not inst or not inst:IsA("LuaSourceContainer") then
		return false, "find_code", hits[1] .. " is not a Lua source container"
	end
	local oks, src = pcall(function() return inst.Source end)
	if not oks then return false, "find_code", "cannot read source of " .. hits[1] end
	if pluginToken and src then
		request("POST", "/api/context", {
			context = "-- Script find_code hit: " .. hits[1] .. "\n```lua\n" .. src .. "\n```\n",
		})
	end
	return true, string.format("found %d match(es) for '%s' — top hit %s (%d chars)",
		#hits, target, hits[1], #(src or ""))
end

local origExecuteAction = executeAction
executeAction = function(a)
	local t = a.type
	if t == "find_code" then
		local ok, sum, err = executeFindCode(a)
		return ok, "find_code", sum or err
	elseif t == "read_script" then
		local inst, resolvedPath, ierr = resolveTarget({ targetCode = a.targetCode, path = a.path or a.parent })
		if not inst then return false, "read_script", ierr end
		if not inst:IsA("LuaSourceContainer") then
			return false, "read_script", (resolvedPath or "?") .. " is not a script"
		end
		local oks, src = pcall(function() return inst.Source end)
		if not oks then return false, "read_script", tostring(src) end
		if pluginToken and src and resolvedPath then
			request("POST", "/api/context", {
				context = "-- Script read_script: " .. resolvedPath .. "\n```lua\n" .. src .. "\n```\n",
			})
		end
		return true, string.format("read script %s (%d chars)", resolvedPath or "?", #(src or ""))
	end
	return origExecuteAction(a)
end

-- ===========================================================================
-- Toolbar toggle + boot
-- ===========================================================================
button.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

-- Boot: verify stored token against the server so a stale token doesn't
-- sit in the UI as "Linked" after a server restart.
task.spawn(function()
	verifyStoredLink()
end)
