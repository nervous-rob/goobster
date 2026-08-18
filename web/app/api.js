/**
 * Thin fetch wrapper for the web app API, plus the SSE reader used by chat.
 * Session auth rides on the httpOnly cookie - nothing to attach here.
 */

class ApiError extends Error {
    constructor(status, code, message, details = null) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
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
        throw new ApiError(res.status, error.code || 'INTERNAL',
            error.message || `Request failed (${res.status})`, error.details || null);
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
    branch: (conversationId, messageId) =>
        request(`/api/app/chat/conversations/${conversationId}/branch`, { method: 'POST', body: { messageId } }),
    shareStatus: (conversationId) =>
        request(`/api/app/chat/conversations/${conversationId}/share`),
    createShare: (conversationId) =>
        request(`/api/app/chat/conversations/${conversationId}/share`, { method: 'POST' }),
    revokeShare: (conversationId) =>
        request(`/api/app/chat/conversations/${conversationId}/share`, { method: 'DELETE' }),
    stop: () => request('/api/app/chat/stop', { method: 'POST' }),
    turnStatus: () => request('/api/app/chat/turn'),
    voiceCapabilities: () => request('/api/app/voice/capabilities'),
    transcribe: (audio, mimeType) =>
        request('/api/app/voice/transcribe', { method: 'POST', body: { audio, mimeType } }),
    tasks: () => request('/api/app/tasks'),
    createTask: (task) => request('/api/app/tasks', { method: 'POST', body: task }),
    toggleAutomation: (id, enabled) =>
        request(`/api/app/tasks/automations/${id}`, { method: 'PATCH', body: { enabled } }),
    deleteAutomation: (id) => request(`/api/app/tasks/automations/${id}`, { method: 'DELETE' }),
    cancelFollowup: (id) => request(`/api/app/tasks/followups/${id}`, { method: 'DELETE' }),
    usage: (days = 30) => request(`/api/app/usage?days=${days}`),
    retention: (scope) => request(`/api/app/memory/retention?scope=${encodeURIComponent(scope)}`),
    setRetention: (scope, days) =>
        request('/api/app/memory/retention', { method: 'PUT', body: { scope, days } }),
    searchMessages: (query, limit = 20) =>
        request(`/api/app/chat/search?q=${encodeURIComponent(query)}&limit=${limit}`),
    chatSettings: () => request('/api/app/chat/settings'),
    listModels: (provider) =>
        request(`/api/app/chat/models${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`),
    setThoughtful: (thoughtful) => request('/api/app/chat/settings', { method: 'PATCH', body: { thoughtful } }),
    saveChatSettings: (fields) => request('/api/app/chat/settings', { method: 'PATCH', body: fields }),
    clearIncognito: () => request('/api/app/chat/incognito', { method: 'DELETE' }),
    integrations: () => request('/api/app/integrations'),
    connectIntegration: (provider, token) =>
        request(`/api/app/integrations/${provider}`, { method: 'POST', body: { token } }),
    disconnectIntegration: (provider) =>
        request(`/api/app/integrations/${provider}`, { method: 'DELETE' }),
    report: (scope) => request(`/api/app/memory/report?scope=${encodeURIComponent(scope)}`),
    memories: (scope) => request(`/api/app/memory/memories?scope=${encodeURIComponent(scope)}&limit=300`),
    deleteMemory: (scope, id) => request(`/api/app/memory/memories/${id}?scope=${encodeURIComponent(scope)}`, { method: 'DELETE' }),
    facts: (scope) => request(`/api/app/memory/facts?scope=${encodeURIComponent(scope)}`),
    deleteFact: (scope, id) => request(`/api/app/memory/facts/${id}?scope=${encodeURIComponent(scope)}`, { method: 'DELETE' }),
    graph: (guildId) => request(`/api/app/graph?guildId=${encodeURIComponent(guildId)}`),
    home: () => request('/api/app/home'),
    constellation: (scope) =>
        request(`/api/app/memory/constellation?scope=${encodeURIComponent(scope)}`),
    forgetMe: (confirm) =>
        request('/api/app/privacy/forget', { method: 'POST', body: { confirm } }),
    applets: () => request('/api/app/applets'),
    pinApplet: (body) => request('/api/app/applets', { method: 'POST', body }),
    applet: (id) => request(`/api/app/applets/${id}`),
    touchApplet: (id) =>
        request(`/api/app/applets/${id}`, { method: 'PATCH', body: { touchOpened: true } }),
    renameApplet: (id, title) =>
        request(`/api/app/applets/${id}`, { method: 'PATCH', body: { title } }),
    unpinApplet: (id) => request(`/api/app/applets/${id}`, { method: 'DELETE' }),

