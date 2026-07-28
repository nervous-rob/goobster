/**
 * RAM-assisted ground truth for the GBA agent (lib/gameState.js): the
 * FireRed-family state reader against a fake memory bridge (including
 * every degrade-to-null path), the explored-tile memory, and the
 * deterministic movement describer.
 */

const {
    GameStateReader,
    TileMemory,
    describeMovement,
    normalizeGameCode,
    KNOWN_GAMES
} = require('../clients/gba-mcp/lib/gameState');

const FIRERED = KNOWN_GAMES.BPRE;
const SB1_BASE = 0x02025234; // arbitrary in-EWRAM save block location

/** A fake bridge backed by a sparse byte map, serving the `read` verb. */
function makeMemoryBridge() {
    const bytes = new Map();
    const bridge = {
        bytes,
        setU8(addr, value) { bytes.set(addr, value & 0xff); },
        setU16(addr, value) { this.setU8(addr, value); this.setU8(addr + 1, value >>> 8); },
        setU32(addr, value) { this.setU16(addr, value & 0xffff); this.setU16(addr + 2, value >>> 16); },
        request: jest.fn(async (verb, { addr, len }) => {
            if (verb !== 'read') throw new Error(`unexpected verb ${verb}`);
            let hex = '';
            for (let i = 0; i < len; i++) {
                hex += (bytes.get(addr + i) || 0).toString(16).padStart(2, '0');
            }
            return { hex };
        })
    };
    return bridge;
}

/** Populate a plausible FireRed state: position, map, battle flag. */
function seedFireRed(bridge, { x = 10, y = 7, mapGroup = 3, mapNum = 1, battleByte = 0 } = {}) {
    bridge.setU32(FIRERED.saveBlock1Ptr, SB1_BASE);
    bridge.setU16(SB1_BASE, x);
    bridge.setU16(SB1_BASE + 2, y);
    bridge.setU8(SB1_BASE + 4, mapGroup);
    bridge.setU8(SB1_BASE + 5, mapNum);
    bridge.setU8(FIRERED.mainAddr + 0x439, battleByte);
}

describe('normalizeGameCode', () => {
    test('strips the AGB- prefix and uppercases', () => {
        expect(normalizeGameCode('AGB-BPRE')).toBe('BPRE');
        expect(normalizeGameCode('bpre')).toBe('BPRE');
        expect(normalizeGameCode('  BPEE ')).toBe('BPEE');
        expect(normalizeGameCode('')).toBe('');
        expect(normalizeGameCode(null)).toBe('');
    });
});

describe('GameStateReader', () => {
    test('reads position, map, and battle flag for FireRed', async () => {
        const bridge = makeMemoryBridge();
        seedFireRed(bridge, { x: 12, y: 9, mapGroup: 3, mapNum: 1, battleByte: 0 });
        const reader = new GameStateReader({ bridge, gameCode: 'AGB-BPRE' });
        expect(reader.supported).toBe(true);
        expect(reader.game.name).toBe('Pokémon FireRed');

        const state = await reader.read();
        expect(state).toEqual({ x: 12, y: 9, mapGroup: 3, mapNum: 1, mapId: '3.1', inBattle: false });
    });

    test('the in-battle flag is bit 1 of the gMain byte, not the whole byte', async () => {
        const bridge = makeMemoryBridge();
        seedFireRed(bridge, { battleByte: 0x02 });
        const reader = new GameStateReader({ bridge, gameCode: 'BPRE' });
        expect((await reader.read()).inBattle).toBe(true);

        // Bit 0 is oamLoadDisabled - not a battle.
        bridge.setU8(FIRERED.mainAddr + 0x439, 0x01);
        expect((await reader.read()).inBattle).toBe(false);
        bridge.setU8(FIRERED.mainAddr + 0x439, 0x07);
        expect((await reader.read()).inBattle).toBe(true);
    });

    test('unknown game codes are unsupported and never touch the bridge', async () => {
        const bridge = makeMemoryBridge();
        const reader = new GameStateReader({ bridge, gameCode: 'FAKE' });
        expect(reader.supported).toBe(false);
        expect(await reader.read()).toBeNull();
        expect(bridge.request).not.toHaveBeenCalled();
    });

    test('implausible reads degrade to null instead of lying', async () => {
        // Save block pointer outside EWRAM (uninitialized / wrong game rev).
        const bad = makeMemoryBridge();
        bad.setU32(FIRERED.saveBlock1Ptr, 0x08000000);
        expect(await new GameStateReader({ bridge: bad, gameCode: 'BPRE' }).read()).toBeNull();

        // Null pointer (title screen, before a save block exists).
        const zero = makeMemoryBridge();
        expect(await new GameStateReader({ bridge: zero, gameCode: 'BPRE' }).read()).toBeNull();

        // Garbage coordinates.
        const garbage = makeMemoryBridge();
        seedFireRed(garbage, { x: 0xFFFF, y: 3 });
        expect(await new GameStateReader({ bridge: garbage, gameCode: 'BPRE' }).read()).toBeNull();
    });

    test('bridge errors and malformed hex degrade to null', async () => {
        const failing = { request: jest.fn(async () => { throw new Error('bridge down'); }) };
        expect(await new GameStateReader({ bridge: failing, gameCode: 'BPRE' }).read()).toBeNull();

        const short = { request: jest.fn(async () => ({ hex: 'ab' })) };
        expect(await new GameStateReader({ bridge: short, gameCode: 'BPRE' }).read()).toBeNull();

        const junk = { request: jest.fn(async () => ({ hex: 'zzzzzzzz' })) };
        expect(await new GameStateReader({ bridge: junk, gameCode: 'BPRE' }).read()).toBeNull();
    });
});

