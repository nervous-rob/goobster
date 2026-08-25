import type { AppConfig, ChatMessage, Conversation, Me, ToolEvent } from './types';
import { parseSseFrame } from './parseSse.js';

export class ApiError extends Error {
    status: number;
    code: string;
    details: unknown;
    constructor(status: number, code: string, message: string, details: unknown = null) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

async function request<T = unknown>(path: string, { method = 'GET', body = null }: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : null
    });
    let json: { error?: { code?: string; message?: string; details?: unknown } } | null = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
        const error = json?.error || {};
        throw new ApiError(res.status, error.code || 'INTERNAL',
            error.message || `Request failed (${res.status})`, error.details || null);
    }
    return json as T;
}

export const api = {
    config: () => request<AppConfig>('/api/app/config'),
    me: () => request<Me>('/api/app/me'),
    logout: () => request('/api/app/auth/logout', { method: 'POST' }),
    devSession: (userId: string, name: string) =>
        request('/api/app/auth/dev-session', { method: 'POST', body: { userId, name } }),

    conversations: () => request<{ conversations: Conversation[] }>('/api/app/chat/conversations'),
    createConversation: () => request<Conversation>('/api/app/chat/conversations', { method: 'POST' }),
    renameConversation: (id: number, title: string) =>
        request(`/api/app/chat/conversations/${id}`, { method: 'PATCH', body: { title } }),
    deleteConversation: (id: number) =>
        request(`/api/app/chat/conversations/${id}`, { method: 'DELETE' }),
    chatHistory: (conversationId?: number | null, limit = 200) =>
        request<{ messages: ChatMessage[] }>(
            `/api/app/chat/history?limit=${limit}${conversationId ? `&conversationId=${conversationId}` : ''}`),
    truncate: (conversationId: number, messageId: number) =>
        request('/api/app/chat/truncate', { method: 'POST', body: { conversationId, messageId } }),
    branch: (conversationId: number, messageId: number) =>
        request(`/api/app/chat/conversations/${conversationId}/branch`, { method: 'POST', body: { messageId } }),
    shareStatus: (conversationId: number) =>
        request(`/api/app/chat/conversations/${conversationId}/share`),
    createShare: (conversationId: number) =>
        request(`/api/app/chat/conversations/${conversationId}/share`, { method: 'POST' }),
    revokeShare: (conversationId: number) =>
        request(`/api/app/chat/conversations/${conversationId}/share`, { method: 'DELETE' }),
    stop: () => request('/api/app/chat/stop', { method: 'POST' }),
    turnStatus: () => request('/api/app/chat/turn'),
    searchMessages: (query: string, limit = 20) =>
        request(`/api/app/chat/search?q=${encodeURIComponent(query)}&limit=${limit}`),
    chatSettings: () => request('/api/app/chat/settings'),
    listModels: (provider?: string | null) =>
        request(`/api/app/chat/models${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`),
    setThoughtful: (thoughtful: boolean) =>
        request('/api/app/chat/settings', { method: 'PATCH', body: { thoughtful } }),
    saveChatSettings: (fields: Record<string, unknown>) =>
        request('/api/app/chat/settings', { method: 'PATCH', body: fields }),
    clearIncognito: () => request('/api/app/chat/incognito', { method: 'DELETE' }),

    voiceCapabilities: () => request<{ stt: boolean; tts: boolean }>('/api/app/voice/capabilities'),
    transcribe: (audio: string, mimeType: string) =>
        request<{ text: string }>('/api/app/voice/transcribe', { method: 'POST', body: { audio, mimeType } }),

    integrations: () => request('/api/app/integrations'),
    connectIntegration: (provider: string, token: string) =>
        request(`/api/app/integrations/${provider}`, { method: 'POST', body: { token } }),
    disconnectIntegration: (provider: string) =>
        request(`/api/app/integrations/${provider}`, { method: 'DELETE' }),

    home: () => request('/api/app/home'),
    report: (scope: string) => request(`/api/app/memory/report?scope=${encodeURIComponent(scope)}`),
    memories: (scope: string) =>
        request(`/api/app/memory/memories?scope=${encodeURIComponent(scope)}&limit=300`),
    deleteMemory: (scope: string, id: number) =>
        request(`/api/app/memory/memories/${id}?scope=${encodeURIComponent(scope)}`, { method: 'DELETE' }),
    facts: (scope: string) => request(`/api/app/memory/facts?scope=${encodeURIComponent(scope)}`),
    deleteFact: (scope: string, id: number) =>
        request(`/api/app/memory/facts/${id}?scope=${encodeURIComponent(scope)}`, { method: 'DELETE' }),
    graph: (guildId: string) => request(`/api/app/graph?guildId=${encodeURIComponent(guildId)}`),
    constellation: (scope: string) =>
        request(`/api/app/memory/constellation?scope=${encodeURIComponent(scope)}`),
    reflection: (scope: string, target: string) =>
        request(`/api/app/memory/reflection?scope=${encodeURIComponent(scope)}&target=${encodeURIComponent(target)}`),
    startReflection: (scope: string, target: string) =>
        request('/api/app/memory/reflection', { method: 'POST', body: { scope, target } }),
    retention: (scope: string) => request(`/api/app/memory/retention?scope=${encodeURIComponent(scope)}`),
    setRetention: (scope: string, days: number) =>
        request('/api/app/memory/retention', { method: 'PUT', body: { scope, days } }),
    forgetMe: (confirm: string) =>
        request('/api/app/privacy/forget', { method: 'POST', body: { confirm } }),

    tasks: () => request('/api/app/tasks'),
    createTask: (task: Record<string, unknown>) => request('/api/app/tasks', { method: 'POST', body: task }),
    toggleAutomation: (id: number, enabled: boolean) =>
        request(`/api/app/tasks/automations/${id}`, { method: 'PATCH', body: { enabled } }),
    deleteAutomation: (id: number) => request(`/api/app/tasks/automations/${id}`, { method: 'DELETE' }),
    cancelFollowup: (id: number) => request(`/api/app/tasks/followups/${id}`, { method: 'DELETE' }),
    usage: (days = 30) => request(`/api/app/usage?days=${days}`),

    attention: () => request('/api/app/attention'),
    attentionEnroll: (initiative?: string) =>
        request('/api/app/attention/enroll', { method: 'POST', body: initiative ? { initiative } : {} }),
    attentionDisable: () => request('/api/app/attention/disable', { method: 'POST' }),
    attentionUpdatePolicy: (fields: Record<string, unknown>) =>
        request('/api/app/attention/policy', { method: 'PATCH', body: fields }),
    attentionActOnNotice: (id: number, action: string, snoozeHours?: number) =>
        request(`/api/app/attention/notices/${id}`, { method: 'POST', body: { action, snoozeHours } }),
    attentionItem: (id: number) => request(`/api/app/attention/items/${id}`),
    attentionResolveItem: (id: number, state: 'resolved' | 'abandoned') =>
        request(`/api/app/attention/items/${id}/resolve`, { method: 'POST', body: { state } }),
    attentionCancelWatch: (id: number) =>
        request(`/api/app/attention/watches/${id}`, { method: 'DELETE' }),

    applets: () => request('/api/app/applets'),
    pinApplet: (body: Record<string, unknown>) => request('/api/app/applets', { method: 'POST', body }),
    touchApplet: (id: number) =>
        request(`/api/app/applets/${id}`, { method: 'PATCH', body: { touchOpened: true } }),
    unpinApplet: (id: number) => request(`/api/app/applets/${id}`, { method: 'DELETE' }),

    exchangeOverview: (guildId: string) =>
        request(`/api/app/exchange/overview?guildId=${encodeURIComponent(guildId)}`),
    exchangeQuote: (guildId: string, symbol: string) =>
        request(`/api/app/exchange/quote?guildId=${encodeURIComponent(guildId)}&symbol=${encodeURIComponent(symbol)}`),
    exchangeHistory: (guildId: string, symbol: string, range = '3mo') =>
        request(`/api/app/exchange/history?guildId=${encodeURIComponent(guildId)}&symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(range)}`),
    exchangeSearch: (guildId: string, query: string) =>
        request(`/api/app/exchange/search?guildId=${encodeURIComponent(guildId)}&q=${encodeURIComponent(query)}`),
    exchangeTrade: (guildId: string, trade: Record<string, unknown>) =>
        request('/api/app/exchange/trade', { method: 'POST', body: { guildId, ...trade } }),
    exchangeChain: (guildId: string, symbol: string, expiry: string | null = null) =>
        request(`/api/app/exchange/chain?guildId=${encodeURIComponent(guildId)}&symbol=${encodeURIComponent(symbol)}${expiry ? `&expiry=${encodeURIComponent(expiry)}` : ''}`),
    exchangeTradeOption: (guildId: string, trade: Record<string, unknown>) =>
        request('/api/app/exchange/options', { method: 'POST', body: { guildId, ...trade } }),
    exchangeOrders: (guildId: string) =>
        request(`/api/app/exchange/orders?guildId=${encodeURIComponent(guildId)}`),
    exchangePlaceOrder: (guildId: string, order: Record<string, unknown>) =>
        request('/api/app/exchange/orders', { method: 'POST', body: { guildId, ...order } }),
    exchangeCancelOrder: (guildId: string, orderId: number) =>
        request(`/api/app/exchange/orders/${orderId}?guildId=${encodeURIComponent(guildId)}`, { method: 'DELETE' }),
    exchangeLeaderboard: (guildId: string) =>
        request(`/api/app/exchange/leaderboard?guildId=${encodeURIComponent(guildId)}`),

    mtgaLibrary: () => request('/api/app/mtga/library'),
    mtgaCreateFolder: (name: string) => request('/api/app/mtga/folders', { method: 'POST', body: { name } }),
    mtgaRenameFolder: (id: number, name: string) =>
        request(`/api/app/mtga/folders/${id}`, { method: 'PATCH', body: { name } }),
    mtgaDeleteFolder: (id: number) => request(`/api/app/mtga/folders/${id}`, { method: 'DELETE' }),
    mtgaImportDecks: (body: Record<string, unknown>) =>
        request('/api/app/mtga/decks/import', { method: 'POST', body }),
    mtgaPreviewLog: (body: Record<string, unknown>) =>
        request('/api/app/mtga/decks/preview-log', { method: 'POST', body }),
    mtgaImportLog: (body: Record<string, unknown>) =>
        request('/api/app/mtga/decks/import-log', { method: 'POST', body }),
    mtgaDeck: (id: number) => request(`/api/app/mtga/decks/${id}`),
    mtgaUpdateDeck: (id: number, fields: Record<string, unknown>) =>
        request(`/api/app/mtga/decks/${id}`, { method: 'PATCH', body: fields }),
    mtgaDeleteDeck: (id: number) => request(`/api/app/mtga/decks/${id}`, { method: 'DELETE' }),
    mtgaExportDeck: (id: number) => request(`/api/app/mtga/decks/${id}/export`),

    observatoryProjects: () => request('/api/app/observatory/projects'),
    observatoryProject: (slug: string) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}`),
    observatoryDeleteProject: (slug: string) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
    observatoryCancelJob: (id: number) =>
        request(`/api/app/observatory/jobs/${id}/cancel`, { method: 'POST' }),
    observatoryResumeJob: (id: number) =>
        request(`/api/app/observatory/jobs/${id}/resume`, { method: 'POST' }),
    observatoryRender: (slug: string, fps: number | null = null) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}/render`,
            { method: 'POST', body: fps ? { fps } : {} }),
    observatoryShareStatus: (slug: string) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}/share`),
    observatoryCreateShare: (slug: string) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}/share`, { method: 'POST' }),
    observatoryRevokeShare: (slug: string) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}/share`, { method: 'DELETE' }),
    spitballLenses: () => request('/api/app/spitball/lenses'),
    spitballExpeditions: () => request('/api/app/spitball/expeditions'),
    spitballCreateExpedition: (body: Record<string, unknown>) =>
        request('/api/app/spitball/expeditions', { method: 'POST', body }),
    spitballExpedition: (id: number | string) =>
        request(`/api/app/spitball/expeditions/${id}`),
    spitballPauseExpedition: (id: number | string) =>
        request(`/api/app/spitball/expeditions/${id}/pause`, { method: 'POST' }),
    spitballContinueExpedition: (id: number | string) =>
        request(`/api/app/spitball/expeditions/${id}/continue`, { method: 'POST' }),
    spitballExtendExpedition: (id: number | string, extraCycles?: number) =>
        request(`/api/app/spitball/expeditions/${id}/extend`, {
            method: 'POST',
            body: extraCycles ? { extraCycles } : {}
        }),
    spitballCancelExpedition: (id: number | string) =>
        request(`/api/app/spitball/expeditions/${id}/cancel`, { method: 'POST' }),
    spitballClaims: (id: number | string) =>
        request(`/api/app/spitball/expeditions/${id}/claims`),
    spitballNoteEvidence: (nodeId: number | string) =>
        request(`/api/app/spitball/notes/${nodeId}/evidence`),
    spitballNotes: (scope: string, filters: {
        q?: string; type?: string; tag?: string; source?: string; limit?: number; offset?: number;
    } = {}) => {
        const params = new URLSearchParams({ scope });
        if (filters.q) params.set('q', filters.q);
        if (filters.type) params.set('type', filters.type);
        if (filters.tag) params.set('tag', filters.tag);
        if (filters.source) params.set('source', filters.source);
        if (filters.limit) params.set('limit', String(filters.limit));
        if (filters.offset) params.set('offset', String(filters.offset));
        return request(`/api/app/spitball/notes?${params.toString()}`);
    },
    spitballCreateNote: (scope: string, fields: Record<string, unknown>) =>
        request('/api/app/spitball/notes', { method: 'POST', body: { scope, ...fields } }),
    spitballUpdateNote: (scope: string, nodeId: number | string, fields: Record<string, unknown>) =>
        request(`/api/app/spitball/notes/${nodeId}`, { method: 'PATCH', body: { scope, ...fields } }),
    spitballDeleteNote: (scope: string, nodeId: number | string) =>
        request(`/api/app/spitball/notes/${nodeId}?scope=${encodeURIComponent(scope)}`, { method: 'DELETE' }),

    parlorPersonas: () => request('/api/app/parlor/personas'),
    parlorCreatePersona: (persona: Record<string, unknown>) =>
        request('/api/app/parlor/personas', { method: 'POST', body: persona }),
    parlorUpdatePersona: (id: number, fields: Record<string, unknown>) =>
        request(`/api/app/parlor/personas/${id}`, { method: 'PATCH', body: fields }),
    parlorDeletePersona: (id: number) => request(`/api/app/parlor/personas/${id}`, { method: 'DELETE' }),
    parlorNotes: (personaId: number, { tagId = null, q = null }: { tagId?: number | null; q?: string | null } = {}) =>
        request(`/api/app/parlor/personas/${personaId}/notes?${tagId ? `tagId=${tagId}&` : ''}${q ? `q=${encodeURIComponent(q)}` : ''}`),
    parlorCreateNote: (personaId: number, note: Record<string, unknown>) =>
        request(`/api/app/parlor/personas/${personaId}/notes`, { method: 'POST', body: note }),
    parlorUpdateNote: (noteId: number, fields: Record<string, unknown>) =>
        request(`/api/app/parlor/notes/${noteId}`, { method: 'PATCH', body: fields }),
    parlorDeleteNote: (noteId: number) => request(`/api/app/parlor/notes/${noteId}`, { method: 'DELETE' }),
    parlorTags: (personaId: number) => request(`/api/app/parlor/personas/${personaId}/tags`),
    parlorSuggestTags: (personaId: number, title: string, content: string) =>
        request(`/api/app/parlor/personas/${personaId}/suggest-tags`, { method: 'POST', body: { title, content } }),
    parlorGraph: (personaId: number) => request(`/api/app/parlor/personas/${personaId}/graph`),
    parlorSearch: (personaId: number, q: string) =>
        request(`/api/app/parlor/personas/${personaId}/search?q=${encodeURIComponent(q)}`),
    parlorConversations: () => request('/api/app/parlor/conversations'),
    parlorCreateConversation: (personaIds: number[]) =>
        request('/api/app/parlor/conversations', { method: 'POST', body: { personaIds } }),
    parlorRenameConversation: (id: number, title: string) =>
        request(`/api/app/parlor/conversations/${id}`, { method: 'PATCH', body: { title } }),
    parlorDeleteConversation: (id: number) =>
        request(`/api/app/parlor/conversations/${id}`, { method: 'DELETE' }),
    parlorSetParticipant: (conversationId: number, personaId: number, present: boolean) =>
        request(`/api/app/parlor/conversations/${conversationId}/participants/${personaId}`,
            { method: present ? 'PUT' : 'DELETE' }),
    parlorMessages: (conversationId: number, limit = 200) =>
        request(`/api/app/parlor/conversations/${conversationId}/messages?limit=${limit}`),
    parlorQuickstart: (prompt: string) =>
        request('/api/app/parlor/quickstart', { method: 'POST', body: { prompt } }),
    parlorStop: () => request('/api/app/parlor/stop', { method: 'POST' }),
    parlorLiveCapabilities: () => request('/api/app/parlor/live/capabilities'),
    parlorVoices: () => request('/api/app/parlor/voices'),
    parlorSetPersonaVoice: (personaId: number, voice: string) =>
        request(`/api/app/parlor/personas/${personaId}/voice`, { method: 'PUT', body: { voice } }),
    friends: () => request('/api/app/friends'),
    parlorMembers: (conversationId: number) =>
        request(`/api/app/parlor/conversations/${conversationId}/members`),
    parlorInvitable: (conversationId: number, q = '') =>
        request(`/api/app/parlor/conversations/${conversationId}/invitable${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    parlorInvite: (conversationId: number, userId: string) =>
        request(`/api/app/parlor/conversations/${conversationId}/invites`, { method: 'POST', body: { userId } }),
    parlorRevokeInvite: (inviteId: number) =>
        request(`/api/app/parlor/invites/${inviteId}`, { method: 'DELETE' }),
    parlorInvites: () => request('/api/app/parlor/invites'),
    parlorRespondInvite: (inviteId: number, accept: boolean) =>
        request(`/api/app/parlor/invites/${inviteId}/respond`, { method: 'POST', body: { accept } }),
    parlorRemoveMember: (conversationId: number, memberId: string) =>
        request(`/api/app/parlor/conversations/${conversationId}/members/${memberId}`, { method: 'DELETE' })
};

