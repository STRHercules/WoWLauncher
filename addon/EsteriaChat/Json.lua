local chat = EsteriaChat
local function utf8(code)
  if code < 128 then return string.char(code) end
  if code < 2048 then return string.char(192 + math.floor(code / 64), 128 + code % 64) end
  if code < 65536 then return string.char(224 + math.floor(code / 4096), 128 + math.floor(code / 64) % 64, 128 + code % 64) end
  return string.char(240 + math.floor(code / 262144), 128 + math.floor(code / 4096) % 64, 128 + math.floor(code / 64) % 64, 128 + code % 64)
end
function chat.encode(value, depth)
  depth = (depth or 0) + 1
  assert(depth <= 16, "JSON nesting limit")
  if type(value) == "string" then
    return '"' .. value:gsub('[%z\1-\31\\"]', function(c) return string.format("\\u%04x", c:byte()) end) .. '"'
  end
  if type(value) == "boolean" or type(value) == "number" then
    assert(value == value and value ~= math.huge and value ~= -math.huge, "Invalid JSON number")
    return tostring(value)
  end
  if value == nil then return "null" end
  assert(type(value) == "table", "Invalid JSON value")
  local parts = {}
  if #value > 0 then
    for i = 1, #value do parts[i] = chat.encode(value[i], depth) end
    return "[" .. table.concat(parts, ",") .. "]"
  end
  for key, item in pairs(value) do
    assert(type(key) == "string", "Invalid JSON key")
    parts[#parts + 1] = chat.encode(key, depth) .. ":" .. chat.encode(item, depth)
  end
  return "{" .. table.concat(parts, ",") .. "}"
end
function chat.decode(source)
  assert(type(source) == "string" and #source <= 23040, "JSON size limit")
  local pos = 1
  local parse
  local function skip() local _, last = source:find("^%s*", pos); pos = (last or pos - 1) + 1 end
  local function quoted()
    assert(source:sub(pos, pos) == '"', "Expected JSON string")
    pos = pos + 1
    local parts = {}
    while pos <= #source do
      local c = source:sub(pos, pos); pos = pos + 1
      if c == '"' then return table.concat(parts) end
      if c == "\\" then
        local escape = source:sub(pos, pos); pos = pos + 1
        local escapes = { ['"'] = '"', ["\\"] = "\\", ["/"] = "/", b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" }
        if escape == "u" then
          local hex = source:sub(pos, pos + 3); assert(hex:match("^%x%x%x%x$"), "Invalid Unicode")
          local code = tonumber(hex, 16); pos = pos + 4
          if code >= 55296 and code <= 56319 then
            assert(source:sub(pos, pos + 1) == "\\u", "Missing surrogate")
            local low = tonumber(source:sub(pos + 2, pos + 5), 16)
            assert(low and low >= 56320 and low <= 57343, "Invalid surrogate")
            code = 65536 + (code - 55296) * 1024 + low - 56320; pos = pos + 6
          else assert(code < 56320 or code > 57343, "Invalid surrogate") end
          parts[#parts + 1] = utf8(code)
        else assert(escapes[escape], "Invalid escape"); parts[#parts + 1] = escapes[escape] end
      else assert(c:byte() >= 32, "Control character"); parts[#parts + 1] = c end
    end
    error("Unterminated JSON string")
  end
  parse = function(depth)
    assert(depth < 16, "JSON nesting limit"); skip()
    local c = source:sub(pos, pos)
    if c == '"' then return quoted() end
    if c == "{" or c == "[" then
      pos = pos + 1; skip()
      local result = {}; local closing = c == "{" and "}" or "]"
      if source:sub(pos, pos) == closing then pos = pos + 1; return result end
      while true do
        local key
        if c == "{" then key = quoted(); skip(); assert(source:sub(pos, pos) == ":", "Expected colon"); pos = pos + 1 end
        local value = parse(depth + 1)
        if c == "{" then result[key] = value else result[#result + 1] = value end
        skip(); local separator = source:sub(pos, pos); pos = pos + 1
        if separator == closing then return result end
        assert(separator == ",", "Expected comma"); skip()
      end
    end
    for word, value in pairs({ ["true"] = true, ["false"] = false }) do
      if source:sub(pos, pos + #word - 1) == word then pos = pos + #word; return value end
    end
    if source:sub(pos, pos + 3) == "null" then pos = pos + 4; return nil end
    local number = source:match("^-?%d+%.?%d*[eE]?[+-]?%d*", pos)
    assert(number and tonumber(number), "Invalid JSON token")
    pos = pos + #number; return tonumber(number)
  end
  local value = parse(0); skip(); assert(pos > #source, "Trailing JSON bytes"); return value
end
