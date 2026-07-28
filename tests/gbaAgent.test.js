/**
 * Phase 2 of Goobster Plays Pokémon — the autonomous player. Covers the
 * brain (JSON extraction + decision legalization + history), the stuck
 * detector (synthetic frames), the Ollama provider against a fake HTTP
 * server, and the full GameAgent loop with a scripted fake model and a
 * fake bridge writing real PNGs.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ExperienceBook } = require('../clients/gba-mcp/lib/experience');

const brain = require('../clients/gba-mcp/lib/agentBrain');
const { StuckDetector, thresholds } = require('../clients/gba-mcp/lib/stuckDetector');
const { createModel, createOpenAiModel, VisionModelError } = require('../clients/gba-mcp/lib/visionModel');
const { GameAgent } = require('../clients/gba-mcp/lib/gameAgent');
const { encodePng } = require('../clients/gba-mcp/lib/png');

function makeFrame(width, height, paint = () => [0, 0, 128]) {
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b] = paint(x, y);
            const i = (y * width + x) * 4;
            rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
        }
    }
    return { width, height, rgba };
}

describe('agentBrain', () => {
    test('extractJson tolerates fences and surrounding prose', () => {
        expect(brain.extractJson('{"a":1}')).toEqual({ a: 1 });
        expect(brain.extractJson('Sure! Here you go:\n```json\n{"a":{"b":"}"}}\n```\nHope that helps!'))
            .toEqual({ a: { b: '}' } });
        expect(brain.extractJson('no json here')).toBeNull();
        expect(brain.extractJson('{"broken": ')).toBeNull();
    });

    test('parseDecision legalizes actions and keeps the rest', () => {
        const decision = brain.parseDecision(JSON.stringify({
            observe: 'A square on a blue field',
            objective: 'reach the corner',
            actions: ['right', 'RIGHT', 'wait', 'B+DOWN'],
            say: 'off we go',
            milestone: false
        }));
        expect(decision.actions).toEqual([
            { kind: 'press', mask: 1 << 4, label: 'RIGHT' },
            { kind: 'press', mask: 1 << 4, label: 'RIGHT' },
            { kind: 'wait' },
            { kind: 'press', mask: (1 << 1) | (1 << 7), label: 'B+DOWN' }
        ]);
        expect(decision.objective).toBe('reach the corner');
        expect(decision.dropped).toEqual([]);
    });

    test('illegal actions are dropped, not executed; all-illegal degrades to wait', () => {
        const decision = brain.parseDecision('{"observe":"x","actions":["FLY","UPWARDS"]}');
        expect(decision.actions).toEqual([{ kind: 'wait' }]);
        expect(decision.dropped).toHaveLength(2);
        expect(decision.dropped[0]).toMatch(/Unknown button/);
    });

    test('action count is capped', () => {
        const decision = brain.parseDecision(JSON.stringify({ actions: Array(12).fill('A') }));
        expect(decision.actions).toHaveLength(brain.MAX_ACTIONS_PER_TURN);
        expect(decision.dropped.length).toBe(12 - brain.MAX_ACTIONS_PER_TURN);
    });

    test('unusable answers return null', () => {
        expect(brain.parseDecision('I cannot help with that.')).toBeNull();
        expect(brain.parseDecision('{}')).toBeNull();
    });

    test('system prompt teaches cursor mechanics, demotes SELECT, and carries operator hints', () => {
        const prompt = brain.buildSystemPrompt({ goal: 'win', hints: 'Press START on naming screens.' });
        expect(prompt).toContain('The D-pad MOVES the cursor');
        expect(prompt).toContain('SELECT does NOT mean "select the option"');
        expect(prompt).toContain('Mashing A');
        expect(prompt).toContain('GAME NOTES from the operator:\nPress START on naming screens.');
        expect(brain.buildSystemPrompt({ goal: 'win' })).not.toContain('GAME NOTES');
    });

    test('learning adds the "learn" contract, past lessons, and progress to the system prompt', () => {
        const learning = brain.buildSystemPrompt({
            goal: 'win', learning: true,
            lessons: ['Brock leads with Geodude'],
            milestones: ['Earned the Boulder Badge']
        });
        expect(learning).toContain('"learn" field');
        expect(learning).toContain('LESSONS FROM YOUR PAST SESSIONS');
        expect(learning).toContain('- Brock leads with Geodude');
        expect(learning).toContain('PROGRESS ALREADY MADE');
        expect(learning).toContain('- Earned the Boulder Badge');

        const plain = brain.buildSystemPrompt({ goal: 'win' });
        expect(plain).not.toContain('"learn" field');
        expect(plain).not.toContain('LESSONS FROM');
        expect(plain).not.toContain('PROGRESS ALREADY MADE');
    });

    test('parseDecision carries the optional learn field through legalization', () => {
        const decision = brain.parseDecision('{"observe":"x","actions":["A"],"learn":"  Ledges are one-way  "}');
        expect(decision.learn).toBe('Ledges are one-way');
        expect(brain.parseDecision('{"observe":"x","actions":["A"]}').learn).toBeNull();
    });

    test('memory assist adds the ground-truth contract to the system prompt', () => {
        const assisted = brain.buildSystemPrompt({ goal: 'win', memoryAssist: true });
        expect(assisted).toContain('GROUND TRUTH');
        expect(assisted).toContain('authoritative');
        expect(brain.buildSystemPrompt({ goal: 'win' })).not.toContain('GROUND TRUTH');
    });

    test('state lines render as a ground-truth block in the turn prompt', () => {
        const prompt = brain.buildTurnPrompt({
            objective: 'go north', historyLines: ['turn 1: pressed [UP]'], turn: 2, stuckWarning: null,
            stateLines: ['You are standing on tile (5, 5) of map 3.1.', 'Since last turn, you moved 1 tile UP.']
        });
        expect(prompt).toContain('GROUND TRUTH (read from the emulator RAM');
        expect(prompt).toContain('- You are standing on tile (5, 5) of map 3.1.');
        expect(prompt).toContain('- Since last turn, you moved 1 tile UP.');
        // The block precedes the history so the model reads facts first.
        expect(prompt.indexOf('GROUND TRUTH')).toBeLessThan(prompt.indexOf('Recent turns:'));

        expect(brain.buildTurnPrompt({ objective: null, historyLines: [], turn: 1, stuckWarning: null }))
            .not.toContain('GROUND TRUTH');
    });

    test('rejected actions are reported back in the next turn prompt', () => {
        const prompt = brain.buildTurnPrompt({
            objective: null, historyLines: [], turn: 2, stuckWarning: null,
            rejectedActions: ['MOVE_RIGHT (Unknown button "MOVE_RIGHT". ...)']
        });
        expect(prompt).toContain('INVALID and ignored: MOVE_RIGHT');
        expect(prompt).toContain('Valid actions are only:');
    });

    test('a stale notice leads the next turn prompt', () => {
        const prompt = brain.buildTurnPrompt({
            objective: 'x', historyLines: [], turn: 3, stuckWarning: null,
            staleNotice: 'Your buttons were NOT pressed. Decide again.'
        });
        expect(prompt).toContain('IMPORTANT: Your buttons were NOT pressed. Decide again.');
        expect(brain.buildTurnPrompt({ objective: 'x', historyLines: [], turn: 3, stuckWarning: null }))
            .not.toContain('NOT pressed');
    });

    test('history entries can carry a note', () => {
        const history = new brain.TurnHistory();
        history.record({ turn: 4, actions: [{ kind: 'press', mask: 1, label: 'A' }], observe: 'door', note: 'buttons NOT pressed' });
        expect(history.render()[0]).toBe('turn 4: pressed [A] - door [buttons NOT pressed]');
    });

    test('the system prompt teaches dialog mashing and its own latency', () => {
        const prompt = brain.buildSystemPrompt({ goal: 'win' });
        expect(prompt).toContain('How dialog works');
        expect(prompt).toContain('the arrow is NOT always shown');
        expect(prompt).toContain('TIMING: your buttons land a few SECONDS after the screenshot');
    });

    test('markLastNoEffect annotates the previous turn exactly once', () => {
        const history = new brain.TurnHistory();
        history.record({ turn: 1, actions: [{ kind: 'press', mask: 1, label: 'A' }], observe: 'menu' });
        history.markLastNoEffect();
        history.markLastNoEffect();
        expect(history.render()[0]).toBe('turn 1: pressed [A] - menu [the screen did NOT change after this]');
        history.markLastNoEffect(); // and never on an empty history
        expect(new brain.TurnHistory().render()).toEqual([]);
    });

    test('history renders capped rolling summaries into the prompt', () => {
        const history = new brain.TurnHistory(2);
        history.record({ turn: 1, actions: [{ kind: 'press', mask: 1, label: 'A' }], observe: 'menu' });
        history.record({ turn: 2, actions: [{ kind: 'wait' }], observe: null });
        history.record({ turn: 3, actions: [{ kind: 'press', mask: 16, label: 'RIGHT' }], observe: 'walking' });
        const lines = history.render();
        expect(lines).toHaveLength(2);
        expect(lines[1]).toBe('turn 3: pressed [RIGHT] - walking');

        const prompt = brain.buildTurnPrompt({ objective: 'go east', historyLines: lines, turn: 4, stuckWarning: 'stuck!' });
        expect(prompt).toContain('Current objective: go east');
        expect(prompt).toContain('turn 3: pressed [RIGHT]');
        expect(prompt).toContain('IMPORTANT: stuck!');
    });
});

describe('StuckDetector', () => {
    test('idle animation noise does not mask stuckness; real change resets', () => {
        const detector = new StuckDetector();
        const base = makeFrame(240, 160);
        expect(detector.record(base).level).toBe(0);

        // "Idle animation": a single sweeping 4px marker (1 changed cell).
        for (let i = 1; i < thresholds.WARN_AFTER; i++) {
            const frame = makeFrame(240, 160, (x, y) => (y < 8 && x >= i * 16 && x < i * 16 + 4) ? [255, 255, 255] : [0, 0, 128]);
            detector.record(frame);
        }
        const warned = detector.record(makeFrame(240, 160));
        expect(warned.level).toBe(1);
        expect(warned.warning).toMatch(/same/i);

        // A real scene change (half the screen) resets the counter.
        const changed = detector.record(makeFrame(240, 160, (x) => x > 120 ? [255, 0, 0] : [0, 0, 128]));
        expect(changed.level).toBe(0);
        expect(changed.sameFrames).toBe(0);
    });

    test('escalates to a checkpoint reset and starts over', () => {
        const detector = new StuckDetector();
        const frame = () => makeFrame(240, 160);
        let result = detector.record(frame());
        for (let i = 0; i < thresholds.RESET_AFTER; i++) {
            result = detector.record(frame());
        }
        expect(result.level).toBe(3);
        expect(result.shouldReset).toBe(true);
        // Counter restarted after the reset signal.
        expect(detector.record(frame()).level).toBe(0);
    });
});

describe('visionModel', () => {
    let server;
    let port;
    let lastRequest;
    let respondWith;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                lastRequest = { url: req.url, body: JSON.parse(body) };
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify(respondWith));
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    afterAll(() => new Promise(resolve => server.close(resolve)));

    test('ollama provider sends the image and returns message content', async () => {
        respondWith = { message: { content: '{"actions":["A"]}' } };
        const model = createModel({ provider: 'ollama', host: `http://127.0.0.1:${port}`, model: 'test-vl' });
        expect(model.name).toBe('ollama/test-vl');

        const text = await model.decide({ system: 'sys', prompt: 'turn 1', imageBase64: 'aW1n' });
        expect(text).toBe('{"actions":["A"]}');
        expect(lastRequest.url).toBe('/api/chat');
        expect(lastRequest.body.model).toBe('test-vl');
        expect(lastRequest.body.messages[0]).toEqual({ role: 'system', content: 'sys' });
        expect(lastRequest.body.messages[1].images).toEqual(['aW1n']);
    });

    test('openai provider sends reasoning effort and reads output_text', async () => {
        respondWith = { output_text: '{"actions":["A"]}' };
        const model = createOpenAiModel({
            apiKey: 'test-key', model: 'gpt-test', reasoningEffort: 'medium',
            baseUrl: `http://127.0.0.1:${port}`
        });
        expect(model.name).toBe('openai/gpt-test');

        const text = await model.decide({ system: 'sys', prompt: 'turn 1', imageBase64: 'aW1n' });
        expect(text).toBe('{"actions":["A"]}');
        expect(lastRequest.url).toBe('/responses');
        expect(lastRequest.body.model).toBe('gpt-test');
        expect(lastRequest.body.instructions).toBe('sys');
        expect(lastRequest.body.reasoning).toEqual({ effort: 'medium' });
        expect(lastRequest.body.input[0].content[1].image_url).toContain('base64,aW1n');

        // No effort requested -> the knob is not sent at all.
        const plain = createOpenAiModel({ apiKey: 'test-key', baseUrl: `http://127.0.0.1:${port}` });
        await plain.decide({ system: 's', prompt: 'p', imageBase64: 'i' });
        expect(lastRequest.body.reasoning).toBeUndefined();

        expect(() => createOpenAiModel({ apiKey: 'k', reasoningEffort: 'ultra' }))
            .toThrow(/reasoning effort/);
    });

    test('empty responses and unknown providers are errors', async () => {
        respondWith = { message: { content: '' } };
        const model = createModel({ provider: 'ollama', host: `http://127.0.0.1:${port}` });
        await expect(model.decide({ system: 's', prompt: 'p', imageBase64: 'i' }))
            .rejects.toThrow(VisionModelError);

        expect(() => createModel({ provider: 'skynet' })).toThrow(/Unknown provider/);
        expect(() => createModel({ provider: 'openai', apiKey: null })).toThrow(/OPENAI_API_KEY/);
    });
});

describe('GameAgent loop', () => {
    function makeFakeBridge() {
        // A tiny simulated game: a marker moves right when RIGHT is held.
        const state = { x: 0, frame: 0, saved: null, loads: 0, saves: 0, presses: [] };
        return {
            state,
            request: jest.fn(async (verb, params) => {
                state.frame += 10;
                if (verb === 'status') return { title: 'FAKEGAME', code: 'FAKE', platform: '0', frame: String(state.frame) };
                if (verb === 'screenshot') {
                    const frame = makeFrame(240, 160, (x) => (x >= state.x && x < state.x + 40) ? [255, 255, 255] : [0, 0, 128]);
                    fs.writeFileSync(params.path, encodePng(frame));
                    return {};
                }
                if (verb === 'press') {
                    state.presses.push(params.seq);
                    const mask = Number(params.seq.split(':')[0]);
                    if (mask & (1 << 4)) state.x = Math.min(200, state.x + 40); // RIGHT moves the marker
                    return {};
                }
                if (verb === 'wait') return {};
                if (verb === 'savestate') { state.saves++; state.saved = state.x; return { slot: params.slot }; }
                if (verb === 'loadstate') { state.loads++; state.x = state.saved ?? 0; return { slot: params.slot }; }
                throw new Error(`unexpected verb ${verb}`);
            })
        };
    }

    function makeFakeBroadcast() {
        return {
            posts: [],
            milestones: [],
            runStatuses: [],
            sendStatus: jest.fn(),
            async post(payload) { this.posts.push(payload); return { posted: true }; },
            async sendMilestone(payload) { this.milestones.push(payload); return { posted: true }; },
            sendRunStatus(payload) { this.runStatuses.push(payload); },
            close() {}
        };
    }

    test('plays scripted decisions end-to-end: presses, objectives, milestones, checkpoints', async () => {
        const bridge = makeFakeBridge();
        const broadcast = makeFakeBroadcast();
        const decisions = [
            '{"observe":"marker left","objective":"push right","actions":["RIGHT","RIGHT"],"say":"heading east"}',
            '{"observe":"closer","actions":["RIGHT"],"milestone":true,"say":"halfway!"}',
            '{"observe":"done","actions":["WAIT"]}'
        ];
        let call = 0;
        const model = { name: 'fake/scripted', decide: async () => decisions[Math.min(call++, decisions.length - 1)] };

        const agent = new GameAgent({
            bridge, model, broadcast,
            options: { maxTurns: 3, turnDelayMs: 0, checkpointEvery: 2, postEvery: 100, goal: 'reach the right edge' }
        });
        const stats = await agent.run();

        expect(stats.turns).toBe(3);
        expect(stats.presses).toBe(3);
        expect(stats.waits).toBe(1);
        expect(stats.modelFailures).toBe(0);
        expect(bridge.state.x).toBe(120); // 3 RIGHT presses * 40px
        expect(stats.checkpoints).toBe(1); // turn 2 (plus the opening checkpoint outside stats)
        expect(broadcast.sendStatus).toHaveBeenCalledWith({ title: 'FAKEGAME', code: 'FAKE' });

        // Posts: opening + final summary; the milestone went down its own path.
        expect(broadcast.posts).toHaveLength(2);
        expect(broadcast.posts[0].text).toContain('taking the controls of **FAKEGAME**');
        expect(broadcast.posts[1].text).toContain('Session over: 3 turns');
        expect(stats.milestones).toBe(1);
        expect(broadcast.milestones).toHaveLength(1);
        expect(broadcast.milestones[0]).toMatchObject({ text: 'halfway!', turn: 2 });
        expect(broadcast.milestones[0].image).toEqual(expect.any(String));

        // Live status embed feed: one per turn plus the final 'ended' frame.
        expect(broadcast.runStatuses).toHaveLength(4);
        expect(broadcast.runStatuses[0]).toMatchObject({ turn: 1, phase: 'playing' });
        expect(broadcast.runStatuses.at(-1)).toMatchObject({ phase: 'ended', turn: 3 });
        expect(broadcast.runStatuses.at(-1).stats).toMatchObject({ milestones: 1 });
    });

    test('audience advice is drained into the prompt and credited to its author', async () => {
        const bridge = makeFakeBridge();
        const broadcast = makeFakeBroadcast();
        const prompts = [];
        const model = {
            name: 'fake/advice-listener',
            decide: async ({ prompt }) => {
                prompts.push(prompt);
                return '{"observe":"ok","actions":["RIGHT"]}';
            }
        };

        const agent = new GameAgent({
            bridge, model, broadcast,
            options: { maxTurns: 2, turnDelayMs: 0, postEvery: 100, checkpointEvery: 100, goal: 'anything' }
        });
        agent.addAdvice({ author: 'Dave', text: 'buy Repels before Mt. Moon' });
        agent.addAdvice({ author: 'Sam', text: '  press START to heal  ' });
        agent.addAdvice({ author: '', text: '' }); // ignored

        const stats = await agent.run();
        expect(stats.adviceSeen).toBe(2);
        expect(prompts[0]).toContain('Advice from the audience:');
        expect(prompts[0]).toContain('- Dave: buy Repels before Mt. Moon');
        expect(prompts[0]).toContain('- Sam: press START to heal');
        // Drained: turn 2 has no advice block.
        expect(prompts[1]).not.toContain('Advice from the audience');
    });

    test('ineffective and illegal actions are fed back into the next prompt', async () => {
        const bridge = makeFakeBridge();
        const prompts = [];
        let call = 0;
        // Turn 1 presses A (moves nothing) plus an illegal action; turn 2+ waits.
        const decisions = [
            '{"observe":"trying","actions":["A","MASH_HARDER"]}',
            '{"observe":"hm","actions":["WAIT"]}',
            '{"observe":"hm","actions":["WAIT"]}'
        ];
        const model = {
            name: 'fake/feedback',
            decide: async ({ prompt }) => {
                prompts.push(prompt);
                return decisions[Math.min(call++, decisions.length - 1)];
            }
        };
        const agent = new GameAgent({
            bridge, model, broadcast: makeFakeBroadcast(),
            options: { maxTurns: 3, turnDelayMs: 0, postEvery: 100, checkpointEvery: 100, goal: 'anything' }
        });
        await agent.run();

        // Turn 2 prompt: the illegal action from turn 1 is called out...
        expect(prompts[1]).toContain('INVALID and ignored: MASH_HARDER');
        // ...and turn 3 sees that turn 2 (and turn 1) changed nothing on screen.
        expect(prompts[2]).toContain('[the screen did NOT change after this]');
        // The rejection note is one-shot, not repeated forever.
        expect(prompts[2]).not.toContain('MASH_HARDER');
    });

    test('an advice flood keeps only the most recent entries', () => {
        const agent = new GameAgent({
            bridge: makeFakeBridge(), model: { name: 'x', decide: async () => '' },
            options: { goal: 'x' }
        });
        for (let i = 1; i <= 9; i++) agent.addAdvice({ author: `user${i}`, text: `advice ${i}` });
        expect(agent._adviceQueue).toHaveLength(5);
        expect(agent._adviceQueue[0].text).toBe('advice 5');
        expect(agent._adviceQueue.at(-1).text).toBe('advice 9');
        expect(agent.stats.adviceSeen).toBe(9);
    });

    test('model failures degrade to watching and eventually stop the run', async () => {
        const bridge = makeFakeBridge();
        const broadcast = makeFakeBroadcast();
        const model = { name: 'fake/broken', decide: async () => { throw new Error('brain offline'); } };

        const agent = new GameAgent({
            bridge, model, broadcast,
            options: { maxTurns: 50, turnDelayMs: 0, maxModelFailures: 3, goal: 'anything' }
        });
        const stats = await agent.run();

        expect(stats.turns).toBe(3);          // stopped at the failure cap
        expect(stats.modelFailures).toBe(3);
        expect(stats.waits).toBe(2);          // failures 1-2 watched; failure 3 stopped
        expect(stats.presses).toBe(0);
        expect(broadcast.posts.some(p => p.text.includes('brain stopped answering'))).toBe(true);
    });

    test('a stuck run reloads the watchdog checkpoint', async () => {
        const bridge = makeFakeBridge();
        const broadcast = makeFakeBroadcast();
        // The model insists on pressing A (which moves nothing) forever.
        const model = { name: 'fake/stubborn', decide: async () => '{"observe":"hm","actions":["A"]}' };

        const agent = new GameAgent({
            bridge, model, broadcast,
            options: { maxTurns: 14, turnDelayMs: 0, checkpointEvery: 100, postEvery: 100, goal: 'anything' }
        });
        const stats = await agent.run();

        expect(stats.stuckResets).toBeGreaterThanOrEqual(1);
        expect(bridge.state.loads).toBeGreaterThanOrEqual(1);
        expect(broadcast.posts.some(p => p.text.includes('rewound to my last checkpoint'))).toBe(true);
    });
});

const SB1_BASE = 0x02025234;
const hexU16 = v => [v & 0xff, (v >>> 8) & 0xff].map(b => b.toString(16).padStart(2, '0')).join('');
const hexU32 = v => hexU16(v & 0xffff) + hexU16(v >>> 16);

/**
 * A FireRed-shaped fake: the player walks on a tile grid (UP is
 * blocked by a wall), and the `read` verb serves the save-block
 * pointer, position/map bytes, and the gMain battle byte.
 */