    // The Jimbucks Exchange (guild-scoped trading terminal)
    exchangeOverview: (guildId) =>
        request(`/api/app/exchange/overview?guildId=${encodeURIComponent(guildId)}`),
    exchangeQuote: (guildId, symbol) =>
        request(`/api/app/exchange/quote?guildId=${encodeURIComponent(guildId)}&symbol=${encodeURIComponent(symbol)}`),
    exchangeHistory: (guildId, symbol, range = '3mo') =>
        request(`/api/app/exchange/history?guildId=${encodeURIComponent(guildId)}` +
            `&symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(range)}`),
    exchangeSearch: (guildId, query) =>
        request(`/api/app/exchange/search?guildId=${encodeURIComponent(guildId)}&q=${encodeURIComponent(query)}`),
    exchangeTrade: (guildId, trade) =>
        request('/api/app/exchange/trade', { method: 'POST', body: { guildId, ...trade } }),
    exchangeChain: (guildId, symbol, expiry = null) =>
        request(`/api/app/exchange/chain?guildId=${encodeURIComponent(guildId)}` +
            `&symbol=${encodeURIComponent(symbol)}${expiry ? `&expiry=${encodeURIComponent(expiry)}` : ''}`),
    exchangeTradeOption: (guildId, trade) =>
        request('/api/app/exchange/options', { method: 'POST', body: { guildId, ...trade } }),
    exchangeOrders: (guildId) =>
        request(`/api/app/exchange/orders?guildId=${encodeURIComponent(guildId)}`),
    exchangePlaceOrder: (guildId, order) =>
        request('/api/app/exchange/orders', { method: 'POST', body: { guildId, ...order } }),
    exchangeCancelOrder: (guildId, orderId) =>
        request(`/api/app/exchange/orders/${orderId}?guildId=${encodeURIComponent(guildId)}`, { method: 'DELETE' }),
    exchangeLeaderboard: (guildId) =>
        request(`/api/app/exchange/leaderboard?guildId=${encodeURIComponent(guildId)}`),

    // MTGA deck library (import Arena deck exports into folders)
    mtgaLibrary: () => request('/api/app/mtga/library'),
    mtgaCreateFolder: (name) => request('/api/app/mtga/folders', { method: 'POST', body: { name } }),
    mtgaRenameFolder: (id, name) =>
        request(`/api/app/mtga/folders/${id}`, { method: 'PATCH', body: { name } }),
    mtgaDeleteFolder: (id) => request(`/api/app/mtga/folders/${id}`, { method: 'DELETE' }),
    mtgaImportDecks: (body) => request('/api/app/mtga/decks/import', { method: 'POST', body }),
    mtgaDeck: (id) => request(`/api/app/mtga/decks/${id}`),
    mtgaUpdateDeck: (id, fields) =>
        request(`/api/app/mtga/decks/${id}`, { method: 'PATCH', body: fields }),
    mtgaDeleteDeck: (id) => request(`/api/app/mtga/decks/${id}`, { method: 'DELETE' }),
    mtgaExportDeck: (id) => request(`/api/app/mtga/decks/${id}/export`),

