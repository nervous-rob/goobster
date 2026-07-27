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
const { Broadcast, resolvePairing } = require('./lib/broadcast');

const CONFIG_FILE = path.join(__dirname, 'goobster-gba-run.json');

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
        const pairing = await resolvePairing({ ...options, configFile: CONFIG_FILE }).catch(error => fail(error.message));
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
