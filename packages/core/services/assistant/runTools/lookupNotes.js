/**
 * Run capability: look up the person's own notes, memories and saved files
 * (needs `read` on `knowledge`).
 */

module.exports = {
    lookupNotes: {
        effect: 'read',
        source: 'private',
        definition: {
            name: 'lookupNotes',
            description: 'Look up what is already in the person\'s own notes, memories and saved files about a topic.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to look up.' } }, required: ['query'] }
        },
        needs: () => ({ operation: 'read', resource: { kind: 'knowledge', id: 'personal' } }),
        async run({ query }, ctx) {
            return require('../../../utils/toolsRegistry').execute('lookupNotes', {
                query: String(query || ''), about: 'me', interactionContext: ctx.interactionContext
            });
        }
    }
};
