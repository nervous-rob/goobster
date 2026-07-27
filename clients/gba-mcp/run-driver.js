#!/usr/bin/env node
/**
 * goobster-gba run driver — Phase 1 of "Goobster Plays Pokémon"
 * (documentation/goobster_plays_pokemon.md): executes a scripted playbook
 * against the local mGBA bridge and streams screenshots/captions to
 * Goobster, who posts them into the Discord channel bound with
 * /gbarun link. Zero AI — this proves the whole broadcast pipe.
 *
 * Zero dependencies; requires Node 22+ (built-in WebSocket + fetch).
 * Runs on the machine that runs mGBA (same box as goobster-gba.lua).
 *
 * First run (pair with a /gbarun link code, saved next to this script):
 *   node run-driver.js --server https://<goobster-url> --code XXXX-XXXX --playbook playbooks/keytest-demo.json
 * After that:
 *   node run-driver.js --playbook playbooks/keytest-demo.json
 * Local-only rehearsal (no Goobster, prints instead of posting):
 *   node run-driver.js --dry-run --playbook playbooks/keytest-demo.json
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MgbaClient, frameTimeout } = require('./lib/mgbaClient');
const { upscalePng } = require('./lib/png');
const { parsePlaybook, PlaybookError } = require('./lib/playbook');

const CONFIG_FILE = path.join(__dirname, 'goobster-gba-run.json');
const ACK_TIMEOUT_MS = 15000;

function log(message) {
    console.log(`[run-driver] ${new Date().toISOString()} ${message}`);
}

function fail(message) {
    console.error(`[run-driver] ${message}`);
    process.exit(1);
}

function parseArgs(argv) {
    const options = {
        playbook: null,
        server: null,
        code: null,
        label: os.hostname(),
        bridgeHost: process.env.GOOBSTER_GBA_HOST || '127.0.0.1',
        bridgePort: Number(process.env.GOOBSTER_GBA_PORT || 5771),
        dryRun: false
    };
    for (let i = 2; i < argv.length; i++) {
        switch (argv[i]) {
            case '--playbook': options.playbook = argv[++i]; break;
            case '--server': options.server = argv[++i]; break;
            case '--code': options.code = argv[++i]; break;
            case '--label': options.label = argv[++i]; break;
            case '--bridge-host': options.bridgeHost = argv[++i]; break;
            case '--bridge-port': options.bridgePort = Number(argv[++i]); break;
            case '--dry-run': options.dryRun = true; break;
            case '--help':
                console.log('usage: node run-driver.js --playbook FILE [--server URL --code XXXX-XXXX] [--label NAME] [--bridge-host HOST] [--bridge-port PORT] [--dry-run]');
                process.exit(0);
                break;
            default:
                fail(`Unknown option: ${argv[i]}`);
        }
    }
    if (!options.playbook) fail('--playbook is required (see clients/gba-mcp/playbooks/)');
    return options;
}

function normalizeServerUrl(raw) {
    let base = String(raw || '').trim().replace(/\/+$/, '');
    if (base.startsWith('ws://')) base = 'http://' + base.slice(5);
    if (base.startsWith('wss://')) base = 'https://' + base.slice(6);
    if (!/^https?:\/\//.test(base)) base = 'https://' + base;
    return base;
}

/** Load or create the saved pairing (server + token) next to this script. */
async function resolvePairing({ server, code, label }) {
    if (code) {
        if (!server) fail('--code needs --server <goobster url> too');
        const base = normalizeServerUrl(server);
        const response = await fetch(`${base}/api/gba-run/pair`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code, label })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            fail(`Pairing failed: ${body?.error?.message || response.status}`);
        }
        const pairing = { server: base, token: body.token, guildId: body.guildId };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(pairing, null, 2));
        log(`Paired with ${base} (guild ${body.guildId}); saved to ${CONFIG_FILE}`);
        return pairing;
    }
    try {
        const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (saved.server && saved.token) return saved;
    } catch { /* no saved pairing */ }
    fail('No pairing found. Run /gbarun link in Discord, then start with --server <url> --code <code>.');
}

/**
 * Minimal broadcast connection to Goobster: hello/ready handshake, posts
 * acked by seq. Never throws out of post(); a dead connection means the
 * post is skipped (the run keeps going, the pipe is best-effort).
 */
class Broadcast {
    constructor({ server, token }) {
        this.url = `${normalizeServerUrl(server).replace(/^http/, 'ws')}/api/gba-run/ws`;
        this.token = token;
        this.socket = null;
        this._seq = 0;
        this._acks = new Map(); // seq -> { resolve, timer }
        this.delivered = 0;
        this.failed = 0;
    }

