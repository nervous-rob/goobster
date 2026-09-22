import type { StartPage } from './rooms';

export type Scope = {
    id: string;
    kind: 'dm' | 'guild';
    name: string;
    icon?: string | null;
    manageGuild?: boolean;
    graphAvailable?: boolean;
};

export type Me = {
    user: { id: string; name: string; avatar: string | null };
    /** Application identity (shared-instance): entitlement and sign-in surface. */
    identity?: {
        installationId: string | null;
        installationName?: string;
        account: { role: 'member' | 'operator'; status: 'active' | 'disabled'; entitlement: Entitlement } | null;
        discordLinked: boolean;
        operator: boolean;
        nativeLogin: boolean;
        /** Effective sign-up policy and whether email-backed flows exist. */
        registration?: RegistrationMode;
        mail?: boolean;
    };
    /** The Discord bot user when Discord is connected; null otherwise (kept for compatibility). */
    bot: { id: string; name: string } | null;
    /** The assistant's identity on this installation - always present, with or without Discord. */
    assistant: { id: string; name: string };
    /** The Discord adapter: part of this installation at all, and reachable right now. */
    discord: { enabled: boolean; connected: boolean; reason: string | null };
    /** The in-app inbox: unread count for the sidebar badge. */
    inbox: { unread: number };
    scopes: Scope[];
    maxInputLength: number;
    /** `projects` = organizing projects (ADR 0009); `observatory` = running code in them. */
    features: { projects?: boolean; observatory?: boolean; spitball?: boolean };
};

export type InboxKind = 'reminder' | 'task' | 'watch' | 'notice' | 'invite' | 'project' | 'expedition' | 'system';

/** One delivered result of unattended work (GET /api/app/inbox). */
export type InboxItem = {
    id: number;
    kind: InboxKind;
    title: string;
    body: string | null;
    source: { type: string; id: string | null } | null;
    link: string | null;
    /**
     * Set when this row is the Inbox delivery of one or more attention
     * notices (`source.type === 'attention'`). The notices' own actions
     * stay on Attention; this is the relationship and their current status.
     */
    attention: {
        notices: Array<{
            id: number;
            title: string | null;
            status: string | null;
            snoozeUntil: string | null;
        }>;
    } | null;
    attachments: Array<{ url: string; name: string | null }>;
    read: boolean;
    archived: boolean;
    /** The optional Discord echo of this item: bookkeeping, never the source of truth. */
    discord: { status: 'skipped' | 'sent' | 'failed'; error: string | null; sentAt: string | null };
    createdAt: string;
};

export type InboxList = { items: InboxItem[]; unread: number; nextCursor: string | null };

/** Someone the signed-in person can reach (GET /api/app/people, invite pickers). */
export type Person = {
    id: string;
    name: string;
    avatar?: string | null;
    source: 'friend' | 'server' | 'member';
    via?: string | null;
};

export type Entitlement = 'invite' | 'migration' | 'bootstrap' | 'open';
export type RegistrationMode = 'invite' | 'open';

/** GET /api/app/account - the signed-in person's sign-in methods (safe metadata only). */
export type AccountSummary = {
    principalId: string;
    kind: 'legacy' | 'native';
    displayName: string | null;
    account: { role: string; status: string; entitlement: string; loginName: string | null } | null;
    nativeLogin: boolean;
    hasPassword: boolean;
    passwordMinLength: number;
    /** The address on file, if any, and whether it has been proven. */
    email: { address: string; verified: boolean; pendingVerification: boolean; updatedAt: string } | null;
    /** Whether this installation can send mail (verification, recovery). */
    mail: { enabled: boolean; reason: string | null };
    discord: {
        linked: boolean;
        subject: string | null;
        linkedAt: string | null;
        canDisconnect: boolean;
        canConnect: boolean;
    };
    recentAuth: boolean;
    recentAuthMinutes: number;
    discordLoginAvailable: boolean;
};

export type InviteState = 'open' | 'redeemed' | 'revoked' | 'expired';

export type Invite = {
    id: number;
    role: 'member' | 'operator';
    note: string | null;
    issuedBy: string;
    expiresAt: string;
    createdAt: string;
    consumedAt: string | null;
    consumedBy: string | null;
    revokedAt: string | null;
    state: InviteState;
};

export type InvitePreview = {
    role: 'member' | 'operator';
    expiresAt: string;
    installation: { id: string; name: string };
    passwordMinLength: number;
};

