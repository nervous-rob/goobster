/**
 * The YAML campaign loader: built-in campaigns must load and validate
 * cleanly, and the validator must catch the mistakes campaign authors
 * (human or AI) are most likely to make.
 */
const questLoader = require('../services/tavern/questLoader');
const { DIFFICULTY } = require('../services/tavern/content');

describe('built-in campaigns', () => {
    test('load, validate, and register on the quest board', () => {
        const quests = questLoader.getQuests();
        expect(Object.keys(quests)).toEqual(
            expect.arrayContaining(['missing-bell-of-brinewatch', 'rat-problem'])
        );
    });

    test('Brinewatch has its scenes, endings, clocks, and start wired up', () => {
        const quest = questLoader.getQuest('missing-bell-of-brinewatch');
        expect(quest.start).toBe('arrival');
        expect(Object.keys(quest.scenes)).toEqual(
            expect.arrayContaining(['arrival', 'chapel', 'crypt', 'finale'])
        );
        expect(Object.keys(quest.endings)).toEqual(
            expect.arrayContaining(['hang-bell', 'sink-bell', 'beacon-bell', 'collapse-escape'])
        );
        const collapse = quest.clocks.find(c => c.id === 'collapse');
        expect(collapse.kind).toBe('danger');
        expect(collapse.onFull).toEqual({ end: 'collapse-escape' });
        expect(questLoader.validateQuest(quest)).toEqual([]);
    });

    test('every built-in campaign validates with zero errors', () => {
        for (const quest of Object.values(questLoader.getQuests())) {
            expect(questLoader.validateQuest(quest)).toEqual([]);
        }
    });
});

describe('validateQuest', () => {
    const minimalQuest = () => ({
        id: 'test-quest',
        title: 'A Test',
        hook: 'Testing.',
        players: { min: 1, max: 2 },
        start: 'one',
        clocks: [{ id: 'doom', name: 'Doom', size: 4, kind: 'danger', onFull: { end: 'fin' } }],
        scenes: {
            one: {
                id: 'one', title: 'One', text: 'A scene.',
                options: [
                    { key: 'punch', label: 'Punch it', stat: 'might', dc: 'challenging',
                        success: { text: 'ok', effects: { end: 'fin' } },
                        failure: { text: 'ouch', effects: { clock: { id: 'doom', delta: 1 } } } }
                ]
            }
        },
        endings: { fin: { id: 'fin', title: 'Fin', text: 'The end.' } }
    });

    test('accepts a minimal valid quest', () => {
        expect(questLoader.validateQuest(minimalQuest())).toEqual([]);
    });

    test('catches dangling scene/ending/clock references', () => {
        const quest = minimalQuest();
        quest.start = 'nowhere';
        quest.scenes.one.options[0].success.effects = { goto: 'missing-scene' };
        quest.scenes.one.options[0].failure.effects = { clock: { id: 'ghost-clock', delta: 1 } };
        const errors = questLoader.validateQuest(quest);
        expect(errors.join('\n')).toMatch(/start must name an existing scene/);
        expect(errors.join('\n')).toMatch(/unknown scene 'missing-scene'/);
        expect(errors.join('\n')).toMatch(/clock effect needs/);
    });

    test('catches bad stats, DCs, and unknown effects', () => {
        const quest = minimalQuest();
        quest.scenes.one.options[0].stat = 'charisma';
        quest.scenes.one.options[0].dc = 'impossible';
        quest.scenes.one.options[0].success.effects = { teleport: true };
        const errors = questLoader.validateQuest(quest);
        expect(errors.join('\n')).toMatch(/stat must be one of/);
        expect(errors.join('\n')).toMatch(/dc must be 2-30/);
        expect(errors.join('\n')).toMatch(/unknown effect 'teleport'/);
    });

    test('option keys must be unique slugs without underscores (customId-safe)', () => {
        const quest = minimalQuest();
        quest.scenes.one.options.push({ key: 'bad_key', label: 'Nope', goto: 'one' });
        const errors = questLoader.validateQuest(quest);
        expect(errors.join('\n')).toMatch(/without underscores/);
    });

    test('an option cannot be both a check and a travel option', () => {
        const quest = minimalQuest();
        quest.scenes.one.options[0].goto = 'one';
        const errors = questLoader.validateQuest(quest);
        expect(errors.join('\n')).toMatch(/either a check .* or a direct goto\/end/);
    });
});

describe('resolveDc', () => {
    test('accepts band names and sane numbers, rejects the rest', () => {
        expect(questLoader.resolveDc('routine')).toBe(DIFFICULTY.routine);
        expect(questLoader.resolveDc('challenging')).toBe(13);
        expect(questLoader.resolveDc(16)).toBe(16);
        expect(questLoader.resolveDc('impossible')).toBeNull();
        expect(questLoader.resolveDc(1)).toBeNull();
        expect(questLoader.resolveDc(99)).toBeNull();
    });
});
