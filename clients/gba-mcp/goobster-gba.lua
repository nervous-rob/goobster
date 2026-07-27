-- goobster-gba.lua — mGBA side of the Goobster GBA harness.
--
-- Runs inside mGBA (0.10+ scripting API) and exposes the emulator over a
-- loopback TCP socket for goobster-gba-mcp (server.js). Load it either:
--   * mGBA 0.10.x GUI: Tools > Scripting... > File > Load script
--   * dev/0.11+ builds: mgba-qt --script goobster-gba.lua <rom.gba>
--   * headless dev builds: mgba-headless --script goobster-gba.lua <rom.gba>
--
-- Protocol (one line per message, values percent-encoded):
--   request:  <id> <verb> [key=value]...
--   response: <id> ok  [key=value]...  |  <id> err msg=<text>
--
-- Verbs:
--   status                         -> title=<> code=<> platform=<n> frame=<n>
--   screenshot path=<file>        -> writes a PNG to <file>
--   press seq=<mask:hold:gap,...> -> plays a key sequence, replies when done
--   wait frames=<n>               -> replies after <n> frames
--   savestate slot=<n>            -> saves to slot
--   loadstate slot=<n>            -> loads from slot
--   read addr=<n> len=<n>         -> hex=<bytes> (bus addresses, e.g. EWRAM)
--
-- Frame-consuming verbs (press/wait) run one at a time; a second request
-- while one is active gets an err reply. Key masks use the C.GBA_KEY bit
-- indices (A=0, B=1, SELECT=2, START=3, RIGHT=4, LEFT=5, UP=6, DOWN=7,
-- R=8, L=9); the MCP server builds them, this script just applies them.

local PORT = 5771
do
    -- Environment override when the host exposes os.getenv to scripts.
    local ok, value = pcall(function() return os.getenv("GOOBSTER_GBA_PORT") end)
    if ok and value and tonumber(value) then
        PORT = tonumber(value)
    end
end

local server = nil
local clients = {}
local nextClientId = 1

-- The single in-flight frame-consuming operation, or nil.
--   { id, client, kind = "press"|"wait",
--     frames (wait), queue/index/phase/counter (press) }
local active = nil

local function encodeValue(value)
    return (tostring(value):gsub("[%%%s=]", function(c)
        return string.format("%%%02X", string.byte(c))
    end))
end

local function decodeValue(value)
    return (value:gsub("%%(%x%x)", function(hex)
        return string.char(tonumber(hex, 16))
    end))
end

local function sendLine(client, parts)
    if not client.sock then return end
    local ok = pcall(function() client.sock:send(table.concat(parts, " ") .. "\n") end)
    if not ok then
        clients[client.id] = nil
        client.sock = nil
    end
end

