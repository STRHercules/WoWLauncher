local chat, unpack = EsteriaChat, unpack
local cfg = chat.config
local texture = "Interface\\AddOns\\EsteriaChat\\Assets\\panel.tga"
local bubble = "Interface\\AddOns\\EsteriaChat\\Assets\\bubble.tga"
local me, capabilities, active, friends, groups, messages = nil, nil, nil, {}, {}, {}
local cursors, rows, media, pendingMedia = {}, {}, {}, {}
local avatars = {}
local requestSerial, sending, sendAttempt = 0, false, nil
local poll, feedBusy, historyBusy = 0, false, false
local frame = CreateFrame("Frame", "EsteriaChatPanel", UIParent)
frame:SetSize(760, 520); frame:SetPoint("CENTER"); frame:SetFrameStrata("DIALOG")
frame:SetMovable(true); frame:SetResizable(true); frame:SetMinResize(620, 380); frame:SetMaxResize(1400, 1000)
frame:EnableMouse(true); frame:RegisterForDrag("LeftButton")
frame:SetBackdrop({ bgFile = texture, edgeFile = bubble, edgeSize = 8, insets = {left = 4, right = 4, top = 4, bottom = 4} })
frame:SetBackdropColor(unpack(cfg.background)); frame:SetBackdropBorderColor(unpack(cfg.accent))
frame:Hide()
local fonts, buttons = {}, {}
local function label(parent, text, size)
  local fs = parent:CreateFontString(nil, "OVERLAY")
  fs:SetFont(cfg.font, size or 12); fs:SetTextColor(unpack(cfg.text)); fs:SetJustifyH("LEFT")
  fs:SetText((text or ""):gsub("|", "||")); fonts[#fonts + 1] = {font = fs, size = size or 12}; return fs
end
local title = label(frame, cfg.productName .. " Chat", 15); title:SetPoint("TOPLEFT", 14, -12)
local status = label(frame, "Connecting...", 11); status:SetPoint("TOPLEFT", 14, -34)
local function setStatus(value) status:SetText((value or ""):gsub("|", "||")) end
local function button(parent, text, width, run)
  local b = CreateFrame("Button", nil, parent); b:SetSize(width, 26)
  b:SetBackdrop({bgFile = texture, edgeFile = bubble, edgeSize = 6})
  b:SetBackdropColor(unpack(cfg.panel)); b:SetBackdropBorderColor(unpack(cfg.accent))
  local fs = label(b, text, 11); fs:SetPoint("CENTER"); b.text = fs
  b:SetScript("OnClick", run); buttons[#buttons + 1] = b; return b
end
local close = button(frame, "X", 26, function() frame:Hide() end); close:SetPoint("TOPRIGHT", -10, -10)
local resize = button(frame, "/", 20, function() end); resize:SetPoint("BOTTOMRIGHT", -4, 4)
resize:SetScript("OnMouseDown", function() frame:StartSizing("BOTTOMRIGHT") end)
resize:SetScript("OnMouseUp", function() frame:StopMovingOrSizing() end)
local function savePosition()
  if not EsteriaChatDB then return end
  local point, _, relative, x, y = frame:GetPoint()
  EsteriaChatDB.point, EsteriaChatDB.relative, EsteriaChatDB.x, EsteriaChatDB.y = point, relative, x, y
  EsteriaChatDB.width, EsteriaChatDB.height = frame:GetWidth(), frame:GetHeight()
end
frame:SetScript("OnDragStart", function() frame:StartMoving() end)
frame:SetScript("OnDragStop", function() frame:StopMovingOrSizing(); savePosition() end)
local function edit(parent, width)
  local e = CreateFrame("EditBox", nil, parent); e:SetSize(width, 28); e:SetAutoFocus(false)
  e:SetFont(cfg.font, 12); e:SetTextColor(unpack(cfg.text)); e:SetTextInsets(8, 8, 0, 0)
  e:SetBackdrop({bgFile = texture, edgeFile = bubble, edgeSize = 6}); e:SetBackdropColor(unpack(cfg.background))
  e:SetScript("OnEscapePressed", function(self) self:ClearFocus() end); return e
end
local composer = edit(frame, 360); composer:SetMaxLetters(1000)
composer:SetPoint("BOTTOMLEFT", 220, 16); composer:SetPoint("BOTTOMRIGHT", -98, 16)
local listScroll = CreateFrame("ScrollFrame", nil, frame); listScroll:SetPoint("TOPLEFT", 12, -74); listScroll:SetPoint("BOTTOMLEFT", 12, 54); listScroll:SetWidth(190)
local list = CreateFrame("Frame", nil, listScroll); list:SetWidth(190); list:SetHeight(1); listScroll:SetScrollChild(list)
local scroll = CreateFrame("ScrollFrame", nil, frame); scroll:SetPoint("TOPLEFT", 220, -78); scroll:SetPoint("BOTTOMRIGHT", -16, 56)
local content = CreateFrame("Frame", nil, scroll); content:SetSize(500, 1); scroll:SetScrollChild(content)
local function wheel(self, delta) self:SetVerticalScroll(math.max(0, math.min(self:GetVerticalScrollRange(), self:GetVerticalScroll() - delta * 45))) end
scroll:EnableMouseWheel(true); scroll:SetScript("OnMouseWheel", wheel)
listScroll:EnableMouseWheel(true); listScroll:SetScript("OnMouseWheel", wheel)
local function clearMedia()
  for slot = 1, 8 do if EsteriaChatMediaHide then EsteriaChatMediaHide(slot) end end
  for _, entry in ipairs(media) do if entry.image then entry.image:Hide() end end
  media = {}
end
frame:SetScript("OnHide", function() composer:ClearFocus(); clearMedia(); savePosition() end)
local function check(result)
  if result.error then setStatus(result.message or "Chat disconnected."); return false end
  return true
end
local refreshFeed, loadHistory, renderMessages, renderList
local function choose(key, name)
  active = { key = key, name = name }; messages[key] = messages[key] or {}; sendAttempt = nil
  pendingMedia = {}; clearMedia(); setStatus(name); renderMessages(); loadHistory()
end
renderList = function()
  avatars = {}
  for _, row in ipairs(rows) do row:Hide() end
  local index = 0
  local function add(key, name, detail, avatarUrl)
    index = index + 1
    local row = rows[index] or button(list, "", 186, function() end); rows[index] = row
    row:SetHeight(42); row:ClearAllPoints(); row:SetPoint("TOPLEFT", 0, -(index - 1) * 46)
    row.text:SetText((name .. "\n" .. detail):gsub("|", "||"))
    row.text:ClearAllPoints(); row.text:SetPoint("TOPLEFT", avatarUrl and 36 or 8, -4); row.text:SetWidth(avatarUrl and 140 or 170); row.text:SetHeight(36)
    row:SetScript("OnClick", function() choose(key, name) end); row:Show()
    row.avatar = row.avatar or row:CreateTexture(nil, "ARTWORK"); row.avatar:Hide()
    if avatarUrl and EsteriaChatMediaPlace then
      local id = avatarUrl:match("/avatars/(%d+)%.")
      if id then row.avatar:SetSize(28, 28); row.avatar:SetPoint("TOPLEFT", 4, -6); avatars[#avatars + 1] = {attachment = {id = "avatar_" .. id}, anchor = row, image = row.avatar, width = 28, height = 28, avatar = true} end
    end
  end
  for _, g in ipairs(groups) do add("group:" .. g.id, g.name, tostring(g.unread or 0) .. " unread") end
  for _, f in ipairs(friends) do add("dm:" .. f.username, f.displayName, (f.presence or "offline") .. " | " .. tostring(f.unread or 0) .. " unread", f.avatarUrl) end
  list:SetHeight(math.max(1, index * 46))
end
local blocks = {}
renderMessages = function(keepScroll)
  clearMedia()
  for _, block in ipairs(blocks) do block:Hide() end
  if not active then return end
  local y = 0
  local width = math.max(200, scroll:GetWidth() - 8)
  content:SetWidth(width)
  for i, message in ipairs(messages[active.key] or {}) do
    local block = blocks[i]
    if not block then
      block = CreateFrame("Frame", nil, content); blocks[i] = block
      block:SetBackdrop({bgFile = texture, edgeFile = bubble, edgeSize = 8, insets = {left = 4, right = 4, top = 4, bottom = 4}})
      block.body = label(block, "", 12); block.body:SetPoint("TOPLEFT", 10, -28)
      block.meta = label(block, "", 10); block.meta:SetPoint("TOPLEFT", 10, -8)
      block.placeholders = {}
    end
    block:ClearAllPoints(); block:SetPoint("TOPLEFT", message.from == me.username and 28 or 0, -y)
    block:SetWidth(width - 28); block.body:SetWidth(width - 48)
    block.body:SetText((message.body or ""):gsub("|", "||"))
    block.meta:SetText(((message.from == me.username and "You" or message.from) .. " · " .. (message.createdAt or ""):sub(12, 16) .. " UTC"):gsub("|", "||"))
    block:SetBackdropColor(unpack(message.from == me.username and {0.227, 0.184, 0.11, 1} or cfg.panel))
    block:SetBackdropBorderColor(unpack(cfg.panel))
    local height = math.max(44, block.body:GetStringHeight() + 36)
    for _, p in ipairs(block.placeholders) do p:Hide() end
    for j, a in ipairs(message.attachments or {}) do
      local placeholder = block.placeholders[j] or label(block, "", 11); block.placeholders[j] = placeholder
      placeholder:ClearAllPoints(); placeholder:SetPoint("TOPLEFT", 10, -height); placeholder:SetWidth(width - 48); placeholder:Show()
      placeholder:SetText(a.expired and "Attachment expired" or "Media needs the supported chat extension.")
      if not a.expired and EsteriaChatMediaPlace then
        placeholder.image = placeholder.image or block:CreateTexture(nil, "ARTWORK")
        placeholder.image:ClearAllPoints(); placeholder.image:SetPoint("TOPLEFT", placeholder, "TOPLEFT")
        placeholder.image:SetSize(math.min(width - 48, 320), 180)
        media[#media + 1] = { attachment = a, anchor = placeholder, image = placeholder.image, width = math.min(width - 48, 320), height = 180 }
        height = height + 188
      else height = height + 22 end
    end
    block:SetHeight(height); block:Show(); y = y + height + 10
  end
  content:SetHeight(math.max(1, y))
  if not keepScroll then scroll:SetVerticalScroll(math.max(0, y - scroll:GetHeight())) end
end
loadHistory = function(before)
  if not active or historyBusy then return end
  local thread = active; historyBusy = true
  chat.request({ op = "history", conversation = thread.key, since = before and 0 or cursors[thread.key] or 0, before = before }, function(result)
    historyBusy = false
    if not check(result) then return end
    local existing, map = messages[thread.key] or {}, {}
    for _, m in ipairs(existing) do map[m.id] = m end
    local incoming = false
    for _, m in ipairs(result.messages or {}) do
      if not map[m.id] and m.from ~= me.username then incoming = true end
      map[m.id] = m
    end
    local merged = {}; for _, m in pairs(map) do merged[#merged + 1] = m end
    table.sort(merged, function(a, b) return a.id < b.id end)
    while #merged > 200 do table.remove(merged, 1) end
    messages[thread.key] = merged
    if not before and #result.messages > 0 then cursors[thread.key] = result.messages[#result.messages].id end
    if active and active.key == thread.key then
      renderMessages(before ~= nil)
      if frame:IsShown() and #merged > 0 and scroll:GetVerticalScroll() >= scroll:GetVerticalScrollRange() - 10 then
        chat.request({op = "read", conversation = thread.key, cursor = math.min(merged[#merged].id, cursors[thread.key] or 0)}, check)
      end
    end
    if incoming and EsteriaChatDB.sounds and me.explicitPresence ~= "dnd" then PlaySoundFile(cfg.incomingSound) end
  end)
end
refreshFeed = function(page, accumulator)
  if feedBusy and not accumulator then return end
  feedBusy = true
  chat.request({op = "feed", page = page or 0}, function(result)
    if not check(result) then feedBusy = false; return end
    accumulator = accumulator or {friends = {}, groups = {}, incoming = {}}
    for _, f in ipairs(result.friends or {}) do accumulator.friends[#accumulator.friends + 1] = f end
    for _, g in ipairs(result.groups or {}) do accumulator.groups[#accumulator.groups + 1] = g end
    for _, invite in ipairs(result.incoming or {}) do accumulator.incoming[#accumulator.incoming + 1] = invite.username end
    if result.hasMore then refreshFeed((page or 0) + 1, accumulator); return end
    feedBusy = false; me = result.me; friends, groups = accumulator.friends, accumulator.groups
    chat.incoming = accumulator.incoming
    local unread = (result.unread or 0)
    for _, g in ipairs(groups) do unread = unread + (g.unread or 0) end
    if chat.lastUnread and unread > chat.lastUnread and not frame:IsShown() and EsteriaChatDB.sounds and me.explicitPresence ~= "dnd" then
      PlaySoundFile(cfg.incomingSound); DEFAULT_CHAT_FRAME:AddMessage(cfg.productName .. ": new chat message (" .. unread .. " unread).")
    end
    chat.lastUnread = unread; title:SetText((cfg.productName .. " Chat · " .. unread .. " unread"):gsub("|", "||"))
    renderList(); setStatus(active and active.name or "Signed in as " .. me.displayName)
  end)
end
local function send()
  if not active or sending or not me then return end
  local body = composer:GetText():match("^%s*(.-)%s*$")
  if body == "" and #pendingMedia == 0 then return end
  local thread = active
  local signature = thread.key .. "\n" .. body .. "\n" .. table.concat(pendingMedia, ",")
  if not sendAttempt or sendAttempt.signature ~= signature then
    requestSerial = requestSerial + 1
    sendAttempt = {signature = signature, id = "game_" .. me.username .. "_" .. time() .. "_" .. math.floor(GetTime() * 1000) .. "_" .. requestSerial}
  end
  sending = true
  chat.request({op = "send", conversation = thread.key, body = body, requestId = sendAttempt.id,
    attachments = #pendingMedia > 0 and pendingMedia or nil}, function(result)
    sending = false
    if not check(result) then return end
    messages[thread.key] = messages[thread.key] or {}
    local seen = false; for _, m in ipairs(messages[thread.key]) do if m.id == result.message.id then seen = true end end
    if not seen then table.insert(messages[thread.key], result.message) end
    pendingMedia = {}; sendAttempt = nil
    if active and active.key == thread.key then composer:SetText(""); renderMessages() end
    if EsteriaChatDB.sounds then PlaySoundFile(cfg.outgoingSound) end
  end)
end
composer:SetScript("OnEnterPressed", send)
local sendButton = button(frame, "Send", 70, send); sendButton:SetPoint("BOTTOMRIGHT", -16, 16)
local older = button(frame, "Older", 65, function()
  local first = active and messages[active.key] and messages[active.key][1]
  if first then loadHistory(first.id) end
end); older:SetPoint("TOPLEFT", 220, -48)
local attach = button(frame, "Attach", 65, function()
  if not active or not capabilities or not capabilities.features.attachments then return end
  if not EsteriaChatMediaUpload then setStatus("Sending images needs the supported chat extension/helper."); return end
  chat.request({op = "mediaTicket"}, function(result)
    if check(result) then EsteriaChatMediaUpload(result.token, active.key) end
  end)
end); attach:SetPoint("TOPLEFT", 290, -48)
local preferences = button(frame, "Autoplay", 82, function()
  EsteriaChatDB.autoplay = not EsteriaChatDB.autoplay; setStatus(EsteriaChatDB.autoplay and "Autoplay enabled" or "Autoplay disabled")
end); preferences:SetPoint("TOPLEFT", 360, -48)
local refresh = button(frame, "Refresh", 72, function() refreshFeed(); loadHistory() end); refresh:SetPoint("TOPLEFT", 12, -48)
local socialDialog = CreateFrame("Frame", nil, frame); socialDialog:SetSize(360, 210); socialDialog:SetPoint("CENTER"); socialDialog:SetFrameStrata("FULLSCREEN_DIALOG")
socialDialog:SetBackdrop({bgFile = texture, edgeFile = bubble, edgeSize = 8}); socialDialog:SetBackdropColor(unpack(cfg.panel)); socialDialog:EnableMouse(true); socialDialog:Hide()
local dialogTitle = label(socialDialog, "Friend account", 13); dialogTitle:SetPoint("TOPLEFT", 12, -12)
local dialogInput = edit(socialDialog, 336); dialogInput:SetPoint("TOPLEFT", 12, -38); dialogInput:SetMaxLetters(400)
local dialogHint = label(socialDialog, "", 11); dialogHint:SetPoint("TOPLEFT", 12, -72); dialogHint:SetWidth(336)
local actionButton = button(socialDialog, "Add friend", 100, function() end); actionButton:SetPoint("BOTTOMLEFT", 12, 12)
local acceptButton = button(socialDialog, "Accept", 90, function()
  chat.request({op = "accept", username = dialogInput:GetText()}, function(result) if check(result) then socialDialog:Hide(); refreshFeed() end end)
end); acceptButton:SetPoint("BOTTOMLEFT", 118, 12)
local cancelButton = button(socialDialog, "Cancel", 80, function() socialDialog:Hide(); dialogInput:ClearFocus() end); cancelButton:SetPoint("BOTTOMRIGHT", -12, 12)
dialogInput:SetScript("OnEscapePressed", function() socialDialog:Hide(); dialogInput:ClearFocus() end)
local addFriend = button(frame, "Friend +", 82, function()
  dialogTitle:SetText("Friend account"); dialogHint:SetText("Enter the social account name.\nRequests: " .. table.concat(chat.incoming or {}, ", "))
  dialogInput:SetText(""); acceptButton:Show(); actionButton.text:SetText("Add friend")
  actionButton:SetScript("OnClick", function()
    chat.request({op = "friend", username = dialogInput:GetText()}, function(result) if check(result) then socialDialog:Hide(); refreshFeed() end end)
  end); socialDialog:Show(); dialogInput:SetFocus()
end); addFriend:SetPoint("TOPLEFT", 90, -48)
local newGroup = button(frame, "Group +", 82, function()
  dialogTitle:SetText("New group"); dialogHint:SetText("Enter group name;friend1,friend2\nUse social account names from your friends list.")
  dialogInput:SetText(""); acceptButton:Hide(); actionButton.text:SetText("Create group")
  actionButton:SetScript("OnClick", function()
    local name, usernames = dialogInput:GetText():match("^([^;]+);(.+)$"); local members = {}
    if not name then dialogHint:SetText("Enter group name;friend1,friend2"); return end
    for username in usernames:gmatch("[^,%s]+") do members[#members + 1] = username end
    chat.request({op = "createGroup", name = name, members = members}, function(result)
      if check(result) then socialDialog:Hide(); refreshFeed(); choose("group:" .. result.group.id, result.group.name) end
    end)
  end); socialDialog:Show(); dialogInput:SetFocus()
end); newGroup:SetPoint("TOPLEFT", 448, -48)
local function getCapabilities()
  chat.request({op = "capabilities"}, function(result)
    if not check(result) then return end
    capabilities = result
    cfg.productName = result.productName or cfg.productName
    for key, value in pairs(result.branding or {}) do
      if key == "font" and value:match("^[%w_.-]+%.ttf$") then cfg.font = "Interface\\AddOns\\EsteriaChat\\Assets\\" .. value
      elseif value:match("^#%x%x%x%x%x%x$") then cfg[key] = {tonumber(value:sub(2,3),16)/255, tonumber(value:sub(4,5),16)/255, tonumber(value:sub(6,7),16)/255, 1} end
    end
    frame:SetBackdropColor(unpack(cfg.background)); frame:SetBackdropBorderColor(unpack(cfg.accent))
    for _, item in ipairs(fonts) do item.font:SetFont(cfg.font, item.size); item.font:SetTextColor(unpack(cfg.text)) end
    for _, item in ipairs(buttons) do item:SetBackdropColor(unpack(cfg.panel)); item:SetBackdropBorderColor(unpack(cfg.accent)) end
    composer:SetFont(cfg.font, 12); dialogInput:SetFont(cfg.font, 12)
    if result.features.friends then addFriend:Show() else addFriend:Hide() end
    if result.features.groups then newGroup:Show() else newGroup:Hide() end
    if result.features.attachments then attach:Show() else attach:Hide() end
    refreshFeed()
  end)
end
local ticker = CreateFrame("Frame"); ticker:RegisterEvent("PLAYER_LOGIN"); ticker:RegisterEvent("PLAYER_LOGOUT")
ticker:SetScript("OnEvent", function(_, event)
  if event == "PLAYER_LOGOUT" then clearMedia(); savePosition(); return end
  EsteriaChatDB = EsteriaChatDB or {width = 760, height = 520, scale = 1, sounds = true, autoplay = true}
  frame:SetSize(math.max(620, math.min(1400, EsteriaChatDB.width or 760)), math.max(380, math.min(1000, EsteriaChatDB.height or 520)))
  frame:SetScale(math.max(0.6, math.min(1.5, EsteriaChatDB.scale or 1)))
  if EsteriaChatDB.point then frame:ClearAllPoints(); frame:SetPoint(EsteriaChatDB.point, UIParent, EsteriaChatDB.relative, EsteriaChatDB.x or 0, EsteriaChatDB.y or 0) end
  getCapabilities()
end)
frame:SetScript("OnSizeChanged", function() if me then renderMessages(true) end; savePosition() end)
ticker:SetScript("OnUpdate", function(_, delta)
  poll = poll + delta
  if poll >= 5 then
    poll = 0
    if me then refreshFeed(); if active then loadHistory() end else getCapabilities() end
    if (#media > 0 or #avatars > 0 or #pendingMedia > 0) and EsteriaChatMediaAuthorize then
      chat.request({op = "mediaTicket"}, function(result) if check(result) then EsteriaChatMediaAuthorize(result.token) end end)
    end
    if EsteriaChatMediaResult then
      local result = EsteriaChatMediaResult()
      if result and result ~= "" then
        local ok, value = pcall(chat.decode, result)
        if ok and value.attachment then pendingMedia[#pendingMedia + 1] = value.attachment.id; setStatus("Image uploaded. Press Send or /ec cancel.")
        elseif ok then setStatus(value.message or "Media helper unavailable.") end
      end
    end
  end
  if not frame:IsShown() then return end
  local scale = frame:GetEffectiveScale(); local uiScale = UIParent:GetEffectiveScale()
  local windowHeight = UIParent:GetHeight() * uiScale
  local slot = 0
  local visibleMedia = {}
  for _, entry in ipairs(media) do visibleMedia[#visibleMedia + 1] = entry end
  for _, entry in ipairs(avatars) do visibleMedia[#visibleMedia + 1] = entry end
  for _, entry in ipairs(visibleMedia) do
    local left, top = entry.anchor:GetLeft(), entry.anchor:GetTop()
    local clip = entry.avatar and listScroll or scroll
    local visible = left and top and entry.anchor:IsVisible() and top >= clip:GetBottom() and top - entry.height <= clip:GetTop()
    if visible and EsteriaChatMediaPlace and slot < 8 then
      slot = slot + 1
      entry.image:SetTexture("Interface\\AddOns\\EsteriaChat\\Assets\\marker" .. slot .. ".tga"); entry.image:Show()
      EsteriaChatMediaPlace(slot, entry.attachment.id, left * scale, windowHeight - top * scale,
        entry.width * scale, entry.height * scale, scroll:GetLeft() * scale, windowHeight - scroll:GetTop() * scale,
        scroll:GetWidth() * scale, scroll:GetHeight() * scale, EsteriaChatDB.autoplay and 1 or 0)
      local state = EsteriaChatMediaStatus and EsteriaChatMediaStatus(slot) or 0
      if not entry.avatar then entry.anchor:SetText(state == 1 and "" or state == 2 and "Attachment expired" or "Connecting to media helper...") end
    else entry.image:Hide() end
  end
  for unused = slot + 1, 8 do if EsteriaChatMediaHide then EsteriaChatMediaHide(unused) end end
end)
SLASH_ESTERIACHAT1 = "/ec"
SlashCmdList.ESTERIACHAT = function(command)
  local action, rest = command:match("^(%S+)%s*(.*)$")
  if action == "link" then chat.request({op = "link", code = rest}, function(result) if check(result) then setStatus("Confirm the game account in the launcher."); frame:Show() end end)
  elseif action == "friend" or action == "accept" or action == "removeFriend" or action == "block" then
    chat.request({op = action, username = rest}, function(result) if check(result) then refreshFeed() end end)
  elseif action == "group" then
    local name, names = rest:match("^([^;]+);(.+)$"); local members = {}
    if not name then setStatus("/ec group NAME;friend1,friend2"); frame:Show(); return end
    for username in names:gmatch("[^,%s]+") do members[#members + 1] = username end
    chat.request({op = "createGroup", name = name, members = members}, function(result) if check(result) then refreshFeed(); choose("group:" .. result.group.id, result.group.name) end end)
  elseif action == "presence" then chat.request({op = "presence", presence = rest}, check)
  elseif action == "privacy" then chat.request({op = "privacy", shareCharacterPresence = rest == "on"}, check)
  elseif action == "unblock" then chat.request({op = "block", username = rest, remove = true}, check)
  elseif action == "report" then
    local id, reason = rest:match("^(%d+)%s+(.+)$")
    if active and id then chat.request({op = "report", conversation = active.key, messageId = tonumber(id), reason = reason}, check)
    else setStatus("Open a conversation, then /ec report MESSAGE_ID reason"); frame:Show() end
  elseif action == "sounds" then EsteriaChatDB.sounds = not EsteriaChatDB.sounds
  elseif action == "scale" then EsteriaChatDB.scale = math.max(0.6, math.min(1.5, tonumber(rest) or 1)); frame:SetScale(EsteriaChatDB.scale)
  elseif action == "cancel" then
    for _, id in ipairs(pendingMedia) do if EsteriaChatMediaCancel then EsteriaChatMediaCancel(id) end end
    pendingMedia = {}; setStatus("Unused uploads cancelled.")
  else if frame:IsShown() then frame:Hide() else frame:Show(); refreshFeed(); if me then renderMessages() end end end
end