    async connect() {
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(this.url);
            const timer = setTimeout(() => reject(new Error('Timed out connecting to Goobster')), 15000);
            socket.addEventListener('open', () => {
                socket.send(JSON.stringify({ type: 'hello', token: this.token }));
            });
            socket.addEventListener('message', event => {
                let message;
                try { message = JSON.parse(event.data); } catch { return; }
                if (message.type === 'ready') {
                    clearTimeout(timer);
                    this.socket = socket;
                    resolve();
                } else if (message.type === 'ack') {
                    const pending = this._acks.get(message.seq);
                    if (pending) {
                        this._acks.delete(message.seq);
                        clearTimeout(pending.timer);
                        pending.resolve(message);
                    }
                } else if (message.type === 'error') {
                    clearTimeout(timer);
                    reject(new Error(`${message.code}: ${message.message}`));
                }
            });
            socket.addEventListener('close', () => {
                this.socket = null;
                for (const [seq, pending] of this._acks) {
                    clearTimeout(pending.timer);
                    pending.resolve({ posted: false, error: 'connection closed' });
                    this._acks.delete(seq);
                }
            });
            socket.addEventListener('error', () => {
                clearTimeout(timer);
                reject(new Error(`Cannot reach Goobster at ${this.url}`));
            });
        });
    }

    _isOpen() {
        return this.socket && this.socket.readyState === 1;
    }

    /** Fire-and-forget status update (game title for /gbarun status). */
    sendStatus(game) {
        if (this._isOpen()) {
            this.socket.send(JSON.stringify({ type: 'status', game }));
        }
    }

    /** Post text and/or an image; resolves with the ack (never rejects). */
    async post({ text, image, filename }) {
        if (!this._isOpen()) {
            try {
                await this.connect();
                log('Reconnected to Goobster');
            } catch (error) {
                this.failed++;
                return { posted: false, error: error.message };
            }
        }
        const seq = ++this._seq;
        const ack = await new Promise(resolve => {
            const timer = setTimeout(() => {
                this._acks.delete(seq);
                resolve({ posted: false, error: 'ack timeout' });
            }, ACK_TIMEOUT_MS);
            this._acks.set(seq, { resolve, timer });
            this.socket.send(JSON.stringify({ type: 'post', seq, text, image, filename }));
        });
        if (ack.posted) this.delivered++;
        else this.failed++;
        return ack;
    }

    close() {
        try { this.socket?.close(); } catch { /* closing */ }
    }
}

async function main() {
    const options = parseArgs(process.argv);

    let playbook;
    try {
        playbook = parsePlaybook(JSON.parse(fs.readFileSync(options.playbook, 'utf8')));
    } catch (error) {
        if (error instanceof PlaybookError) fail(`Invalid playbook: ${error.message}`);
        fail(`Cannot read playbook ${options.playbook}: ${error.message}`);
    }
    log(`Playbook "${playbook.name}" (${playbook.steps.length} steps)`);

    const bridge = new MgbaClient({ host: options.bridgeHost, port: options.bridgePort, log });

    let broadcast = null;
    if (options.dryRun) {
        log('Dry run: posts will be printed, not sent');
    } else {
        const pairing = await resolvePairing(options);
        broadcast = new Broadcast(pairing);
        await broadcast.connect();
        log(`Connected to Goobster (guild ${pairing.guildId})`);
    }

    // Announce the game so /gbarun status can show it.
    const status = await bridge.request('status');
    log(`Game: ${status.title} (${status.code}), frame ${status.frame}`);
    broadcast?.sendStatus({ title: status.title, code: status.code });

    let screenshotSeq = 0;
    async function captureScreen(upscale) {
        const file = path.join(os.tmpdir(), `goobster-run-${process.pid}-${++screenshotSeq}.png`);
        try {
            await bridge.request('screenshot', { path: file });
            return upscalePng(await fs.promises.readFile(file), upscale);
        } finally {
            fs.promises.unlink(file).catch(() => {});
        }
    }

    for (let i = 0; i < playbook.steps.length; i++) {
        const step = playbook.steps[i];
        const where = `[${i + 1}/${playbook.steps.length}]`;
        switch (step.kind) {
            case 'press': {
                const seq = step.presses.map(p => `${p.mask}:${step.holdFrames}:${step.gapFrames}`).join(',');
                await bridge.request('press', { seq }, { timeoutMs: frameTimeout(step.totalFrames) });
                log(`${where} pressed ${step.presses.map(p => p.label).join(', ')}`);
                break;
            }
            case 'wait':
                await bridge.request('wait', { frames: step.frames }, { timeoutMs: frameTimeout(step.frames) });
                log(`${where} waited ${step.frames} frames`);
                break;
            case 'save':
                await bridge.request('savestate', { slot: step.slot });
                log(`${where} saved state to slot ${step.slot}`);
                break;
            case 'load':
                await bridge.request('loadstate', { slot: step.slot });
                log(`${where} loaded state from slot ${step.slot}`);
                break;
            case 'note':
                log(`${where} NOTE: ${step.text}`);
                break;
            case 'post': {
                const image = step.screen ? (await captureScreen(step.upscale)).toString('base64') : undefined;
                if (options.dryRun) {
                    log(`${where} DRY-RUN post: "${step.text}"${image ? ` + screenshot (${image.length} base64 chars)` : ''}`);
                    break;
                }
                const ack = await broadcast.post({
                    text: step.text || undefined,
                    image,
                    filename: `run-step-${i + 1}.png`
                });
                log(`${where} post "${step.text || '(screenshot)'}" -> ${ack.posted ? 'delivered' : `FAILED (${ack.error})`}`);
                break;
            }
        }
    }

    if (broadcast) {
        log(`Run complete: ${broadcast.delivered} posts delivered, ${broadcast.failed} failed`);
        broadcast.close();
    } else {
        log('Run complete (dry run)');
    }
    bridge.close();
}

main().catch(error => fail(error.message));
