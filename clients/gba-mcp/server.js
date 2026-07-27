#!/usr/bin/env node
/**
 * goobster-gba-mcp — MCP server that drives a GBA game running in mGBA.
 *
 * Phase 0 of "Goobster Plays Pokémon" (see
 * documentation/goobster_plays_pokemon.md): exposes the emulator as a
 * standard MCP tool surface so any MCP client — the future autonomous
 * AI handler, or a human driving from Cursor/Claude Desktop for
 * debugging — can see the screen, press buttons, and manage save states.
 *
 * Pairs with goobster-gba.lua, which runs inside mGBA and listens on a
 * loopback TCP socket. Both processes must run on the same machine (the
 * screenshot hand-off uses a temp file).
 *
 * Zero dependencies by design (like clients/screen-companion): run it
 * with nothing but Node 20+.
 *
 * Usage:
 *   node server.js [--host 127.0.0.1] [--port 5771] [--allow-memory]
 * Environment (flags win):
 *   GOOBSTER_GBA_HOST, GOOBSTER_GBA_PORT, GOOBSTER_GBA_ALLOW_MEMORY=1
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { McpServer } = require('./lib/mcpServer');
const { MgbaClient, BridgeError, frameTimeout } = require('./lib/mgbaClient');
const { upscalePng } = require('./lib/png');
const tools = require('./lib/tools');

const VERSION = '0.1.0';

function parseArgs(argv) {
    const options = {
        host: process.env.GOOBSTER_GBA_HOST || '127.0.0.1',
        port: Number(process.env.GOOBSTER_GBA_PORT || 5771),
        allowMemory: process.env.GOOBSTER_GBA_ALLOW_MEMORY === '1'
    };
    for (let i = 2; i < argv.length; i++) {
        switch (argv[i]) {
            case '--host': options.host = argv[++i]; break;
            case '--port': options.port = Number(argv[++i]); break;
            case '--allow-memory': options.allowMemory = true; break;
            case '--help':
                console.error('usage: node server.js [--host HOST] [--port PORT] [--allow-memory]');
                process.exit(0);
                break;
            default:
                console.error(`Unknown option: ${argv[i]}`);
                process.exit(1);
        }
    }
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
        console.error(`Invalid port: ${options.port}`);
        process.exit(1);
    }
    return options;
}

/** stderr logger — stdout belongs to the MCP protocol. */
function log(message) {
    console.error(`[gba-mcp] ${new Date().toISOString()} ${message}`);
}

function textContent(text) {
    return { type: 'text', text };
}

function imageContent(pngBuffer) {
    return { type: 'image', data: pngBuffer.toString('base64'), mimeType: 'image/png' };
}

function errorResult(message) {
    return { content: [textContent(message)], isError: true };
}

/**
 * Build the tool dispatcher bound to a bridge client.
 * Exported for tests (which inject a fake bridge).
 * @param {MgbaClient} bridge
 * @param {{ allowMemory?: boolean, screenshotDir?: string }} [options]
 */
