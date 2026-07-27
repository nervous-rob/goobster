/**
 * Playbook parsing and validation for the scripted run driver (Phase 1).
 *
 * A playbook is a JSON file describing a fixed sequence of steps:
 *
 *   {
 *     "name": "FireRed intro",
 *     "steps": [
 *       { "post": "Here we go!", "screen": true },
 *       { "press": ["A", "A", "START"], "hold": 10, "gap": 30 },
 *       { "wait": 120 },
 *       { "save": 1 },
 *       { "load": 1 },
 *       { "note": "printed to the driver console only" }
 *     ]
 *   }
 *
 * Same trust boundary as everything else: steps are validated up front
 * with file-position errors (questLoader style), so a typo fails before
 * the run starts, not 40 steps in.
 */

const {
    ToolInputError,
    validatePressArgs,
    validateWaitArgs,
    validateSlot,
    LIMITS
} = require('./tools');

const MAX_STEPS = 500;
const MAX_POST_LENGTH = 1800;

class PlaybookError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PlaybookError';
    }
}

/**
 * Validate a parsed playbook object into a normalized step list.
 * @param {object} raw parsed JSON
 * @returns {{ name: string, steps: Array<object> }}
 */
function parsePlaybook(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new PlaybookError('Playbook must be a JSON object with a "steps" array');
    }
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 100) : 'Unnamed run';
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
        throw new PlaybookError('Playbook needs a non-empty "steps" array');
    }
    if (raw.steps.length > MAX_STEPS) {
        throw new PlaybookError(`Playbook has ${raw.steps.length} steps; at most ${MAX_STEPS} allowed`);
    }

    const steps = raw.steps.map((step, index) => {
        const where = `step ${index + 1}`;
        if (!step || typeof step !== 'object' || Array.isArray(step)) {
            throw new PlaybookError(`${where}: each step must be an object`);
        }
        const kinds = ['press', 'wait', 'post', 'save', 'load', 'note'].filter(k => k in step);
        if (kinds.length !== 1) {
            throw new PlaybookError(`${where}: exactly one of press/wait/post/save/load/note per step (found: ${kinds.join(', ') || 'none'})`);
        }
        const kind = kinds[0];

        try {
            switch (kind) {
                case 'press': {
                    const { presses, holdFrames, gapFrames, totalFrames } = validatePressArgs({
                        buttons: step.press,
                        hold_frames: step.hold,
                        gap_frames: step.gap
                    });
                    return { kind, presses, holdFrames, gapFrames, totalFrames };
                }
                case 'wait': {
                    const { frames } = validateWaitArgs({ frames: step.wait });
                    return { kind, frames };
                }
                case 'post': {
                    const text = typeof step.post === 'string' ? step.post.trim().slice(0, MAX_POST_LENGTH) : '';
                    const screen = step.screen !== false;
                    if (!text && !screen) {
                        throw new ToolInputError('a post needs text and/or "screen": true');
                    }
                    const upscale = step.upscale === undefined
                        ? LIMITS.defaultUpscale
                        : (() => {
                            const n = Number(step.upscale);
                            if (!Number.isInteger(n) || n < LIMITS.minUpscale || n > LIMITS.maxUpscale) {
                                throw new ToolInputError(`upscale must be an integer between ${LIMITS.minUpscale} and ${LIMITS.maxUpscale}`);
                            }
                            return n;
                        })();
                    return { kind, text, screen, upscale };
                }
                case 'save':
                case 'load':
                    return { kind, slot: validateSlot({ slot: step[kind] }) };
                case 'note': {
                    const text = typeof step.note === 'string' ? step.note.trim() : '';
                    if (!text) throw new ToolInputError('a note needs text');
                    return { kind, text };
                }
            }
        } catch (error) {
            if (error instanceof ToolInputError || error instanceof PlaybookError) {
                throw new PlaybookError(`${where}: ${error.message}`);
            }
            throw error;
        }
    });

    return { name, steps };
}

module.exports = { parsePlaybook, PlaybookError, MAX_STEPS };
