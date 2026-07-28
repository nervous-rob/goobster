/**
 * RAM-assisted ground truth for the autonomous player — the operator
 * opt-in (`--allow-memory`) slice of the design doc's anti-stuck
 * machinery (documentation/goobster_plays_pokemon.md, "Design rules").
 *
 * The agent still plays from screenshots; this module only supplies the
 * loop-detector ground truth the design sanctions: player coordinates,
 * map id, and the in-battle flag. Addresses come from the pret decomps
 * (pokefirered): the save block DMA-shifts, so we follow the stable
 * pointer at gSaveBlock1Ptr each read instead of caching the base.
 *
 * Everything degrades gracefully: unknown game codes report
 * `supported: false`, and any failed or implausible read returns null —
 * the agent then plays that turn vision-only, never crashes.
 */

// Per-game address maps, keyed by the 4-character cartridge code.
// x/y (u16le) sit at SaveBlock1+0, mapGroup/mapNum (u8) at +4/+5;
// gMain.inBattle is bit 1 of the byte at gMain+0x439.
const SAVE_BLOCK1_X_OFFSET = 0;
const SAVE_BLOCK1_Y_OFFSET = 2;
const SAVE_BLOCK1_MAP_GROUP_OFFSET = 4;
const SAVE_BLOCK1_MAP_NUM_OFFSET = 5;
const MAIN_IN_BATTLE_OFFSET = 0x439;
const MAIN_IN_BATTLE_MASK = 0x02;

const KNOWN_GAMES = Object.freeze({
    // Pokémon FireRed (US) — pret/pokefirered symbols.
    BPRE: { name: 'Pokémon FireRed', saveBlock1Ptr: 0x03005008, mainAddr: 0x030030F0 },
    // Pokémon LeafGreen (US) — same engine, same layout.
    BPGE: { name: 'Pokémon LeafGreen', saveBlock1Ptr: 0x03005008, mainAddr: 0x030030F0 },
    // Pokémon Emerald (US) — pret/pokeemerald symbols ("season two").
    BPEE: { name: 'Pokémon Emerald', saveBlock1Ptr: 0x03005D8C, mainAddr: 0x030022C0 }
});

// EWRAM bounds for validating the DMA-shifted save block pointer.
const EWRAM_START = 0x02000000;
const EWRAM_END = 0x02040000;
// Map coordinates are small; anything huge means we read garbage.
const MAX_PLAUSIBLE_COORD = 0x3FFF;

/**
 * Normalize an mGBA game code ("AGB-BPRE" or "BPRE") to the 4-char key.
 * @param {string} code
 * @returns {string}
 */
function normalizeGameCode(code) {
    const trimmed = String(code || '').trim().toUpperCase();
    const parts = trimmed.split('-');
    return parts[parts.length - 1] || '';
}

/**
 * Reads grounded game state (position, map, in-battle) through the
 * bridge's `read` verb. One instance per run; construct after
 * `get_status` so the game code is known.
 */
class GameStateReader {
    /**
     * @param {object} deps
     * @param {{ request: Function }} deps.bridge mGBA bridge client
     * @param {string} deps.gameCode cartridge code from `status`
     */
    constructor({ bridge, gameCode }) {
        this.bridge = bridge;
        this.gameCode = normalizeGameCode(gameCode);
        this.game = KNOWN_GAMES[this.gameCode] || null;
    }

    /** Whether this game's RAM layout is known. */
    get supported() {
        return this.game !== null;
    }

    /**
     * Read the current grounded state. Returns null (never throws) when
     * the game is unsupported or any read fails or looks implausible.
     * @returns {Promise<{ x: number, y: number, mapGroup: number, mapNum: number, mapId: string, inBattle: boolean }|null>}
     */
    async read() {
        if (!this.game) return null;
        try {
            const ptrBytes = await this._read(this.game.saveBlock1Ptr, 4);
            const base = ptrBytes.readUInt32LE(0);
            if (base < EWRAM_START || base + 8 > EWRAM_END) return null;

            const sb1 = await this._read(base, 6);
            const x = sb1.readUInt16LE(SAVE_BLOCK1_X_OFFSET);
            const y = sb1.readUInt16LE(SAVE_BLOCK1_Y_OFFSET);
            if (x > MAX_PLAUSIBLE_COORD || y > MAX_PLAUSIBLE_COORD) return null;
            const mapGroup = sb1.readUInt8(SAVE_BLOCK1_MAP_GROUP_OFFSET);
            const mapNum = sb1.readUInt8(SAVE_BLOCK1_MAP_NUM_OFFSET);

            const battleByte = await this._read(this.game.mainAddr + MAIN_IN_BATTLE_OFFSET, 1);
            const inBattle = (battleByte.readUInt8(0) & MAIN_IN_BATTLE_MASK) !== 0;

            return { x, y, mapGroup, mapNum, mapId: `${mapGroup}.${mapNum}`, inBattle };
        } catch {
            return null;
        }
    }

