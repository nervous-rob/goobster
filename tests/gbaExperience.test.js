/**
 * Cross-session learning for the GBA agent (lib/experience.js): lesson
 * legalization (dedupe-as-reinforcement, caps, eviction), milestone
 * memory, wall-bump memory with its report threshold, and the
 * persistence round-trip — including per-game isolation and corrupt
 * files degrading to a fresh book.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ExperienceBook, CAPS } = require('../clients/gba-mcp/lib/experience');

let dir;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gba-exp-'));
});
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function makeBook(name = 'book.json') {
    return new ExperienceBook({ file: path.join(dir, name) });
}

describe('lessons', () => {
    test('legalizes, stores, and renders model-proposed lessons', () => {
        const book = makeBook();
        book.open('AGB-BPRE');

        expect(book.addLesson('  Brock\'s   Onix is weak\nto water moves  ', { turn: 12 }))
            .toEqual({ added: true, reason: 'learned' });
        expect(book.renderLessons()).toEqual(["Brock's Onix is weak to water moves"]);

        // Too short / empty proposals are rejected, not stored.
        expect(book.addLesson('ok').added).toBe(false);
        expect(book.addLesson('').added).toBe(false);
        expect(book.renderLessons()).toHaveLength(1);
    });

    test('near-duplicates reinforce instead of duplicating', () => {
        const book = makeBook();
        book.open('BPRE');
        book.addLesson('The Viridian gym is locked until late in the game');

        expect(book.addLesson('the viridian GYM is locked, until late in the game!').reason).toBe('reinforced');
        // A substring of an existing lesson is also a repeat.
        expect(book.addLesson('The Viridian gym is locked').reason).toBe('reinforced');
        expect(book.renderLessons()).toHaveLength(1);
    });

    test('a full book evicts the least-reinforced lesson first', () => {
        const book = makeBook();
        book.open('BPRE');
        for (let i = 0; i < CAPS.lessons; i++) book.addLesson(`unique game nuance number ${i} zzz`);
        // Reinforce lesson 0 so it survives the eviction.
        book.addLesson('unique game nuance number 0 zzz');

        book.addLesson('a brand new lesson that overflows the cap');
        const all = book.renderLessons();
        expect(book._game.lessons).toHaveLength(CAPS.lessons);
        expect(book._game.lessons.some(l => l.text.includes('number 0'))).toBe(true);
        expect(book._game.lessons.some(l => l.text.includes('number 1 '))).toBe(false); // evicted (seen 1, oldest)
        expect(all.at(-1)).toBe('a brand new lesson that overflows the cap');
    });

    test('rendering is capped to the most recent lessons', () => {
        const book = makeBook();
        book.open('BPRE');
        for (let i = 0; i < CAPS.renderLessons + 5; i++) book.addLesson(`lesson about thing number ${i} xyz`);
        const rendered = book.renderLessons();
        expect(rendered).toHaveLength(CAPS.renderLessons);
        expect(rendered.at(-1)).toContain(`number ${CAPS.renderLessons + 4}`);
        expect(rendered.join('\n')).not.toContain('number 0 ');
    });

    test('an unopened book rejects writes and renders nothing', () => {
        const book = makeBook();
        expect(book.addLesson('anything at all here').added).toBe(false);
        expect(book.addMilestone('a badge')).toBe(false);
        expect(book.renderLessons()).toEqual([]);
        expect(book.renderMilestones()).toEqual([]);
        expect(book.bumpedDirections({ mapId: '3.1', x: 1, y: 1 })).toEqual([]);
    });
});

describe('milestones', () => {
    test('deduplicates and renders the most recent few', () => {
        const book = makeBook();
        book.open('BPRE');
        expect(book.addMilestone('Earned the Boulder Badge!')).toBe(true);
        expect(book.addMilestone('earned the boulder badge')).toBe(false);
        for (let i = 0; i < CAPS.renderMilestones + 3; i++) book.addMilestone(`milestone ${i}`);

        const rendered = book.renderMilestones();
        expect(rendered).toHaveLength(CAPS.renderMilestones);
        expect(rendered.at(-1)).toBe(`milestone ${CAPS.renderMilestones + 2}`);
    });
});

describe('wall bumps', () => {
    test('a wall is only "known" after the report threshold', () => {
        const book = makeBook();
        book.open('BPRE');
        const at = { mapId: '3.1', x: 5, y: 5 };

        book.recordBump({ ...at, direction: 'UP' });
        expect(book.bumpedDirections(at)).toEqual([]); // one misread is not gospel

        book.recordBump({ ...at, direction: 'UP' });
        expect(book.bumpedDirections(at)).toEqual(['UP']);

        // Other tiles and maps are unaffected.
        expect(book.bumpedDirections({ mapId: '3.1', x: 6, y: 5 })).toEqual([]);
        expect(book.bumpedDirections({ mapId: '4.0', x: 5, y: 5 })).toEqual([]);
    });
});

describe('persistence', () => {
    test('everything survives a save/reopen round-trip, per game', () => {
        const file = path.join(dir, 'exp.json');
        const first = new ExperienceBook({ file });
        first.open('AGB-BPRE');
        first.addLesson('Nurse Joy heals the whole party for free');
        first.addMilestone('Got the Pokedex');
        first.recordBump({ mapId: '3.1', x: 5, y: 5, direction: 'UP' });
        first.recordBump({ mapId: '3.1', x: 5, y: 5, direction: 'UP' });
        first.tiles.record({ mapId: '3.1', x: 5, y: 5 });
        first.tiles.record({ mapId: '3.1', x: 6, y: 5 });
        first.save();

        const second = new ExperienceBook({ file });
        const info = second.open('BPRE'); // bare code resolves to the same section
        expect(info).toEqual({ lessons: 1, milestones: 1, mapsSeen: 1 });
        expect(second.renderLessons()).toEqual(['Nurse Joy heals the whole party for free']);
        expect(second.renderMilestones()).toEqual(['Got the Pokedex']);
        expect(second.bumpedDirections({ mapId: '3.1', x: 5, y: 5 })).toEqual(['UP']);
        expect(second.tiles.describe({ mapId: '3.1', x: 5, y: 5 }).visitsHere).toBe(1);
        expect(second.tiles.describe({ mapId: '3.1', x: 5, y: 5 }).unexploredDirections).toEqual(['UP', 'DOWN', 'LEFT']);

        // A different game shares the file but none of the knowledge.
        const emerald = new ExperienceBook({ file });
        expect(emerald.open('BPEE')).toEqual({ lessons: 0, milestones: 0, mapsSeen: 0 });
        emerald.addLesson('Mudkip is the safe Hoenn starter pick');
        emerald.save();

        // Saving one game never clobbers the other.
        const third = new ExperienceBook({ file });
        expect(third.open('BPRE').lessons).toBe(1);
    });

    test('a corrupt file degrades to a fresh book and is overwritten on save', () => {
        const file = path.join(dir, 'exp.json');
        fs.writeFileSync(file, 'not json at all {{{');
        const logs = [];
        const book = new ExperienceBook({ file, log: msg => logs.push(msg) });

        expect(book.open('BPRE')).toEqual({ lessons: 0, milestones: 0, mapsSeen: 0 });
        expect(logs.join('\n')).toContain('starting fresh');

        book.addLesson('a lesson that survives the corruption');
        book.save();
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).games.BPRE.lessons).toHaveLength(1);
    });

    test('save failures log and never throw', () => {
        const logs = [];
        const book = new ExperienceBook({ file: path.join(dir, 'nope', 'deeper', 'exp.json'), log: msg => logs.push(msg) });
        book.open('BPRE');
        book.addLesson('this will not persist but must not crash');
        expect(() => book.save()).not.toThrow();
        expect(logs.join('\n')).toContain('could not save');
    });
});
