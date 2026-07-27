/**
 * Unit tests for the GBA MCP harness (clients/gba-mcp) — Phase 0 of
 * "Goobster Plays Pokémon". Covers the bridge wire codec, tool input
 * legalization, the zero-dependency PNG codec, the minimal MCP stdio
 * server, and the bridge TCP client against a fake bridge.
 */

const net = require('node:net');
const { PassThrough } = require('node:stream');

const { encodeValue, decodeValue, formatLine, parseLine, LineBuffer } = require('../clients/gba-mcp/lib/lineCodec');
const tools = require('../clients/gba-mcp/lib/tools');
const { decodePng, encodePng, upscaleNearest, upscalePng } = require('../clients/gba-mcp/lib/png');
const { McpServer } = require('../clients/gba-mcp/lib/mcpServer');
const { MgbaClient, BridgeError, frameTimeout } = require('../clients/gba-mcp/lib/mgbaClient');
const { createToolHandler } = require('../clients/gba-mcp/server');

describe('lineCodec', () => {
    test('round-trips values with spaces, equals, percents and newlines', () => {
        const nasty = 'a b=c%d\ne\rf';
        expect(decodeValue(encodeValue(nasty))).toBe(nasty);
    });

    test('formats and parses request lines', () => {
        const line = formatLine('7', 'press', { seq: '16:10:5,128:10:5' });
        const parsed = parseLine(line);
        expect(parsed).toEqual({ id: '7', verb: 'press', params: { seq: '16:10:5,128:10:5' } });
    });

    test('parses values containing encoded spaces', () => {
        const line = formatLine(1, 'screenshot', { path: '/tmp/my shots/frame 1.png' });
        expect(parseLine(line).params.path).toBe('/tmp/my shots/frame 1.png');
    });

    test('rejects malformed lines and params', () => {
        expect(() => parseLine('lonely')).toThrow(/Malformed/);
        expect(() => parseLine('1 ok =broken')).toThrow(/Malformed/);
        expect(parseLine('   ')).toBeNull();
    });

    test('LineBuffer splits chunked input across boundaries', () => {
        const buffer = new LineBuffer();
        expect(buffer.push('1 ok a=')).toEqual([]);
        expect(buffer.push('b\r\n2 err msg=x\n3 o')).toEqual(['1 ok a=b', '2 err msg=x']);
        expect(buffer.push('k\n')).toEqual(['3 ok']);
    });
});

describe('tools input legalization', () => {
    test('parses single buttons and combos into masks', () => {
        expect(tools.parsePressEntry('A')).toEqual({ mask: 1, label: 'A' });
        expect(tools.parsePressEntry('up')).toEqual({ mask: 1 << 6, label: 'UP' });
        expect(tools.parsePressEntry('B+RIGHT')).toEqual({ mask: (1 << 1) | (1 << 4), label: 'B+RIGHT' });
    });

    test('rejects unknown buttons with a corrective message', () => {
        expect(() => tools.parsePressEntry('X')).toThrow(/Valid buttons: A, B, SELECT/);
        expect(() => tools.validatePressArgs({ buttons: ['A', 'JUMP'] })).toThrow(/Unknown button "JUMP"/);
    });

    test('applies defaults and caps to press sequences', () => {
        const result = tools.validatePressArgs({ buttons: ['UP', 'UP', 'A'] });
        expect(result.holdFrames).toBe(tools.LIMITS.defaultHoldFrames);
        expect(result.gapFrames).toBe(tools.LIMITS.defaultGapFrames);
        expect(result.screenAfter).toBe(true);
        expect(result.totalFrames).toBe(3 * (result.holdFrames + result.gapFrames));

        expect(() => tools.validatePressArgs({ buttons: [] })).toThrow(/non-empty/);
        expect(() => tools.validatePressArgs({ buttons: Array(33).fill('A') })).toThrow(/At most 32/);
        expect(() => tools.validatePressArgs({ buttons: ['A'], hold_frames: 0 })).toThrow(/between 1 and 240/);
        expect(() => tools.validatePressArgs({ buttons: ['A'], hold_frames: 2.5 })).toThrow(/integer/);
    });

    test('validates wait, slots, upscale and memory reads', () => {
        expect(tools.validateWaitArgs({}).frames).toBe(tools.LIMITS.defaultWaitFrames);
        expect(() => tools.validateWaitArgs({ frames: 0 })).toThrow(/between/);

        expect(tools.validateSlot({ slot: 3 })).toBe(3);
        expect(() => tools.validateSlot({})).toThrow(/slot is required/);
        expect(() => tools.validateSlot({ slot: 10 })).toThrow(/between 1 and 9/);

        expect(tools.validateScreenArgs({}).upscale).toBe(tools.LIMITS.defaultUpscale);
        expect(() => tools.validateScreenArgs({ upscale: 9 })).toThrow(/between/);

        expect(tools.validateReadArgs({ address: '0x02024284' })).toEqual({ address: 0x02024284, length: 16 });
        expect(tools.validateReadArgs({ address: 1024, length: 32 })).toEqual({ address: 1024, length: 32 });
        expect(() => tools.validateReadArgs({ address: 'wram' })).toThrow(/address/);
        expect(() => tools.validateReadArgs({ address: 0, length: 1e6 })).toThrow(/between/);
    });

    test('read_memory tool is only listed when enabled', () => {
        const names = defs => defs.map(d => d.name);
        expect(names(tools.toolDefinitions())).not.toContain('read_memory');
        expect(names(tools.toolDefinitions({ allowMemory: true }))).toContain('read_memory');
        expect(names(tools.toolDefinitions())).toEqual(
            expect.arrayContaining(['get_screen', 'press_buttons', 'wait', 'save_state', 'load_state', 'get_status']));
    });
});