describe('TileMemory', () => {
    test('tracks visits and reports unexplored neighbor directions', () => {
        const tiles = new TileMemory();
        tiles.record({ mapId: '3.1', x: 5, y: 5 });
        tiles.record({ mapId: '3.1', x: 5, y: 4 }); // stepped UP
        tiles.record({ mapId: '3.1', x: 5, y: 5 }); // and back

        const here = tiles.describe({ mapId: '3.1', x: 5, y: 5 });
        expect(here.visitsHere).toBe(2);
        expect(here.tilesSeen).toBe(2);
        // UP (5,4) is visited; DOWN/LEFT/RIGHT are not.
        expect(here.unexploredDirections).toEqual(['DOWN', 'LEFT', 'RIGHT']);

        // A different map knows nothing about these tiles.
        const elsewhere = tiles.describe({ mapId: '4.0', x: 5, y: 5 });
        expect(elsewhere.visitsHere).toBe(0);
        expect(elsewhere.unexploredDirections).toHaveLength(4);
    });

    test('per-map tile cap stops new tiles but keeps counting known ones', () => {
        const tiles = new TileMemory({ maxTilesPerMap: 2 });
        tiles.record({ mapId: 'm', x: 0, y: 0 });
        tiles.record({ mapId: 'm', x: 1, y: 0 });
        tiles.record({ mapId: 'm', x: 2, y: 0 }); // over the cap - dropped
        tiles.record({ mapId: 'm', x: 0, y: 0 }); // known - still counted

        expect(tiles.describe({ mapId: 'm', x: 0, y: 0 }).visitsHere).toBe(2);
        expect(tiles.describe({ mapId: 'm', x: 0, y: 0 }).tilesSeen).toBe(2);
        expect(tiles.describe({ mapId: 'm', x: 2, y: 0 }).visitsHere).toBe(0);
    });

    test('map cap evicts the oldest map', () => {
        const tiles = new TileMemory({ maxMaps: 2 });
        tiles.record({ mapId: 'first', x: 0, y: 0 });
        tiles.record({ mapId: 'second', x: 0, y: 0 });
        tiles.record({ mapId: 'third', x: 0, y: 0 });

        expect(tiles.describe({ mapId: 'first', x: 0, y: 0 }).tilesSeen).toBe(0);
        expect(tiles.describe({ mapId: 'third', x: 0, y: 0 }).tilesSeen).toBe(1);
    });
});

describe('describeMovement', () => {
    test('nothing to compare on the first read', () => {
        expect(describeMovement(null, { x: 1, y: 1, mapId: '1.1' })).toBeNull();
    });

    test('reports tile deltas in button vocabulary', () => {
        const at = (x, y) => ({ x, y, mapId: '3.1' });
        expect(describeMovement(at(5, 5), at(8, 4))).toBe('you moved 3 tiles RIGHT and 1 tile UP');
        expect(describeMovement(at(5, 5), at(4, 7))).toBe('you moved 1 tile LEFT and 2 tiles DOWN');
        expect(describeMovement(at(5, 5), at(5, 5))).toBe('your position did NOT change');
    });

    test('map transitions are called out explicitly', () => {
        expect(describeMovement({ x: 9, y: 0, mapId: '3.1' }, { x: 4, y: 12, mapId: '3.2' }))
            .toBe('you entered a NEW MAP (map 3.1 -> map 3.2)');
    });
});