export async function fetchSpeech(text: string, signal?: AbortSignal | null): Promise<Blob> {
    const res = await fetch('/api/app/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: signal || undefined
    });
    if (!res.ok) {
        let json: { error?: { code?: string; message?: string } } | null = null;
        try { json = await res.json(); } catch { /* not JSON */ }
        const error = json?.error || {};
        throw new ApiError(res.status, error.code || 'INTERNAL', error.message || `Request failed (${res.status})`);
    }
    return res.blob();
}

type ChatHandlers = {
    onStart?: (data: { conversationId?: number }) => void;
    onTyping?: () => void;
    onDelta?: (text: string) => void;
    onTool?: (data: ToolEvent) => void;
    onMessage?: (data: { content: string; attachments?: Array<{ url: string; name?: string }>; isError?: boolean }) => void;
    onError?: (data: { code?: string; message?: string }) => void;
    onDone?: (data: { ok?: boolean; conversationId?: number }) => void;
};

type ParlorHandlers = ChatHandlers & {
    onUserMessage?: (data: unknown) => void;
    onPersonaStart?: (data: { personaId?: number; name?: string }) => void;
    onPersonaPass?: (data: unknown) => void;
    onPersonaTool?: (data: { phase: string; name: string }) => void;
    onPersonaMessage?: (data: { content?: string; personaId?: number; grounding?: unknown[] }) => void;
    onLearned?: (data: unknown) => void;
};

