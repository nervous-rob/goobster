/**
 * Run capability: search the web (needs `read` on `web`; counts against the
 * daily search budget).
 */

module.exports = {
    searchWeb: {
        effect: 'read',
        budget: 'searches',
        definition: {
            name: 'searchWeb',
            description: 'Search the web and return a short sourced summary. Each search counts against a small daily budget; search only for what the task needs.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to search for.' } }, required: ['query'] }
        },
        needs: () => ({ operation: 'read', resource: { kind: 'web' } }),
        async run({ query }) {
            if (!query || typeof query !== 'string') return 'A search query is required.';
            return require('../../perplexityService').search(query);
        }
    }
};
