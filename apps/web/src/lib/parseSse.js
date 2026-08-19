/**
 * SSE frame helpers shared by the React client and Jest.
 * EventSource cannot POST, so chat/parlor turns parse fetch body streams.
 * ESM so Vite can bundle it; Jest loads it with dynamic import().
 */

export function parseSseFrame(rawEvent) {
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
export const HINT_TO_KEYS = {
    home: [['home']],
    tasks: [['tasks'], ['home']]
};

export function queryKeysForInvalidation(hints) {
    const out = [];
    const seen = new Set();
    for (const hint of hints || []) {
        for (const key of (HINT_TO_KEYS[hint] || [[hint]])) {
            const id = JSON.stringify(key);
            if (seen.has(id)) continue;
            seen.add(id);
            out.push(key);
        }
    }
    return out;
}
