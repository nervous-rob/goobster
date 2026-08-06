/**
 * Thin fetch wrapper for the web app API, plus the SSE reader used by chat.
 * Session auth rides on the httpOnly cookie - nothing to attach here.
 */

class ApiError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

async function request(path, { method = 'GET', body = null } = {}) {
    const res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : null
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
        const error = json?.error || {};
        throw new ApiError(res.status, error.code || 'INTERNAL', error.message || `Request failed (${res.status})`);
    }
    return json;
}

export const api = {
    config: () => request('/api/app/config'),
    me: () => request('/api/app/me'),
    logout: () => request('/api/app/auth/logout', { method: 'POST' }),
    devSession: (userId, name) => request('/api/app/auth/dev-session', { method: 'POST', body: { userId, name } }),
    chatHistory: (limit = 100) => request(`/api/app/chat/history?limit=${limit}`),
    report: (scope) => request(`/api/app/memory/report?scope=${encodeURIComponent(scope)}`),
    memories: (scope) => request(`/api/app/memory/memories?scope=${encodeURIComponent(scope)}&limit=300`),
    deleteMemory: (scope, id) => request(`/api/app/memory/memories/${id}?scope=${encodeURIComponent(scope)}`, { method: 'DELETE' }),
    facts: (scope) => request(`/api/app/memory/facts?scope=${encodeURIComponent(scope)}`),
    deleteFact: (scope, id) => request(`/api/app/memory/facts/${id}?scope=${encodeURIComponent(scope)}`, { method: 'DELETE' }),
    graph: (guildId) => request(`/api/app/graph?guildId=${encodeURIComponent(guildId)}`)
};

export { ApiError };

/**
 * POST a chat message and stream the Server-Sent Events reply.
 * EventSource cannot POST, so the stream is parsed off fetch's body reader.
 * @param {string} message
 * @param {Object} handlers - { onTyping, onDelta, onMessage, onError, onDone }
 */
export async function streamChat(message, handlers = {}) {
    const res = await fetch('/api/app/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message })
    });

    if (!res.ok) {
        let json = null;
        try { json = await res.json(); } catch { /* not JSON */ }
        const error = json?.error || {};
        throw new ApiError(res.status, error.code || 'INTERNAL', error.message || `Request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const dispatch = (rawEvent) => {
        let event = 'message';
        const dataLines = [];
        for (const line of rawEvent.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) return;
        let data;
        try { data = JSON.parse(dataLines.join('\n')); } catch { return; }

        if (event === 'typing') handlers.onTyping?.();
        else if (event === 'delta') handlers.onDelta?.(data.text || '');
        else if (event === 'message') handlers.onMessage?.(data);
        else if (event === 'error') handlers.onError?.(data);
        else if (event === 'done') handlers.onDone?.(data);
    };

    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const rawEvent = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (rawEvent.trim() && !rawEvent.startsWith(':')) dispatch(rawEvent);
        }
    }
}
