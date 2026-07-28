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
const { StuckDetector, frameSignature, changedCells, GRID_CELLS, thresholds } = require('./stuckDetector');
const { GameStateReader, TileMemory, describeMovement } = require('./gameState');

// D-pad key bits (RIGHT=4, LEFT=5, UP=6, DOWN=7 in the GBA key mask).
const DIRECTION_BITS = Object.freeze({ RIGHT: 1 << 4, LEFT: 1 << 5, UP: 1 << 6, DOWN: 1 << 7 });

// Fresh-frame guard: the game keeps running while the model thinks, so
// right before pressing anything the screen is recaptured and compared
// with the frame the model actually saw. Half the grid changing means
// the scene the buttons were aimed at no longer exists.
const STALE_DRASTIC_CELLS = Math.floor(GRID_CELLS / 2);

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
     * @param {import('./experience').ExperienceBook|null} [deps.experience] cross-session learning
     * @param {(msg: string) => void} [deps.log]
     * @param {object} [deps.options] overrides for DEFAULTS
     */
    constructor({ bridge, model, broadcast = null, experience = null, log = () => {}, options = {} }) {
        this.bridge = bridge;
        this.model = model;
        this.broadcast = broadcast;
        this.experience = experience;
        this.log = log;
        this.options = { ...DEFAULTS, ...options };
        this.stuck = new StuckDetector();
        this.history = new brain.TurnHistory();
        this.stopped = false;
        this.stats = { turns: 0, presses: 0, waits: 0, postsDelivered: 0, modelFailures: 0, stuckResets: 0, checkpoints: 0, milestones: 0, adviceSeen: 0, lessons: 0, staleSkips: 0, waitSkips: 0 };
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
        this._lastDpadDirections = [];
        this._trail = [];               // recent positions (ping-pong detection)
        this._staleNotice = null;       // one-shot fresh-frame guard callout
        this._rebuildSystem();
    }

    /**
     * (Re)build the system prompt. Called again whenever the experience
     * book changes (a new lesson or milestone), so learning takes effect
     * on the very next turn — not just the next session.
     */
    _rebuildSystem() {
        this._system = brain.buildSystemPrompt({
            goal: this.options.goal,
            hints: this.options.hints || null,
            memoryAssist: this.options.memoryAssist,
            learning: this.experience !== null,
            lessons: this.experience ? this.experience.renderLessons() : [],
            milestones: this.experience ? this.experience.renderMilestones() : []
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
                // One unambiguous direction that went nowhere is a
                // learnable bump (reported once seen twice).
                if (this._lastDpadDirections.length === 1) {
                    this.experience?.recordBump({
                        mapId: state.mapId, x: state.x, y: state.y,
                        direction: this._lastDpadDirections[0]
                    });
                }
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

        // Ping-pong detection: an A-B-A-B pattern in the recent trail
        // means the model keeps reversing its own moves.
        if (!state.inBattle) {
            this._trail.push({ mapId: state.mapId, x: state.x, y: state.y });
            if (this._trail.length > 6) this._trail.shift();
            const key = p => `${p.mapId}:${p.x},${p.y}`;
            const trail = this._trail;
            if (trail.length >= 4
                && key(trail.at(-1)) === key(trail.at(-3))
                && key(trail.at(-2)) === key(trail.at(-4))
                && key(trail.at(-1)) !== key(trail.at(-2))) {
                lines.push(`You are PING-PONGING between (${trail.at(-2).x}, ${trail.at(-2).y}) and (${state.x}, ${state.y}) - you keep reversing your own moves. Pick ONE direction and commit to it for several turns.`);
            }
        }

        if (!state.inBattle) {
            this._tiles.record(state);
            const explored = this._tiles.describe(state);
            if (explored.unexploredDirections.length > 0) {
                lines.push(`You have stood on ${explored.tilesSeen} different tiles of this map. Adjacent tiles you have NEVER stood on: ${explored.unexploredDirections.join(', ')}.`);
            } else {
                lines.push(`You have stood on ${explored.tilesSeen} different tiles of this map, including every tile adjacent to this one - consider heading somewhere new.`);
            }
            const blocked = this.experience ? this.experience.bumpedDirections(state) : [];
            if (blocked.length > 0) {
                lines.push(`From this tile you already KNOW these directions are blocked (you bumped into them before): ${blocked.join(', ')}. Do not try them again.`);
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
            // (or trail) spanning the reload would be nonsense.
            this._lastState = null;
            this._sameTileTurns = 0;
            this._trail = [];
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
            stateLines,
            staleNotice: this._staleNotice
        });
        this._rejectedActions = [];
        this._staleNotice = null;

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
            this._lastDpadDirections = [];
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

        // Fresh-frame guard: the model deliberated for seconds while the
        // game kept running. Recapture and compare with the frame it saw:
        //  - a drastic change (scene transition, battle intro, warp)
        //    means its button presses are aimed at a screen that no
        //    longer exists - hold them and ask for a fresh decision;
        //  - a WAIT aimed at "text still printing"/"animation playing"
        //    is already satisfied if the screen moved on - skip it
        //    instead of wasting more real time.
        let actionsToRun = decision.actions;
        let historyNote = null;
        const hasPresses = decision.actions.some(a => a.kind === 'press');
        const guardFrame = await this._captureScreen().catch(() => null);
        if (guardFrame) {
            const drift = changedCells(frameSignature(decoded), frameSignature(guardFrame.decoded));
            if (hasPresses && drift >= STALE_DRASTIC_CELLS) {
                actionsToRun = [];
                historyNote = 'buttons NOT pressed - the screen had already changed completely';
                this._staleNotice = 'The screen changed completely while you were deciding last turn, so your buttons were NOT pressed. Decide again from this fresh screenshot.';
                this.stats.staleSkips++;
                this.log(`turn ${turn}: screen drifted ${drift} cells while deciding - holding the buttons`);
            } else if (!hasPresses && drift > thresholds.STILL_CELL_TOLERANCE) {
                actionsToRun = [];
                historyNote = 'the wait was skipped - the screen had already moved on';
                this.stats.waitSkips++;
                this.log(`turn ${turn}: skipping WAIT - the screen already moved on while deciding`);
            }
        }

        await this._executeActions(actionsToRun);
        const dpad = new Set();
        for (const action of actionsToRun) {
            if (action.kind !== 'press') continue;
            for (const [direction, bit] of Object.entries(DIRECTION_BITS)) {
                if (action.mask & bit) dpad.add(direction);
            }
        }
        this._lastDpadDirections = [...dpad];
        this._lastActionsHadDpad = dpad.size > 0;
        this.history.record({ turn, actions: decision.actions, observe: decision.observe, note: historyNote });

        // Cross-session learning: legalize and store a proposed lesson,
        // then rebuild the system prompt so it applies immediately.
        if (decision.learn && this.experience) {
            const result = this.experience.addLesson(decision.learn, { turn });
            if (result.added) {
                this.stats.lessons++;
                this._rebuildSystem();
                this.experience.save();
                this.log(`turn ${turn}: learned: ${decision.learn}`);
            } else if (result.reason === 'reinforced') {
                this.log(`turn ${turn}: lesson reinforced: ${decision.learn}`);
            }
        }

        const labels = decision.actions.map(a => a.kind === 'wait' ? brain.WAIT_ACTION : a.label).join(', ');
        this.log(`turn ${turn}: [${labels}] ${decision.observe || ''}${decision.objective ? ` | objective: ${decision.objective}` : ''}`);

        // Broadcast: milestones become highlighted embeds (recorded
        // server-side); otherwise a heartbeat post every postEvery turns.
        if (decision.milestone) {
            this.stats.milestones++;
            if (this.experience) {
                // Remembered across sessions so an old badge is never
                // re-announced as fresh news next run.
                const recorded = this.experience.addMilestone(decision.say || decision.observe || `milestone at turn ${turn}`);
                if (recorded) {
                    this._rebuildSystem();
                    this.experience.save();
                }
            }
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

        // Watchdog checkpoint (the experience book rides the cadence so
        // explored tiles and bumps persist even if the process dies).
        if (turn % this.options.checkpointEvery === 0) {
            await this.bridge.request('savestate', { slot: this.options.checkpointSlot });
            this._hasCheckpoint = true;
            this.stats.checkpoints++;
            this.experience?.save();
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

        if (this.experience) {
            const known = this.experience.open(status.code);
            // Explored-tile memory carries over from previous sessions.
            this._tiles = this.experience.tiles;
            this._rebuildSystem();
            this.log(`experience book open for ${this.experience.gameCode}: ${known.lessons} lessons, ${known.milestones} milestones, ${known.mapsSeen} maps explored`);
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

        this.experience?.save();

        const final = await this._captureScreen().catch(() => null);
        await this._post(
            `🏁 Session over: ${this.stats.turns} turns, ${this.stats.presses} button presses, ` +
            `${this.stats.milestones} milestones, ${this.stats.stuckResets} checkpoint rewinds` +
            `${this.stats.lessons > 0 ? `, ${this.stats.lessons} new lessons learned` : ''}.` +
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
