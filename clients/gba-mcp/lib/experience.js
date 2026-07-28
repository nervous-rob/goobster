/**
 * The experience book — cross-session learning for the autonomous
 * player. Everything the agent picks up while playing survives restarts
 * in one JSON file next to the agent, sectioned per game code so
 * FireRed lessons never leak into another cartridge.
 *
 * Two kinds of learning live here:
 *
 *  - **Model-written lessons** (the factsService pattern brought to the
 *    laptop): the decision JSON may carry a "learn" field with one
 *    durable game nuance the model just verified. Deterministic code
 *    legalizes it — trimmed, length-capped, deduplicated (a repeat
 *    reinforces the existing lesson instead of duplicating it), and
 *    bounded (the least-reinforced oldest lesson is evicted when full).
 *    Lessons are injected into future sessions' system prompts.
 *
 *  - **Deterministic behavior memory**: wall bumps (tile + direction
 *    that moved the player nowhere — reported back once seen twice, so
 *    one misread never becomes gospel), the explored-tile map, and
 *    milestones already achieved (so old wins are never re-announced).
 *
 * Persistence is best-effort and never fatal: a corrupt or unwritable
 * file logs a warning and the book keeps working in memory.
 */

const fs = require('node:fs');
const { TileMemory, normalizeGameCode } = require('./gameState');

const CAPS = Object.freeze({
    lessons: 60,            // stored per game
    lessonLength: 200,
    minLessonLength: 8,
    renderLessons: 40,      // most recent shown in the prompt
    milestones: 40,
    milestoneLength: 200,
    renderMilestones: 12,
    bumpsPerMap: 2000,
    bumpReportThreshold: 2  // bumps seen before a wall is "known"
});

