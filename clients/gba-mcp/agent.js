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
 *   node agent.js --provider openai --reasoning medium --allow-memory \
 *       --hints-file hints/pokemon-firered.txt --goal "Earn the Boulder Badge"
 *
 * --allow-memory turns on RAM ground truth for known games (FireRed /
 * LeafGreen / Emerald): exact player position, map id, and in-battle
 * flag are read each turn and fed into the prompt as deterministic
 * feedback (see lib/gameState.js). Vision-first still applies - the
 * agent plays from the screen; RAM only keeps it honest about movement.
 *
 * Cross-session learning is on by default (--no-learn disables): the
 * model banks verified game nuances via a "learn" JSON field, and the
 * harness banks wall bumps, explored tiles, and achieved milestones -
 * all persisted per game in goobster-gba-experience.json and injected
 * into future sessions' prompts (see lib/experience.js).
 *
 * Sync mode is on by default (--no-sync disables): the game is frozen
 * (bridge "hold") from screenshot to button press, so the model's whole
 * deliberation describes one instant - no stale screens, however slow
 * the model. Needs the current goobster-gba.lua; older bridge scripts
 * fall back to the fresh-frame guard automatically.
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
const { ExperienceBook } = require('./lib/experience');

const CONFIG_FILE = path.join(__dirname, 'goobster-gba-run.json');
const EXPERIENCE_FILE = path.join(__dirname, 'goobster-gba-experience.json');

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
        dryRun: false,
        allowMemory: process.env.GOOBSTER_GBA_ALLOW_MEMORY === '1',
        reasoning: null,
        think: null,
        learn: true,
        experienceFile: EXPERIENCE_FILE,
        sync: true
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
            case '--allow-memory': options.allowMemory = true; break;
            case '--reasoning': options.reasoning = argv[++i]; break;
            case '--think': options.think = true; break;
            case '--no-learn': options.learn = false; break;
            case '--experience-file': options.experienceFile = argv[++i]; break;
            case '--no-sync': options.sync = false; break;
            case '--help':
                console.log('usage: node agent.js [--provider ollama|openai] [--model NAME] [--ollama-host URL]\n' +
                    '                     [--reasoning minimal|low|medium|high] [--think] [--allow-memory]\n' +
                    '                     [--no-learn] [--experience-file FILE] [--no-sync]\n' +
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

    if (options.reasoning && options.provider !== 'openai') {
        fail('--reasoning only applies to --provider openai');
    }
    if (options.think !== null && options.provider !== 'ollama') {
        fail('--think only applies to --provider ollama');
    }

    let model;
    try {
        model = createModel({
            provider: options.provider,
            model: options.model || undefined,
            host: options.ollamaHost,
            reasoningEffort: options.reasoning,
            think: options.think,
            log
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
    const experience = options.learn ? new ExperienceBook({ file: options.experienceFile, log }) : null;
    if (experience) log(`Cross-session learning on (${options.experienceFile}); disable with --no-learn`);
    const agent = new GameAgent({
        bridge,
        model,
        broadcast,
        experience,
        log,
        options: {
            goal: options.goal,
            hints: options.hints,
            maxTurns: options.turns,
            turnDelayMs: options.turnDelayMs,
            postEvery: options.postEvery,
            checkpointEvery: options.checkpointEvery,
            memoryAssist: options.allowMemory,
            syncMode: options.sync
        }
    });

    if (broadcast) {
        broadcast.onAdvice = advice => agent.addAdvice(advice);
        for (const advice of pendingAdvice) agent.addAdvice(advice);
        pendingAdvice = [];
    }

    let interrupted = false;
    process.on('SIGINT', () => {
        if (interrupted) {
            log('SIGINT again - exiting immediately');
            process.exit(130);
        }
        interrupted = true;
        log('SIGINT - finishing the current turn, then stopping (Ctrl+C again to force quit)');
        agent.stop();
    });

    const stats = await agent.run();
    log(`Done: ${JSON.stringify(stats)}`);
    broadcast?.close();
    bridge.close();
}

main().catch(error => fail(error.message));