async function readSse(url: string, payload: unknown, dispatch: (event: string, data: unknown) => void, signal?: AbortSignal | null) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: signal || undefined
    });
    if (!res.ok) {
        let json: { error?: { code?: string; message?: string } } | null = null;
        try { json = await res.json(); } catch { /* not JSON */ }
        const error = json?.error || {};
        throw new ApiError(res.status, error.code || 'INTERNAL', error.message || `Request failed (${res.status})`);
    }
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const rawEvent = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (!rawEvent.trim() || rawEvent.startsWith(':')) continue;
            const parsed = parseSseFrame(rawEvent);
            if (parsed) dispatch(parsed.event, parsed.data);
        }
    }
}

export function streamChat(payload: Record<string, unknown>, handlers: ChatHandlers = {}, signal?: AbortSignal | null) {
    return readSse('/api/app/chat', payload, (event, data) => {
        if (event === 'start') handlers.onStart?.(data as { conversationId?: number });
        else if (event === 'typing') handlers.onTyping?.();
        else if (event === 'delta') handlers.onDelta?.((data as { text?: string }).text || '');
        else if (event === 'tool') handlers.onTool?.(data as ToolEvent);
        else if (event === 'message') handlers.onMessage?.(data as { content: string });
        else if (event === 'error') handlers.onError?.(data as { message?: string });
        else if (event === 'done') handlers.onDone?.(data as { ok?: boolean });
    }, signal);
}

