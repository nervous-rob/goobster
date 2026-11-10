// These tools write conversation-derived content to durable memory, files or
// records (a capability gap is derived from what the person asked for, so an
// incognito turn must not leave one behind either). Keep selection and
// execution on the same policy, including stale tool calls.
//
// The delegation tools are blocked for both directions: an incognito turn
// neither reads delegated work into the conversation nor drafts or steers
// it (documentation/delegated_conversation.md).
const DELEGATION_TOOLS = new Set(['proposeResponsibility', 'describeDelegatedWork', 'controlDelegatedWork']);
const INCOGNITO_BLOCKED_TOOLS = new Set([
    'rememberFact', 'saveArtifact', 'findImages', 'fetchWebFile', 'noteCapabilityGap',
    ...DELEGATION_TOOLS
]);

function isIncognitoToolBlocked(name, context) {
    return context?.skipHistory === true && INCOGNITO_BLOCKED_TOOLS.has(name);
}

/** What a blocked tool answers in an incognito turn. */
function incognitoRefusal(name) {
    return DELEGATION_TOOLS.has(name)
        ? '❌ Delegated work is not read or changed in incognito. Use a regular chat for this.'
        : '❌ Saving memories, files and records is disabled in incognito. Use a regular chat to save this content.';
}

module.exports = { isIncognitoToolBlocked, incognitoRefusal, INCOGNITO_BLOCKED_TOOLS };