export type AdminAccount = {
    principalId: string;
    displayName: string | null;
    loginName: string | null;
    status: 'active' | 'disabled';
    role: 'member' | 'operator';
    entitlement: Entitlement;
    hasPassword: boolean;
    discordLinked: boolean;
    email: { address: string; verified: boolean } | null;
    createdAt: string;
    updatedAt: string;
};

/** GET /api/app/admin/installation - sign-up policy and mail status. */
export type InstallationView = {
    installationId: string;
    installationName: string;
    publicUrl: string | null;
    nativeLogin: boolean;
    requireAccount: boolean;
    registration: { configured: RegistrationMode; effective: RegistrationMode };
    mail: { enabled: boolean; provider: string | null; from: string | null; linksEnabled: boolean; reason: string | null };
    emailVerifyTtlMinutes: number;
    recoveryTtlMinutes: number;
};

export type MigrationReport = {
    generatedAt: string;
    installationId: string;
    requireAccount: boolean;
    tables: Array<{ table: string; column: string; rows: number; owners: number }>;
    owners: { total: number; snowflake: number; native: number; unresolved: number; withPrincipal: number; withAccount: number };
    unresolved: Array<{ id: string; rows: number; tables: string[] }>;
    principals: { total: number };
    accounts: { total: number; active: number; disabled: number; operators: number };
};

/** Spitball Expeditions (autonomous research runs) */
export type Lens = {
    id: string;
    name: string;
    description: string;
    sourcePreferences: string[];
    relationshipPriorities: string[];
    noteArchetypes: string[];
    epistemicPolicy: Record<string, boolean>;
};

export type Lead = {
    topic: string;
    kind?: string;
    reason?: string;
    relevance?: number;
    novelty?: number;
    uncertainty?: number;
    expectedValue?: number;
    suggestedQueries?: string[];
    cycleNumber?: number;
};

export type ExpeditionCycle = {
    id: number;
    cycleNumber: number;
    status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
    sourceCount: number;
    sourcesAccepted: number;
    claimsExtracted: number;
    notesProposed: number;
    notesCreated: number;
    notesMerged: number;
    edgesCreated: number;
    tagsAdded: number;
    conflictsFound: number;
    noveltyScore: number | null;
    coverageScore: number | null;
    coverage?: { summary?: string; unresolvedQuestions?: string[] } | null;
    leads: Lead[];
    startedAt?: string;
    finishedAt?: string | null;
    lastError?: string | null;
};

export type ResearchSource = {
    id: number;
    cycleId: number | null;
    provider: string;
    sourceType?: string | null;
    url?: string | null;
    canonicalUrl?: string | null;
    title?: string | null;
    author?: string | null;
    publisher?: string | null;
    publishedAt?: string | null;
    retrievedAt?: string;
    relevanceScore?: number | null;
    qualityScore?: number | null;
    noveltyScore?: number | null;
    accepted: boolean;
    rejectionReason?: string | null;
};

export type ResearchClaim = {
    id: number;
    sourceId: number | null;
    cycleId?: number | null;
    text: string;
    kind: string;
    confidence: number;
    sourceLocation?: string | null;
    createdAt?: string;
};

/**
 * Saved-knowledge curation (ADR 0008): did the person decide to keep this?
 * Independent of `source`, which records who wrote the row.
 */
export type Curation = 'saved' | 'memory' | 'unclassified';

/** The server-side projection a personal-scope read asks for. */
export type CurationView = 'knowledge' | 'memory' | 'all';

export type CurationCounts = { saved: number; memory: number; unclassified: number };

export type UserNote = {
    id: number;
    type: string;
    label: string;
    content?: string | null;
    salience?: number;
    confidence?: number;
    source?: string;
    curation?: Curation;
    tags: string[];
    createdAt?: string;
    updatedAt?: string;
};

export type NotesPayload = {
    notes: UserNote[];
    total: number;
    cap: number;
    view: CurationView;
    types: Array<{ type: string; c: number }>;
    sources: Array<{ source: string; c: number }>;
    curations: Array<{ curation: Curation; c: number }>;
    tags: Array<{ name: string; uses: number }>;
    /** Scope-wide breakdown, independent of the projection. */
    curation: CurationCounts;
    nodeTypes: string[];
    nodeSources: string[];
    curationStates: Curation[];
    views: CurationView[];
};

// --- Explicit transfers (ADR 0010) -----------------------------------------