export function streamObservatoryCommand(payload: Record<string, unknown>, handlers: ChatHandlers = {}, signal?: AbortSignal | null) {
    return readSse('/api/app/observatory/command', payload, (event, data) => {
        if (event === 'start') handlers.onStart?.(data as { conversationId?: number });
        else if (event === 'typing') handlers.onTyping?.();
        else if (event === 'delta') handlers.onDelta?.((data as { text?: string }).text || '');
        else if (event === 'tool') handlers.onTool?.(data as ToolEvent);
        else if (event === 'message') handlers.onMessage?.(data as { content: string });
        else if (event === 'error') handlers.onError?.(data as { message?: string });
        else if (event === 'done') handlers.onDone?.(data as { ok?: boolean });
    }, signal);
}

function dispatchParlor(handlers: ParlorHandlers, event: string, data: unknown) {
    if (event === 'start') handlers.onStart?.(data as { conversationId?: number });
    else if (event === 'user_message') handlers.onUserMessage?.(data);
    else if (event === 'persona_start') handlers.onPersonaStart?.(data as { personaId?: number; name?: string });
    else if (event === 'persona_pass') handlers.onPersonaPass?.(data);
    else if (event === 'delta') handlers.onDelta?.((data as { text?: string }).text || '');
    else if (event === 'persona_tool') handlers.onPersonaTool?.(data as { phase: string; name: string });
    else if (event === 'persona_message') handlers.onPersonaMessage?.(data as { content?: string });
    else if (event === 'learned') handlers.onLearned?.(data);
    else if (event === 'error') handlers.onError?.(data as { message?: string });
    else if (event === 'done') handlers.onDone?.(data as { ok?: boolean });
}

export function streamParlorChat(payload: Record<string, unknown>, handlers: ParlorHandlers = {}, signal?: AbortSignal | null) {
    return readSse('/api/app/parlor/chat', payload, (event, data) => dispatchParlor(handlers, event, data), signal);
}

export function streamParlorNudge(conversationId: number, personaId: number, handlers: ParlorHandlers = {}, signal?: AbortSignal | null) {
    return readSse(`/api/app/parlor/conversations/${conversationId}/personas/${personaId}/respond`,
        {}, (event, data) => dispatchParlor(handlers, event, data), signal);
}
