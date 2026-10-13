local frames, now, sent = {}, 0, {}
function CreateFrame()
  local f = {scripts = {}}
  function f:RegisterEvent() end
  function f:SetScript(event, fn) self.scripts[event] = fn end
  frames[#frames + 1] = f; return f
end
function GetTime() return now end
function UnitName() return "Alpha" end
function SendAddonMessage(prefix, text, channel, recipient) sent[#sent + 1] = {prefix, text, channel, recipient} end
dofile("addon/EsteriaChat/Config.lua")
dofile("addon/EsteriaChat/Json.lua")
dofile("addon/EsteriaChat/Transport.lua")
local c = EsteriaChat
local value = {body = "quote \" newline\n and | texture", nested = {one = 1, yes = true, no = false}, members = {"alpha", "bravo"}}
local decoded = c.decode(c.encode(value))
assert(decoded.body == value.body and decoded.nested.one == 1 and decoded.nested.no == false)
assert(decoded.members[2] == "bravo")
assert(#c.decode('"\\ud83d\\ude00"') == 4)
assert(not pcall(c.decode, '{"x":1}garbage'))
assert(not pcall(c.decode, '"\\ud800"'))
assert(not pcall(c.decode, '{"x":[' .. string.rep('[', 30) .. '1'))
local calls = 0
local id = c.request({op = "send", body = string.rep("a", 1000)}, function(result) assert(result.ok == true); calls = calls + 1 end)
for i = 1, 10 do now = now + .11; frames[1].scripts.OnUpdate(nil, .11) end
assert(#sent > 1 and #sent < 10)
for _, packet in ipairs(sent) do assert(#packet[2] <= 220 and packet[4] == "Alpha") end
c.receive("EC1", "1:" .. id .. ":1:1:{\"ok\":true}", "WHISPER", "Spoof")
assert(calls == 0)
c.receive("EC1", "1:" .. id .. ":1:129:bad", "WHISPER", "Alpha")
assert(calls == 0)
c.receive("EC1", "1:" .. id .. ":1:1:{\"ok\":true}", "WHISPER", "Alpha")
c.receive("EC1", "1:" .. id .. ":1:1:{\"ok\":true}", "WHISPER", "Alpha")
assert(calls == 1, "duplicate reply delivered twice")
local received
id = c.request({op = "feed"}, function(result) received = result.body end)
local response = c.encode({body = string.rep("b", 350)})
local count = math.ceil(#response / 180)
for i = count, 1, -1 do c.receive("EC1", "1:" .. id .. ":" .. i .. ":" .. count .. ":" .. response:sub((i - 1) * 180 + 1, i * 180), "WHISPER", "Alpha") end
assert(received == string.rep("b", 350), "out-of-order fragments lost")
local timedOut
c.request({op = "feed"}, function(result) timedOut = result.error end)
now = now + 16; frames[1].scripts.OnUpdate(nil, 0)
assert(timedOut == "disconnected", "request timeout missing")
assert(loadfile("addon/EsteriaChat/Chat.lua"), "UI Lua syntax")
print("addon selftest passed: JSON, Unicode, fragmentation, spoof rejection, bounds, duplicate replies and timeouts")