/** Who can read a destination at the moment a note enters it. */
export type TransferAudience = {
    kind: 'personal' | 'project' | 'discussion';
    ownerId: string;
    ownerName?: string | null;
    members?: Array<{ userId: string; userName: string | null }>;
    memberIds: string[];
    shared: boolean;
    private: boolean;
};

export type TransferMode = 'reference' | 'copy';

/** One row of the transfer ledger, as the API returns it. */
export type KnowledgeTransfer = {
    id: number;
    userId: string;
    sourceKind: 'chat_message' | 'note';
    sourceConversationId: number | null;
    sourceMessageId: number | null;
    sourceNodeId: number | null;
    sourceLabel: string | null;
    targetKind: 'note' | 'project' | 'discussion';
    targetId: number;
    mode: TransferMode;
    copyNodeId: number | null;
    copyMessageId: number | null;
    audience: TransferAudience | null;
    createdAt: string;
};

/** Where a personal note has gone (GET /api/app/spitball/notes/:id/transfers). */
export type NoteDestinations = {
    note: { id: number; label: string; curation?: Curation };
    savedFrom: { conversationId: number | null; messageId: number | null; title: string | null; createdAt: string } | null;
    projects: Array<{
        transferId: number;
        mode: TransferMode;
        projectId: number;
        slug: string;
        name: string;
        ownerId: string;
        role: 'owner' | 'collaborator';
        copyNodeId: number | null;
        audience: TransferAudience | null;
        canRemove: boolean;
        createdAt: string;
    }>;
    discussions: Array<{
        transferId: number;
        conversationId: number;
        title: string | null;
        ownerId: string;
        projectId: number | null;
        messageId: number | null;
        messageExists: boolean;
        audience: TransferAudience | null;
        canRemove: boolean;
        createdAt: string;
    }>;
};

/** POST .../transfers with target=project. */
export type AddToProjectResult = {
    mode: TransferMode;
    project: { id: number; slug: string; name: string; ownerId: string; role: 'owner' | 'collaborator' };
    audience: TransferAudience;
    transfer: KnowledgeTransfer;
    copy: { id: number; label: string } | null;
};

/** POST .../transfers with target=discussion. */
export type UseInDiscussionResult = {
    mode: 'copy';
    discussion: { id: number; title: string | null; ownerId: string; projectId: number | null };
    audience: TransferAudience;
    message: { id: number };
    transfer: KnowledgeTransfer;
};

/** POST /api/app/spitball/notes/from-message. */
export type SaveMessageAsNoteResult = {
    note: UserNote;
    transfer: KnowledgeTransfer;
    truncated: boolean;
};

/** GET /api/app/projects/:slug/audience. */
export type ProjectAudience = TransferAudience & {
    role: 'owner' | 'collaborator';
    project: { id: number; slug: string; name: string; ownerId: string };
};

export type NoteEvidence = {
    note: { id: number; label: string; type?: string; content?: string | null; confidence?: number; source?: string };
    expeditions: Array<{ id: number; seed: string; lensId?: string | null; status: string; finishedAt?: string | null }>;
    claims: Array<{
        id: number;
        text: string;
        kind: string;
        confidence: number;
        sourceLocation?: string | null;
        source: { id: number; title?: string | null; url?: string | null; provider: string; sourceType?: string | null; publisher?: string | null };
    }>;
    otherProvenance: Record<string, number>;
};

export type Expedition = {
    id: number;
    projectId?: number | null;
    seed: string;
    lensId: string | null;
    lensText: string | null;
    intent: string | null;
    depth: 'focused' | 'standard' | 'deep';
    status: 'DRAFT' | 'QUEUED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
    maxCycles: number;
    maxSources: number;
    maxNotes: number;
    currentCycle: number;
    sourcesAccepted: number;
    notesCreated: number;
    edgesCreated: number;
    summary: string | null;
    stopReason: string | null;
    lastError: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    lens?: Lens | null;
    researchBrief?: ResearchBrief | null;
    continuationProposal?: ContinuationProposal | null;
};

export type ResearchBrief = {
    shape: 'survey' | 'timeline' | 'deep_dive' | 'comparison' | 'default';
    varietyTarget: number;
    depthPerUnit: 'shallow' | 'medium' | 'deep';
    unitKind: 'person' | 'concept' | 'event' | 'work' | 'mixed';
    coverageUnits: Array<{ label: string; kind: string }>;
    searchStrategy: string;
};

