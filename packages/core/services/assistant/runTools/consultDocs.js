/**
 * Run capability: search Goobster's own public documentation. Touches
 * nothing of the person's, so it needs no grant.
 */

module.exports = {
    consultDocs: {
        effect: 'read',
        definition: {
            name: 'consultDocs',
            description: 'Search Goobster\'s own public documentation.',
            parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        },
        needs: () => null,
        async run({ query }, ctx) {
            return require('../../../utils/toolsRegistry').execute('consultDocs', {
                action: 'search', query: String(query || ''), interactionContext: ctx.interactionContext
            });
        }
    }
};