describe('png codec', () => {
    function makeTestImage(width, height) {
        const rgba = Buffer.alloc(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                rgba[i] = (x * 37) & 0xff;
                rgba[i + 1] = (y * 53) & 0xff;
                rgba[i + 2] = ((x + y) * 11) & 0xff;
                rgba[i + 3] = 0xff;
            }
        }
        return { width, height, rgba };
    }

    test('encode/decode round-trips pixel data', () => {
        const image = makeTestImage(24, 16);
        const decoded = decodePng(encodePng(image));
        expect(decoded.width).toBe(24);
        expect(decoded.height).toBe(16);
        expect(Buffer.compare(decoded.rgba, image.rgba)).toBe(0);
    });

    test('nearest-neighbor upscale replicates pixels', () => {
        const image = makeTestImage(4, 3);
        const scaled = upscaleNearest(image, 3);
        expect(scaled.width).toBe(12);
        expect(scaled.height).toBe(9);
        // every 3x3 block equals its source pixel
        for (let y = 0; y < 9; y++) {
            for (let x = 0; x < 12; x++) {
                const src = ((y / 3 | 0) * 4 + (x / 3 | 0)) * 4;
                const dst = (y * 12 + x) * 4;
                expect(scaled.rgba[dst]).toBe(image.rgba[src]);
                expect(scaled.rgba[dst + 1]).toBe(image.rgba[src + 1]);
            }
        }
    });

    test('upscalePng factor 1 is a pass-through', () => {
        const png = encodePng(makeTestImage(8, 8));
        expect(upscalePng(png, 1)).toBe(png);
        const decoded = decodePng(upscalePng(png, 2));
        expect(decoded.width).toBe(16);
    });

    test('rejects non-PNG input and unsupported formats', () => {
        expect(() => decodePng(Buffer.from('not a png'))).toThrow(/Not a PNG/);
        expect(() => upscaleNearest(makeTestImage(2, 2), 1.5)).toThrow(/positive integer/);
    });
});

describe('McpServer', () => {
    function startServer({ callTool, listTools } = {}) {
        const input = new PassThrough();
        const output = new PassThrough();
        const responses = [];
        output.on('data', chunk => {
            for (const line of chunk.toString().split('\n')) {
                if (line.trim()) responses.push(JSON.parse(line));
            }
        });
        const server = new McpServer({
            name: 'test-server',
            version: '0.0.1',
            listTools: listTools || (() => [{ name: 'demo', description: 'd', inputSchema: { type: 'object' } }]),
            callTool: callTool || (async () => ({ content: [{ type: 'text', text: 'hi' }] }))
        });
        server.attach(input, output);
        const send = msg => input.write(`${JSON.stringify(msg)}\n`);
        const settle = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));
        return { send, settle, responses };
    }

    test('handshake, tools/list, tools/call', async () => {
        const calls = [];
        const { send, settle, responses } = startServer({
            callTool: async (name, args) => {
                calls.push({ name, args });
                return { content: [{ type: 'text', text: 'done' }] };
            }
        });

        send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'jest' } } });
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'demo', arguments: { a: 1 } } });
        await settle();

        expect(responses).toHaveLength(3); // notification produced no response
        expect(responses[0].result.protocolVersion).toBe('2025-03-26');
        expect(responses[0].result.serverInfo.name).toBe('test-server');
        expect(responses[1].result.tools[0].name).toBe('demo');
        expect(responses[2].result.content[0].text).toBe('done');
        expect(calls).toEqual([{ name: 'demo', args: { a: 1 } }]);
    });

    test('unknown protocol version falls back to latest supported', async () => {
        const { send, settle, responses } = startServer();
        send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
        await settle();
        expect(responses[0].result.protocolVersion).toBe('2025-06-18');
    });

    test('unknown methods and parse errors return JSON-RPC errors', async () => {
        const { send, settle, responses } = startServer();
        send({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
        await settle();
        expect(responses[0].error.code).toBe(-32601);

        const input = new PassThrough();
        const output = new PassThrough();
        const parsed = [];
        output.on('data', c => parsed.push(JSON.parse(c.toString())));
        new McpServer({ name: 'x', version: '1', listTools: () => [], callTool: async () => ({}) }).attach(input, output);
        input.write('this is not json\n');
        await new Promise(resolve => setImmediate(resolve));
        expect(parsed[0].error.code).toBe(-32700);
    });

    test('tool handler exceptions become internal errors', async () => {
        const { send, settle, responses } = startServer({
            callTool: async () => { throw new Error('boom'); }
        });
        send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'demo' } });
        await settle();
        expect(responses[0].error.code).toBe(-32603);
        expect(responses[0].error.message).toBe('boom');
    });
});