function makeFireRedBridge() {
    const player = { x: 5, y: 5, battleByte: 0 };
    return {
        player,
        request: jest.fn(async (verb, params) => {
            if (verb === 'status') return { title: 'POKEMON FIRE', code: 'AGB-BPRE', platform: '0', frame: '1' };
            if (verb === 'screenshot') {
                const frame = makeFrame(240, 160, (x) => (x >= player.x * 8 && x < player.x * 8 + 16) ? [255, 255, 255] : [0, 96, 0]);
                fs.writeFileSync(params.path, encodePng(frame));
                return {};
            }
            if (verb === 'press') {
                const mask = Number(params.seq.split(':')[0]);
                if (mask & (1 << 4)) player.x += 1;        // RIGHT
                if (mask & (1 << 5)) player.x -= 1;        // LEFT
                if (mask & (1 << 7)) player.y += 1;        // DOWN
                // UP (bit 6): wall - no movement.
                return {};
            }
            if (verb === 'read') {
                const { addr, len } = params;
                if (addr === 0x03005008 && len === 4) return { hex: hexU32(SB1_BASE) };
                if (addr === SB1_BASE && len === 6) return { hex: hexU16(player.x) + hexU16(player.y) + '0301' };
                if (addr === 0x030030F0 + 0x439 && len === 1) return { hex: player.battleByte.toString(16).padStart(2, '0') };
                throw new Error(`unexpected read 0x${addr.toString(16)}+${len}`);
            }
            if (verb === 'wait' || verb === 'savestate' || verb === 'loadstate') return {};
            throw new Error(`unexpected verb ${verb}`);
        })
    };
}

