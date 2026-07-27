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

function buildSystemPrompt({ goal }) {
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
        `- Buttons: A, B, L, R, UP, DOWN, LEFT, RIGHT, START, SELECT. Combos hold buttons together: "B+RIGHT".`,
        `- "${WAIT_ACTION}" watches for a moment without pressing anything (use it while text scrolls or animations play).`,
        `- 1 to ${MAX_ACTIONS_PER_TURN} actions per turn. Prefer a few deliberate presses; you get a fresh screenshot next turn.`,
        '- In dialogs and menus, A advances/confirms and B cancels. START usually opens the pause menu.',
        '',
        'Set "milestone": true only for genuinely notable moments (a badge, a new area, a boss beaten, something hilarious) - and never for the same accomplishment twice: once you have reported a milestone, it is old news.',
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
 */
function buildTurnPrompt({ objective, historyLines, turn, stuckWarning }) {
    const parts = [`Turn ${turn}. Here is the current screen.`];
    if (objective) parts.push(`Current objective: ${objective}`);
    if (historyLines.length > 0) {
        parts.push('Recent turns:', ...historyLines.map(line => `- ${line}`));
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
 *             milestone: boolean, actions: Array<{kind:'press',mask:number,label:string}|{kind:'wait'}>,
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

    render() {
        return [...this.entries];
    }
}

module.exports = {
    buildSystemPrompt,
    buildTurnPrompt,
    parseDecision,
    extractJson,
    TurnHistory,
    MAX_ACTIONS_PER_TURN,
    WAIT_ACTION
};