export type ContinuationProposal = {
    needed: boolean;
    extendable?: boolean;
    reason?: string | null;
    suggestedCycles?: number;
    uncoveredUnits?: string[];
    remainingGaps?: string[];
    coveredCount?: number;
    varietyTarget?: number;
    summary?: string | null;
};

export type ExpeditionDetail = {
    expedition: Expedition;
    cycles: ExpeditionCycle[];
    sources: ResearchSource[];
    leads: Lead[];
};

export type AppConfig = {
    clientId: string;
    devMode: boolean;
    loginAvailable: boolean;
    nativeLogin: boolean;
    /** Effective sign-up policy ('open' only when mail is configured). */
    registration: RegistrationMode;
    /** "Forgot password" by email is available. */
    emailRecovery: boolean;
    installationName: string;
    /** Whether this installation has a Discord adapter at all. */
    discord: boolean;
    passwordMinLength: number;
    maxInputLength: number;
};

export type Conversation = {
    id: number;
    title: string | null;
    messageCount?: number;
    lastMessageAt?: string | null;
    parentConversationId?: number | null;
    branchedFromMessageId?: number | null;
    shareToken?: string | null;
};

/**
 * One entry in a turn's "Thinking" timeline: interstitial text the model
 * wrote before calling tools, or a tool execution. Streamed live over SSE
 * and persisted with the reply (metadata.steps), so live turns and reloaded
 * history render identically. `running` exists only client-side, marking a
 * tool whose result event hasn't arrived yet.
 */
export type TurnStep = {
    type: 'text' | 'tool';
    content?: string;
    id?: number;
    name?: string;
    argsPreview?: string;
    resultPreview?: string;
    isError?: boolean;
    cached?: boolean;
    durationMs?: number;
    running?: boolean;
};

/** Server snapshot of an in-flight Study turn (thoughts / tools / draft). */
export type TurnProgress = {
    userContent?: string;
    draft?: string;
    typing?: boolean;
    steps?: TurnStep[];
};

/** Follow-up waiting for the current Study reply to finish. */
export type ChatQueueItem = {
    id: number | string;
    conversationId?: number | null;
    position: number;
    message: string;
    imageCount?: number;
    fileCount?: number;
    incognito?: boolean;
    createdAt?: string | null;
};

/** SSE `tool` event payload: per-tool progress within a streaming turn. */
export type ToolEvent = {
    phase: 'start' | 'result';
    id?: number;
    name: string;
    cached?: boolean;
    isError?: boolean;
    argsPreview?: string;
    resultPreview?: string;
    durationMs?: number;
};

/**
 * A file the bot attached to a reply: served through the owner-bound files
 * route; the optional hints drive the inline renderer (caption/source for
 * found-on-the-web files, kind when the extension is not enough).
 */
export type ChatAttachment = {
    url: string;
    name?: string;
    caption?: string;
    sourceUrl?: string;
    kind?: string;
};

export type ChatMessage = {
    id: number;
    role: 'user' | 'assistant' | 'system';
    content: string;
    createdAt: string;
    attachments?: ChatAttachment[];
    isError?: boolean;
    steps?: TurnStep[];
};

export type ApiErrorShape = {
    status: number;
    code: string;
    message: string;
    details?: unknown;
};

export type SettingSection<TValues = Record<string, unknown>, TEffective = Record<string, unknown>> = {
    revision: number;
    scope: 'private' | 'account' | 'device';
    values: TValues;
    effective: TEffective;
    sources: Record<string, string>;
    appliesTo: string[];
    providers?: Array<{ key: string; name: string; configured: boolean; chatModel?: string }>;
    thoughtfulAvailable?: boolean;
    categories?: string[];
    initiativeLevels?: string[];
};