describe('GameAgent memory assist', () => {
    test('ground truth narrates movement, walls, and battle starts into the prompts', async () => {
        const bridge = makeFireRedBridge();
        const prompts = [];
        let call = 0;
        const decisions = [
            '{"observe":"outside","objective":"go east","actions":["RIGHT"]}',
            '{"observe":"trying north","actions":["UP"]}',       // blocked by the wall
            '{"observe":"grass rustles","actions":["A"]}',       // a battle starts after this
            '{"observe":"battle!","actions":["WAIT"]}'
        ];
        const model = {
            name: 'fake/grounded',
            decide: async ({ prompt }) => {
                prompts.push(prompt);
                const decision = decisions[Math.min(call++, decisions.length - 1)];
                if (call === 3) bridge.player.battleByte = 0x02; // wild encounter
                return decision;
            }
        };

        const agent = new GameAgent({
            bridge, model, broadcast: null,
            options: { maxTurns: 4, turnDelayMs: 0, postEvery: 100, checkpointEvery: 100, goal: 'explore', memoryAssist: true }
        });
        const stats = await agent.run();
        expect(stats.turns).toBe(4);

        // Turn 1: position + exploration, nothing to compare yet.
        expect(prompts[0]).toContain('GROUND TRUTH');
        expect(prompts[0]).toContain('You are standing on tile (5, 5) of map 3.1.');
        expect(prompts[0]).toContain('NEVER stood on: UP, DOWN, LEFT, RIGHT');
        expect(prompts[0]).not.toContain('Since last turn');

        // Turn 2: the RIGHT press actually moved the player.
        expect(prompts[1]).toContain('You are standing on tile (6, 5) of map 3.1.');
        expect(prompts[1]).toContain('Since last turn, you moved 1 tile RIGHT.');

        // Turn 3: UP hit a wall - deterministic no-movement callout.
        expect(prompts[2]).toContain('your position did NOT change');
        expect(prompts[2]).toContain('moved you NOWHERE');

        // Turn 4: the battle flag flipped between reads.
        expect(prompts[3]).toContain('A battle STARTED since last turn');
        // In battle, no exploration hints - the D-pad is a cursor now.
        expect(prompts[3]).not.toContain('NEVER stood on');
    });

    test('ping-ponging between two tiles is called out in the ground truth', async () => {
        const bridge = makeFireRedBridge();
        const prompts = [];
        let call = 0;
        const decisions = [
            '{"observe":"east","actions":["RIGHT"]}',
            '{"observe":"hmm west","actions":["LEFT"]}',
            '{"observe":"east again","actions":["RIGHT"]}',
            '{"observe":"lost","actions":["WAIT"]}'
        ];
        const model = {
            name: 'fake/wanderer',
            decide: async ({ prompt }) => { prompts.push(prompt); return decisions[Math.min(call++, decisions.length - 1)]; }
        };
        const agent = new GameAgent({
            bridge, model, broadcast: null,
            options: { maxTurns: 4, turnDelayMs: 0, postEvery: 100, checkpointEvery: 100, goal: 'explore', memoryAssist: true }
        });
        await agent.run();

        // Positions at reads: (5,5) (6,5) (5,5) (6,5) - an A-B-A-B pattern.
        expect(prompts[3]).toContain('You are PING-PONGING between (5, 5) and (6, 5)');
        expect(prompts[2]).not.toContain('PING-PONGING'); // not yet provable at 3 reads
    });

    test('same-tile streaks surface after repeated ground-truth reads', () => {
        const agent = new GameAgent({
            bridge: makeFireRedBridge(), model: { name: 'x', decide: async () => '' },
            options: { goal: 'x', memoryAssist: true }
        });
        const at = { x: 2, y: 3, mapGroup: 0, mapNum: 0, mapId: '0.0', inBattle: false };
        let lines = [];
        for (let i = 0; i < 5; i++) lines = agent._groundTruth({ ...at });
        expect(lines.join('\n')).toContain('this exact tile for 5 turns in a row');
    });

    test('an unsupported game plays vision-only even with memory assist on', async () => {
        // The generic fake bridge reports code FAKE and has no read verb.
        const state = { x: 0, frame: 0 };
        const bridge = {
            request: jest.fn(async (verb, params) => {
                if (verb === 'status') return { title: 'FAKEGAME', code: 'FAKE', platform: '0', frame: '1' };
                if (verb === 'screenshot') {
                    fs.writeFileSync(params.path, encodePng(makeFrame(240, 160, x => (x < 40 + 40 * state.x) ? [255, 255, 255] : [0, 0, 128])));
                    return {};
                }
                if (verb === 'press') { state.x++; return {}; }
                if (verb === 'wait' || verb === 'savestate' || verb === 'loadstate') return {};
                throw new Error(`unexpected verb ${verb}`);
            })
        };
        const prompts = [];
        const model = {
            name: 'fake/x',
            decide: async ({ prompt }) => { prompts.push(prompt); return '{"observe":"ok","actions":["RIGHT"]}'; }
        };
        const agent = new GameAgent({
            bridge, model, broadcast: null,
            options: { maxTurns: 2, turnDelayMs: 0, postEvery: 100, checkpointEvery: 100, goal: 'x', memoryAssist: true }
        });
        await agent.run();

        expect(prompts.join('\n')).not.toContain('GROUND TRUTH');
        expect(bridge.request.mock.calls.every(([verb]) => verb !== 'read')).toBe(true);
    });
});

