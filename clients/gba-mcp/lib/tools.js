/**
 * MCP tool definitions and input legalization for the GBA harness.
 *
 * Follows the repo-wide trust boundary: the model proposes, deterministic
 * code validates. Every tool input is normalized and clamped here before
 * anything reaches the emulator; bad input throws ToolInputError with a
 * message the calling model can read and correct.
 */

/** GBA key bit indices (mGBA C.GBA_KEY values). */
const BUTTONS = Object.freeze({
    A: 0,
    B: 1,
    SELECT: 2,
    START: 3,
    RIGHT: 4,
    LEFT: 5,
    UP: 6,
    DOWN: 7,
    R: 8,
    L: 9
});

const BUTTON_NAMES = Object.keys(BUTTONS);

const LIMITS = Object.freeze({
    maxPresses: 32,
    minHoldFrames: 1,
    maxHoldFrames: 240,
    minGapFrames: 0,
    maxGapFrames: 240,
    defaultHoldFrames: 10,
    defaultGapFrames: 5,
    minWaitFrames: 1,
    maxWaitFrames: 3600,
    defaultWaitFrames: 60,
    minSlot: 1,
    maxSlot: 9,
    minUpscale: 1,
    maxUpscale: 4,
    defaultUpscale: 3,
    maxReadLength: 4096
});

/** Input the model can fix — reported back as a tool error, never thrown up. */
class ToolInputError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ToolInputError';
    }
}

function clampInt(value, name, min, max, fallback) {
    if (value === undefined || value === null) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n)) {
        throw new ToolInputError(`${name} must be an integer`);
    }
    if (n < min || n > max) {
        throw new ToolInputError(`${name} must be between ${min} and ${max}`);
    }
    return n;
}

/**
 * Parse one press entry — a button name or a '+'-joined combo
 * ("A", "UP", "B+RIGHT") — into a key bitmask.
 * @param {string} entry
 * @returns {{ mask: number, label: string }}
 */
function parsePressEntry(entry) {
    if (typeof entry !== 'string' || entry.trim() === '') {
        throw new ToolInputError('Each button entry must be a non-empty string');
    }
    const names = entry.split('+').map(s => s.trim().toUpperCase());
    let mask = 0;
    for (const name of names) {
        if (!(name in BUTTONS)) {
            throw new ToolInputError(`Unknown button "${name}". Valid buttons: ${BUTTON_NAMES.join(', ')}`);
        }
        mask |= 1 << BUTTONS[name];
    }
    return { mask, label: names.join('+') };
}

/**
 * Validate press_buttons arguments into a normalized sequence.
 * @param {object} args
 * @returns {{ presses: Array<{mask: number, label: string}>, holdFrames: number, gapFrames: number, screenAfter: boolean, totalFrames: number }}
 */
function validatePressArgs(args = {}) {
    if (!Array.isArray(args.buttons) || args.buttons.length === 0) {
        throw new ToolInputError('buttons must be a non-empty array of button names (e.g. ["UP", "UP", "A"] or ["B+RIGHT"])');
    }
    if (args.buttons.length > LIMITS.maxPresses) {
        throw new ToolInputError(`At most ${LIMITS.maxPresses} presses per call`);
    }
    const holdFrames = clampInt(args.hold_frames, 'hold_frames',
        LIMITS.minHoldFrames, LIMITS.maxHoldFrames, LIMITS.defaultHoldFrames);
    const gapFrames = clampInt(args.gap_frames, 'gap_frames',
        LIMITS.minGapFrames, LIMITS.maxGapFrames, LIMITS.defaultGapFrames);
    const presses = args.buttons.map(parsePressEntry);
    return {
        presses,
        holdFrames,
        gapFrames,
        screenAfter: args.screen_after !== false,
        totalFrames: presses.length * (holdFrames + gapFrames)
    };
}

/**
 * Validate wait arguments.
 * @param {object} args
 * @returns {{ frames: number, screenAfter: boolean }}
 */
function validateWaitArgs(args = {}) {
    return {
        frames: clampInt(args.frames, 'frames',
            LIMITS.minWaitFrames, LIMITS.maxWaitFrames, LIMITS.defaultWaitFrames),
        screenAfter: args.screen_after !== false
    };
}

/**
 * Validate a save-state slot.
 * @param {object} args
 * @returns {number}
 */
function validateSlot(args = {}) {
    const slot = clampInt(args.slot, 'slot', LIMITS.minSlot, LIMITS.maxSlot, null);
    if (slot === null) {
        throw new ToolInputError(`slot is required (${LIMITS.minSlot}-${LIMITS.maxSlot})`);
    }
    return slot;
}

/**
 * Validate get_screen arguments.
 * @param {object} args
 * @returns {{ upscale: number }}
 */
function validateScreenArgs(args = {}) {
    return {
        upscale: clampInt(args.upscale, 'upscale',
            LIMITS.minUpscale, LIMITS.maxUpscale, LIMITS.defaultUpscale)
    };
}

/**
 * Validate read_memory arguments. Address accepts a number or a hex
 * string ("0x02024284").
 * @param {object} args
 * @returns {{ address: number, length: number }}
 */
