/**
 * Stuck detection for the autonomous player: notices when the screen has
 * stopped meaningfully changing across turns and escalates deterministically
 * (design doc "anti-stuck machinery", Phase 2 slice of the ladder).
 *
 * Frames are compared as a coarse grid of average-color cells rather than
 * pixel-exact hashes, so idle animations (a blinking cursor, the keytest
 * frame-counter sweep, water tiles) don't mask being stuck: a frame counts
 * as "same" when at most STILL_CELL_TOLERANCE cells changed.
 *
 * Escalation levels:
 *   0 - fine
 *   1 - warn the model in the prompt (after WARN_AFTER same-frames)
 *   2 - stronger prompt: demand a different approach (after PUSH_AFTER)
 *   3 - watchdog: reload the last checkpoint (after RESET_AFTER), then
 *       the counter starts over
 */

const GRID_COLS = 15;
const GRID_ROWS = 10;
// Mean-channel delta (0-255) for a cell to count as changed.
const CELL_DELTA_THRESHOLD = 8;
// Frames with at most this many changed cells are "the same screen".
const STILL_CELL_TOLERANCE = 2;

const WARN_AFTER = 3;
const PUSH_AFTER = 6;
const RESET_AFTER = 10;

/**
 * Reduce an RGBA frame to a grid of average colors.
 * @param {{ width: number, height: number, rgba: Buffer }} image
 * @returns {Float64Array} GRID_COLS*GRID_ROWS*3 channel means
 */
function frameSignature({ width, height, rgba }) {
    const sums = new Float64Array(GRID_COLS * GRID_ROWS * 3);
    const counts = new Float64Array(GRID_COLS * GRID_ROWS);
    for (let y = 0; y < height; y++) {
        const cellY = Math.min(GRID_ROWS - 1, (y * GRID_ROWS / height) | 0);
        for (let x = 0; x < width; x++) {
            const cellX = Math.min(GRID_COLS - 1, (x * GRID_COLS / width) | 0);
            const cell = cellY * GRID_COLS + cellX;
            const src = (y * width + x) * 4;
            sums[cell * 3] += rgba[src];
            sums[cell * 3 + 1] += rgba[src + 1];
            sums[cell * 3 + 2] += rgba[src + 2];
            counts[cell]++;
        }
    }
    for (let cell = 0; cell < counts.length; cell++) {
        if (counts[cell] > 0) {
            sums[cell * 3] /= counts[cell];
            sums[cell * 3 + 1] /= counts[cell];
            sums[cell * 3 + 2] /= counts[cell];
        }
    }
    return sums;
}

/**
 * Count grid cells whose average color moved past the threshold.
 * @param {Float64Array} a
 * @param {Float64Array} b
 * @returns {number}
 */
function changedCells(a, b) {
    let changed = 0;
    for (let cell = 0; cell < GRID_COLS * GRID_ROWS; cell++) {
        const delta =
            Math.abs(a[cell * 3] - b[cell * 3]) +
            Math.abs(a[cell * 3 + 1] - b[cell * 3 + 1]) +
            Math.abs(a[cell * 3 + 2] - b[cell * 3 + 2]);
        if (delta / 3 >= CELL_DELTA_THRESHOLD) changed++;
    }
    return changed;
}

class StuckDetector {
    constructor() {
        this._lastSignature = null;
        this.sameFrames = 0;
    }

    /**
     * Record this turn's frame; returns the current escalation.
     * @param {{ width: number, height: number, rgba: Buffer }} image
     * @returns {{ level: 0|1|2|3, sameFrames: number, warning: string|null, shouldReset: boolean }}
     */
    record(image) {
        const signature = frameSignature(image);
        if (this._lastSignature && changedCells(this._lastSignature, signature) <= STILL_CELL_TOLERANCE) {
            this.sameFrames++;
        } else {
            this.sameFrames = 0;
        }
        this._lastSignature = signature;

        if (this.sameFrames >= RESET_AFTER) {
            this.sameFrames = 0;
            return {
                level: 3,
                sameFrames: RESET_AFTER,
                warning: 'You were badly stuck, so the last checkpoint was just reloaded. Take a completely different approach this time.',
                shouldReset: true
            };
        }
        if (this.sameFrames >= PUSH_AFTER) {
            return {
                level: 2,
                sameFrames: this.sameFrames,
                warning: `The screen has not changed for ${this.sameFrames} turns. Whatever you are doing is NOT working - do something different (new direction, press B to back out, or interact with something else).`,
                shouldReset: false
            };
        }
        if (this.sameFrames >= WARN_AFTER) {
            return {
                level: 1,
                sameFrames: this.sameFrames,
                warning: `The screen looks the same as the last ${this.sameFrames} turns. Consider a different action.`,
                shouldReset: false
            };
        }
        return { level: 0, sameFrames: this.sameFrames, warning: null, shouldReset: false };
    }

    reset() {
        this._lastSignature = null;
        this.sameFrames = 0;
    }
}

module.exports = {
    StuckDetector,
    frameSignature,
    changedCells,
    thresholds: { WARN_AFTER, PUSH_AFTER, RESET_AFTER, STILL_CELL_TOLERANCE }
};
