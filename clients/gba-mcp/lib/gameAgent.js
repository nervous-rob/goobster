/**
 * The autonomous player loop — Phase 2 of "Goobster Plays Pokémon"
 * (documentation/goobster_plays_pokemon.md).
 *
 * Each turn: capture the screen → run stuck detection → ask the vision
 * model for a decision → legalize it (agentBrain) → execute the actions
 * through the mGBA bridge → occasionally checkpoint, and broadcast
 * screenshots + commentary to Discord through the Phase 1 pipe.
 *
 * Deterministic guardrails around a non-deterministic brain:
 *  - every action is legalized before it reaches the emulator
 *  - unusable model answers degrade to watching (never crash the run)
 *  - repeated identical screens escalate: prompt warning → stronger
 *    warning → checkpoint reload (StuckDetector)
 *  - periodic save-state checkpoints bound how much a disaster can lose
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { frameTimeout } = require('./mgbaClient');
const { decodePng, encodePng, upscaleNearest } = require('./png');
const brain = require('./agentBrain');
const { StuckDetector } = require('./stuckDetector');
const { GameStateReader, TileMemory, describeMovement } = require('./gameState');

// D-pad key bits (RIGHT=4, LEFT=5, UP=6, DOWN=7 in the GBA key mask).
const DPAD_MASK = 0xF0;

const DEFAULTS = {
    goal: 'Explore the game and make as much progress as you can.',
    hints: null,            // operator-supplied game notes appended to the system prompt
    maxTurns: 0,            // 0 = run until stopped
    turnDelayMs: 2000,
    holdFrames: 10,
    gapFrames: 5,
    waitFrames: 60,
    upscale: 3,
    checkpointEvery: 20,    // turns between watchdog save-states
    checkpointSlot: 9,
    postEvery: 12,          // heartbeat post cadence (turns)
    maxModelFailures: 5,    // consecutive failures before giving up
    memoryAssist: false     // operator opt-in RAM ground truth (--allow-memory)
};

class GameAgent {
    /**
     * @param {object} deps
     * @param {import('./mgbaClient').MgbaClient} deps.bridge
     * @param {{ name: string, decide: Function }} deps.model
     * @param {{ post: Function, sendStatus: Function }|null} [deps.broadcast]
     * @param {(msg: string) => void} [deps.log]
     * @param {object} [deps.options] overrides for DEFAULTS
     */
    constructor({ bridge, model, broadcast = null, log = () => {}, options = {} }) {
        this.bridge = bridge;
        this.model = model;
        this.broadcast = broadcast;
        this.log = log;
        this.options = { ...DEFAULTS, ...options };
        this.stuck = new StuckDetector();
        this.history = new brain.TurnHistory();
        this.stopped = false;
        this.stats = { turns: 0, presses: 0, waits: 0, postsDelivered: 0, modelFailures: 0, stuckResets: 0, checkpoints: 0, milestones: 0, adviceSeen: 0 };
        this._screenshotSeq = 0;
        this._hasCheckpoint = false;
        this._objective = null;
        this._consecutiveFailures = 0;
        this._adviceQueue = [];
        this._rejectedActions = [];
        this._stateReader = null;       // RAM ground truth (memoryAssist only)
        this._tiles = new TileMemory();
        this._lastState = null;
        this._sameTileTurns = 0;
        this._lastActionsHadDpad = false;
        this._system = brain.buildSystemPrompt({
            goal: this.options.goal,
            hints: this.options.hints || null,
            memoryAssist: this.options.memoryAssist
        });
    }

    /** Ask the loop to stop after the current turn. */
    stop() {
        this.stopped = true;
    }

    /**
     * Queue audience advice (from the broadcast channel via Goobster).
     * Bounded: a flood keeps only the most recent entries.
     * @param {{ author: string, text: string }} advice
     */
    addAdvice({ author, text }) {
        if (typeof text !== 'string' || !text.trim()) return;
        this._adviceQueue.push({
            author: String(author || 'someone').slice(0, 64),
            text: text.trim().slice(0, 300)
        });
        if (this._adviceQueue.length > 5) this._adviceQueue.shift();
        this.stats.adviceSeen++;
        this.log(`advice from ${author}: ${text.trim().slice(0, 120)}`);
    }

    /** Capture the current frame; returns decoded pixels + upscaled base64. */
    async _captureScreen() {
        const file = path.join(os.tmpdir(), `goobster-agent-${process.pid}-${++this._screenshotSeq}.png`);
        try {
            await this.bridge.request('screenshot', { path: file });
            const png = await fs.promises.readFile(file);
            const decoded = decodePng(png);
            const upscaled = encodePng(upscaleNearest(decoded, this.options.upscale));
            return { decoded, base64: upscaled.toString('base64') };
        } finally {
            fs.promises.unlink(file).catch(() => {});
        }
    }

    async _post(text, imageBase64) {
        if (!this.broadcast) return;
        const ack = await this.broadcast.post({
            text,
            image: imageBase64,
            filename: `agent-turn-${this.stats.turns}.png`
        });
        if (ack.posted) this.stats.postsDelivered++;
        else this.log(`post failed: ${ack.error}`);
    }

    async _executeActions(actions) {
        for (const action of actions) {
            if (action.kind === 'wait') {
                await this.bridge.request('wait', { frames: this.options.waitFrames },
                    { timeoutMs: frameTimeout(this.options.waitFrames) });
                this.stats.waits++;
            } else {
                const seq = `${action.mask}:${this.options.holdFrames}:${this.options.gapFrames}`;
                await this.bridge.request('press', { seq },
                    { timeoutMs: frameTimeout(this.options.holdFrames + this.options.gapFrames) });
                this.stats.presses++;
            }
        }
    }

    /**
     * Turn a fresh RAM state read into deterministic prompt lines:
     * position, battle transitions, what the last actions actually did,
     * same-tile streaks, and explored-map hints. Updates the trackers.
     * @param {{ x: number, y: number, mapGroup: number, mapNum: number, mapId: string, inBattle: boolean }} state
     * @returns {string[]}
     */
    _groundTruth(state) {
        const lines = [];
        const prev = this._lastState;
        lines.push(`You are standing on tile (${state.x}, ${state.y}) of map ${state.mapId}.`);

        if (state.inBattle) {
            lines.push(prev && !prev.inBattle
                ? 'A battle STARTED since last turn - use the battle menu, the D-pad only moves the cursor now.'
                : 'You are IN A BATTLE - use the battle menu, the D-pad only moves the cursor.');
        } else if (prev?.inBattle) {
            lines.push('The battle ENDED - you are back in the overworld.');
        }

        const movement = describeMovement(prev, state);
        if (movement) {
            let line = `Since last turn, ${movement}.`;
            if (!state.inBattle && this._lastActionsHadDpad && prev && !prev.inBattle
                && prev.mapId === state.mapId && prev.x === state.x && prev.y === state.y) {
                line += ' Your direction presses moved you NOWHERE - a wall is blocking you, or a menu/dialog has the controls.';
            }
            lines.push(line);
        }

        if (prev && !state.inBattle && prev.mapId === state.mapId && prev.x === state.x && prev.y === state.y) {
            this._sameTileTurns++;
        } else {
            this._sameTileTurns = 0;
        }
        if (this._sameTileTurns >= 3) {
            lines.push(`You have now been on this exact tile for ${this._sameTileTurns + 1} turns in a row.`);
        }

        if (!state.inBattle) {
            this._tiles.record(state);
            const explored = this._tiles.describe(state);
            if (explored.unexploredDirections.length > 0) {
                lines.push(`You have stood on ${explored.tilesSeen} different tiles of this map. Adjacent tiles you have NEVER stood on: ${explored.unexploredDirections.join(', ')}.`);
            } else {
                lines.push(`You have stood on ${explored.tilesSeen} different tiles of this map, including every tile adjacent to this one - consider heading somewhere new.`);
            }
        }

        this._lastState = state;
        return lines;
    }

    /** One perceive-think-act turn. Returns false when the run should end. */
    async runTurn() {
        const turn = ++this.stats.turns;
        const { decoded, base64 } = await this._captureScreen();

        // Stuck handling first: a badly stuck run reloads the checkpoint
        // before the model sees the (restored) screen's prompt.
        const stuckState = this.stuck.record(decoded);
        // Deterministic no-effect feedback: this frame is compared against
        // the previous turn's, so an unchanged screen means the previous
        // turn's actions did nothing - annotate them in the history.
        if (stuckState.sameFrames > 0) {
            this.history.markLastNoEffect();
        }
        if (stuckState.shouldReset && this._hasCheckpoint) {
            await this.bridge.request('loadstate', { slot: this.options.checkpointSlot });
            this.stats.stuckResets++;
            this.stuck.reset();
            // The reload teleported the player; a movement comparison
            // against the pre-reload state would be nonsense.
            this._lastState = null;
            this._sameTileTurns = 0;
            this.log(`turn ${turn}: stuck for ${stuckState.sameFrames} turns - reloaded checkpoint slot ${this.options.checkpointSlot}`);
            await this._post(`🔄 I was thoroughly stuck, so I rewound to my last checkpoint. Attempt #${this.stats.stuckResets + 1}, here we go.`, base64);
        }

        // RAM ground truth (opt-in): a failed read simply plays this
        // turn vision-only.
        let stateLines = [];
        if (this._stateReader) {
            const state = await this._stateReader.read();
            if (state) stateLines = this._groundTruth(state);
        }

        // Drain up to 3 pieces of audience advice into this turn's prompt.
        const advice = this._adviceQueue.splice(0, 3);

        const prompt = brain.buildTurnPrompt({
            objective: this._objective,
            historyLines: this.history.render(),
            turn,
            stuckWarning: stuckState.shouldReset ? null : stuckState.warning,
            advice,
            rejectedActions: this._rejectedActions,
            stateLines
        });
        this._rejectedActions = [];

        let decision = null;
        try {
            const text = await this.model.decide({ system: this._system, prompt, imageBase64: base64 });
            decision = brain.parseDecision(text);
            if (!decision) this.log(`turn ${turn}: unusable model answer: ${String(text).slice(0, 200)}`);
        } catch (error) {
            this.log(`turn ${turn}: model error: ${error.message}`);
        }

        if (!decision) {
            this.stats.modelFailures++;
            this._consecutiveFailures++;
            if (this._consecutiveFailures >= this.options.maxModelFailures) {
                this.log(`${this._consecutiveFailures} consecutive model failures - stopping the run`);
                await this._post(`⚠️ My brain stopped answering (${this._consecutiveFailures} failures in a row), so I'm pausing the run here.`);
                return false;
            }
            // Watch instead of pressing garbage.
            await this._executeActions([{ kind: 'wait' }]);
            this._lastActionsHadDpad = false;
            return true;
        }
        this._consecutiveFailures = 0;

        if (decision.dropped.length > 0) {
            this.log(`turn ${turn}: dropped illegal actions: ${decision.dropped.join('; ')}`);
            // Fed back into the next prompt so the model can correct its
            // vocabulary instead of silently drifting to safe buttons.
            this._rejectedActions = decision.dropped.slice(0, 4);
        }
        if (decision.objective) this._objective = decision.objective;

        await this._executeActions(decision.actions);
        this._lastActionsHadDpad = decision.actions.some(a => a.kind === 'press' && (a.mask & DPAD_MASK) !== 0);
        this.history.record({ turn, actions: decision.actions, observe: decision.observe });

        const labels = decision.actions.map(a => a.kind === 'wait' ? brain.WAIT_ACTION : a.label).join(', ');
        this.log(`turn ${turn}: [${labels}] ${decision.observe || ''}${decision.objective ? ` | objective: ${decision.objective}` : ''}`);

        // Broadcast: milestones become highlighted embeds (recorded
        // server-side); otherwise a heartbeat post every postEvery turns.
        if (decision.milestone) {
            this.stats.milestones++;
            const fresh = await this._captureScreen().catch(() => null);
            if (this.broadcast) {
                const ack = await this.broadcast.sendMilestone({
                    text: decision.say || decision.observe || 'Something notable happened.',
                    image: fresh ? fresh.base64 : base64,
                    turn,
                    filename: `milestone-turn-${turn}.png`
                });
                if (ack.posted) this.stats.postsDelivered++;
                else this.log(`milestone post failed: ${ack.error}`);
            }
        } else if (turn % this.options.postEvery === 0) {
            const caption = [
                '🎮',
                decision.say || decision.observe || 'Still at it.',
                `\n-# turn ${turn}${this._objective ? ` · objective: ${this._objective}` : ''}`
            ].join(' ');
            const fresh = await this._captureScreen().catch(() => null);
            await this._post(caption, fresh ? fresh.base64 : base64);
        }

        // Live status embed feed (coalesced server-side).
        this.broadcast?.sendRunStatus({
            turn,
            objective: this._objective,
            phase: 'playing',
            stats: { presses: this.stats.presses, stuckResets: this.stats.stuckResets, milestones: this.stats.milestones },
            image: base64
        });

        // Watchdog checkpoint.
        if (turn % this.options.checkpointEvery === 0) {
            await this.bridge.request('savestate', { slot: this.options.checkpointSlot });
            this._hasCheckpoint = true;
            this.stats.checkpoints++;
            this.log(`turn ${turn}: checkpoint saved to slot ${this.options.checkpointSlot}`);
        }

        return true;
    }

    /** Run until maxTurns, a stop() call, or too many model failures. */
    async run() {
        const status = await this.bridge.request('status');
        this.log(`Playing ${status.title} (${status.code}) with ${this.model.name} - goal: ${this.options.goal}`);
        this.broadcast?.sendStatus({ title: status.title, code: status.code });

        if (this.options.memoryAssist) {
            const reader = new GameStateReader({ bridge: this.bridge, gameCode: status.code });
            if (reader.supported) {
                this._stateReader = reader;
                this.log(`RAM ground truth enabled for ${reader.game.name} (${reader.gameCode})`);
            } else {
                this.log(`RAM ground truth requested but game code "${status.code}" has no known RAM map - playing vision-only`);
            }
        }

        // An opening checkpoint so a stuck reset always has somewhere to go.
        await this.bridge.request('savestate', { slot: this.options.checkpointSlot });
        this._hasCheckpoint = true;

        const opening = await this._captureScreen();
        await this._post(`🕹️ I'm taking the controls of **${status.title}** — goal: ${this.options.goal}`, opening.base64);

        while (!this.stopped && (this.options.maxTurns === 0 || this.stats.turns < this.options.maxTurns)) {
            const keepGoing = await this.runTurn();
            if (!keepGoing) break;
            if (this.options.turnDelayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, this.options.turnDelayMs));
            }
        }

        const final = await this._captureScreen().catch(() => null);
        await this._post(
            `🏁 Session over: ${this.stats.turns} turns, ${this.stats.presses} button presses, ` +
            `${this.stats.milestones} milestones, ${this.stats.stuckResets} checkpoint rewinds.` +
            `${this._objective ? ` Last objective: ${this._objective}` : ''}`,
            final ? final.base64 : undefined
        );
        this.broadcast?.sendRunStatus({
            turn: this.stats.turns,
            objective: this._objective,
            phase: 'ended',
            stats: { presses: this.stats.presses, stuckResets: this.stats.stuckResets, milestones: this.stats.milestones },
            image: final ? final.base64 : undefined
        });
        return this.stats;
    }
}

module.exports = { GameAgent, DEFAULTS };
