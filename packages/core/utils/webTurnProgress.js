/**
 * In-flight Study turn progress: the same timeline the React composer
 * reducer builds (interstitial text + tool chips + the current draft).
 * Kept pure so the server snapshot and the browser hydrate identically.
 */

function emptyProgress(userContent = '') {
    return {
        userContent: String(userContent || ''),
        draft: '',
        typing: false,
        steps: []
    };
}

function cloneProgress(progress) {
    const src = progress && typeof progress === 'object' ? progress : emptyProgress();
    return {
        userContent: String(src.userContent || ''),
        draft: String(src.draft || ''),
        typing: Boolean(src.typing),
        steps: Array.isArray(src.steps) ? src.steps.map((step) => ({ ...step })) : []
    };
}

function parseProgress(json) {
    if (!json) return emptyProgress();
    if (typeof json === 'object') return cloneProgress(json);
    try {
        return cloneProgress(JSON.parse(json));
    } catch {
        return emptyProgress();
    }
}

function applyProgressEvent(progress, kind, payload) {
    const next = progress || emptyProgress();
    if (kind === 'typing') {
        next.typing = true;
        return next;
    }
    if (kind === 'delta') {
        next.draft += String(payload || '');
        next.typing = false;
        return next;
    }
    if (kind === 'tool') {
        const event = payload && typeof payload === 'object' ? payload : {};
        if (event.phase === 'start') {
            if (next.draft.trim()) {
                next.steps.push({ type: 'text', content: next.draft });
            }
            next.steps.push({
                type: 'tool',
                id: event.id,
                name: event.name,
                cached: event.cached,
                argsPreview: event.argsPreview,
                running: true
            });
            next.draft = '';
            next.typing = false;
            return next;
        }
        let index = next.steps.findIndex((step) => step.type === 'tool' && step.running
            && (event.id !== undefined ? step.id === event.id : step.name === event.name));
        if (index === -1) index = next.steps.length;
        const previous = next.steps[index] || {};
        next.steps[index] = {
            type: 'tool',
            id: event.id,
            name: event.name,
            cached: event.cached,
            isError: event.isError,
            argsPreview: previous.argsPreview ?? event.argsPreview,
            resultPreview: event.resultPreview,
            durationMs: event.durationMs,
            running: false
        };
        next.typing = false;
        return next;
    }
    if (kind === 'message') {
        next.draft = '';
        next.steps = [];
        next.typing = false;
        return next;
    }
    return next;
}

module.exports = {
    emptyProgress,
    cloneProgress,
    parseProgress,
    applyProgressEvent
};