describe('GameAgent fresh-frame guard', () => {
    /** Every screenshot is a completely different full-screen color, so
     *  the frame the model saw never matches the pre-press recapture. */
    function makeVolatileBridge() {
        let shot = 0;
        return {
            request: jest.fn(async (verb, params) => {
                if (verb === 'status') return { title: 'FAKEGAME', code: 'FAKE', platform: '0', frame: '1' };
                if (verb === 'screenshot') {
                    const color = (shot++ % 2 === 0) ? [255, 0, 0] : [0, 0, 255];
                    fs.writeFileSync(params.path, encodePng(makeFrame(240, 160, () => color)));
                    return {};
                }
                if (verb === 'press' || verb === 'wait' || verb === 'savestate' || verb === 'loadstate') return {};
                throw new Error(`unexpected verb ${verb}`);
            })
        };
    }

    test('presses aimed at a vanished screen are held and the model is told', async () => {
        const bridge = makeVolatileBridge();
        const prompts = [];
        const model = {
            name: 'fake/stale',
            decide: async ({ prompt }) => { prompts.push(prompt); return '{"observe":"pressing on","actions":["A","A"]}'; }
        };
        const agent = new GameAgent({
            bridge, model, broadcast: null,
            options: { maxTurns: 2, turnDelayMs: 0, postEvery: 100, checkpointEvery: 100, goal: 'x' }
        });
        const stats = await agent.run();

        expect(stats.presses).toBe(0);          // every press was held
        expect(stats.staleSkips).toBe(2);
        expect(bridge.request.mock.calls.every(([verb]) => verb !== 'press')).toBe(true);
        expect(prompts[1]).toContain('IMPORTANT: The screen changed completely while you were deciding');
        expect(prompts[1]).toContain('[buttons NOT pressed - the screen had already changed completely]');
    });

    test('a WAIT is skipped when the screen already moved on while deciding', async () => {
        const bridge = makeVolatileBridge();
        const prompts = [];
        const model = {
            name: 'fake/waiter',
            decide: async ({ prompt }) => { prompts.push(prompt); return '{"observe":"text is printing","actions":["WAIT"]}'; }
        };
        const agent = new GameAgent({
            bridge, model, broadcast: null,
            options: { maxTurns: 2, turnDelayMs: 0, postEvery: 100, checkpointEvery: 100, goal: 'x' }
        });
        const stats = await agent.run();

        expect(stats.waits).toBe(0);            // no real time wasted
        expect(stats.waitSkips).toBe(2);
        expect(prompts[1]).toContain('[the wait was skipped - the screen had already moved on]');
        // Skipping a wait is not an error - no scary notice, just history.
        expect(prompts[1]).not.toContain('IMPORTANT: The screen changed completely');
    });

    test('a stable screen executes actions exactly as decided', async () => {
        // The generic fake bridge repaints the same frame within a turn.
        const state = { x: 0 };
        const bridge = {
            request: jest.fn(async (verb, params) => {
                if (verb === 'status') return { title: 'FAKEGAME', code: 'FAKE', platform: '0', frame: '1' };
                if (verb === 'screenshot') {
                    fs.writeFileSync(params.path, encodePng(makeFrame(240, 160, x => (x < 40 + 40 * state.x) ? [255, 255, 255] : [0, 0, 128])));
                    return {};
                }
                if (verb === 'press') { state.x++; return {}; }
                if (verb === 'wait' || verb === 'savestate' || verb === 'loadstate') return {};
                throw new Error(`unexpected verb ${verb}`);
            })
        };
        const model = { name: 'fake/steady', decide: async () => '{"observe":"ok","actions":["RIGHT"]}' };
        const agent = new GameAgent({
            bridge, model, broadcast: null,
            options: { maxTurns: 3, turnDelayMs: 0, postEvery: 100, checkpointEvery: 100, goal: 'x' }
        });
        const stats = await agent.run();

        expect(stats.presses).toBe(3);
        expect(stats.staleSkips).toBe(0);
        expect(stats.waitSkips).toBe(0);
    });
});

