local chat = EsteriaChat
local pending, queue, counter = {}, {}, 0
local event = CreateFrame("Frame")
event:RegisterEvent("CHAT_MSG_ADDON")
function chat.request(payload, callback)
  local encoded = chat.encode(payload)
  if #encoded > 23040 or #queue > 128 then callback({ error = "busy", message = "Chat transport busy." }); return end
  local count = math.ceil(#encoded / 180)
  counter = counter % 999999999 + 1
  pending[counter] = { callback = callback, count = nil, parts = {}, started = GetTime(), bytes = 0 }
  for i = 1, count do queue[#queue + 1] = { id = counter, text = "1:" .. counter .. ":" .. i .. ":" .. count .. ":" .. encoded:sub((i - 1) * 180 + 1, i * 180) } end
  return counter
end
function chat.receive(prefix, text, channel, sender)
  if prefix ~= "EC1" or channel ~= "WHISPER" or sender ~= UnitName("player") or #text > 220 then return end
  local id, index, count, part = text:match("^1:(%d+):(%d+):(%d+):(.*)$")
  id, index, count = tonumber(id), tonumber(index), tonumber(count)
  local request = id and pending[id]
  if not request or not index or not count or count < 1 or count > 128 or index < 1 or index > count or #part > 180 then return end
  if request.count and request.count ~= count then return end
  request.count = count
  if request.parts[index] then return end
  request.parts[index] = part; request.bytes = request.bytes + #part
  if request.bytes > 23040 then pending[id] = nil; return end
  for i = 1, count do if not request.parts[i] then return end end
  pending[id] = nil
  local ok, result = pcall(chat.decode, table.concat(request.parts))
  request.callback(ok and result or { error = "protocol", message = "Invalid chat response." })
end
event:SetScript("OnEvent", function(_, _, prefix, text, channel, sender) chat.receive(prefix, text, channel, sender) end)
local elapsed = 0
event:SetScript("OnUpdate", function(_, delta)
  elapsed = elapsed + delta
  if elapsed >= 0.1 then
    elapsed = 0
    local packet = table.remove(queue, 1)
    if packet and pending[packet.id] then
      pending[packet.id].started = GetTime()
      SendAddonMessage("EC1", packet.text, "WHISPER", UnitName("player"))
    end
  end
  for id, request in pairs(pending) do
    if GetTime() - request.started > 15 then
      pending[id] = nil; request.callback({ error = "disconnected", message = "Chat timed out. Retry when connected." })
    end
  end
end)