    /**
     * @param {number} addr
     * @param {number} len
     * @returns {Promise<Buffer>}
     */
    async _read(addr, len) {
        const response = await this.bridge.request('read', { addr, len });
        const hex = typeof response.hex === 'string' ? response.hex : '';
        if (hex.length !== len * 2 || /[^0-9a-fA-F]/.test(hex)) {
            throw new Error(`Bad read response for 0x${addr.toString(16)}: "${hex}"`);
        }
        return Buffer.from(hex, 'hex');
    }
}

/**
 * Explored-map memory: which tiles the player has stood on, per map.
 * Bounded so a very long run can't grow without limit; once a map hits
 * its tile cap, new tiles stop being recorded (visit counts on known
 * tiles keep updating).
 */
class TileMemory {
    constructor({ maxMaps = 50, maxTilesPerMap = 5000 } = {}) {
        this.maxMaps = maxMaps;
        this.maxTilesPerMap = maxTilesPerMap;
        this.maps = new Map(); // mapId -> Map<"x,y", visitCount>
    }

    /**
     * Record the player standing on a tile.
     * @param {{ mapId: string, x: number, y: number }} pos
     */
    record({ mapId, x, y }) {
        let tiles = this.maps.get(mapId);
        if (!tiles) {
            if (this.maps.size >= this.maxMaps) {
                // Evict the oldest map (insertion order) — old areas
                // matter less than wherever the player is now.
                this.maps.delete(this.maps.keys().next().value);
            }
            tiles = new Map();
            this.maps.set(mapId, tiles);
        }
        const key = `${x},${y}`;
        const visits = tiles.get(key);
        if (visits !== undefined) {
            tiles.set(key, visits + 1);
        } else if (tiles.size < this.maxTilesPerMap) {
            tiles.set(key, 1);
        }
    }

    /**
     * Plain-object form for persistence: { mapId: { "x,y": visits } }.
     * @returns {Object<string, Object<string, number>>}
     */
    toJSON() {
        const out = {};
        for (const [mapId, tiles] of this.maps) {
            out[mapId] = Object.fromEntries(tiles);
        }
        return out;
    }

    /**
     * Rebuild from persisted data, re-applying the bounds so an edited
     * or stale file can never blow past the caps.
     * @param {Object<string, Object<string, number>>|null|undefined} data
     * @param {{ maxMaps?: number, maxTilesPerMap?: number }} [options]
     * @returns {TileMemory}
     */
    static fromJSON(data, options = {}) {
        const memory = new TileMemory(options);
        if (!data || typeof data !== 'object') return memory;
        for (const [mapId, tiles] of Object.entries(data)) {
            if (memory.maps.size >= memory.maxMaps) break;
            if (!tiles || typeof tiles !== 'object') continue;
            const restored = new Map();
            for (const [key, visits] of Object.entries(tiles)) {
                if (restored.size >= memory.maxTilesPerMap) break;
                if (!/^-?\d+,-?\d+$/.test(key)) continue;
                const count = Number(visits);
                if (Number.isFinite(count) && count > 0) restored.set(key, Math.floor(count));
            }
            if (restored.size > 0) memory.maps.set(mapId, restored);
        }
        return memory;
    }

    /**
     * Summarize exploration around a tile.
     * @param {{ mapId: string, x: number, y: number }} pos
     * @returns {{ visitsHere: number, tilesSeen: number, unexploredDirections: string[] }}
     */
    describe({ mapId, x, y }) {
        const tiles = this.maps.get(mapId) || new Map();
        const neighbors = [
            ['UP', x, y - 1],
            ['DOWN', x, y + 1],
            ['LEFT', x - 1, y],
            ['RIGHT', x + 1, y]
        ];
        return {
            visitsHere: tiles.get(`${x},${y}`) || 0,
            tilesSeen: tiles.size,
            unexploredDirections: neighbors
                .filter(([, nx, ny]) => !tiles.has(`${nx},${ny}`))
                .map(([direction]) => direction)
        };
    }
}

/**
 * Deterministic sentence for what happened between two state reads.
 * @param {{ x: number, y: number, mapId: string }|null} prev
 * @param {{ x: number, y: number, mapId: string }} cur
 * @returns {string|null} null when there is nothing to compare
 */
function describeMovement(prev, cur) {
    if (!prev) return null;
    if (prev.mapId !== cur.mapId) {
        return `you entered a NEW MAP (map ${prev.mapId} -> map ${cur.mapId})`;
    }
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    if (dx === 0 && dy === 0) {
        return 'your position did NOT change';
    }
    const parts = [];
    if (dx !== 0) parts.push(`${Math.abs(dx)} tile${Math.abs(dx) === 1 ? '' : 's'} ${dx > 0 ? 'RIGHT' : 'LEFT'}`);
    if (dy !== 0) parts.push(`${Math.abs(dy)} tile${Math.abs(dy) === 1 ? '' : 's'} ${dy > 0 ? 'DOWN' : 'UP'}`);
    return `you moved ${parts.join(' and ')}`;
}

module.exports = {
    GameStateReader,
    TileMemory,
    describeMovement,
    normalizeGameCode,
    KNOWN_GAMES
};
