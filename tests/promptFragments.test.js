/**
 * Shared prompt fragments: portal/parlor rendering must stay in lockstep,
 * personality directives must label DM vs server, and retired slash
 * protocol must not be taught as the live invocation path.
 */
const { DEFAULT_PROMPT } = require('@goobster/core/utils/chat/prompts');
const {
    FALLBACK_PERSONALITY,
    MINI_APP_BRIDGE,
    CRON_FROM_NL_SYSTEM,
    richRenderingContract,
    personalityDirectiveBlock,
    groundedRecallPrompt
} = require('@goobster/core/utils/chat/promptFragments');

describe('rich rendering contract', () => {
    test('portal and parlor share the Observatory mini-app bridge', () => {
        const portal = richRenderingContract({ surface: 'portal' });
        const parlor = richRenderingContract({ surface: 'parlor' });
        for (const text of [portal, parlor, MINI_APP_BRIDGE]) {
            expect(text).toContain('goobster-observatory-read');
            expect(text).toContain("type: 'observatory.read'");
            expect(text).toContain('Never ask for allow-same-origin');
            expect(text).toContain('cannot fetch /api/app');
        }
        expect(portal).toContain('WEB PORTAL:');
        expect(parlor).toContain('RENDERING (the parlor renders rich replies)');
        expect(parlor).toContain('```html');
    });
});

describe('personality and slash protocol', () => {
    test('DEFAULT_PROMPT is personality, not a slash-command catalog', () => {
        expect(DEFAULT_PROMPT.startsWith(FALLBACK_PERSONALITY)).toBe(true);
        expect(DEFAULT_PROMPT).not.toContain('/search query:');
        expect(DEFAULT_PROMPT).not.toContain('/generate image:');
        expect(DEFAULT_PROMPT).not.toContain('EXACT format');
    });

    test('personality directives label DM scope separately from a server', () => {
        expect(personalityDirectiveBlock({ isGuild: true, directive: 'Be brief.' }))
            .toBe('SERVER DIRECTIVE (wins on conflict):\nBe brief.');
        expect(personalityDirectiveBlock({ isGuild: false, directive: 'Be brief.' }))
            .toBe('DM DIRECTIVE (wins on conflict):\nBe brief.');
        expect(personalityDirectiveBlock({ isGuild: true, directive: '  ' })).toBeNull();
    });
});

describe('groundedRecallPrompt', () => {
    test('graph notes come first; legacy facts only when the graph is empty', () => {
        const withGraph = groundedRecallPrompt({
            graphExcerpt: 'Ship on Fridays',
            memoryLines: ['- [2026-01-01] Rob: we ship Fridays'],
            legacyFacts: ['Old unused fact']
        });
        expect(withGraph).toContain('SERVER NOTES (knowledge graph)');
        expect(withGraph).toContain('Ship on Fridays');
        expect(withGraph).toContain('MEMORY EXCERPTS');
        expect(withGraph).not.toContain('LEGACY SERVER FACTS');
        expect(withGraph).not.toContain('Old unused fact');

        const fallback = groundedRecallPrompt({
            legacyFacts: ['Currency is called Jimmy points']
        });
        expect(fallback).toContain('LEGACY SERVER FACTS');
        expect(fallback).toContain('Jimmy points');
        expect(fallback).not.toContain('KNOWN SERVER FACTS');
    });
});

describe('cron NL prompt', () => {
    test('asks for a 5-part expression or INVALID', () => {
        expect(CRON_FROM_NL_SYSTEM).toContain('m h dom mon dow');
        expect(CRON_FROM_NL_SYSTEM).toContain('INVALID');
        expect(CRON_FROM_NL_SYSTEM).toContain('every day at 9am');
    });
});
