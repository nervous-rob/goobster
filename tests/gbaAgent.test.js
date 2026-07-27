/**
 * Phase 2 of Goobster Plays Pokémon — the autonomous player. Covers the
 * brain (JSON extraction + decision legalization + history), the stuck
 * detector (synthetic frames), the Ollama provider against a fake HTTP
 * server, and the full GameAgent loop with a scripted fake model and a
 * fake bridge writing real PNGs.
 */

const http = require('node:http');
const fs = require('node:fs');

const brain = require('../clients/gba-mcp/lib/agentBrain');
const { StuckDetector, thresholds } = require('../clients/gba-mcp/lib/stuckDetector');
const { createModel, VisionModelError } = require('../clients/gba-mcp/lib/visionModel');
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

    test('rejected actions are reported back in the next turn prompt', () => {
        const prompt = brain.buildTurnPrompt({
            objective: null, historyLines: [], turn: 2, stuckWarning: null,
            rejectedActions: ['MOVE_RIGHT (Unknown button "MOVE_RIGHT". ...)']
        });
        expect(prompt).toContain('INVALID and ignored: MOVE_RIGHT');
        expect(prompt).toContain('Valid actions are only:');
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
