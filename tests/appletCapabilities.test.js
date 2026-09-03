/**
 * Capability declarations for sandboxed mini-apps.
 */
const {
    extractObservatoryReadProjects,
    observatoryContentUrl,
    normalizeObservatoryGrants,
    legalizeObservatoryGrants
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