/** Comparison form for dedupe: lowercase, alphanumeric words only. */
function normalizeText(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

class ExperienceBook {
    /**
     * @param {object} options
     * @param {string} options.file JSON file path (created on first save)
     * @param {(msg: string) => void} [options.log]
     */
    constructor({ file, log = () => {} }) {
        this.file = file;
        this.log = log;
        this.data = { version: 1, games: {} };
        this.gameCode = null;
        this._game = null;
        /** @type {TileMemory|null} explored-tile memory for the open game */
        this.tiles = null;
    }

    /**
     * Load the file (if any) and bind to one game's section. Returns
     * counts for logging. Safe to call once per run, after `status`.
     * @param {string} gameCode
     * @returns {{ lessons: number, milestones: number, mapsSeen: number }}
     */
    open(gameCode) {
        try {
            if (fs.existsSync(this.file)) {
                const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                if (parsed && typeof parsed === 'object' && parsed.games && typeof parsed.games === 'object') {
                    this.data = { version: 1, games: parsed.games };
                }
            }
        } catch (error) {
            this.log(`experience book ${this.file} is unreadable (${error.message}) - starting fresh`);
            this.data = { version: 1, games: {} };
        }

        this.gameCode = normalizeGameCode(gameCode) || 'UNKNOWN';
        const section = this.data.games[this.gameCode];
        this._game = {
            lessons: Array.isArray(section?.lessons) ? section.lessons.filter(l => l && typeof l.text === 'string').slice(0, CAPS.lessons) : [],
            milestones: Array.isArray(section?.milestones) ? section.milestones.filter(m => m && typeof m.text === 'string').slice(0, CAPS.milestones) : [],
            bumps: (section?.bumps && typeof section.bumps === 'object') ? section.bumps : {}
        };
        this.data.games[this.gameCode] = this._game;
        this.tiles = TileMemory.fromJSON(section?.tiles);
        return {
            lessons: this._game.lessons.length,
            milestones: this._game.milestones.length,
            mapsSeen: this.tiles.maps.size
        };
    }

    /**
     * Record a model-proposed lesson. A near-duplicate (same normalized
     * text, or one containing the other) reinforces the existing lesson.
     * @param {string} text
     * @param {{ turn?: number|null }} [meta]
     * @returns {{ added: boolean, reason: 'learned'|'reinforced'|'rejected' }}
     */
    addLesson(text, { turn = null } = {}) {
        if (!this._game) return { added: false, reason: 'rejected' };
        const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, CAPS.lessonLength);
        const norm = normalizeText(clean);
        if (norm.length < CAPS.minLessonLength) return { added: false, reason: 'rejected' };

        const existing = this._game.lessons.find(lesson => {
            const other = normalizeText(lesson.text);
            return other === norm || other.includes(norm) || norm.includes(other);
        });
        if (existing) {
            existing.seen = (existing.seen || 1) + 1;
            existing.at = new Date().toISOString();
            return { added: false, reason: 'reinforced' };
        }

        this._game.lessons.push({ text: clean, turn, at: new Date().toISOString(), seen: 1 });
        if (this._game.lessons.length > CAPS.lessons) {
            // Evict the least-reinforced lesson, oldest first on ties.
            let worst = 0;
            for (let i = 1; i < this._game.lessons.length; i++) {
                if ((this._game.lessons[i].seen || 1) < (this._game.lessons[worst].seen || 1)) worst = i;
            }
            this._game.lessons.splice(worst, 1);
        }
        return { added: true, reason: 'learned' };
    }

    /** Most recent lessons, oldest first, for the system prompt. */
    renderLessons() {
        if (!this._game) return [];
        return [...this._game.lessons]
            .sort((a, b) => String(a.at).localeCompare(String(b.at)))
            .slice(-CAPS.renderLessons)
            .map(lesson => lesson.text);
    }

    /**
     * Record an achieved milestone (deduplicated, so re-announcing an
     * old badge in a later session is preventable at the prompt level).
     * @param {string} text
     * @returns {boolean} whether it was new
     */
    addMilestone(text) {
        if (!this._game) return false;
        const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, CAPS.milestoneLength);
        const norm = normalizeText(clean);
        if (!norm) return false;
        if (this._game.milestones.some(m => normalizeText(m.text) === norm)) return false;
        this._game.milestones.push({ text: clean, at: new Date().toISOString() });
        if (this._game.milestones.length > CAPS.milestones) this._game.milestones.shift();
        return true;
    }

    /** Most recent milestones, oldest first, for the system prompt. */
    renderMilestones() {
        if (!this._game) return [];
        return this._game.milestones.slice(-CAPS.renderMilestones).map(m => m.text);
    }

    /**
     * Record a wall bump: direction presses from a tile that moved the
     * player nowhere.
     * @param {{ mapId: string, x: number, y: number, direction: string }} bump
     */
    recordBump({ mapId, x, y, direction }) {
        if (!this._game) return;
        const map = this._game.bumps[mapId] = this._game.bumps[mapId] || {};
        const key = `${x},${y}:${direction}`;
        if (map[key] === undefined && Object.keys(map).length >= CAPS.bumpsPerMap) return;
        map[key] = (map[key] || 0) + 1;
    }

    /**
     * Directions confirmed blocked from a tile (bumped at least
     * `bumpReportThreshold` times — one misread never becomes gospel).
     * @param {{ mapId: string, x: number, y: number }} pos
     * @returns {string[]}
     */
    bumpedDirections({ mapId, x, y }) {
        if (!this._game) return [];
        const map = this._game.bumps[mapId];
        if (!map) return [];
        return ['UP', 'DOWN', 'LEFT', 'RIGHT']
            .filter(direction => (map[`${x},${y}:${direction}`] || 0) >= CAPS.bumpReportThreshold);
    }

    /**
     * Persist the book (atomic write: temp file + rename). Never throws;
     * failures log and the run continues.
     */
    save() {
        if (!this._game) return;
        try {
            this._game.tiles = this.tiles ? this.tiles.toJSON() : {};
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.data));
            fs.renameSync(tmp, this.file);
        } catch (error) {
            this.log(`could not save the experience book: ${error.message}`);
        }
    }
}

module.exports = { ExperienceBook, CAPS, normalizeText };