function createToolHandler(bridge, { allowMemory = false, screenshotDir = os.tmpdir() } = {}) {
    let screenshotSeq = 0;

    async function captureScreen(upscale) {
        const file = path.join(screenshotDir, `goobster-gba-${process.pid}-${++screenshotSeq}.png`);
        try {
            await bridge.request('screenshot', { path: file });
            const png = await fs.promises.readFile(file);
            return imageContent(upscalePng(png, upscale));
        } finally {
            fs.promises.unlink(file).catch(() => {});
        }
    }

    async function statusLine() {
        const status = await bridge.request('status');
        const title = status.title || 'unknown';
        return `Game: ${title} (${status.code || '????'}) | frame ${status.frame}`;
    }

    return async function callTool(name, args) {
        try {
            switch (name) {
                case 'get_screen': {
                    const { upscale } = tools.validateScreenArgs(args);
                    const image = await captureScreen(upscale);
                    return { content: [image, textContent(await statusLine())] };
                }
                case 'press_buttons': {
                    const { presses, holdFrames, gapFrames, screenAfter, totalFrames } = tools.validatePressArgs(args);
                    const seq = presses.map(p => `${p.mask}:${holdFrames}:${gapFrames}`).join(',');
                    await bridge.request('press', { seq }, { timeoutMs: frameTimeout(totalFrames) });
                    const labels = presses.map(p => p.label).join(', ');
                    const content = [textContent(`Pressed: ${labels} (${holdFrames} frames each). ${await statusLine()}`)];
                    if (screenAfter) content.unshift(await captureScreen(tools.LIMITS.defaultUpscale));
                    return { content };
                }
                case 'wait': {
                    const { frames, screenAfter } = tools.validateWaitArgs(args);
                    await bridge.request('wait', { frames }, { timeoutMs: frameTimeout(frames) });
                    const content = [textContent(`Waited ${frames} frames. ${await statusLine()}`)];
                    if (screenAfter) content.unshift(await captureScreen(tools.LIMITS.defaultUpscale));
                    return { content };
                }
                case 'save_state': {
                    const slot = tools.validateSlot(args);
                    await bridge.request('savestate', { slot });
                    return { content: [textContent(`Saved state to slot ${slot}.`)] };
                }
                case 'load_state': {
                    const slot = tools.validateSlot(args);
                    await bridge.request('loadstate', { slot });
                    return {
                        content: [
                            await captureScreen(tools.LIMITS.defaultUpscale),
                            textContent(`Loaded state from slot ${slot}. ${await statusLine()}`)
                        ]
                    };
                }
                case 'get_status': {
                    try {
                        const status = await bridge.request('status');
                        return {
                            content: [textContent(
                                `Bridge connected (${bridge.host}:${bridge.port}). ` +
                                `Game: ${status.title || 'none loaded'} (${status.code || '????'}), ` +
                                `platform ${status.platform === '0' ? 'GBA' : status.platform === '1' ? 'GB' : status.platform}, ` +
                                `frame ${status.frame}.`
                            )]
                        };
                    } catch (error) {
                        if (error instanceof BridgeError && error.code !== 'REMOTE') {
                            return { content: [textContent(`Bridge NOT connected: ${error.message}`)] };
                        }
                        throw error;
                    }
                }
                case 'read_memory': {
                    if (!allowMemory) {
                        return errorResult('read_memory is disabled. Start the server with --allow-memory to enable RAM-assisted play.');
                    }
                    const { address, length } = tools.validateReadArgs(args);
                    const result = await bridge.request('read', { addr: address, len: length });
                    const hex = result.hex || '';
                    const bytes = hex.match(/.{1,2}/g) || [];
                    const lines = [];
                    for (let i = 0; i < bytes.length; i += 16) {
                        const addr = (address + i).toString(16).padStart(8, '0');
                        lines.push(`0x${addr}: ${bytes.slice(i, i + 16).join(' ')}`);
                    }
                    return { content: [textContent(lines.join('\n') || '(no data)')] };
                }
                default:
                    return errorResult(`Unknown tool: ${name}`);
            }
        } catch (error) {
            if (error instanceof tools.ToolInputError || error instanceof BridgeError) {
                return errorResult(error.message);
            }
            throw error;
        }
    };
}

function main() {
    const options = parseArgs(process.argv);
    const bridge = new MgbaClient({ host: options.host, port: options.port, log });
    const server = new McpServer({
        name: 'goobster-gba-mcp',
        version: VERSION,
        listTools: () => tools.toolDefinitions({ allowMemory: options.allowMemory }),
        callTool: createToolHandler(bridge, { allowMemory: options.allowMemory }),
        log
    });

    log(`Starting (bridge ${options.host}:${options.port}, memory tools ${options.allowMemory ? 'ENABLED' : 'disabled'})`);
    server.attach(process.stdin, process.stdout).then(() => {
        log('stdin closed, shutting down');
        bridge.close();
        process.exit(0);
    });
}

if (require.main === module) {
    main();
}

module.exports = { createToolHandler, parseArgs, VERSION };
