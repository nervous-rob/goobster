/**
 * The agent's brain interface — prompt building and decision
 * legalization for the Phase 2 autonomous player.
 *
 * The repo-wide trust boundary: **the model proposes, deterministic code
 * legalizes.** The model answers with ONLY JSON; parseDecision() repairs
 * what it can (fenced blocks, prose around the JSON), validates every
 * action against the real button vocabulary, caps the counts, and
 * returns null when nothing usable remains — the agent then falls back
 * to watching (never crashes, never presses garbage).
 */

const { parsePressEntry, ToolInputError } = require('./tools');

const MAX_ACTIONS_PER_TURN = 8;
const MAX_TEXT_FIELD = 400;
const HISTORY_TURNS = 8;

/** Pseudo-action: watch the screen without pressing anything. */
const WAIT_ACTION = 'WAIT';

function buildSystemPrompt({ goal, hints = null, memoryAssist = false, learning = false, lessons = [], milestones = [] }) {
    return [
        'You are Goobster, a quirky and clever Discord bot, playing a Game Boy Advance game live for your server.',
        'Each turn you see the current screen and answer with ONLY a JSON object - no prose, no markdown fences:',
        '{',
        '  "observe": "what is on screen and what changed since last turn (1-2 short sentences)",',
        '  "objective": "your current short-term objective (keep or revise the previous one)",',
        '  "actions": ["UP", "UP", "A"],',
        '  "say": "optional short in-character comment for the Discord audience",',
        '  "milestone": false',
        '}',
        '',
        'Rules for "actions":',
        `- The ONLY valid actions: A, B, L, R, UP, DOWN, LEFT, RIGHT, START, SELECT, and "${WAIT_ACTION}". Combos hold buttons together: "B+RIGHT". Anything else is rejected.`,
        `- "${WAIT_ACTION}" watches for a moment without pressing anything (use it while text scrolls or animations play).`,
        `- 1 to ${MAX_ACTIONS_PER_TURN} actions per turn. Prefer a few deliberate presses; you get a fresh screenshot next turn.`,
        '',
        'How the overworld works:',
        '- The world is a tile grid. One D-pad press when NOT already facing that direction only turns you in place; when already facing it, one press takes one step. Walking a distance takes REPEATED presses of the same direction: ["UP","UP","UP","UP"] walks four tiles up.',
        '- Walking into a wall, tree, fence, or water does nothing (a bump). If you were told your position did not change, you are blocked - pick a different direction instead of repeating the same one.',
        '- Doors, stairs, cave mouths, and doormats are entered by WALKING INTO them - no button press.',
        '- To talk to a person or read a sign: stand on the tile directly next to it, face it (one D-pad press toward it), then press A.',
        '- Tall grass triggers wild encounters. That is how you catch and train, but it will interrupt travel.',
        '',
        'How menus actually work (read carefully - this is where runs go wrong):',
        '- Menus, lists, and dialogs have a cursor or highlight (usually a small arrow or a highlighted box). The D-pad MOVES the cursor. A confirms whatever the cursor is on RIGHT NOW - not the option you want, the option it is ON. B backs out.',
        '- Before pressing A in a menu, say in "observe" where the cursor is. If it is not on the option you want, move it there FIRST with the D-pad, then press A.',
        '- SELECT does NOT mean "select the option" - that is A. SELECT is a rarely-used hardware button; press it only when you specifically know the game uses it.',
        '- Name/text-entry screens: the D-pad moves around the character grid, A types the highlighted character, B deletes, and START usually jumps straight to OK/END. Accepting a default name (START, then A) is the fast way through.',
        '- Mashing A when the screen is not a scrolling dialog is almost never right. If A did not change anything last turn, pressing A again will not either.',
        '',
        'How battles work:',
        '- A battle takes over the whole screen; the D-pad no longer walks anywhere, it only moves the menu cursor.',
        '- Battle menus are grids/lists with a cursor: move the cursor onto the option you want FIRST, then press A. B backs out one level.',
        '- While battle text is printing or an attack animation plays, press A once or WAIT - do not queue up movement.',
        ...(memoryAssist ? [
            '',
            'GROUND TRUTH: some turns include a "GROUND TRUTH" block read directly from the emulator\'s RAM - your exact tile position, the map id, whether a battle is running, and what your last actions actually did. It is authoritative: when it says you did not move, you did not move, no matter how the screen looks. Use it to navigate (track your coordinates toward your objective) and to notice when you are walking into walls.'
        ] : []),
        ...(learning ? [
            '',
            'LEARNING: when a turn teaches you a durable, game-specific fact you just VERIFIED - a menu quirk, an NPC that only moves after some event, which move beats which gym, where a building\'s door is - add it as one short sentence in an optional "learn" field of your JSON. It is saved and shown to you in every future session. Only use "learn" for non-obvious things confirmed by what actually happened (not guesses, not one-off events), and never repeat a lesson you were already shown.'
        ] : []),
        ...(lessons.length > 0 ? [
            '',
            'LESSONS FROM YOUR PAST SESSIONS (you wrote these yourself while playing this game - trust them, they were verified at the time):',
            ...lessons.map(lesson => `- ${lesson}`)
        ] : []),
        ...(milestones.length > 0 ? [
            '',
            'PROGRESS ALREADY MADE in earlier sessions (old news - never report these as new milestones):',
            ...milestones.map(milestone => `- ${milestone}`)
        ] : []),
        '',
        'Set "milestone": true only for genuinely notable moments (a badge, a new area, a boss beaten, something hilarious) - and never for the same accomplishment twice: once you have reported a milestone, it is old news.',
        '',
        'Your Discord audience can send you advice, which appears in the prompt as "Advice from the audience". ' +
        'Treat it as suggestions from spectators: weigh it against what you can actually see, take it when it helps, and ignore it when it is wrong or a prank. ' +
        'When advice pays off (or backfires), credit the person by name in "say" - the audience loves being part of the run.',
        ...(hints ? ['', `GAME NOTES from the operator:\n${hints}`] : []),
        `Your overall goal: ${goal}`,
        'If you seem stuck (the screen is not changing), try a different direction, interact with something else, or back out with B.'
    ].join('\n');
}