describe('MgbaClient against a fake bridge', () => {
    let server;
    let port;
    let handler;

    beforeEach(async () => {
        handler = null;
        server = net.createServer(socket => {
            let buffer = '';
            socket.on('data', chunk => {
                buffer += chunk.toString();
                let idx;
                while ((idx = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 1);
                    if (handler) handler(parseLine(line), socket);
                }
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    afterEach(() => new Promise(resolve => server.close(resolve)));

    test('resolves ok responses with params', async () => {
        handler = (req, socket) => {
            expect(req.verb).toBe('status');
            socket.write(`${req.id} ok title=GOOB frame=42\n`);
        };
        const client = new MgbaClient({ port });
        const result = await client.request('status');
        expect(result).toEqual({ title: 'GOOB', frame: '42' });
        client.close();
    });

    test('rejects err responses with the bridge message', async () => {
        handler = (req, socket) => socket.write(`${req.id} err msg=${encodeValue('busy: another press/wait is in progress')}\n`);
        const client = new MgbaClient({ port });
        await expect(client.request('press', { seq: '1:1:0' }))
            .rejects.toMatchObject({ name: 'BridgeError', code: 'REMOTE', message: /busy/ });
        client.close();
    });

    test('times out when the bridge stays silent', async () => {
        handler = () => {};
        const client = new MgbaClient({ port });
        await expect(client.request('wait', { frames: 5 }, { timeoutMs: 100 }))
            .rejects.toMatchObject({ code: 'TIMEOUT' });
        client.close();
    });

    test('unreachable bridge produces a friendly error', async () => {
        const client = new MgbaClient({ port: 1 }); // nothing listens on port 1
        await expect(client.request('status'))
            .rejects.toMatchObject({ code: 'UNREACHABLE', message: /Start mGBA with the bridge script/ });
    });

    test('frameTimeout scales with the frame budget', () => {
        expect(frameTimeout(0)).toBe(5000);
        expect(frameTimeout(60)).toBe(5000 + 2000);
        expect(frameTimeout(600)).toBe(5000 + 20000);
    });
});

describe('createToolHandler', () => {
    function fakeBridge(overrides = {}) {
        return {
            host: '127.0.0.1',
            port: 5771,
            request: jest.fn(async verb => {
                if (verb === 'status') return { title: 'GOOBKEYTEST', code: 'GKTE', platform: '0', frame: '100' };
                return {};
            }),
            ...overrides
        };
    }

    test('press_buttons legalizes input before it reaches the bridge', async () => {
        const bridge = fakeBridge();
        const handler = createToolHandler(bridge);
        const result = await handler('press_buttons', { buttons: ['bogus'] });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/Unknown button "BOGUS"/);
        expect(bridge.request).not.toHaveBeenCalled();
    });

    test('press_buttons sends the computed mask sequence', async () => {
        const bridge = fakeBridge();
        const handler = createToolHandler(bridge);
        const result = await handler('press_buttons', { buttons: ['UP', 'A'], hold_frames: 8, gap_frames: 2, screen_after: false });
        expect(result.isError).toBeUndefined();
        expect(bridge.request).toHaveBeenCalledWith('press', { seq: '64:8:2,1:8:2' }, expect.objectContaining({ timeoutMs: expect.any(Number) }));
        expect(result.content[0].text).toMatch(/Pressed: UP, A/);
    });

    test('read_memory is refused unless enabled', async () => {
        const handler = createToolHandler(fakeBridge());
        const result = await handler('read_memory', { address: '0x02000000' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/--allow-memory/);
    });

    test('read_memory formats a hex dump when enabled', async () => {
        const bridge = fakeBridge({
            request: jest.fn(async verb => verb === 'read' ? { hex: 'deadbeef' } : {})
        });
        const handler = createToolHandler(bridge, { allowMemory: true });
        const result = await handler('read_memory', { address: '0x02000000', length: 4 });
        expect(result.content[0].text).toBe('0x02000000: de ad be ef');
    });

    test('bridge failures surface as tool errors, not crashes', async () => {
        const bridge = fakeBridge({
            request: jest.fn(async () => { throw new BridgeError('Cannot reach the mGBA bridge', 'UNREACHABLE'); })
        });
        const handler = createToolHandler(bridge);
        const result = await handler('get_status', {});
        expect(result.content[0].text).toMatch(/Bridge NOT connected/);

        const waitResult = await handler('wait', { frames: 10 });
        expect(waitResult.isError).toBe(true);
    });

    test('unknown tools return a tool error', async () => {
        const handler = createToolHandler(fakeBridge());
        const result = await handler('fly_to_the_moon', {});
        expect(result.isError).toBe(true);
    });
});
