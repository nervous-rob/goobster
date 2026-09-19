/**
 * imageSearchService: provider adapters normalize MediaWiki / Perplexity
 * answers into one candidate shape, dedupe, size-filter, rank by lexical
 * relevance, and degrade per provider (an adapter error is reported, never
 * thrown). fetch is injected; no network.
 */
const { ImageSearchService, rankByRelevance, candidateFromImageInfo } = require('../packages/core/services/imageSearchService');

const jacketInfo = {
    title: 'File:M1943 Field Jacket.jpg',
    imageinfo: [{
        size: 60770, width: 300, height: 380, mime: 'image/jpeg',
        url: 'https://upload.wikimedia.org/wikipedia/commons/a/a1/M1943_Field_Jacket.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo',
        thumburl: 'https://upload.wikimedia.org/wikipedia/commons/a/a1/M1943_Field_Jacket.jpg?utm_source=commons.wikimedia.org',
        thumbwidth: 1024, thumbheight: 1297,
        descriptionurl: 'https://commons.wikimedia.org/wiki/File:M1943_Field_Jacket.jpg',
        extmetadata: {
            ImageDescription: { value: 'A photo of an <b>M-1943</b> Field Jacket.' },
            Artist: { value: 'Carl Wouters' },
            Credit: { value: '<a href="http://example.org">http://example.org</a>' },
            LicenseShortName: { value: 'CC BY-SA 3.0' }
        }
    }]
};
const capInfo = {
    title: 'File:German WW2 M43 field cap.jpg',
    imageinfo: [{
        size: 2829958, width: 3249, height: 4875, mime: 'image/jpeg',
        url: 'https://upload.wikimedia.org/wikipedia/commons/9/9c/German_M43_cap.jpg',
        thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9c/German_M43_cap.jpg/1024px-German_M43_cap.jpg',
        thumbwidth: 1024, thumbheight: 1536,
        descriptionurl: 'https://commons.wikimedia.org/wiki/File:German_WW2_M43_field_cap.jpg',
        extmetadata: { Artist: { value: 'Wolfmann' }, LicenseShortName: { value: 'CC BY-SA 4.0' } }
    }]
};
const iconInfo = {
    title: 'File:Jacket icon.png',
    imageinfo: [{ size: 900, width: 64, height: 64, mime: 'image/png', url: 'https://upload.wikimedia.org/icon.png', thumburl: 'https://upload.wikimedia.org/icon.png', thumbwidth: 64, thumbheight: 64, extmetadata: {} }]
};
const svgInfo = {
    title: 'File:Jacket diagram.svg',
    imageinfo: [{
        size: 12000, width: 800, height: 600, mime: 'image/svg+xml',
        url: 'https://upload.wikimedia.org/wikipedia/commons/d/d1/Jacket_diagram.svg',
        thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d1/Jacket_diagram.svg/1024px-Jacket_diagram.svg.png',
        thumbwidth: 1024, thumbheight: 768, descriptionurl: 'https://commons.wikimedia.org/wiki/File:Jacket_diagram.svg',
        extmetadata: { LicenseShortName: { value: 'Public domain' } }
    }]
};