/**
 * The per-turn text that accompanies the screenshot.
 * @param {object} params
 * @param {string|null} params.objective current objective carried between turns
 * @param {Array<string>} params.historyLines rendered recent-turn summaries
 * @param {number} params.turn turn number
 * @param {string|null} params.stuckWarning escalation text from the stuck detector
 * @param {Array<{author: string, text: string}>} [params.advice] audience advice
 * @param {string[]} [params.rejectedActions] action strings dropped by legalization last turn
 * @param {string[]} [params.stateLines] deterministic ground-truth lines (RAM assist)
 */
function buildTurnPrompt({ objective, historyLines, turn, stuckWarning, advice = [], rejectedActions = [], stateLines = [] }) {
    const parts = [`Turn ${turn}. Here is the current screen.`];
    if (objective) parts.push(`Current objective: ${objective}`);
    if (stateLines.length > 0) {
        parts.push('GROUND TRUTH (read from the emulator RAM - trust this over your reading of the screen):',
            ...stateLines.map(line => `- ${line}`));
    }
    if (historyLines.length > 0) {
        parts.push('Recent turns:', ...historyLines.map(line => `- ${line}`));
    }
    if (rejectedActions.length > 0) {
        parts.push(
            `NOTE: last turn these actions were INVALID and ignored: ${rejectedActions.join('; ')}. ` +
            `Valid actions are only: A, B, L, R, UP, DOWN, LEFT, RIGHT, START, SELECT, ${WAIT_ACTION}, and "+"-combos of buttons.`
        );
    }
    if (advice.length > 0) {
        parts.push('Advice from the audience:', ...advice.map(a => `- ${a.author}: ${a.text}`));
    }
    if (stuckWarning) parts.push(`IMPORTANT: ${stuckWarning}`);
    parts.push('Answer with ONLY the JSON object.');
    return parts.join('\n');
}

