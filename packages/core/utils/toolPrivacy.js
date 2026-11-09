// These tools write conversation-derived content to durable memory, files or
// records (a capability gap is derived from what the person asked for, so an
// incognito turn must not leave one behind either). Keep selection and
// execution on the same policy, including stale tool calls.
const INCOGNITO_BLOCKED_TOOLS = new Set([
    'rememberFact', 'saveArtifact', 'findImages', 'fetchWebFile', 'noteCapabilityGap'
]);

function isIncognitoToolBlocked(name, context) {
    return context?.skipHistory === true && INCOGNITO_BLOCKED_TOOLS.has(name);
}

module.exports = { isIncognitoToolBlocked };