export type UserSettingsResponse = {
    schemaVersion: number;
    sections: {
        profile: SettingSection<{
            callGoobster: string | null;
            callUser: string | null;
            customInstructions: string | null;
            personalityDirective: string | null;
            memeMode: boolean;
            accountPreferredName: string | null;
            answerLength: 'concise' | 'balanced' | 'detailed';
            tone: 'neutral' | 'warm' | 'direct' | 'playful';
            humor: 'off' | 'light' | 'playful';
            responseLanguage: string | null;
            timezone: string | null;
            measurementSystem: 'follow-locale' | 'metric' | 'imperial';
            timeFormat: 'follow-locale' | '12' | '24';
            dateLocale: string | null;
            personalityPreset: 'concise-direct' | 'warm-detailed' | 'playful-brief' | null;
        }>;
        chat: SettingSection<{
            provider: string | null;
            model: string | null;
            reasoningEffort: string | null;
            thoughtful?: boolean;
            replyMaxTokens: number | null;
            temperature: number | null;
            topP: number | null;
            parlorProvider: string | null;
            parlorModel: string | null;
            researchProvider: string | null;
            researchModel: string | null;
            disabledTools: string[];
            usageAlertTokens: number | null;
        }, {
            provider: string | null;
            providerName?: string;
            model: string | null;
            reasoningEffort: string | null;
            thoughtful?: boolean;
            replyMaxTokens: number | null;
            temperature: number | null;
            topP: number | null;
            parlorProvider: string | null;
            parlorModel: string | null;
            researchProvider: string | null;
            researchModel: string | null;
            disabledTools: string[];
            usageAlertTokens: number | null;
        }>;
        voice: SettingSection<{
            voiceId: string | null;
            voiceName: string | null;
            speed: number;
            accent: string | null;
            voiceSendMode: 'auto' | 'manual';
            voiceCaptureEngine: 'auto' | 'live' | 'batch';
            speechPauseMs: number;
            startVoiceMuted: boolean;
            showCaptions: boolean;
            autoReadReplies: boolean;
        }, {
            voiceId: string | null;
            voiceName: string | null;
            speed: number;
            accent: string | null;
            accentLabel: string | null;
            voiceSendMode: 'auto' | 'manual';
            voiceCaptureEngine: 'auto' | 'live' | 'batch';
            speechPauseMs: number;
            startVoiceMuted: boolean;
            showCaptions: boolean;
            autoReadReplies: boolean;
        }> & { accents?: Array<{ id: string; label: string }> };
        initiative: SettingSection<{
            enabled: boolean;
            initiative: string;
            maxContactsPerDay: number;
            contactCooldownMinutes: number;
            quietStartMinute: number | null;
            quietEndMinute: number | null;
            boundaries: Record<string, { proactiveRead?: boolean; proactiveCompute?: boolean; externalWrite?: string | boolean }>;
            notifyInApp: boolean;
            notifyMentionBanners: boolean;
            notifyOutbound: boolean;
            notifySounds: boolean;
            presenceVisible: boolean;
            defaultSnoozeHours: number;
            quietHoursTzMode: 'utc' | 'local';
        }>;
        memory: SettingSection<{
            retentionDays: number | null;
            defaultNewChatPrivacy: 'regular' | 'incognito';
            learnMemories: boolean;
            useMemories: boolean;
            chatHistoryRetentionDays: number | null;
        }>;
        appearance: SettingSection<{
            theme: 'light' | 'dark' | 'system';
            linkByTag: boolean;
            textSize: 's' | 'm' | 'l';
            reducedMotion: 'system' | 'on' | 'off';
            density: 'comfortable' | 'compact';
            enterToSend: boolean;
            expandChatDetails: boolean;
            startPage: StartPage;
            hiddenToolRooms: string[];
            preferredExchangeGuild: string | null;
            expeditionDefaultDepth: 'focused' | 'standard' | 'deep';
            expeditionDefaultLens: string;
            parlorDefaultEmoji: string | null;
            parlorDefaultCharter: string | null;
        }>;
        connections: SettingSection<{
            github: { connected: boolean; verifiedAccount: string | null };
            notion: { connected: boolean; verifiedAccount: string | null };
            githubAllowlist: string[];
            notionAllowlist: string[];
        }>;
        account: SettingSection<{
            userId: string;
            username: string;
            avatar: string | null;
        }>;
    };
    capabilities: {
        stt: boolean;
        tts: boolean;
        liveVoice?: boolean;
    };
};

export type SectionUpdateResponse = {
    section: string;
    revision: number;
    data: SettingSection;
};

export type ResetPreviewResponse = {
    section: string;
    currentRevision: number;
    currentValues: Record<string, unknown>;
    proposedValues: Record<string, unknown>;
    changes: Record<string, unknown>;
};

export type RetentionPreviewResponse = {
    section: 'memory';
    currentRevision: number;
    currentRetentionDays: number | null;
    proposedRetentionDays: number | null;
    memoryCount: number;
    affectedCount: number;
    dataClasses: string[];
};

export type ChatHistoryPreviewResponse = {
    section: 'memory';
    currentRevision: number;
    proposedRetentionDays: number | null;
    conversationCount: number;
    affectedCount: number;
    dataClasses: string[];
};

export type SettingsSectionId = keyof UserSettingsResponse['sections'];