    // The Observatory (persistent simulation projects)
    observatoryProjects: () => request('/api/app/observatory/projects'),
    observatoryProject: (slug) => request(`/api/app/observatory/projects/${encodeURIComponent(slug)}`),
    observatoryDeleteProject: (slug) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
    observatoryCancelJob: (id) => request(`/api/app/observatory/jobs/${id}/cancel`, { method: 'POST' }),
    observatoryResumeJob: (id) => request(`/api/app/observatory/jobs/${id}/resume`, { method: 'POST' }),
    observatoryRender: (slug, fps = null) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}/render`,
            { method: 'POST', body: fps ? { fps } : {} }),
    observatoryShareStatus: (slug) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}/share`),
    observatoryCreateShare: (slug) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}/share`, { method: 'POST' }),
    observatoryRevokeShare: (slug) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}/share`, { method: 'DELETE' }),

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
    parlorQuickstart: (prompt) => request('/api/app/parlor/quickstart', { method: 'POST', body: { prompt } }),
    parlorStop: () => request('/api/app/parlor/stop', { method: 'POST' }),

    // Parlor Live (voice sessions + persona voices)
    parlorLiveCapabilities: () => request('/api/app/parlor/live/capabilities'),
    parlorVoices: () => request('/api/app/parlor/voices'),
    parlorSetPersonaVoice: (personaId, voice) =>
        request(`/api/app/parlor/personas/${personaId}/voice`, { method: 'PUT', body: { voice } }),

    // Shared discussions (multi-user parlors)
    parlorMembers: (conversationId) =>
        request(`/api/app/parlor/conversations/${conversationId}/members`),
    parlorInvitable: (conversationId, q = '') =>
        request(`/api/app/parlor/conversations/${conversationId}/invitable` +
            `${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    parlorInvite: (conversationId, userId) =>
        request(`/api/app/parlor/conversations/${conversationId}/invites`, { method: 'POST', body: { userId } }),
    parlorRevokeInvite: (inviteId) =>
        request(`/api/app/parlor/invites/${inviteId}`, { method: 'DELETE' }),
    parlorInvites: () => request('/api/app/parlor/invites'),
    parlorRespondInvite: (inviteId, accept) =>
        request(`/api/app/parlor/invites/${inviteId}/respond`, { method: 'POST', body: { accept } }),
    parlorRemoveMember: (conversationId, memberId) =>
        request(`/api/app/parlor/conversations/${conversationId}/members/${memberId}`, { method: 'DELETE' })
};

export { ApiError };

/**
 * Read-aloud: POST text, get back an MP3 Blob (streamed from the TTS
 * provider through the server).
 * @param {string} text
 * @param {AbortSignal} [signal]
 * @returns {Promise<Blob>}
 */
export async function fetchSpeech(text, signal = null) {
    const res = await fetch('/api/app/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal
    });
    if (!res.ok) {
        let json = null;
        try { json = await res.json(); } catch { /* not JSON */ }
        const error = json?.error || {};
        throw new ApiError(res.status, error.code || 'INTERNAL', error.message || `Request failed (${res.status})`);
    }
    return res.blob();
}

/**
 * POST to an endpoint speaking the chat SSE vocabulary and stream the
 * reply. EventSource cannot POST, so the stream is parsed off fetch's
 * body reader.
 * @param {string} url - the SSE endpoint
 * @param {Object} payload - request body
 * @param {Object} handlers - { onStart, onTyping, onDelta, onTool, onMessage, onError, onDone }
 * @param {AbortSignal} [signal] - aborts the read (the Stop button)
 */
async function streamChatEvents(url, payload, handlers = {}, signal = null) {
    const res = await fetch(url, {
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
        else if (event === 'tool') handlers.onTool?.(data);
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
 * POST a chat message and stream the Server-Sent Events reply.
 * @param {Object} payload - { message, conversationId, images }
 * @param {Object} handlers - { onStart, onTyping, onDelta, onTool, onMessage, onError, onDone }
 * @param {AbortSignal} [signal] - aborts the read (the Stop button)
 */
export function streamChat(payload, handlers = {}, signal = null) {
    return streamChatEvents('/api/app/chat', payload, handlers, signal);
}

/**
 * Run one Observatory custom command as a streamed agent turn (the same
 * event vocabulary as streamChat). `project` may be null for pane-level
 * commands (the agent may then create projects).
 * @param {Object} payload - { project, instructions }
 * @param {Object} handlers - { onStart, onTyping, onDelta, onTool, onMessage, onError, onDone }
 * @param {AbortSignal} [signal]
 */
export function streamObservatoryCommand(payload, handlers = {}, signal = null) {
    return streamChatEvents('/api/app/observatory/command', payload, handlers, signal);
}

/**
 * POST a parlor turn endpoint and stream the SSE reply (same framing as
 * streamChat, with the parlor's multi-persona event vocabulary).
 * @param {string} url - the parlor SSE endpoint
 * @param {Object} payload - request body
 * @param {Object} handlers - { onStart, onUserMessage, onPersonaStart, onPersonaPass,
 *                              onDelta, onPersonaTool, onPersonaMessage, onLearned,
 *                              onError, onDone }
 * @param {AbortSignal} [signal]
 */
async function streamParlorEvents(url, payload, handlers = {}, signal = null) {
    const res = await fetch(url, {
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
        else if (event === 'persona_pass') handlers.onPersonaPass?.(data);
        else if (event === 'delta') handlers.onDelta?.(data.text || '');
        else if (event === 'persona_tool') handlers.onPersonaTool?.(data);
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

/** One user turn: every seated persona considers, then replies in order. */
export function streamParlorChat(payload, handlers = {}, signal = null) {
    return streamParlorEvents('/api/app/parlor/chat', payload, handlers, signal);
}

/** Manually ask one seated persona to speak right now (no user message). */
export function streamParlorNudge(conversationId, personaId, handlers = {}, signal = null) {
    return streamParlorEvents(
        `/api/app/parlor/conversations/${conversationId}/personas/${personaId}/respond`,
        {}, handlers, signal);
}