describe('GameAgent learning', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gba-learn-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    const bookAt = file => new ExperienceBook({ file: path.join(dir, file) });

    test('a learned lesson reshapes the system prompt on the very next turn', async () => {
        const bridge = makeFireRedBridge();
        const systems = [];
        let call = 0;
        const decisions = [
            '{"observe":"sign read","actions":["A"],"learn":"The gym in Viridian is locked at first"}',
            '{"observe":"ok","actions":["WAIT"],"learn":"the gym in viridian is locked at first"}', // repeat: reinforced, not duplicated
            '{"observe":"ok","actions":["WAIT"]}'
        ];
        const model = {
            name: 'fake/student',
            decide: async ({ system }) => { systems.push(system); return decisions[Math.min(call++, decisions.length - 1)]; }
        };

        const experience = bookAt('exp.json');
        const agent = new GameAgent({
            bridge, model, broadcast: null, experience,
            options: { maxTurns: 3, turnDelayMs: 0, postEvery: 100, checkpointEvery: 100, goal: 'explore' }
        });
        const stats = await agent.run();

        expect(stats.lessons).toBe(1);
        expect(systems[0]).toContain('"learn" field');
        expect(systems[0]).not.toContain('LESSONS FROM YOUR PAST SESSIONS');
        expect(systems[1]).toContain('LESSONS FROM YOUR PAST SESSIONS');
        expect(systems[1]).toContain('- The gym in Viridian is locked at first');
        // The reinforcement did not create a second copy.
        expect(systems[2].match(/gym in Viridian is locked/gi)).toHaveLength(1);
    });

    test('lessons, milestones, and wall bumps persist into the next session', async () => {
        const file = 'exp.json';

        // Session one: learn a lesson, hit a milestone, bump the same
        // wall twice, and walk one tile east.
        const firstBridge = makeFireRedBridge();
        let call = 0;
        const decisions = [
            '{"observe":"wall ahead","actions":["UP"],"learn":"The mart clerk gives you a parcel for Oak"}',
            '{"observe":"still a wall","actions":["UP"]}',
            '{"observe":"badge!","actions":["RIGHT"],"milestone":true,"say":"Earned the Boulder Badge!"}',
            '{"observe":"resting","actions":["WAIT"]}'
        ];
        const firstModel = { name: 'fake/one', decide: async () => decisions[Math.min(call++, decisions.length - 1)] };
        const first = new GameAgent({
            bridge: firstBridge, model: firstModel, broadcast: null, experience: bookAt(file),
            options: { maxTurns: 4, turnDelayMs: 0, postEvery: 100, checkpointEvery: 100, goal: 'explore', memoryAssist: true }
        });
        await first.run();

        // Session two: a fresh process (new book, same file) knows it all.
        const secondBridge = makeFireRedBridge();
        const systems = [];
        const prompts = [];
        const secondModel = {
            name: 'fake/two',
            decide: async ({ system, prompt }) => { systems.push(system); prompts.push(prompt); return '{"observe":"ok","actions":["WAIT"]}'; }
        };
        const second = new GameAgent({
            bridge: secondBridge, model: secondModel, broadcast: null, experience: bookAt(file),
            options: { maxTurns: 1, turnDelayMs: 0, postEvery: 100, checkpointEvery: 100, goal: 'explore', memoryAssist: true }
        });
        await second.run();

        expect(systems[0]).toContain('- The mart clerk gives you a parcel for Oak');
        expect(systems[0]).toContain('PROGRESS ALREADY MADE');
        expect(systems[0]).toContain('- Earned the Boulder Badge!');
        // The wall bumped twice at (5,5) last session is now known ground truth.
        expect(prompts[0]).toContain('already KNOW these directions are blocked (you bumped into them before): UP.');
        // Explored tiles carried over: (6,5) was walked last session, so
        // RIGHT is not in the never-visited list this session.
        expect(prompts[0]).toContain('NEVER stood on: UP, DOWN, LEFT.');
    });

    test('without an experience book nothing about learning reaches the prompts', async () => {
        const bridge = makeFireRedBridge();
        const systems = [];
        const model = {
            name: 'fake/na',
            decide: async ({ system }) => { systems.push(system); return '{"observe":"ok","actions":["WAIT"],"learn":"should be ignored"}'; }
        };
        const agent = new GameAgent({
            bridge, model, broadcast: null,
            options: { maxTurns: 2, turnDelayMs: 0, postEvery: 100, checkpointEvery: 100, goal: 'x' }
        });
        const stats = await agent.run();

        expect(stats.lessons).toBe(0);
        expect(systems.join('\n')).not.toContain('"learn" field');
        expect(systems.join('\n')).not.toContain('LESSONS FROM');
    });
});