function jsonResponse(body, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

/** Route fetch calls by hostname + a distinguishing query parameter. */
function fakeFetch(handlers) {
    const calls = [];
    const fetch = async (url) => {
        const u = new URL(url);
        calls.push(u);
        for (const [match, handler] of handlers) {
            if (match(u)) return handler(u);
        }
        return jsonResponse({}, false, 404);
    };
    return { fetch, calls };
}

const isCommonsSearch = (u) => u.hostname === 'commons.wikimedia.org' && u.searchParams.get('generator') === 'search';
const isWikiSearch = (u) => u.hostname === 'en.wikipedia.org' && u.searchParams.get('generator') === 'search';
const isWikiInfo = (u) => u.hostname === 'en.wikipedia.org' && u.searchParams.has('titles');

describe('candidateFromImageInfo', () => {
    test('small raster originals are used as-is, tracking params stripped, metadata cleaned', () => {
        const cand = candidateFromImageInfo(jacketInfo, 'Wikimedia Commons');
        expect(cand).toMatchObject({
            title: 'M1943 Field Jacket',
            imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/a1/M1943_Field_Jacket.jpg',
            pageUrl: 'https://commons.wikimedia.org/wiki/File:M1943_Field_Jacket.jpg',
            width: 300, height: 380, mime: 'image/jpeg',
            description: 'A photo of an M-1943 Field Jacket.',
            credit: 'Carl Wouters', license: 'CC BY-SA 3.0', provider: 'Wikimedia Commons'
        });
    });

    test('large originals and SVG pages fall back to the sized raster thumbnail', () => {
        const big = candidateFromImageInfo(capInfo, 'Wikimedia Commons');
        expect(big.imageUrl).toContain('/1024px-German_M43_cap.jpg');
        expect(big).toMatchObject({ width: 1024, height: 1536, mime: 'image/jpeg' });
        const svg = candidateFromImageInfo(svgInfo, 'Wikimedia Commons');
        expect(svg.imageUrl).toMatch(/1024px-Jacket_diagram\.svg\.png$/);
        expect(svg.mime).toBe('image/png');
        expect(candidateFromImageInfo({ title: 'File:x' }, 'p')).toBeNull();
    });
});

describe('search', () => {
    test('merges Wikipedia lead image + Commons hits, dedupes by URL, drops tiny images', async () => {
        const { fetch, calls } = fakeFetch([
            [isWikiSearch, () => jsonResponse({ query: { pages: [{ index: 1, title: 'U.S. Army M1943 uniform', pageimage: 'M1943 Field Jacket.jpg' }] } })],
            [isWikiInfo, () => jsonResponse({ query: { pages: [jacketInfo] } })],
            [isCommonsSearch, () => jsonResponse({ query: { pages: [
                { index: 2, ...capInfo }, { index: 1, ...jacketInfo }, { index: 3, ...iconInfo }
            ] } })]
        ]);
        const svc = new ImageSearchService({ fetch, perplexity: { isConfigured: () => false } });
        const { candidates, providersTried, errors } = await svc.search('M1943 field jacket', { limit: 2 });
        expect(errors).toEqual([]);
        expect(providersTried).toEqual(['wikipedia', 'commons']);
        // One jacket (Wikipedia title wins, Commons duplicate dropped), the cap, no icon
        expect(candidates.map(c => [c.provider, c.title])).toEqual([
            ['Wikipedia', 'U.S. Army M1943 uniform'],
            ['Wikimedia Commons', 'German WW2 M43 field cap']
        ]);
        expect(candidates[0].description).toBe('A photo of an M-1943 Field Jacket.');
        // Requests identify themselves per Wikimedia etiquette
        expect(calls.every(u => u.searchParams.get('format') === 'json')).toBe(true);
        expect(calls.find(isCommonsSearch).searchParams.get('gsrsearch')).toBe('M1943 field jacket filetype:bitmap');
    });

    test('a failing provider is reported, the others still answer', async () => {
        const { fetch } = fakeFetch([
            [isWikiSearch, () => jsonResponse({}, false, 503)],
            [isCommonsSearch, () => jsonResponse({ query: { pages: [{ index: 1, ...jacketInfo }] } })]
        ]);
        const svc = new ImageSearchService({ fetch, perplexity: { isConfigured: () => false } });
        const { candidates, errors } = await svc.search('M1943 field jacket');
        expect(candidates).toHaveLength(1);
        expect(errors).toEqual([expect.stringMatching(/^wikipedia: /)]);
    });

    test('Perplexity is asked only when the free providers come up short, and only when configured', async () => {
        const searchImages = jest.fn(async () => [
            { imageUrl: 'https://img.example.org/a.jpg', pageUrl: 'https://shop.example.org/m43', width: 800, height: 600 }
        ]);
        const emptyFetch = fakeFetch([
            [isWikiSearch, () => jsonResponse({ query: { pages: [] } })],
            [isCommonsSearch, () => jsonResponse({ query: { pages: [] } })]
        ]).fetch;
        const configured = new ImageSearchService({ fetch: emptyFetch, perplexity: { isConfigured: () => true, searchImages } });
        const short = await configured.search('M1943 field jacket', { limit: 2 });
        expect(searchImages).toHaveBeenCalledWith('M1943 field jacket');
        expect(short.candidates).toEqual([expect.objectContaining({
            provider: 'Perplexity', imageUrl: 'https://img.example.org/a.jpg', credit: 'shop.example.org'
        })]);
        expect(short.providersTried).toEqual(['wikipedia', 'commons', 'perplexity']);

        const fullFetch = fakeFetch([
            [isWikiSearch, () => jsonResponse({ query: { pages: [] } })],
            [isCommonsSearch, () => jsonResponse({ query: { pages: [{ index: 1, ...jacketInfo }, { index: 2, ...capInfo }] } })]
        ]).fetch;
        searchImages.mockClear();
        const enough = new ImageSearchService({ fetch: fullFetch, perplexity: { isConfigured: () => true, searchImages } });
        await enough.search('M1943 field jacket', { limit: 2 });
        expect(searchImages).not.toHaveBeenCalled();

        const unconfigured = new ImageSearchService({ fetch: emptyFetch, perplexity: { isConfigured: () => false, searchImages } });
        const none = await unconfigured.search('M1943 field jacket');
        expect(none.candidates).toEqual([]);
        expect(none.providersTried).toEqual(['wikipedia', 'commons']);
        expect(unconfigured.listProviders()).toEqual(['wikipedia', 'commons']);
    });

    test('an empty query asks nobody', async () => {
        const { fetch, calls } = fakeFetch([]);
        const svc = new ImageSearchService({ fetch, perplexity: { isConfigured: () => false } });
        expect(await svc.search('   ')).toEqual({ candidates: [], providersTried: [], errors: [] });
        expect(calls).toHaveLength(0);
    });
});

describe('rankByRelevance', () => {
    const c = (title, description, provider = 'Wikimedia Commons') => ({ title, description, provider, imageUrl: title });

    test('covering more of the query wins; hyphenated designations still match; zero-coverage drops', () => {
        const ranked = rankByRelevance('M1943 field jacket', [
            c('7.62×39mm', 'Lead image of the Wikipedia article "7.62×39mm".', 'Wikipedia'),
            c('German field cap', 'Wehrmacht M43 Einheitsfeldmütze.'),
            c('U.S. Army M1943 uniform', 'A photo of an M-1943 Field Jacket.', 'Wikipedia'),
            c('Field jacket detail', 'M1943 field jacket pocket detail.')
        ]);
        expect(ranked.map(r => r.title)).toEqual([
            'U.S. Army M1943 uniform',
            'Field jacket detail',
            'German field cap'
        ]);
        expect(ranked[0].relevance).toBeGreaterThan(ranked[2].relevance);
    });

    test('providers without titles keep engine order and are never dropped', () => {
        const ranked = rankByRelevance('red panda', [
            { imageUrl: 'p1', provider: 'Perplexity' },
            c('Red panda', 'A red panda in a tree.'),
            { imageUrl: 'p2', provider: 'Perplexity' }
        ]);
        expect(ranked.map(r => r.imageUrl)).toEqual(['Red panda', 'p1', 'p2']);
    });
});