function validateReadArgs(args = {}) {
    let address = args.address;
    if (typeof address === 'string') {
        address = address.trim().toLowerCase().startsWith('0x')
            ? parseInt(address, 16)
            : Number(address);
    }
    if (!Number.isInteger(address) || address < 0 || address > 0x0fffffff) {
        throw new ToolInputError('address must be an integer or hex string within the GBA bus (0x00000000-0x0FFFFFFF)');
    }
    const length = clampInt(args.length, 'length', 1, LIMITS.maxReadLength, 16);
    return { address, length };
}

/**
 * MCP tool descriptors.
 * @param {{ allowMemory?: boolean }} [options]
 * @returns {Array<object>}
 */
function toolDefinitions({ allowMemory = false } = {}) {
    const tools = [
        {
            name: 'get_screen',
            description: 'Capture the current emulator screen as a PNG image. The native GBA resolution is 240x160; the image is upscaled for readability.',
            inputSchema: {
                type: 'object',
                properties: {
                    upscale: {
                        type: 'integer',
                        minimum: LIMITS.minUpscale,
                        maximum: LIMITS.maxUpscale,
                        description: `Integer upscale factor (default ${LIMITS.defaultUpscale})`
                    }
                }
            }
        },
        {
            name: 'press_buttons',
            description: 'Press a sequence of GBA buttons, one after another. Each entry is a button name (A, B, L, R, UP, DOWN, LEFT, RIGHT, START, SELECT) or a "+"-joined combo held together (e.g. "B+RIGHT" to run). Returns a screenshot after the sequence completes.',
            inputSchema: {
                type: 'object',
                properties: {
                    buttons: {
                        type: 'array',
                        items: { type: 'string' },
                        minItems: 1,
                        maxItems: LIMITS.maxPresses,
                        description: 'Buttons to press in order, e.g. ["UP", "UP", "A"]'
                    },
                    hold_frames: {
                        type: 'integer',
                        minimum: LIMITS.minHoldFrames,
                        maximum: LIMITS.maxHoldFrames,
                        description: `Frames to hold each press (default ${LIMITS.defaultHoldFrames}; 60 frames = 1 in-game second)`
                    },
                    gap_frames: {
                        type: 'integer',
                        minimum: LIMITS.minGapFrames,
                        maximum: LIMITS.maxGapFrames,
                        description: `Frames to release between presses (default ${LIMITS.defaultGapFrames})`
                    },
                    screen_after: {
                        type: 'boolean',
                        description: 'Attach a screenshot after the sequence (default true)'
                    }
                },
                required: ['buttons']
            }
        },
        {
            name: 'wait',
            description: 'Let the game run for a number of frames (60 frames = 1 in-game second), then return a screenshot. Use while text scrolls, animations play, or to let events unfold.',
            inputSchema: {
                type: 'object',
                properties: {
                    frames: {
                        type: 'integer',
                        minimum: LIMITS.minWaitFrames,
                        maximum: LIMITS.maxWaitFrames,
                        description: `Frames to wait (default ${LIMITS.defaultWaitFrames})`
                    },
                    screen_after: {
                        type: 'boolean',
                        description: 'Attach a screenshot afterwards (default true)'
                    }
                }
            }
        },
        {
            name: 'save_state',
            description: 'Save the full emulator state to a numbered slot (checkpoint before risky moments).',
            inputSchema: {
                type: 'object',
                properties: {
                    slot: {
                        type: 'integer',
                        minimum: LIMITS.minSlot,
                        maximum: LIMITS.maxSlot,
                        description: 'Save slot number'
                    }
                },
                required: ['slot']
            }
        },
        {
            name: 'load_state',
            description: 'Restore the emulator state from a numbered slot. Returns a screenshot of the restored state.',
            inputSchema: {
                type: 'object',
                properties: {
                    slot: {
                        type: 'integer',
                        minimum: LIMITS.minSlot,
                        maximum: LIMITS.maxSlot,
                        description: 'Save slot number'
                    }
                },
                required: ['slot']
            }
        },
        {
            name: 'get_status',
            description: 'Report emulator status: whether the bridge is connected, the loaded game title and code, and the current frame count.',
            inputSchema: { type: 'object', properties: {} }
        }
    ];

    if (allowMemory) {
        tools.push({
            name: 'read_memory',
            description: 'Read bytes from the GBA memory bus (hex dump). Enabled by the harness operator for RAM-assisted play; the default is vision-only.',
            inputSchema: {
                type: 'object',
                properties: {
                    address: {
                        type: 'string',
                        description: 'Bus address as hex string (e.g. "0x02024284") or integer'
                    },
                    length: {
                        type: 'integer',
                        minimum: 1,
                        maximum: LIMITS.maxReadLength,
                        description: 'Number of bytes to read (default 16)'
                    }
                },
                required: ['address']
            }
        });
    }

    return tools;
}

module.exports = {
    BUTTONS,
    BUTTON_NAMES,
    LIMITS,
    ToolInputError,
    parsePressEntry,
    validatePressArgs,
    validateWaitArgs,
    validateSlot,
    validateScreenArgs,
    validateReadArgs,
    toolDefinitions
};
