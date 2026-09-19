/** Scope-aware policy for personal chat, memory and optional tools. */
const { isDmScopeId } = require('../utils/dmScope');
const { isIncognitoToolBlocked } = require('../utils/toolPrivacy');
const MEMORY_WRITERS = new Set(['rememberFact', 'saveArtifact', 'findImages', 'fetchWebFile']);
const MEMORY_READERS = new Set(['lookupNotes', 'showSavedFiles']);

function privateUser(scopeId) {
    return isDmScopeId(scopeId) ? scopeId.slice(3) : null;
}
function privateActor(context) {
    const userId = context?.user?.id;
    const guildId = context?.guildId || context?.guild?.id;
    return userId && (!guildId || guildId === `dm:${userId}`) ? userId : null;
}
async function memoryAllowed(scopeId, key) {
    const userId = privateUser(scopeId);
    if (!userId) return true; // Private settings never rewrite guild policy.
    return await require('./userSettingsService').getPreference(userId, key) !== false;
}
async function toolPolicy(context) {
    const userId = privateActor(context);
    const prefs = userId ? await require('./userSettingsService').getPreferences(userId) : {};
    const disabled = new Set(prefs.disabledTools || []);
    return {
        webSearch: !disabled.has('performSearch'),
        allows: (name) => !isIncognitoToolBlocked(name, context)
            && !disabled.has(name)
            && !(prefs.learnMemories === false && MEMORY_WRITERS.has(name))
            && !(prefs.useMemories === false && MEMORY_READERS.has(name))
    };
}

async function snapshotModel(userId, feature, { personal = true } = {}) {
    const settings = require('./userSettingsService');
    const providers = require('./aiService').listProviders();
    const prefs = personal ? await settings.getPreferences(userId) : {};
    const provider = prefs[`${feature}Provider`] || providers.find(p => p.isDefault)?.key;
    const model = prefs[`${feature}Model`] || providers.find(p => p.key === provider)?.chatModel;
    return { provider: provider || null, model: model || null };
}
module.exports = { privateUser, privateActor, memoryAllowed, toolPolicy, snapshotModel };
