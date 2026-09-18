/**
 * Portal tool-chip labels: observatory/project calls need visible context
 * (action, file, project) so a phone can read them without hovering.
 */
const {
    toolLabel,
    parseArgsPreview,
    describeToolChip,
    chipHoverTitle
} = require('../apps/web/src/lib/toolChipLabel.cjs');

describe('toolLabel', () => {
    test('keeps the familiar verbs for ordinary tools', () => {
        expect(toolLabel('performSearch', false)).toBe('Searching the web');
        expect(toolLabel('performSearch', true)).toBe('Searched the web');
        expect(toolLabel('runCode', true)).toBe('Ran code');
    });

    test('falls back to a readable phrase for unknown tools', () => {
        expect(toolLabel('customThing', false)).toBe('Working: custom thing');
        expect(toolLabel('customThing', true)).toBe('Finished: custom thing');
    });
});

describe('parseArgsPreview', () => {
    test('parses a full JSON preview', () => {
        expect(parseArgsPreview('{"action":"read","project":"jwst-atlas","path":"notes.md"}'))
            .toEqual({ action: 'read', project: 'jwst-atlas', path: 'notes.md' });
    });

    test('salvages fields from a truncated run preview', () => {
        const preview = '{"action":"run","project":"jwst-atlas","language":"python","code":"import numpy as np\\n…';
        const parsed = parseArgsPreview(preview);
        expect(parsed.action).toBe('run');
        expect(parsed.project).toBe('jwst-atlas');
        expect(parsed.language).toBe('python');
    });

    test('returns null for empty chips', () => {
        expect(parseArgsPreview()).toBeNull();
        expect(parseArgsPreview('{}')).toBeNull();
    });
});

describe('describeToolChip', () => {
    test('puts read path and project in the header, not only a hover title', () => {
        const chip = describeToolChip(
            'observatory',
            '{"action":"read","project":"jwst-atlas","path":"src/notes.md"}',
            { done: true }
        );
        expect(chip.verb).toBe('Read');
        expect(chip.context).toBe('notes.md · jwst-atlas');
        expect(chip.header).toBe('Read · notes.md · jwst-atlas');
    });

    test('labels a live run with language and project', () => {
        const chip = describeToolChip(
            'observatory',
            '{"action":"run","project":"jwst-atlas","language":"python","background":true}',
            { done: false }
        );
        expect(chip.verb).toBe('Running');
        expect(chip.context).toBe('python · background · jwst-atlas');
        expect(chip.header).toBe('Running · python · background · jwst-atlas');
    });

    test('labels inspect / mission / fetch without requiring hover', () => {
        expect(describeToolChip(
            'observatory',
            '{"action":"inspect","project":"jwst-atlas"}',
            { done: true }
        ).header).toBe('Inspected · jwst-atlas');

        expect(describeToolChip(
            'observatory',
            '{"action":"mission","missionAction":"propose","project":"jwst-atlas","title":"pgvector"}',
            { done: false }
        ).header).toBe('Proposing mission · jwst-atlas');

        expect(describeToolChip(
            'observatory',
            '{"action":"fetch-data","project":"jwst-atlas","saveAs":"jades.csv"}',
            { done: true }
        ).header).toBe('Fetched data · jades.csv · jwst-atlas');
    });

    test('still works when the preview is truncated mid-code', () => {
        const chip = describeToolChip(
            'observatory',
            '{"action":"run","project":"lab","language":"javascript","code":"console.log(1)…',
            { done: true }
        );
        expect(chip.header).toBe('Ran · javascript · lab');
    });

    test('falls back when observatory args are missing', () => {
        expect(describeToolChip('observatory', '{}', { done: false }).header)
            .toBe('Working: observatory');
        expect(describeToolChip('observatory', undefined, { done: true }).header)
            .toBe('Finished: observatory');
    });

    test('leaves ordinary tools as a single-line verb', () => {
        const chip = describeToolChip('performSearch', '{"query":"grassmannian"}', { done: false });
        expect(chip.verb).toBe('Searching the web');
        expect(chip.context).toBe('');
        expect(chip.header).toBe('Searching the web');
    });
});

describe('chipHoverTitle', () => {
    test('still offers the raw preview for extra detail', () => {
        expect(chipHoverTitle('{"action":"read"}', '12 lines')).toBe('{"action":"read"}\n→ 12 lines');
        expect(chipHoverTitle('{}')).toBeUndefined();
    });
});
