import type { AdminLimits, TokenLimits, ModelCatalog, AccountSummary, AccountSupportView, AdminAccount, AppConfig, ChatAttachment, InstallationView, InstanceStateView, OperatorAuditEntry, SkippedSchedules, Invite, InvitePreview, MigrationReport, ChatHistoryPreviewResponse, ChatMessage, InboxItem, InboxList, Person, ChatQueueItem, Conversation, Me, ToolEvent, TurnProgress, UserSettingsResponse, SectionUpdateResponse, ResetPreviewResponse, RetentionPreviewResponse, TutorialsResponse, TutorialProgress, BriefDetail, BriefSummary, BriefMeasure } from './types';
import { parseSseFrame } from './parseSse.js';
import { accountFetch, sessionChanged } from './browserAccount';

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

/** Optional `?owner=` qualifier so a shared slug resolves unambiguously. */
function ownerQs(owner?: string | null, extra: Record<string, string | number | undefined | null> = {}): string {
    const params = new URLSearchParams();
    if (owner) params.set('owner', owner);
    for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `?${qs}` : '';
}

async function request<T = unknown>(path: string, { method = 'GET', body = null }: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await accountFetch(path, {
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
    if (path === '/api/app/auth/logout' || path === '/api/app/auth/dev-session'
        || path === '/api/app/auth/native-login' || path === '/api/app/auth/register'
        || path === '/api/app/auth/recover'
        || (path === '/api/app/auth/verify-email' && (json as { kind?: string })?.kind === 'registration')) {
        sessionChanged();
    }
    return json as T;
}

export const api = {
    config: () => request<AppConfig>('/api/app/config'),
    me: () => request<Me>('/api/app/me'),
    logout: () => request('/api/app/auth/logout', { method: 'POST' }),
    devSession: (userId: string, name: string) =>
        request('/api/app/auth/dev-session', { method: 'POST', body: { userId, name } }),

    // Native sign-in (release-gated server-side by identity.nativeLogin)
    nativeLogin: (loginName: string, password: string) =>
        request<{ user: { id: string; name: string; loginName: string } }>('/api/app/auth/native-login', { method: 'POST', body: { loginName, password } }),
    inspectInvite: (token: string) => request<InvitePreview>(`/api/app/auth/invite/${encodeURIComponent(token)}`),
    register: (body: { token: string; loginName: string; password: string; displayName?: string }) =>
        request<{ user: { id: string; name: string; loginName: string } }>('/api/app/auth/register', { method: 'POST', body }),
    recover: (body: { token: string; password: string; loginName?: string }) =>
        request<{ user: { id: string; name: string; loginName: string } }>('/api/app/auth/recover', { method: 'POST', body }),
    reauth: (password: string) => request<{ ok: true }>('/api/app/auth/reauth', { method: 'POST', body: { password } }),
    // Email-backed flows (hidden by the server unless mail is configured)
    signup: (body: { loginName: string; password: string; email: string; displayName?: string }) =>
        request<{ ok: true }>('/api/app/auth/signup', { method: 'POST', body }),
    verifyEmail: (token: string) =>
        request<{ kind: 'registration'; user: { id: string; name: string; loginName: string } } | { kind: 'verified'; address: string }>(
            '/api/app/auth/verify-email', { method: 'POST', body: { token } }),
    forgot: (email: string) => request<{ ok: true }>('/api/app/auth/forgot', { method: 'POST', body: { email } }),
    account: () => request<AccountSummary>('/api/app/account'),
    setCredentials: (body: { loginName?: string; currentPassword?: string; newPassword: string }) =>
        request<{ ok: true; loginName: string }>('/api/app/account/credentials', { method: 'PUT', body }),
    setEmail: (email: string) =>
        request<{ address: string; verified: boolean; sent: boolean }>('/api/app/account/email', { method: 'PUT', body: { email } }),
    resendVerification: () =>
        request<{ address: string; verified: boolean; sent: boolean }>('/api/app/account/email/resend', { method: 'POST' }),
    removeEmail: () => request<{ removed: true }>('/api/app/account/email', { method: 'DELETE' }),
    disconnectIdentity: (provider: 'discord') =>
        request<{ ok: true }>(`/api/app/account/identities/${provider}`, { method: 'DELETE' }),

    // Installation administration (operators)
    adminInvites: () => request<{ invites: Invite[]; nativeLogin: boolean; defaultTtlHours: number }>('/api/app/admin/invites'),
    adminCreateInvite: (body: { role: 'member' | 'operator'; ttlHours?: number; note?: string }) =>
        request<{ invite: Invite; url: string }>('/api/app/admin/invites', { method: 'POST', body }),
    adminRevokeInvite: (id: number) => request<{ invite: Invite }>(`/api/app/admin/invites/${id}`, { method: 'DELETE' }),
    adminAccounts: () => request<{ accounts: AdminAccount[]; requireAccount: boolean; failureWindowDays: number }>('/api/app/admin/accounts'),
    adminAccountSupport: (principalId: string, days = 30) =>
        request<AccountSupportView>(`/api/app/admin/accounts/${encodeURIComponent(principalId)}/support?days=${days}`),
    adminAudit: (params: { before?: string | null; limit?: number; target?: string | null } = {}) => {
        const qs = new URLSearchParams();
        if (params.before) qs.set('before', params.before);
        if (params.limit) qs.set('limit', String(params.limit));
        if (params.target) qs.set('target', params.target);
        const suffix = qs.toString();
        return request<{ entries: OperatorAuditEntry[]; nextCursor: string | null }>(`/api/app/admin/audit${suffix ? `?${suffix}` : ''}`);
    },
    usageDiagnostics: (days = 30) => request<AccountSupportView>(`/api/app/usage/diagnostics?days=${days}`),
    adminGrantAccount: (principalId: string, role: 'member' | 'operator' = 'member') =>
        request<{ account: AdminAccount; created: boolean }>('/api/app/admin/accounts', { method: 'POST', body: { principalId, role } }),
    adminUpdateAccount: (principalId: string, body: { status?: 'active' | 'disabled'; role?: 'member' | 'operator' }) =>
        request<{ account: AdminAccount }>(`/api/app/admin/accounts/${encodeURIComponent(principalId)}`, { method: 'PATCH', body }),
    adminIssueRecovery: (principalId: string) =>
        request<{ url: string; expiresAt: string; loginName: string | null }>(`/api/app/admin/accounts/${encodeURIComponent(principalId)}/recovery`, { method: 'POST' }),
    adminIdentityReport: () => request<MigrationReport>('/api/app/admin/identity/report'),
    adminInstallation: () => request<InstallationView>('/api/app/admin/installation'),
    adminLimits: () => request<AdminLimits>('/api/app/admin/limits'),
    adminSetLimits: (body: TokenLimits) => request<TokenLimits>('/api/app/admin/limits', { method: 'PATCH', body }),
    adminInstance: () => request<InstanceStateView>('/api/app/admin/instance'),
    adminInstanceResume: () =>
        request<{ paused: null; skipped: SkippedSchedules; state: InstanceStateView }>('/api/app/admin/instance/resume', { method: 'POST' }),
    adminTestMail: (to: string) => request<{ ok: true; provider: string }>('/api/app/admin/mail/test', { method: 'POST', body: { to } }),

    conversations: () => request<{ conversations: Conversation[] }>('/api/app/chat/conversations'),
    chatSuggestions: () =>
        request<{ suggestions: string[] | null; generatedAt: string | null }>('/api/app/chat/suggestions'),
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
    listChatQueue: () => request<{ items: ChatQueueItem[] }>('/api/app/chat/queue'),
    enqueueChat: (body: Record<string, unknown>) =>
        request<ChatQueueItem>('/api/app/chat/queue', { method: 'POST', body }),
    removeQueued: (id: number | string) =>
        request(`/api/app/chat/queue/${encodeURIComponent(String(id))}`, { method: 'DELETE' }),
    reorderQueue: (ids: Array<number | string>) =>
        request<{ items: ChatQueueItem[] }>('/api/app/chat/queue', { method: 'PATCH', body: { ids } }),
    searchMessages: (query: string, limit = 20) =>
        request(`/api/app/chat/search?q=${encodeURIComponent(query)}&limit=${limit}`),
    chatSettings: () => request('/api/app/chat/settings'),
    settings: () => request<UserSettingsResponse>('/api/app/settings'),
    authorizeLegacyLab: () => request('/api/app/settings/legacy-lab', { method: 'POST' }),

    tutorials: () => request<TutorialsResponse>('/api/app/tutorials'),
    tutorialEvent: (id: string, body: {
        eventId: string;
        generation: number;
        expectedRevision: number;
        action: string;
        stepId?: string | null;
    }) => request<TutorialProgress>(`/api/app/tutorials/${encodeURIComponent(id)}/events`, { method: 'POST', body }),
    resetTutorial: (id: string) =>
        request<TutorialProgress>(`/api/app/tutorials/${encodeURIComponent(id)}/reset`, { method: 'POST' }),
    resetAllTutorials: () =>
        request<{ progress: TutorialProgress[] }>('/api/app/tutorials/reset', { method: 'POST' }),
    patchTutorialPreferences: (autoStart: boolean) =>
        request<TutorialsResponse['preferences']>('/api/app/tutorial-preferences', {
            method: 'PATCH',
            body: { autoStart }
        }),
    markOrientationOffered: () =>
        request<TutorialsResponse['preferences']>('/api/app/tutorials/orientation-offered', { method: 'POST' }),
    keepTutorialExample: (pieceId: string) =>
        request<{ kept: boolean; alreadyHad?: boolean; pieceId: string; note: { id?: number; label: string; curation?: string } }>(
            '/api/app/tutorials/keep-example',
            { method: 'POST', body: { pieceId } }
        ),
    updateSettingsSection: (section: string, body: { expectedRevision?: number | null; changes: Record<string, unknown> }) =>
        request<SectionUpdateResponse>(`/api/app/settings/${encodeURIComponent(section)}`, { method: 'PATCH', body }),
    resetSettingsPreview: (section: string) =>
        request<ResetPreviewResponse>(`/api/app/settings/${encodeURIComponent(section)}/reset-preview`, { method: 'POST' }),
    resetSettingsSection: (section: string, expectedRevision?: number | null) =>
        request<SectionUpdateResponse>(`/api/app/settings/${encodeURIComponent(section)}/reset`, { method: 'POST', body: { expectedRevision } }),
    retentionPreview: (days: number | null) =>
        request<RetentionPreviewResponse>('/api/app/settings/memory/retention-preview', { method: 'POST', body: { days } }),
    applyRetention: (days: number | null, expectedRevision?: number | null) =>
        request<SectionUpdateResponse & { purged: number }>('/api/app/settings/memory/retention', { method: 'POST', body: { days, expectedRevision } }),
    chatHistoryPreview: (days: number | null) =>
        request<ChatHistoryPreviewResponse>('/api/app/settings/memory/chat-history-preview', { method: 'POST', body: { days } }),
    applyChatHistoryRetention: (days: number | null, expectedRevision?: number | null) =>
        request<SectionUpdateResponse & { purged: number }>('/api/app/settings/memory/chat-history', { method: 'POST', body: { days, expectedRevision } }),
    exportSettings: () => request('/api/app/settings/export'),
    listSettingsSessions: () => request<{
        id: number; userName: string | null; avatar: string | null;
        createdAt: string; lastSeenAt: string | null; expiresAt: string; current: boolean;
    }[]>('/api/app/settings/account/sessions'),
    revokeSettingsSession: (id: number) =>
        request(`/api/app/settings/account/sessions/${id}`, { method: 'DELETE' }),
    revokeOtherSessions: () =>
        request<{ revoked: number }>('/api/app/settings/account/sessions/revoke-others', { method: 'POST' }),
    listSettingsShares: () => request<{
        conversations: Array<{ id: number; kind: 'conversation'; title: string; conversationId: number; createdAt: string; path: string }>;
        projects: Array<{ id: number; kind: 'project'; title: string; projectId: number; createdAt: string; path: string }>;
    }>('/api/app/settings/shares'),
    revokeSettingsShare: (kind: 'conversation' | 'project', id: number) =>
        request(`/api/app/settings/shares/${kind}/${id}`, { method: 'DELETE' }),
    listSettingsApplets: () => request<Array<{ id: number; title: string; grants: { observatoryRead?: string[] }; pinned: boolean }>>('/api/app/settings/applets'),
    revokeAppletGrants: (id: number) =>
        request(`/api/app/settings/applets/${id}/revoke-grants`, { method: 'POST' }),
    modelCatalog: (provider?: string, workflow = 'chat') =>
        request<ModelCatalog>(`/api/app/chat/model-catalog?workflow=${encodeURIComponent(workflow)}${provider ? `&provider=${encodeURIComponent(provider)}` : ''}`),
    listModels: (provider?: string | null) =>
        request(`/api/app/chat/models${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`),
    setThoughtful: (thoughtful: boolean) =>
        request('/api/app/chat/settings', { method: 'PATCH', body: { thoughtful } }),
    saveChatSettings: (fields: Record<string, unknown>) =>
        request('/api/app/chat/settings', { method: 'PATCH', body: fields }),
    clearIncognito: () => request('/api/app/chat/incognito', { method: 'DELETE' }),

    voiceCapabilities: () => request<{ stt: boolean; tts: boolean; live?: boolean }>('/api/app/voice/capabilities'),
    transcribe: (audio: string, mimeType: string) =>
        request<{ text: string }>('/api/app/voice/transcribe', { method: 'POST', body: { audio, mimeType } }),
    voiceList: () =>
        request<{ voices: Array<{ id: string; name: string; category?: string | null }> }>('/api/app/voice/voices'),
    voiceSettings: () =>
        request<{
            voiceId: string | null;
            voiceName: string | null;
            speed: number;
            accent: string | null;
            accentLabel: string | null;
            accents: Array<{ id: string; label: string }>;
        }>('/api/app/voice/settings'),
    saveVoiceSettings: (fields: { voiceId?: string | null; speed?: number; accent?: string | null }) =>
        request<{
            voiceId: string | null;
            voiceName: string | null;
            speed: number;
            accent: string | null;
            accentLabel: string | null;
            accents: Array<{ id: string; label: string }>;
        }>(
            '/api/app/voice/settings', { method: 'PATCH', body: fields }),

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
    deleteFact: (scope: string, id: number | string) =>
        request(`/api/app/memory/facts/${encodeURIComponent(String(id))}?scope=${encodeURIComponent(scope)}`, { method: 'DELETE' }),
    graph: (guildId: string) => request(`/api/app/graph?guildId=${encodeURIComponent(guildId)}`),
    constellation: (scope: string, view: 'knowledge' | 'memory' | 'all' = 'knowledge') =>
        request(`/api/app/memory/constellation?scope=${encodeURIComponent(scope)}&view=${encodeURIComponent(view)}`),
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

    inbox: ({ unread = false, archived = false, cursor }: { unread?: boolean; archived?: boolean; cursor?: string | null } = {}) => {
        const params = new URLSearchParams();
        if (archived) params.set('archived', '1');
        if (unread) params.set('unread', '1');
        if (cursor) params.set('cursor', cursor);
        return request<InboxList>(`/api/app/inbox?${params}`);
    },
    inboxRead: (id: number, read = true) =>
        request<InboxItem>(`/api/app/inbox/${id}/read`, { method: 'POST', body: { read } }),
    inboxReadAll: () => request<{ updated: number }>('/api/app/inbox/read-all', { method: 'POST' }),
    inboxArchive: (id: number) => request<{ archived: boolean }>(`/api/app/inbox/${id}/archive`, { method: 'POST' }),
    people: (q: string) =>
        request<{ people: Person[]; friendsSynced: boolean; discord: boolean }>(`/api/app/people?q=${encodeURIComponent(q)}`),

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
    updateAppletGrants: (id: number, grants: { observatoryRead: string[] }) =>
        request(`/api/app/applets/${id}`, { method: 'PATCH', body: { grants } }),
    unpinApplet: (id: number) => request(`/api/app/applets/${id}`, { method: 'DELETE' }),
    promoteApplet: (body: Record<string, unknown>) =>
        request('/api/app/applets/promote', { method: 'POST', body }),

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
    /** Direct creation - an empty organizational container, no model call (ADR 0009). */
    createProject: (body: { name: string; goal?: string }) =>
        request('/api/app/projects', { method: 'POST', body }),
    observatoryProject: (slug: string, owner?: string | null) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}${ownerQs(owner)}`),
    observatoryDeleteProject: (slug: string, owner?: string | null) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}${ownerQs(owner)}`, { method: 'DELETE' }),
    observatoryCancelJob: (id: number) =>
        request(`/api/app/observatory/jobs/${id}/cancel`, { method: 'POST' }),
    observatoryResumeJob: (id: number) =>
        request(`/api/app/observatory/jobs/${id}/resume`, { method: 'POST' }),
    observatoryRender: (slug: string, fps: number | null = null, owner?: string | null) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}/render${ownerQs(owner)}`,
            { method: 'POST', body: fps ? { fps, owner: owner || undefined } : (owner ? { owner } : {}) }),
    observatoryShareStatus: (slug: string, owner?: string | null) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}/share${ownerQs(owner)}`),
    observatoryCreateShare: (slug: string, owner?: string | null) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}/share${ownerQs(owner)}`,
            { method: 'POST', body: owner ? { owner } : {} }),
    observatoryRevokeShare: (slug: string, owner?: string | null) =>
        request(`/api/app/observatory/projects/${encodeURIComponent(slug)}/share${ownerQs(owner)}`, { method: 'DELETE' }),
    observatoryDashboardUrl: (slug: string, owner?: string | null) =>
        `/api/app/observatory/projects/${encodeURIComponent(slug)}/dashboard${ownerQs(owner)}`,
    projectInvites: () => request('/api/app/projects/invites'),
    projectRespondInvite: (inviteId: number, accept: boolean) =>
        request(`/api/app/projects/invites/${inviteId}/respond`, { method: 'POST', body: { accept } }),
    projectRevokeInvite: (inviteId: number) =>
        request(`/api/app/projects/invites/${inviteId}`, { method: 'DELETE' }),
    projectMembers: (slug: string, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/members${ownerQs(owner)}`),
    projectInvitable: (slug: string, q = '', owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/invitable${ownerQs(owner, { q })}`),
    projectInvite: (slug: string, userId: string, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/invites${ownerQs(owner)}`,
            { method: 'POST', body: { userId, owner: owner || undefined } }),
    projectRemoveMember: (slug: string, memberId: string, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/members/${encodeURIComponent(memberId)}${ownerQs(owner)}`,
            { method: 'DELETE' }),
    projectKnowledge: (slug: string, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/knowledge${ownerQs(owner)}`),
    projectKnowledgeNotes: (slug: string, owner?: string | null, q?: string) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/knowledge/notes${ownerQs(owner, { q })}`),
    projectMission: (slug: string, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/mission${ownerQs(owner)}`),
    createProjectMission: (slug: string, body: Record<string, unknown>, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/mission${ownerQs(owner)}`,
            { method: 'POST', body: owner ? { ...body, owner } : body }),
    updateProjectMission: (slug: string, body: Record<string, unknown>, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/mission${ownerQs(owner)}`,
            { method: 'PATCH', body: owner ? { ...body, owner } : body }),
    projectMissionAction: (slug: string, action: string, body: Record<string, unknown> = {}, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/mission/${action}${ownerQs(owner)}`,
            { method: 'POST', body: owner ? { ...body, owner } : body }),
    projectMissionStartStep: (slug: string, stepId: number, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/mission/steps/${stepId}/start${ownerQs(owner)}`,
            { method: 'POST', body: owner ? { owner } : {} }),
    projectMissionCompleteStep: (
        slug: string,
        stepId: number,
        note?: string,
        owner?: string | null,
        selectedId?: string | null
    ) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/mission/steps/${stepId}/complete${ownerQs(owner)}`,
            { method: 'POST', body: { note, selectedId: selectedId || undefined, owner: owner || undefined } }),
    projectNeedsYou: (project?: string | null, owner?: string | null) =>
        request(`/api/app/projects/needs-you${ownerQs(owner, { project: project || undefined })}`),
    projectSetupAudit: (slug: string, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/setup-audit${ownerQs(owner)}`),
    projectMissionSkipStep: (slug: string, stepId: number, reason?: string, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/mission/steps/${stepId}/skip${ownerQs(owner)}`,
            { method: 'POST', body: { reason, owner: owner || undefined } }),
    projectMissionRetryStep: (slug: string, stepId: number, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/mission/steps/${stepId}/retry${ownerQs(owner)}`,
            { method: 'POST', body: owner ? { owner } : {} }),
    addProjectMissionStep: (slug: string, body: Record<string, unknown>, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/mission/steps${ownerQs(owner)}`,
            { method: 'POST', body: owner ? { ...body, owner } : body }),
    addProjectMissionEvidence: (slug: string, body: Record<string, unknown>, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/mission/evidence${ownerQs(owner)}`,
            { method: 'POST', body: owner ? { ...body, owner } : body }),
    projectAssets: (project: string, kind?: string, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(project)}/assets${ownerQs(owner, { kind })}`),
    saveProjectAsset: (project: string, body: Record<string, unknown>, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(project)}/assets${ownerQs(owner)}`,
            { method: 'POST', body: owner ? { ...body, owner } : body }),
    projectAsset: (project: string, asset: string, version?: number, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(project)}/assets/${encodeURIComponent(asset)}${ownerQs(owner, { version })}`),
    updateProjectAsset: (project: string, asset: string, body: Record<string, unknown>, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(project)}/assets/${encodeURIComponent(asset)}${ownerQs(owner)}`,
            { method: 'PATCH', body: owner ? { ...body, owner } : body }),
    deleteProjectAsset: (project: string, asset: string, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(project)}/assets/${encodeURIComponent(asset)}${ownerQs(owner)}`,
            { method: 'DELETE' }),
    projectAssetVersions: (project: string, asset: string, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(project)}/assets/${encodeURIComponent(asset)}/versions${ownerQs(owner)}`),
    projectAssetVersion: (project: string, asset: string, n: number, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(project)}/assets/${encodeURIComponent(asset)}/versions/${n}${ownerQs(owner)}`),
    rollbackProjectAsset: (project: string, asset: string, version: number, owner?: string | null, expectedRevision?: number) =>
        request(`/api/app/projects/${encodeURIComponent(project)}/assets/${encodeURIComponent(asset)}/rollback${ownerQs(owner)}`,
            { method: 'POST', body: { version, expectedRevision, owner: owner || undefined } }),
    runProjectAsset: (project: string, asset: string, background = false, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(project)}/assets/${encodeURIComponent(asset)}/run${ownerQs(owner)}`,
            { method: 'POST', body: { background, owner: owner || undefined } }),
    projectFiles: (project: string, dirPath?: string, owner?: string | null) => {
        // Empty path must stay on the query string: the explorer lists one
        // directory at a time, and omitting `path` walks the whole tree
        // without an `entries` array (ownerQs drops empty strings).
        const params = new URLSearchParams();
        if (owner) params.set('owner', owner);
        if (dirPath !== undefined) params.set('path', dirPath);
        const qs = params.toString();
        return request(`/api/app/projects/${encodeURIComponent(project)}/files${qs ? `?${qs}` : ''}`);
    },
    projectContentUrl: (project: string, filePath: string, download = false, owner?: string | null) => {
        const pathPart = String(filePath || '')
            .replace(/\\/g, '/')
            .split('/')
            .filter(Boolean)
            .map(encodeURIComponent)
            .join('/');
        return `/api/app/projects/${encodeURIComponent(project)}/content/${pathPart}${ownerQs(owner, { download: download ? 1 : undefined })}`;
    },
    putProjectContent: async (project: string, filePath: string, content: string | Blob, owner?: string | null) => {
        const pathPart = String(filePath || '')
            .replace(/\\/g, '/')
            .split('/')
            .filter(Boolean)
            .map(encodeURIComponent)
            .join('/');
        const url = `/api/app/projects/${encodeURIComponent(project)}/content/${pathPart}${ownerQs(owner)}`;
        const isText = typeof content === 'string';
        const res = await accountFetch(url, {
            method: 'PUT',
            headers: isText ? { 'Content-Type': 'application/json' } : {},
            body: isText ? JSON.stringify({ content }) : (() => {
                const form = new FormData();
                form.append('file', content, filePath.split('/').pop() || 'upload');
                return form;
            })()
        });
        let json: { error?: { code?: string; message?: string } } | null = null;
        try { json = await res.json(); } catch { /* non-JSON */ }
        if (!res.ok) {
            const error = json?.error || {};
            throw new ApiError(res.status, error.code || 'INTERNAL',
                error.message || `Request failed (${res.status})`);
        }
        return json;
    },
    deleteProjectContent: (project: string, filePath: string, owner?: string | null) => {
        const pathPart = String(filePath || '')
            .replace(/\\/g, '/')
            .split('/')
            .filter(Boolean)
            .map(encodeURIComponent)
            .join('/');
        return request(`/api/app/projects/${encodeURIComponent(project)}/content/${pathPart}${ownerQs(owner)}`,
            { method: 'DELETE' });
    },
    projectTriggers: (project: string, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(project)}/triggers${ownerQs(owner)}`),
    createProjectTrigger: (project: string, body: Record<string, unknown>, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(project)}/triggers${ownerQs(owner)}`,
            { method: 'POST', body: owner ? { ...body, owner } : body }),
    updateProjectTrigger: (project: string, trigger: string | number, body: Record<string, unknown>, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(project)}/triggers/${encodeURIComponent(String(trigger))}${ownerQs(owner)}`,
            { method: 'PATCH', body: owner ? { ...body, owner } : body }),
    projectTriggerDeliveries: (project: string, trigger: string | number, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(project)}/triggers/${encodeURIComponent(String(trigger))}/deliveries${ownerQs(owner)}`),
    deleteProjectTrigger: (project: string, trigger: string | number, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(project)}/triggers/${encodeURIComponent(String(trigger))}${ownerQs(owner)}`,
            { method: 'DELETE' }),
    projectConversation: (project: string, owner?: string | null) =>
        request<{ id: number; title: string; created?: boolean }>(
            `/api/app/projects/${encodeURIComponent(project)}/conversation${ownerQs(owner)}`),
    projectParlor: (project: string, owner?: string | null) =>
        request<{ conversation: { id: number; title: string | null; ownerId: string; projectId: number }; role: string }>(
            `/api/app/projects/${encodeURIComponent(project)}/parlor${ownerQs(owner)}`),
    spitballLenses: () => request('/api/app/spitball/lenses'),
    spitballExpeditions: (projectId?: number | null) =>
        request(`/api/app/spitball/expeditions${projectId ? `?projectId=${encodeURIComponent(String(projectId))}` : ''}`),
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
    // Research briefs (#254): private to the expedition's owner.
    spitballBriefs: (expeditionId: number | string) =>
        request<{ briefs: BriefSummary[] }>(`/api/app/spitball/expeditions/${expeditionId}/briefs`),
    spitballGenerateBrief: (expeditionId: number | string) =>
        request<BriefDetail>(`/api/app/spitball/expeditions/${expeditionId}/briefs`, { method: 'POST' }),
    spitballBrief: (briefId: number | string) =>
        request<BriefDetail>(`/api/app/spitball/briefs/${briefId}`),
    spitballBriefOverlay: (briefId: number | string, body: { edits: Array<{ target: string; text: string; type: 'wording' | 'factual'; note?: string | null }>; expectedRevision: number }) =>
        request<BriefDetail>(`/api/app/spitball/briefs/${briefId}/overlay`, { method: 'PUT', body }),
    spitballBriefReview: (briefId: number | string, body: { marks: Record<string, string | null>; rationale?: Record<string, string>; gates: Record<string, boolean | null>; notes?: string | null; expectedRevision: number }) =>
        request<BriefDetail>(`/api/app/spitball/briefs/${briefId}/review`, { method: 'PUT', body }),
    spitballBriefAccept: (briefId: number | string, accepted: boolean) =>
        request<BriefDetail>(`/api/app/spitball/briefs/${briefId}/accept`, { method: 'POST', body: { accepted } }),
    spitballBriefUse: (briefId: number | string, used: boolean, note?: string | null) =>
        request<BriefDetail>(`/api/app/spitball/briefs/${briefId}/use`, { method: 'POST', body: { used, note: note ?? null } }),
    spitballBriefExportUrl: (briefId: number | string) => `/api/app/spitball/briefs/${briefId}/export.md?download=1`,
    spitballBriefMeasure: (days = 30) =>
        request<BriefMeasure>(`/api/app/spitball/briefs/measure?days=${encodeURIComponent(String(days))}`),
    spitballNoteEvidence: (nodeId: number | string) =>
        request(`/api/app/spitball/notes/${nodeId}/evidence`),
    spitballNotes: (scope: string, filters: {
        q?: string; type?: string; tag?: string; source?: string;
        /** Server-side curation projection (ADR 0008); defaults to `knowledge`. */
        view?: 'knowledge' | 'memory' | 'all';
        /** Exact curation filter on top of the projection. */
        curation?: 'saved' | 'memory' | 'unclassified' | '';
        limit?: number; offset?: number;
    } = {}) => {
        const params = new URLSearchParams({ scope });
        if (filters.q) params.set('q', filters.q);
        if (filters.type) params.set('type', filters.type);
        if (filters.tag) params.set('tag', filters.tag);
        if (filters.source) params.set('source', filters.source);
        if (filters.view) params.set('view', filters.view);
        if (filters.curation) params.set('curation', filters.curation);
        if (filters.limit) params.set('limit', String(filters.limit));
        if (filters.offset) params.set('offset', String(filters.offset));
        return request(`/api/app/spitball/notes?${params.toString()}`);
    },
    /** Keep / Treat as memory: changes `curation` only, never source, content or revisions. */
    spitballSetNoteCuration: (scope: string, nodeId: number | string, curation: 'saved' | 'memory') =>
        request(`/api/app/spitball/notes/${nodeId}`, { method: 'PATCH', body: { scope, curation } }),
    spitballCreateNote: (scope: string, fields: Record<string, unknown>) =>
        request('/api/app/spitball/notes', { method: 'POST', body: { scope, ...fields } }),
    spitballUpdateNote: (scope: string, nodeId: number | string, fields: Record<string, unknown>) =>
        request(`/api/app/spitball/notes/${nodeId}`, { method: 'PATCH', body: { scope, ...fields } }),
    spitballDeleteNote: (scope: string, nodeId: number | string) =>
        request(`/api/app/spitball/notes/${nodeId}?scope=${encodeURIComponent(scope)}`, { method: 'DELETE' }),

    // Explicit transfers (ADR 0010): deterministic service actions, no model call.
    /** Save an assistant answer as a saved personal note with provenance back to the message. */
    saveMessageAsNote: (body: {
        conversationId: number; messageId: number; label?: string; content?: string; tags?: string[];
    }) => request('/api/app/spitball/notes/from-message', { method: 'POST', body }),
    /** Where a personal note has gone: the chat it came from, projects, discussions. */
    noteTransfers: (nodeId: number | string) =>
        request(`/api/app/spitball/notes/${nodeId}/transfers`),
    /** Add to project (reference into a private project you own, or a published copy). */
    addNoteToProject: (nodeId: number | string, body: { project: string; owner?: string | null; mode: 'reference' | 'copy' }) =>
        request(`/api/app/spitball/notes/${nodeId}/transfers`, { method: 'POST', body: { target: 'project', ...body } }),
    /** Use in discussion: the note becomes a message from you in that transcript. */
    useNoteInDiscussion: (nodeId: number | string, conversationId: number, requestId: string) =>
        request(`/api/app/spitball/notes/${nodeId}/transfers`, { method: 'POST', body: { target: 'discussion', conversationId, requestId } }),
    /** Drop a reference you made; copies are removed from the project side. */
    removeNoteReference: (transferId: number | string) =>
        request(`/api/app/spitball/transfers/${transferId}`, { method: 'DELETE' }),
    /** Who can read a project right now - named before a copy is published. */
    projectAudience: (slug: string, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/audience${ownerQs(owner)}`),
    /** Remove a note from a project's scope (owner, or the publisher of a copy). */
    deleteProjectKnowledgeNote: (slug: string, nodeId: number | string, owner?: string | null) =>
        request(`/api/app/projects/${encodeURIComponent(slug)}/knowledge/notes/${nodeId}${ownerQs(owner)}`, { method: 'DELETE' }),

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