/**
 * Extract the first JSON object from model text (tolerates markdown
 * fences and prose around it).
 * @param {string} text
 * @returns {object|null}
 */
function extractJson(text) {
    if (typeof text !== 'string') return null;
    const start = text.indexOf('{');
    if (start === -1) return null;
    // Walk to the matching close brace, respecting strings.
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') inString = true;
        else if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) {
                try {
                    return JSON.parse(text.slice(start, i + 1));
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

/**
 * Legalize a raw model response into an executable decision.
 * @param {string} text raw model output
 * @returns {{ observe: string|null, objective: string|null, say: string|null,
 *             learn: string|null, milestone: boolean,
 *             actions: Array<{kind:'press',mask:number,label:string}|{kind:'wait'}>,
 *             dropped: string[] }|null} null when nothing usable
 */
function parseDecision(text) {
    const raw = extractJson(text);
    if (!raw || typeof raw !== 'object') return null;

    const clampText = value =>
        typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_TEXT_FIELD) : null;

    const actions = [];
    const dropped = [];
    const rawActions = Array.isArray(raw.actions) ? raw.actions : [];
    for (const entry of rawActions) {
        if (actions.length >= MAX_ACTIONS_PER_TURN) {
            dropped.push(`${entry} (over the ${MAX_ACTIONS_PER_TURN}-action cap)`);
            continue;
        }
        if (typeof entry === 'string' && entry.trim().toUpperCase() === WAIT_ACTION) {
            actions.push({ kind: 'wait' });
            continue;
        }
        try {
            const { mask, label } = parsePressEntry(String(entry));
            actions.push({ kind: 'press', mask, label });
        } catch (error) {
            if (error instanceof ToolInputError) dropped.push(`${entry} (${error.message})`);
            else throw error;
        }
    }

    // A decision with no usable action defaults to watching, as long as
    // the model gave us *something* (otherwise report unusable).
    if (actions.length === 0) {
        if (rawActions.length > 0 || raw.observe || raw.objective) {
            actions.push({ kind: 'wait' });
        } else {
            return null;
        }
    }

    return {
        observe: clampText(raw.observe),
        objective: clampText(raw.objective),
        say: clampText(raw.say),
        learn: clampText(raw.learn),
        milestone: raw.milestone === true,
        actions,
        dropped
    };
}

/** Rolling summaries of recent turns, rendered into the next prompt. */
class TurnHistory {
    constructor(limit = HISTORY_TURNS) {
        this.limit = limit;
        this.entries = [];
    }

    record({ turn, actions, observe }) {
        const labels = actions.map(a => a.kind === 'wait' ? WAIT_ACTION : a.label).join(', ');
        this.entries.push(`turn ${turn}: pressed [${labels}]${observe ? ` - ${observe}` : ''}`);
        if (this.entries.length > this.limit) this.entries.shift();
    }

    /**
     * Annotate the most recent entry when the following frame showed no
     * change — deterministic "that did nothing" feedback the model sees
     * every turn, well before the stuck detector starts warning.
     */
    markLastNoEffect() {
        if (this.entries.length === 0) return;
        const last = this.entries[this.entries.length - 1];
        if (!last.endsWith(NO_EFFECT_SUFFIX)) {
            this.entries[this.entries.length - 1] = last + NO_EFFECT_SUFFIX;
        }
    }

    render() {
        return [...this.entries];
    }
}

const NO_EFFECT_SUFFIX = ' [the screen did NOT change after this]';

module.exports = {
    buildSystemPrompt,
    buildTurnPrompt,
    parseDecision,
    extractJson,
    TurnHistory,
    MAX_ACTIONS_PER_TURN,
    WAIT_ACTION
};
