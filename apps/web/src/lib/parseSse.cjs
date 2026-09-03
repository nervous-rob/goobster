/**
 * SSE frame helpers shared by the React client and Jest.
 * EventSource cannot POST, so chat/parlor turns parse fetch body streams.
 * CommonJS so Jest can require() it from the type:module @goobster/web
 * workspace; Vite interops the same file.
 */

function parseSseFrame(rawEvent) {
    let event = 'message';
    const dataLines = [];
    for (const line of String(rawEvent).split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return null;
    let data;
    try {
        data = JSON.parse(dataLines.join('\n'));
    } catch {
        return null;
    }
    return { event, data };
}

/** Map portal-event invalidation hints onto TanStack Query key prefixes. */
const HINT_TO_KEYS = {
    home: [['home']],
    tasks: [['tasks'], ['home']],
    attention: [['attention'], ['home']],
    observatory: [['observatory']],
    'project-invites': [['project-invites'], ['observatory']]
};

/**
 * One hint's query keys. Beyond the static map, a scoped hint of the form
 * `name:id` (e.g. parlor-messages:12) targets exactly one keyed query -
 * numeric ids are converted so the key matches the client's number-keyed
 * queries. Unknown plain hints fall back to a same-named key prefix.
 */
function keysForHint(hint) {
    if (HINT_TO_KEYS[hint]) return HINT_TO_KEYS[hint];
    const colon = String(hint).indexOf(':');
    if (colon > 0) {
        const name = hint.slice(0, colon);
        const id = hint.slice(colon + 1);
        return [[name, /^\d+$/.test(id) ? Number(id) : id]];
    }
    return [[hint]];
}

function queryKeysForInvalidation(hints) {
    const out = [];
    const seen = new Set();
    for (const hint of hints || []) {
        for (const key of keysForHint(hint)) {
            const id = JSON.stringify(key);
            if (seen.has(id)) continue;
            seen.add(id);
            out.push(key);
        }
    }
    return out;
}

module.exports = { parseSseFrame, queryKeysForInvalidation, HINT_TO_KEYS };
