/**
 * Capability declarations for sandboxed mini-apps.
 */
const {
    extractObservatoryReadProjects,
    observatoryContentUrl,
    normalizeObservatoryGrants,
    legalizeObservatoryGrants,
    isObservatoryReadAllowed
} = require('@goobster/core/utils/appletCapabilities');

describe('extractObservatoryReadProjects', () => {
    test('reads one or more meta tags, including comma lists', () => {
        const source = `
            <html><head>
              <meta name="goobster-observatory-read" content="jwst-atlas">
              <meta content="other-lab, third" name="goobster-observatory-read">
            </head></html>
        `;
        expect(extractObservatoryReadProjects(source)).toEqual([
            'jwst-atlas', 'other-lab', 'third'
        ]);
    });

    test('drops invalid slugs, duplicates, and unrelated meta tags', () => {
        const source = `
            <meta name="viewport" content="width=device-width">
            <meta name="goobster-observatory-read" content="Good-Slug, ../etc, JWST-ATLAS, good-slug">
        `;
        expect(extractObservatoryReadProjects(source)).toEqual(['good-slug', 'jwst-atlas']);
    });

    test('returns empty when nothing is declared', () => {
        expect(extractObservatoryReadProjects('<html></html>')).toEqual([]);
        expect(extractObservatoryReadProjects('')).toEqual([]);
    });
});

describe('observatoryContentUrl', () => {
    test('encodes each path segment and the project slug', () => {
        expect(observatoryContentUrl('jwst-atlas', 'live_pointings/pointings 2026.json'))
            .toBe('/api/app/observatory/projects/jwst-atlas/content/live_pointings/pointings%202026.json');
    });
});

describe('grant legalization', () => {
    test('keeps only declared, well-formed slugs', () => {
        const source = '<meta name="goobster-observatory-read" content="jwst-atlas">';
        expect(legalizeObservatoryGrants(source, {
            observatoryRead: ['jwst-atlas', 'other-lab', '../x']
        })).toEqual({ observatoryRead: ['jwst-atlas'] });
        expect(normalizeObservatoryGrants(['JWST-Atlas', 'jwst-atlas'])).toEqual({
            observatoryRead: ['jwst-atlas']
        });
    });
});

describe('own-project vs cross-project grant resolution', () => {
    const ownSource = '<html><title>Dashboard</title></html>';
    const crossSource = '<html><head><meta name="goobster-observatory-read" content="other-lab"></head></html>';

    test('an app rendered inside its project may read that workspace with no tag and no grant', () => {
        expect(isObservatoryReadAllowed('neurogene-lab', {
            source: ownSource,
            grants: { observatoryRead: [] },
            ownProject: 'neurogene-lab'
        })).toBe(true);
        expect(isObservatoryReadAllowed('Neurogene-Lab', {
            source: ownSource,
            ownProject: 'neurogene-lab'
        })).toBe(true);
    });

    test('cross-project reads still need a declared tag plus an approved grant', () => {
        expect(isObservatoryReadAllowed('other-lab', {
            source: ownSource,
            grants: { observatoryRead: ['other-lab'] },
            ownProject: 'neurogene-lab'
        })).toBe(false);
        expect(isObservatoryReadAllowed('other-lab', {
            source: crossSource,
            grants: { observatoryRead: [] },
            ownProject: 'neurogene-lab'
        })).toBe(false);
        expect(isObservatoryReadAllowed('other-lab', {
            source: crossSource,
            grants: { observatoryRead: ['other-lab'] },
            ownProject: 'neurogene-lab'
        })).toBe(true);
    });

    test('legacy Workshop pins (no ownProject) keep the declare+grant rule', () => {
        expect(isObservatoryReadAllowed('jwst-atlas', {
            source: '<meta name="goobster-observatory-read" content="jwst-atlas">',
            grants: { observatoryRead: ['jwst-atlas'] }
        })).toBe(true);
        expect(isObservatoryReadAllowed('jwst-atlas', {
            source: '<html></html>',
            grants: { observatoryRead: ['jwst-atlas'] }
        })).toBe(false);
        expect(isObservatoryReadAllowed('jwst-atlas', {
            source: '<meta name="goobster-observatory-read" content="jwst-atlas">',
            grants: { observatoryRead: [] },
            ownProject: null
        })).toBe(false);
    });

    test('an invalid or empty requested slug is never allowed', () => {
        expect(isObservatoryReadAllowed('../etc', { ownProject: '../etc' })).toBe(false);
        expect(isObservatoryReadAllowed('', { ownProject: 'lab' })).toBe(false);
    });
});
