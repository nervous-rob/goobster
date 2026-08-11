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
    conversations: () => request('/api/app/chat/conversations'),
    createConversation: () => request('/api/app/chat/conversations', { method: 'POST' }),
    renameConversation: (id, title) => request(`/api/app/chat/conversations/${id}`, { method: 'PATCH', body: { title } }),
    deleteConversation: (id) => request(`/api/app/chat/conversations/${id}`, { method: 'DELETE' }),
    chatHistory: (conversationId, limit = 200) =>
        request(`/api/app/chat/history?limit=${limit}${conversationId ? `&conversationId=${conversationId}` : ''}`),
    truncate: (conversationId, messageId) =>
        request('/api/app/chat/truncate', { method: 'POST', body: { conversationId, messageId } }),
    stop: () => request('/api/app/chat/stop', { method: 'POST' }),
    chatSettings: () => request('/api/app/chat/settings'),
    setThoughtful: (thoughtful) => request('/api/app/chat/settings', { method: 'PATCH', body: { thoughtful } }),
    report: (scope) => request(`/api/app/memory/report?scope=${encodeURIComponent(scope)}`),
    memories: (scope) => request(`/api/app/memory/memories?scope=${encodeURIComponent(scope)}&limit=300`),
    deleteMemory: (scope, id) => request(`/api/app/memory/memories/${id}?scope=${encodeURIComponent(scope)}`, { method: 'DELETE' }),
    facts: (scope) => request(`/api/app/memory/facts?scope=${encodeURIComponent(scope)}`),
    deleteFact: (scope, id) => request(`/api/app/memory/facts/${id}?scope=${encodeURIComponent(scope)}`, { method: 'DELETE' }),
    graph: (guildId) => request(`/api/app/graph?guildId=${encodeURIComponent(guildId)}`),

    // The Parlor (multi-persona workspace)
    parlorPersonas: () => request('/api/app/parlor/personas'),
    parlorCreatePersona: (persona) => request('/api/app/parlor/personas', { method: 'POST', body: persona }),
    parlorUpdatePersona: (id, fields) => request(`/api/app/parlor/personas/${id}`, { method: 'PATCH', body: fields }),
    parlorDeletePersona: (id) => request(`/api/app/parlor/personas/${id}`, { method: 'DELETE' }),
    parlorNotes: (personaId, { tagId = null, q = null } = {}) => request(
        `/api/app/parlor/personas/${personaId}/notes?` +
        `${tagId ? `tagId=${tagId}&` : ''}${q ? `q=${encodeURIComponent(q)}` : ''}`),
    parlorCreateNote: (personaId, note) =>
        request(`/api/app/parlor/personas/${personaId}/notes`, { method: 'POST', body: note }),
    parlorUpdateNote: (noteId, fields) =>
        request(`/api/app/parlor/notes/${noteId}`, { method: 'PATCH', body: fields }),
    parlorDeleteNote: (noteId) => request(`/api/app/parlor/notes/${noteId}`, { method: 'DELETE' }),
    parlorTags: (personaId) => request(`/api/app/parlor/personas/${personaId}/tags`),
    parlorSuggestTags: (personaId, title, content) =>
        request(`/api/app/parlor/personas/${personaId}/suggest-tags`, { method: 'POST', body: { title, content } }),
    parlorGraph: (personaId) => request(`/api/app/parlor/personas/${personaId}/graph`),
    parlorSearch: (personaId, q) =>
        request(`/api/app/parlor/personas/${personaId}/search?q=${encodeURIComponent(q)}`),
    parlorConversations: () => request('/api/app/parlor/conversations'),
    parlorCreateConversation: (personaIds) =>
        request('/api/app/parlor/conversations', { method: 'POST', body: { personaIds } }),
    parlorRenameConversation: (id, title) =>
        request(`/api/app/parlor/conversations/${id}`, { method: 'PATCH', body: { title } }),
    parlorDeleteConversation: (id) => request(`/api/app/parlor/conversations/${id}`, { method: 'DELETE' }),
    parlorSetParticipant: (conversationId, personaId, present) =>
        request(`/api/app/parlor/conversations/${conversationId}/participants/${personaId}`,
            { method: present ? 'PUT' : 'DELETE' }),
    parlorMessages: (conversationId, limit = 200) =>
        request(`/api/app/parlor/conversations/${conversationId}/messages?limit=${limit}`),
    parlorStop: () => request('/api/app/parlor/stop', { method: 'POST' })
};

export { ApiError };

/**
 * POST a chat message and stream the Server-Sent Events reply.
 * EventSource cannot POST, so the stream is parsed off fetch's body reader.
 * @param {Object} payload - { message, conversationId, images }
 * @param {Object} handlers - { onStart, onTyping, onDelta, onMessage, onError, onDone }
 * @param {AbortSignal} [signal] - aborts the read (the Stop button)
 */
export async function streamChat(payload, handlers = {}, signal = null) {
    const res = await fetch('/api/app/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal
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

        if (event === 'start') handlers.onStart?.(data);
        else if (event === 'typing') handlers.onTyping?.();
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

/**
 * POST a parlor turn and stream the SSE reply (same framing as streamChat,
 * with the parlor's multi-persona event vocabulary).
 * @param {Object} payload - { message, conversationId }
 * @param {Object} handlers - { onStart, onUserMessage, onPersonaStart, onDelta,
 *                              onPersonaMessage, onLearned, onError, onDone }
 * @param {AbortSignal} [signal]
 */
export async function streamParlorChat(payload, handlers = {}, signal = null) {
    const res = await fetch('/api/app/parlor/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal
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

        if (event === 'start') handlers.onStart?.(data);
        else if (event === 'user_message') handlers.onUserMessage?.(data);
        else if (event === 'persona_start') handlers.onPersonaStart?.(data);
        else if (event === 'delta') handlers.onDelta?.(data.text || '');
        else if (event === 'persona_message') handlers.onPersonaMessage?.(data);
        else if (event === 'learned') handlers.onLearned?.(data);
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
