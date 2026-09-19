// These tools write conversation-derived content to durable memory or files.
// Keep selection and execution on the same policy, including stale tool calls.
const INCOGNITO_BLOCKED_TOOLS = new Set([
    'rememberFact', 'saveArtifact', 'findImages', 'fetchWebFile'
]);

function isIncognitoToolBlocked(name, context) {
    return context?.skipHistory === true && INCOGNITO_BLOCKED_TOOLS.has(name);
}

module.exports = { isIncognitoToolBlocked };
