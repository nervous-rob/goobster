#!/usr/bin/env node
/**
 * goobster-gba agent — Phase 2 of "Goobster Plays Pokémon"
 * (documentation/goobster_plays_pokemon.md): an autonomous player. A
 * vision model looks at the mGBA screen each turn and decides what to
 * press; deterministic code legalizes and executes; screenshots and
 * commentary stream into Discord through the Phase 1 broadcast pipe.
 *
 * Zero dependencies; requires Node 22+. Runs on the machine that runs
 * mGBA (same box as goobster-gba.lua), next to a local Ollama with a
 * multimodal model — or with --provider openai as a quality ceiling.
 *
 * Examples:
 *   node agent.js --goal "Get out of the first town"
 *   node agent.js --provider ollama --model qwen2.5vl:7b --turns 100
 *   node agent.js --provider openai --turns 20 --dry-run
 *
 * Pairing works like run-driver.js: first run with
 *   --server https://<goobster-url> --code XXXX-XXXX   (/gbarun link)
 * afterwards the saved goobster-gba-run.json is used automatically.
 * --dry-run plays without broadcasting.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MgbaClient } = require('./lib/mgbaClient');
const { Broadcast, resolvePairing } = require('./lib/broadcast');
const { createModel } = require('./lib/visionModel');
const { GameAgent, DEFAULTS } = require('./lib/gameAgent');

const CONFIG_FILE = path.join(__dirname, 'goobster-gba-run.json');

function log(message) {
    console.log(`[agent] ${new Date().toISOString()} ${message}`);
}

function fail(message) {
    console.error(`[agent] ${message}`);
    process.exit(1);
}

function parseArgs(argv) {
    const options = {
        provider: 'ollama',
        model: null,
        ollamaHost: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
        goal: DEFAULTS.goal,
        hints: null,
        turns: DEFAULTS.maxTurns,
        turnDelayMs: DEFAULTS.turnDelayMs,
        postEvery: DEFAULTS.postEvery,
        checkpointEvery: DEFAULTS.checkpointEvery,
        server: null,
        code: null,
        label: os.hostname(),
        bridgeHost: process.env.GOOBSTER_GBA_HOST || '127.0.0.1',
        bridgePort: Number(process.env.GOOBSTER_GBA_PORT || 5771),
        dryRun: false
    };
    for (let i = 2; i < argv.length; i++) {
        switch (argv[i]) {
            case '--provider': options.provider = argv[++i]; break;
            case '--model': options.model = argv[++i]; break;
            case '--ollama-host': options.ollamaHost = argv[++i]; break;
            case '--goal': options.goal = argv[++i]; break;
            case '--hints': options.hints = argv[++i]; break;
            case '--hints-file': {
                const file = argv[++i];
                try {
                    options.hints = fs.readFileSync(file, 'utf8').trim();
                } catch (error) {
                    fail(`Cannot read hints file ${file}: ${error.message}`);
                }
                break;
            }
            case '--turns': options.turns = Number(argv[++i]); break;
            case '--turn-delay-ms': options.turnDelayMs = Number(argv[++i]); break;
            case '--post-every': options.postEvery = Number(argv[++i]); break;
            case '--checkpoint-every': options.checkpointEvery = Number(argv[++i]); break;
            case '--server': options.server = argv[++i]; break;
            case '--code': options.code = argv[++i]; break;
            case '--label': options.label = argv[++i]; break;
            case '--bridge-host': options.bridgeHost = argv[++i]; break;
            case '--bridge-port': options.bridgePort = Number(argv[++i]); break;
            case '--dry-run': options.dryRun = true; break;
            case '--help':
                console.log('usage: node agent.js [--provider ollama|openai] [--model NAME] [--ollama-host URL]\n' +
                    '                     [--goal TEXT] [--hints TEXT | --hints-file FILE]\n' +
                    '                     [--turns N] [--turn-delay-ms MS] [--post-every N]\n' +
                    '                     [--checkpoint-every N] [--server URL --code XXXX-XXXX] [--label NAME]\n' +
                    '                     [--bridge-host HOST] [--bridge-port PORT] [--dry-run]');
                process.exit(0);
                break;
            default:
                fail(`Unknown option: ${argv[i]}`);
        }
    }
    for (const key of ['turns', 'turnDelayMs', 'postEvery', 'checkpointEvery']) {
        if (!Number.isInteger(options[key]) || options[key] < 0) fail(`--${key} must be a non-negative integer`);
    }
    return options;
}

async function main() {
    const options = parseArgs(process.argv);

    let model;
    try {
        model = createModel({
            provider: options.provider,
            model: options.model || undefined,
            host: options.ollamaHost
        });
    } catch (error) {
        fail(error.message);
    }

    let broadcast = null;
    let pendingAdvice = [];
    if (options.dryRun) {
        log('Dry run: playing without broadcasting to Discord');
    } else {
        const pairing = await resolvePairing({ ...options, configFile: CONFIG_FILE }).catch(error => fail(error.message));
        // The agent is constructed after the connection, so buffer any
        // advice that arrives during startup instead of dropping it.
        broadcast = new Broadcast({ ...pairing, onAdvice: advice => pendingAdvice.push(advice) });
        await broadcast.connect();
        log(`Connected to Goobster (guild ${pairing.guildId})`);
    }

    const bridge = new MgbaClient({ host: options.bridgeHost, port: options.bridgePort, log });
    const agent = new GameAgent({
        bridge,
        model,
        broadcast,
        log,
        options: {
            goal: options.goal,
            hints: options.hints,
            maxTurns: options.turns,
            turnDelayMs: options.turnDelayMs,
            postEvery: options.postEvery,
            checkpointEvery: options.checkpointEvery
        }
    });

    if (broadcast) {
        broadcast.onAdvice = advice => agent.addAdvice(advice);
        for (const advice of pendingAdvice) agent.addAdvice(advice);
        pendingAdvice = [];
    }

    process.on('SIGINT', () => {
        log('SIGINT - finishing the current turn, then stopping');
        agent.stop();
    });

    const stats = await agent.run();
    log(`Done: ${JSON.stringify(stats)}`);
    broadcast?.close();
    bridge.close();
}

main().catch(error => fail(error.message));