local function replyOk(client, id, params)
    local parts = { id, "ok" }
    for key, value in pairs(params or {}) do
        parts[#parts + 1] = key .. "=" .. encodeValue(value)
    end
    sendLine(client, parts)
end

local function replyErr(client, id, message)
    sendLine(client, { id, "err", "msg=" .. encodeValue(message) })
end

local function parseLine(line)
    local tokens = {}
    for token in line:gmatch("%S+") do
        tokens[#tokens + 1] = token
    end
    if #tokens < 2 then return nil end
    local params = {}
    for i = 3, #tokens do
        local key, value = tokens[i]:match("^([%w_]+)=(.*)$")
        if key then
            params[key] = decodeValue(value)
        end
    end
    return { id = tokens[1], verb = tokens[2], params = params }
end

-- Parse "mask:hold:gap,mask:hold:gap,..." into a press queue.
local function parseSequence(seq)
    local queue = {}
    for entry in seq:gmatch("[^,]+") do
        local mask, hold, gap = entry:match("^(%d+):(%d+):(%d+)$")
        if not mask then return nil end
        queue[#queue + 1] = {
            mask = tonumber(mask),
            hold = tonumber(hold),
            gap = tonumber(gap)
        }
    end
    if #queue == 0 then return nil end
    return queue
end

local function handleRequest(client, request)
    local id = request.id
    local verb = request.verb
    local params = request.params

    if verb == "status" then
        if not emu then
            replyErr(client, id, "No game loaded")
            return
        end
        local title = ""
        local code = ""
        pcall(function() title = emu:getGameTitle() end)
        pcall(function() code = emu:getGameCode() end)
        replyOk(client, id, {
            title = title,
            code = code,
            platform = emu:platform(),
            frame = emu:currentFrame()
        })
        return
    end

    if verb == "screenshot" then
        if not emu then
            replyErr(client, id, "No game loaded")
            return
        end
        if not params.path or params.path == "" then
            replyErr(client, id, "screenshot requires path=")
            return
        end
        local ok, err = pcall(function() emu:screenshot(params.path) end)
        if ok then
            replyOk(client, id, {})
        else
            replyErr(client, id, "screenshot failed: " .. tostring(err))
        end
        return
    end

    if verb == "press" then
        if not emu then
            replyErr(client, id, "No game loaded")
            return
        end
        if active then
            replyErr(client, id, "busy: another press/wait is in progress")
            return
        end
        local queue = params.seq and parseSequence(params.seq) or nil
        if not queue then
            replyErr(client, id, "press requires seq=mask:hold:gap[,...]")
            return
        end
        active = {
            id = id, client = client, kind = "press",
            queue = queue, index = 1, phase = "hold", counter = queue[1].hold
        }
        emu:setKeys(queue[1].mask)
        return
    end

    if verb == "wait" then
        if not emu then
            replyErr(client, id, "No game loaded")
            return
        end
        if active then
            replyErr(client, id, "busy: another press/wait is in progress")
            return
        end
        local frames = tonumber(params.frames)
        if not frames or frames < 1 then
            replyErr(client, id, "wait requires frames=<n>")
            return
        end
        active = { id = id, client = client, kind = "wait", frames = math.floor(frames) }
        return
    end

    if verb == "savestate" or verb == "loadstate" then
        if not emu then
            replyErr(client, id, "No game loaded")
            return
        end
        local slot = tonumber(params.slot)
        if not slot then
            replyErr(client, id, verb .. " requires slot=<n>")
            return
        end
        local ok, result = pcall(function()
            if verb == "savestate" then
                return emu:saveStateSlot(slot)
            end
            return emu:loadStateSlot(slot)
        end)
        if ok and result then
            replyOk(client, id, { slot = slot })
        else
            replyErr(client, id, verb .. " failed for slot " .. slot)
        end
        return
    end

    if verb == "read" then
        if not emu then
            replyErr(client, id, "No game loaded")
            return
        end
        local addr = tonumber(params.addr)
        local len = tonumber(params.len)
        if not addr or not len or len < 1 then
            replyErr(client, id, "read requires addr=<n> len=<n>")
            return
        end
        local ok, bytes = pcall(function() return emu:readRange(addr, len) end)
        if not ok then
            replyErr(client, id, "read failed: " .. tostring(bytes))
            return
        end
        local hex = {}
        for i = 1, #bytes do
            hex[i] = string.format("%02x", bytes:byte(i))
        end
        replyOk(client, id, { hex = table.concat(hex) })
        return
    end

    replyErr(client, id, "Unknown verb: " .. verb)
end

-- Advance the in-flight press/wait operation by one frame.
local function tick()
    if not active or not emu then return end

    if active.kind == "wait" then
        active.frames = active.frames - 1
        if active.frames <= 0 then
            local finished = active
            active = nil
            replyOk(finished.client, finished.id, {})
        end
        return
    end

    -- press
    active.counter = active.counter - 1
    if active.counter > 0 then return end

    local entry = active.queue[active.index]
    if active.phase == "hold" then
        emu:setKeys(0)
        if entry.gap > 0 then
            active.phase = "gap"
            active.counter = entry.gap
            return
        end
    end

    -- Gap elapsed (or zero): move to the next entry.
    active.index = active.index + 1
    local nextEntry = active.queue[active.index]
    if nextEntry then
        active.phase = "hold"
        active.counter = nextEntry.hold
        emu:setKeys(nextEntry.mask)
    else
        emu:setKeys(0)
        local finished = active
        active = nil
        replyOk(finished.client, finished.id, {})
    end
end

local function onClientData(client)
    if not client.sock then return end
    while true do
        local data, err = client.sock:receive(4096)
        if data then
            client.buffer = client.buffer .. data
            while true do
                local newline = client.buffer:find("\n", 1, true)
                if not newline then break end
                local line = client.buffer:sub(1, newline - 1):gsub("\r$", "")
                client.buffer = client.buffer:sub(newline + 1)
                if #line > 0 then
                    local request = parseLine(line)
                    if request then
                        handleRequest(client, request)
                    end
                end
            end
        else
            if err ~= socket.ERRORS.AGAIN then
                clients[client.id] = nil
                client.sock = nil
                if active and active.client == client then
                    -- Requester vanished mid-operation: release keys, drop it.
                    if emu then pcall(function() emu:setKeys(0) end) end
                    active = nil
                end
            end
            return
        end
    end
end

local function onAccept()
    local sock, err = server:accept()
    if err then
        console:error("goobster-gba: accept failed: " .. tostring(err))
        return
    end
    local client = { id = nextClientId, sock = sock, buffer = "" }
    nextClientId = nextClientId + 1
    clients[client.id] = client
    sock:add("received", function() onClientData(client) end)
    sock:add("error", function()
        clients[client.id] = nil
        client.sock = nil
    end)
    console:log("goobster-gba: client " .. client.id .. " connected")
end

callbacks:add("frame", tick)

local err
server, err = socket.bind("127.0.0.1", PORT)
if not server then
    console:error("goobster-gba: cannot bind 127.0.0.1:" .. PORT .. " (" .. tostring(err) .. ")")
else
    local ok
    ok, err = server:listen()
    if err then
        server:close()
        console:error("goobster-gba: listen failed: " .. tostring(err))
    else
        server:add("received", onAccept)
        console:log("goobster-gba: bridge listening on 127.0.0.1:" .. PORT)
    end
end