export async function fetchSpeech(
    text: string,
    signal?: AbortSignal | null,
    opts: { voiceId?: string | null } = {}
): Promise<Blob> {
    const res = await accountFetch('/api/app/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts.voiceId ? { text, voiceId: opts.voiceId } : { text }),
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
    onStart?: (data: { conversationId?: number; turnId?: string }) => void;
    onSnapshot?: (progress: TurnProgress) => void;
    onTyping?: () => void;
    onDelta?: (text: string) => void;
    onTool?: (data: ToolEvent) => void;
    onMessage?: (data: { content: string; attachments?: ChatAttachment[]; isError?: boolean }) => void;
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
    const isGet = payload === null || payload === undefined;
    const res = await accountFetch(url, {
        method: isGet ? 'GET' : 'POST',
        headers: isGet ? {} : { 'Content-Type': 'application/json' },
        body: isGet ? undefined : JSON.stringify(payload),
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
            if (parsed?.event === 'session-revoked') { sessionChanged(); return; }
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

/** Reattach to an in-flight Study turn (snapshot + live events). */
export function streamLiveTurn(
    handlers: ChatHandlers = {},
    signal?: AbortSignal | null,
    turnId?: string | null
) {
    const expected = turnId ? String(turnId) : null;
    const qs = expected ? `?turnId=${encodeURIComponent(expected)}` : '';
    // Until a matching `start` arrives, ignore snapshots/deltas so a retry
    // cannot hydrate a later queued turn into this chat. `done` still ends
    // the stream so the original turn can settle.
    let bound = expected;
    let matching = !expected;
    return readSse(`/api/app/chat/turn/stream${qs}`, null, (event, data) => {
        if (event === 'start') {
            const incoming = (data as { turnId?: string })?.turnId;
            if (bound && incoming && incoming !== bound) {
                matching = false;
                return;
            }
            if (incoming) bound = String(incoming);
            matching = true;
            handlers.onStart?.(data as { conversationId?: number; turnId?: string });
            return;
        }
        if (event === 'done') {
            handlers.onDone?.(data as { ok?: boolean });
            return;
        }
        if (event === 'error') {
            handlers.onError?.(data as { message?: string });
            return;
        }
        if (!matching) return;
        if (event === 'snapshot') handlers.onSnapshot?.(data as TurnProgress);
        else if (event === 'typing') handlers.onTyping?.();
        else if (event === 'delta') handlers.onDelta?.((data as { text?: string }).text || '');
        else if (event === 'tool') handlers.onTool?.(data as ToolEvent);
        else if (event === 'message') handlers.onMessage?.(data as { content: string });
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

export function streamProjectChat(project: string, payload: Record<string, unknown>, handlers: ChatHandlers = {}, signal?: AbortSignal | null, owner?: string | null) {
    return readSse(`/api/app/projects/${encodeURIComponent(project)}/chat${ownerQs(owner)}`, payload, (event, data) => {
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
