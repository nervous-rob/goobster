import type { StartPage } from './rooms';

export type Scope = {
    id: string;
    kind: 'dm' | 'guild';
    name: string;
    icon?: string | null;
    manageGuild?: boolean;
    graphAvailable?: boolean;
};

export type TokenLimits = { dailyTokens: number | null; windowHours: number; retentionDays: number };
export type TokenUsage = TokenLimits & {
    windowStart: string; resetsAt: string; usedTokens: number; remainingTokens: number | null; waitingRequests: number;
};
export type AdminLimits = TokenLimits & { accounts: Array<TokenUsage & { principalId: string; displayName: string }> };

/** One reason a feature is not active (codes only; the server never sends detail values). */
export type FeatureReason = {
    code: 'NOT_INSTALLED' | 'DISABLED' | 'ENV_OFF' | 'DEPENDENCY_INACTIVE' | 'STATE_ERROR' | 'UNKNOWN_FEATURE';
    dependency?: string;
};

/** The sanitized per-feature state from `GET /api/app/features`; `active` is the reported value the portal acts on. */
export type FeatureStatusEntry = {
    installed: boolean;
    configured: boolean;
    active: boolean;
    pending: boolean;
    requested: boolean;
    pendingActive: boolean | null;
    reasons: FeatureReason[];
    warnings: Array<{ code: string }>;
};

export type FeatureStatus = {
    source: string;
    revision: number | null;
    origin: string | null;
    error: { code: string } | null;
    features: Record<string, FeatureStatusEntry>;
};

export type Me = {
    /** Added client-side from `GET /api/app/features`; null when that request failed (the legacy `features` flags then decide). */
    featureStatus?: FeatureStatus | null;
    limits?: TokenUsage;
    sessionId?: number;
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
    /** Friend requests waiting for an answer and unread direct messages. */
    people?: { pending: number; unread: number };
    scopes: Scope[];
    maxInputLength: number;
    /** `projects` = organizing projects (ADR 0009); `observatory` = running code in them. */
    features: { projects?: boolean; observatory?: boolean; spitball?: boolean };
    /** Installation pause (a restore leaves the instance this way until the host resumes it). */
    instance?: { paused: boolean; reason: string | null; since: string | null };
};

/** Web Push for the installed app (documentation/pwa.md). */
export type PushStatus = {
    enabled: boolean;
    reason: string | null;
    publicKey: string | null;
    devices: number;
    thisDevice: boolean;
};

export type PushSendSummary = {
    sent: number;
    failed: number;
    pruned: number;
    skipped: boolean;
};

/** A stored MCP token. The secret itself is never in this shape. */
export type McpScope = 'read' | 'docs';

export type McpToken = {
    id: number;
    label: string;
    tokenPrefix: string;
    scope: McpScope;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt?: string | null;
    /** UTC text, or null for a token that never expires. */
    expiresAt: string | null;
    expired: boolean;
};

export type McpScopeInfo = { id: McpScope; label: string; description: string };

export type McpOverview = {
    enabled: boolean;
    endpoint: string;
    readOnly: true;
    tools: string[];
    resources: boolean;
    scopes: McpScopeInfo[];
    defaultExpiryDays: number;
    maxExpiryDays: number;
    tokens: McpToken[];
};

export type McpTokenInput = {
    label: string;
    scope: McpScope;
    /** 0 means the token never expires. */
    expiresInDays: number;
};

export type McpTokenCreated = McpToken & { token: string };

/** Skipped-schedule counts a resume reports (documentation/backup_and_restore.md). */
export type SkippedSchedules = {
    automations: number;
    cronTriggers: number;
    eventTriggers: number;
    recurringFollowups: number;
    oneShotFollowups: number;
};

/** GET /api/app/admin/instance - pause state and the last restore / resume. */
export type InstanceStateView = {
    paused: {
        reason: string;
        since: string;
        by: string | null;
        detail?: { archive?: string; archiveCreatedAt?: string; interrupted?: Record<string, number> };
    } | null;
    lastRestore: {
        at: string;
        archive: string;
        archiveCreatedAt: string;
        engine: string;
        schemaChanged: boolean;
        configRestored: boolean;
        interrupted: Record<string, number>;
        by: string | null;
    } | null;
    lastResume: {
        at: string;
        by: string | null;
        pausedSince: string | null;
        pauseReason: string | null;
        skipped: SkippedSchedules;
    } | null;
};

export type InboxKind = 'reminder' | 'task' | 'watch' | 'notice' | 'invite' | 'project' | 'expedition' | 'system';

/** One delivered result of unattended work (GET /api/app/inbox). */
/** One work_failures row as the portal shows it (never a prompt or a body). */
export type WorkFailureRef = {
    id: number | null;
    kind: string | null;
    code: string | null;
    phase: string | null;
    reason: string | null;
    workId: string | null;
    createdAt: string | null;
};

export type WorkFailureRow = {
    id: number;
    kind: string;
    workId: string | null;
    phase: string | null;
    code: string;
    reason: string | null;
    createdAt: string;
};

export type ResourceTotal = { kind: string; unit: string; events: number; quantity: number };

/**
 * GET /api/app/usage/diagnostics (your own) and
 * GET /api/app/admin/accounts/:principalId/support (operators).
 */
export type AccountSupportView = {
    principalId: string;
    days: number;
    usage: { calls: number; inputTokens: number; outputTokens: number; totalTokens: number };
    resources: ResourceTotal[];
    failures: {
        total: number;
        byKind: Array<{ kind: string; count: number }>;
        byCode: Array<{ kind: string; code: string; count: number }>;
        recent: WorkFailureRow[];
    };
};

/** GET /api/app/admin/audit - one operator action. */
export type OperatorAuditEntry = {
    id: number;
    action: string;
    actor: string | null;
    target: string | null;
    detail: Record<string, unknown> | null;
    createdAt: string;
};

export type InboxAsk = {
    available: boolean; reason: string | null;
    project: { id: number; slug: string; name: string; ownerId: string } | null;
    conversations: Array<{ title: string; path: string }>;
};
export type InboxItem = {
    ask?: InboxAsk;
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
    /**
     * Set when this item reports a failed piece of work
     * (`source.type === 'work_failure'`): the ledger row it links to. The
     * fields are null when the row has already been pruned.
     */
    failure: WorkFailureRef | null;
    /**
     * Set when this item is about an access request (`source.type ===
     * 'access_request'`): the host's copy is actionable while pending; the
     * requester's outcome notice never is. Null once the person is erased.
     */
    access: {
        id: number;
        status: AccessRequestStatus;
        principalId: string;
        displayName: string | null;
        actionable: boolean;
        resolvedByName: string | null;
        resolvedAt: string | null;
    } | null;
    /**
     * Set when this item is about a friend request (`source.type ===
     * 'friend_request'`): the addressee's copy is actionable while pending;
     * the requester's acceptance notice never is. Null once someone is erased.
     */
    friend: {
        id: number;
        status: FriendRequestStatus;
        requesterId: string;
        requesterName: string;
        requesterAvatar: string | null;
        addresseeId: string;
        addresseeName: string;
        actionable: boolean;
        respondedAt: string | null;
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

// --- People: friends and direct messages (documentation/friends_and_messages.md)

export type FriendRequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'removed';

/** One friend, with portal presence (their "show me as online" setting respected). */
export type Friend = {
    id: string;
    name: string;
    avatar: string | null;
    since: string | null;
    online?: boolean;
};

/** One friend request, from either seat. */
export type FriendRequest = {
    id: number;
    status: FriendRequestStatus;
    requesterId: string;
    requesterName: string;
    requesterAvatar: string | null;
    addresseeId: string;
    addresseeName: string;
    addresseeAvatar: string | null;
    createdAt: string;
    respondedAt: string | null;
};

/** GET /api/app/friends */
export type FriendsOverview = { friends: Friend[]; incoming: FriendRequest[]; outgoing: FriendRequest[] };

/** The caller's relationship with a person in a search result. */
export type Relationship = {
    status: 'none' | 'friends' | 'outgoing' | 'incoming';
    requestId: number | null;
    direction: 'outgoing' | 'incoming' | null;
};

export type FriendCandidate = Person & { relationship: Relationship };

/** GET /api/app/friends/search - `kind` says how the query was read. */
export type FriendSearch = { people: FriendCandidate[]; kind: 'email' | 'id' | 'name' | 'none' };

export type DmMessage = {
    id: number;
    threadId: number;
    senderId: string;
    content: string;
    createdAt: string;
};

/** One direct-message thread as seen by the signed-in person. */
export type DmThread = {
    id: number;
    with: { id: string; name: string; avatar: string | null; online: boolean };
    /** False once the friendship ended: the thread is read-only. */
    friends: boolean;
    unread: number;
    lastMessage: DmMessage | null;
    createdAt: string;
    lastMessageAt: string | null;
};

export type DmThreadList = { threads: DmThread[]; unread: number };
export type DmThreadPage = { thread: DmThread; messages: DmMessage[]; hasMore: boolean };

export type Entitlement = 'invite' | 'migration' | 'bootstrap' | 'open';
export type RegistrationMode = 'invite' | 'open';

export type AccessRequestStatus = 'pending' | 'approved' | 'declined';

/** One "let me in" request from a signed-in person without an account. */
export type AccessRequest = {
    id: number;
    principalId: string;
    displayName: string | null;
    discordId: string | null;
    note: string | null;
    status: AccessRequestStatus;
    resolvedBy: string | null;
    resolvedByName: string | null;
    resolvedAt: string | null;
    createdAt: string;
};

/** GET /api/app/auth/access-request - what the kept-out person sees. */
export type AccessRequestStatusView = {
    request: AccessRequest | null;
    pending: boolean;
    member: boolean;
    canRequest: boolean;
    retryAt: string | null;
    requireAccount: boolean;
    discord: boolean;
};

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
    /** work_failures rows attributed to this account in the roster's window. */
    failures?: number;
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
    registration: { configured: RegistrationMode; effective: RegistrationMode; pausedReason: string | null };
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
    revision?: number;
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

/** Research brief (#254, documentation/research_brief.md). */
export type BriefEditType = 'none' | 'wording' | 'factual';
export type BriefClaimMark = 'supported' | 'unsupported' | 'missing a qualification';
export type BriefQualityStatus = 'unreviewed' | 'not-ready' | 'ready-to-show';

export type BriefMeta = {
    id: number;
    expeditionId: number;
    status: 'GENERATING' | 'READY' | 'FAILED';
    payer: string | null;
    generatedAt: string | null;
    generatedHash: string | null;
    promptVersion: number | null;
    model: { provider: string | null; name: string | null };
    errorCode: string | null;
    lastError: string | null;
    overlayRevision: number;
    reviewRevision: number;
    acceptedAt: string | null;
    usedAt: string | null;
    useNote: string | null;
    createdAt: string;
    updatedAt: string;
};

export type BriefSummary = BriefMeta & {
    editType: BriefEditType | null;
    quality: BriefQualityStatus | null;
    findings: number;
};

export type BriefBlock = {
    id: string;
    generated: string;
    edited: string | null;
    editType: 'wording' | 'factual' | null;
    editNote: string | null;
    editedAt: string | null;
    text: string;
    claimIds?: number[];
    cited?: boolean;
    citations?: number[];
    kind?: string;
};

export type BriefCitation = {
    n: number;
    claimId: number;
    sourceId: number;
    claimText: string;
    claimKind: string;
    confidence: number;
    sourceLocation: string | null;
    sourceTitle: string | null;
    url: string | null;
    publisher: string | null;
    author: string | null;
    publishedAt: string | null;
    retrievedAt: string | null;
};

export type BriefEvidenceNote = { kind: string; text: string; findingId?: string };

export type BriefOverlayEdit = { target: string; text: string; type: 'wording' | 'factual'; note: string | null; editedAt: string };

export type BriefReview = {
    marks: Record<string, BriefClaimMark>;
    rationale: Record<string, string>;
    gates: { noUnsupportedClaims: boolean | null; weakEvidenceLabelled: boolean | null; disagreementRepresented: boolean | null };
    notes: string | null;
    reviewedAt: string | null;
};

export type BriefQuality = {
    status: BriefQualityStatus;
    parts: { noUnsupportedClaims: boolean | null; weakEvidenceLabelled: boolean | null; disagreementRepresented: boolean | null; editsWordingOnly: boolean };
    counts: { findings: number; marked: number; supported: number; unsupported: number; missingQualification: number };
    editType: BriefEditType;
    reviewedAt: string | null;
    unreviewed: string[];
    reasons: string[];
};

export type BriefDetail = {
    brief: BriefMeta;
    generated: {
        promptVersion: number;
        summary: string;
        summaryClaimIds?: number[];
        findings: Array<{ id: string; text: string; claimIds: number[]; cited: boolean }>;
        limitations: Array<{ id: string; kind: string; text: string; claimIds: number[] }>;
        evidenceNotes: BriefEvidenceNote[];
        citations: BriefCitation[];
        evidence: { expeditionId: number; seed: string; intent: string | null; lens: string | null; cycles: number; sourceCount: number; claimCount: number };
    } | null;
    overlay: { edits: BriefOverlayEdit[] };
    review: BriefReview | null;
    rendered: {
        summary: BriefBlock;
        findings: BriefBlock[];
        limitations: BriefBlock[];
        evidenceNotes: BriefEvidenceNote[];
        citations: BriefCitation[];
        editType: BriefEditType;
    } | null;
    quality: BriefQuality | null;
    integrity: 'verified' | 'mismatch' | null;
};

export type BriefMeasure = {
    days: number;
    since: string;
    briefs: {
        total: number; ready: number; failed: number; generating: number;
        accepted: number; used: number; acceptedAndUsed: number;
        editType: Record<BriefEditType, number>;
        quality: Record<BriefQualityStatus, number>;
    };
    expeditions: number;
    cost: {
        status: 'unavailable' | 'provisional' | 'settled';
        totals: { actualTokens: number; estimatedTokens: number; resources: Record<string, number>; failures: number };
        perAccepted: { actualTokens: number; resources: Record<string, number> } | null;
        acceptedBriefIds: number[];
        note: string;
    };
};

export type AppConfig = {
    clientId: string;
    devMode: boolean;
    loginAvailable: boolean;
    nativeLogin: boolean;
    /** Effective sign-up policy ('open' only when mail is configured). */
    registration: RegistrationMode;
    /**
     * Open sign-up that cannot finish right now (the shared-installation
     * token-cap gate): the person-facing reason, or null when sign-ups work.
     */
    registrationPaused: string | null;
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
    waiting?: string;
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
    phase: 'start' | 'result' | 'admission';
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
            accent: 'blueberry' | 'ocean' | 'mint' | 'sunset' | 'rose' | 'violet' | 'amber' | 'graphite';
            surface: 'tinted' | 'neutral';
            navLayout: 'sidebar' | 'top';
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

export type SettingsSectionId = keyof UserSettingsResponse['sections'] | 'tutorials';

export type TutorialStatus =
    | 'not_started'
    | 'in_progress'
    | 'paused'
    | 'skipped'
    | 'completed'
    | 'finished_with_skips';

export type TutorialProgress = {
    accountId: string;
    tutorialId: string;
    version: number;
    generation: number;
    revision: number;
    status: TutorialStatus;
    currentStepId: string | null;
    completedStepIds: string[];
    skippedStepIds: string[];
    unavailableStepIds: string[];
    updatedAt: string | null;
};

export type TutorialCatalogEntry = {
    id: string;
    roomId: string;
    version: number;
    title: string;
    hostOnly: boolean;
    /** False when the tour's feature is not available on this installation; it stays listed but cannot be launched. */
    available?: boolean;
    unavailable?: { feature: string; reasons: FeatureReason[] } | null;
    stepIds: string[];
    steps: Array<{
        id: string;
        title: string;
        body: string | null;
        anchorId: string | null;
        path: string | null;
        demo: string | null;
        preview?: { before: string; action: string; after: string } | null;
        keepablePieceId: string | null;
    }>;
    launchable: boolean;
};

export type TutorialSample = {
    firstTask: { question: string; source: string; claim: string; brief: string };
    id: string;
    title: string;
    question: string;
    answer: { heading: string; body: string };
    notes: Array<{ id: string; label: string; content: string; tags: string[]; audience: string }>;
    source: { id: string; title: string; excerpt: string };
    claim: { id: string; text: string; distinguishedFrom: string };
    project: { id: string; name: string; slug: string; goal: string; audience: string };
    run: { id: string; title: string; status: string; output: string };
    app: { id: string; title: string; origin: string; version: string };
};

export type TutorialsResponse = {
    catalog: TutorialCatalogEntry[];
    progress: TutorialProgress[];
    preferences: {
        autoStart: boolean;
        orientationOfferedAt: string | null;
        updatedAt: string | null;
    };
    sample: TutorialSample;
};

/** Public model contract, supplied by the backend registry. */
export type ModelDescriptor = {
    id: string; canonicalId: string; provider: string; displayName: string; description: string;
    status: 'supported' | 'preview' | 'custom' | 'disabled'; aliases: string[];
    input: string[]; output: string[]; workflows: string[];
    capabilities: { imageInput: boolean; tools: 'native' | 'prompt-based' | false; streaming: boolean; nativeSearch: boolean; nativeSearchExcludedEfforts?: string[] };
    reasoning: { levels: string[]; default: string | null; aliases: Record<string, string> };
    sampling: { mode: 'always' | 'never' | 'reasoning-off'; temperatureMax: number; exclusive: boolean };
    contextWindow: number | null; maxOutputTokens: number | null; checkedAt: string | null; sources: string[];
    availability: 'listed' | 'not-listed' | 'unknown'; selectable: boolean;
};
export type ModelCatalog = {
    version: number; provider: string; workflow: string; models: ModelDescriptor[];
    discovery: { status: 'live' | 'cached' | 'stale' | 'unavailable' | 'not-configured'; checkedAt: string | null };
    unregisteredCount: number;
};

export type FollowedSourceEntry = {
    id: number; url: string; title: string; author: string | null; publishedAt: string | null;
    retrievedAt: string; contentHash: string; extractedText: string | null; kept: number; expeditionId: number | null;
};
export type FollowedSource = {
    id: number; label: string; url: string; kind: 'feed' | 'page'; enabled: boolean; initialized: boolean;
    lastCheckedAt: string | null; nextCheckAt: string | null; lastError: string | null; disabledCount: number;
    entries: FollowedSourceEntry[]; metrics: { acted: number; dismissed: number; snoozed: number; kept: number };
};
export type FollowedSources = { sources: FollowedSource[]; attentionEnabled: boolean };

// Song Studio shared songs (documents saved on the server and edited live)
export type StudioSongMember = { userId: string; userName: string | null; role: 'owner' | 'editor'; joinedAt: string };
export type StudioSongSummary = {
    id: string; name: string; ownerId: string; role: 'owner' | 'editor'; version: number;
    memberCount: number; createdAt: string; updatedAt: string;
};
export type StudioSongDetail = StudioSongSummary & { project: unknown; members: StudioSongMember[] };

export type AccountExportJob = {
    id: string;
    status: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'EXPIRED';
    createdAt: string;
    finishedAt: string | null;
    expiresAt: string;
    sizeBytes: number | null;
    fileCount: number | null;
    warningCount: number | null;
    error: string | null;
    downloadUrl: string | null;
};

// Host room: operator pages served through the installation manager (documentation/host_operations.md)
export type HostLifecycleWorker = {
    name: string; state: string; supervised?: boolean; pid?: number | null; revision?: number | null; staged?: boolean;
    healthy?: boolean | null; ackedRevision: number | null; restarts?: number; crashes?: number; crashLoop?: boolean;
    backoffMs?: number; code?: string | null; lastExit?: { code?: number | null; signal?: string | null; at?: string } | null;
};
export type HostLifecycleOutcome = {
    revision: number; outcome: 'applied' | 'failed' | 'rolled_back' | 'cancelled'; code?: string | null; at?: string;
    worker?: string; configRecovery?: string; previousRevisionReady?: boolean;
};
export type HostLifecycle = {
    supervising: boolean; mode: string | null; layout: string | null; layoutError: string | null; stateProblem: string | null;
    current: number; committing: boolean;
    pending: {
        revision: number; operationId?: string; changeRef?: string; phase: 'countdown' | 'committing' | string;
        deadline?: string; graceSeconds?: number; secondsLeft?: number;
    } | null;
    lastOutcome: HostLifecycleOutcome | null;
    acked: Record<string, number | null>;
    workers: HostLifecycleWorker[];
    events: Array<{ at: string; type: string; revision?: number; worker?: string; code?: string }>;
};
export type HostManagerStatus = {
    reachable: boolean; state: string | null; reason?: string | null; version?: string | null; installationId?: string | null;
    origin?: string | null; appDatabase?: { reachable: boolean; engine: string | null; reason: string | null } | null;
    lifecycle?: { supervising: boolean; layout: string | null; workers: Array<{ name: string; state: string; ackedRevision: number | null }> } | null;
    audit?: { pending: number } | null; bridge: { available: boolean };
    error: { code: string; message: string } | null;
};
export type HostFeatureState = {
    installed: boolean; configured: boolean; active: boolean; pending: boolean; requested: boolean;
    pendingActive: boolean | null;
    reasons: FeatureReason[]; warnings: Array<{ code: string; names?: string[] }>;
};
export type HostFeatureRow = {
    id: string; kind: string; title: string; summary: string; dependsOn: string[]; requiredBy: string[];
    freshDefault: 'on' | 'off' | string;
    apiKeys: Array<{ name: string; configPath: string | null; purpose: string; required: boolean }>;
    configKeys: string[]; systemDependencies: string[]; requiredSystemDependencies: string[]; docs: string[];
    hostSwitch?: { name: string; covers: string; existing: string };
    state: HostFeatureState;
};
export type HostSharedVerdict = { shared: boolean; reasons: string[]; activeAccounts: number; guilds: number };
export type HostFeatures = {
    manager: { reachable: boolean; code?: string };
    source: string; revision: number | null; runningRevision: number | null; origin: string | null;
    error: { code: string } | null;
    shared: HostSharedVerdict; keepsData: string; gamblingAttestation: { text: string };
    features: HostFeatureRow[];
};
export type HostConfigField = {
    id: string; section: string; type: string; feature: string; apply: 'hot' | 'restart'; help: string; description: string;
    secret: boolean; present: boolean; source: 'env' | 'config' | 'db' | 'default' | 'unset' | 'unknown-db';
    envControlled: boolean; controlledBy: string | null; envName: string | null;
    value?: string | number | boolean | string[] | null; default?: unknown; options?: string[]; min?: number; max?: number;
    masked?: boolean; fingerprint?: string | null; editable: boolean; sources: string[];
    featureActive?: boolean; invalid?: boolean; placeholder?: boolean;
};
export type HostConfigSection = { id: string; title: string; fields: HostConfigField[] };
export type HostConfigReport = {
    revision: string | null;
    file: { present: boolean; readable: boolean; error?: string } | null;
    appDatabase: { reachable: boolean; engine: string | null; reason?: string } | null;
    defaults: { revision: number } | null;
    sections: HostConfigSection[];
    probes: Array<{ target: string; whatItDoes: string; sendsCredentialTo: string | null; needsCredential: boolean }>;
};
export type HostProbeOutcome = {
    target: string; ok: boolean; code: string; latencyMs: number; detail: string; whatItDoes: string; usedSaved: boolean;
};
export type HostOperationKind = 'features.set' | 'config.set' | 'defaults.set' | 'lifecycle.apply' | UpdateOperationKind | InstallOperationKind;
export type UpdateOperationKind = 'update.check' | 'update.stage' | 'update.apply' | 'update.policy';
export type InstallOperationKind = 'install.new' | 'install.reconfigure' | 'install.repair' | 'install.uninstall' | MaintenanceOperationKind;
export type MaintenanceOperationKind = 'backup.create' | 'backup.restore' | 'data.reset';
export type HostPlanChange = {
    id: string; from?: boolean; to?: boolean; running?: boolean; action?: 'set' | 'remove'; secret?: boolean; apply?: string;
    section?: string; value?: unknown; ineffective?: boolean; controlledBy?: string;
};
export type HostOperation = {
    id: string; kind: HostOperationKind; status: string; revision: number | string | null;
    plan: {
        target?: string; effect?: string; changes?: HostPlanChange[]; warnings?: Array<{ code: string; message?: string; id?: string }>;
        restartRequired?: string[]; changeRef?: string; graceSeconds?: number; toRevision?: number;
        attestation?: { by: string; at: string; text: string } | null;
    };
    createdAt?: string; updatedAt?: string; steps: Array<{ name: string; status: string; at?: string }>;
    error?: { code: string; message: string };
};
export type HostPreview = {
    operation: HostOperation;
    preview: { restartRequired: boolean; warnings: Array<{ code: string; count?: number; message: string }> };
    attestation: { by: string; at: string; text: string } | null;
};
export type UpdateVersionRef = { version: string; releaseId?: string };
export type UpdateWindow = { days: number[]; startHour: number; endHour: number; tz: string };
export type HostUpdateStatus = {
    available: boolean;
    code?: string;
    installed?: { version: string; releaseId: string; target: string; features: string[] };
    updater?: string | null;
    policy?: {
        channel: 'stable' | 'prerelease'; mode: 'off' | 'check' | 'download' | 'apply'; effectiveMode: string; capped?: string;
        window?: UpdateWindow; source: { kind: string; owner?: string; repo?: string };
    };
    lastCheck?: { at: string; outcome: string; code?: string; latest?: { version: string; channel: string; tag: string } } | null;
    staged?: { version: string; releaseId: string; schemaChanging: boolean; stagedAt: string; stale: boolean } | null;
    handoff?: { phase: string; from: string; to: string; schemaChanging: boolean; settling?: { until: string; secondsLeft: number } } | null;
    watchdog?: { deadline: string; expired: boolean } | null;
    recovery?: {
        code: string; cause: string | null; at: string; from: UpdateVersionRef; to: UpdateVersionRef; schemaChanging: boolean;
        backup: { verified: boolean; at: string; name: string } | null; restored: boolean; decisions: string[]; warning: string;
    } | null;
    scheduled?: { opensAt: string; requestedAt: string } | null;
    lastApply?: { outcome: string; from?: UpdateVersionRef; to?: UpdateVersionRef; schemaChanging?: boolean; downtimeMs?: number; finishedAt?: string; code?: string } | null;
    handoffAvailability?: { mode: string; selfReplacing: boolean; osSupervised: boolean; supervising: boolean; exitCode: number } | null;
};
export type HostApplied = {
    operation: HostOperation;
    result: { outcome?: string; staged?: boolean; version?: string; latest?: { version: string }; from?: string; to?: string; downtimeMs?: number; code?: string; revision?: number | string; pending?: string[]; restartRequired?: string[]; ineffective?: string[]; changed?: string[]; effect?: string } | null;
};

// Setup wizard (documentation/setup_wizard.md): the installation journeys, shared by the manager-served client and the Host room
export type InstallRootRole = 'code' | 'data' | 'config' | 'cache' | 'logs' | 'uploads' | 'managerStore';
export type InstallSuggest = {
    platform: string; separator: string;
    bases: Array<{ path: string; freeBytes: number | null }>;
    roots: Record<InstallRootRole, { path: string; fixed: boolean; allowed: boolean; freeBytes?: number | null }>;
    layout: { suggested: string; source: string; ready: boolean; problem: string | null; available: string[] };
    database: { engines: Array<{ engine: string; available: boolean }>; configured: string };
    ports: { workers: Array<{ name: string; port: number }>; manager: number | null; lan: boolean; host: string };
    candidates: Array<{ id: string; kind: string; layout: string; dbEngine: string; code: string; evidence: string[] }>;
    sources: InstallSource[];
};
export type InstallSource = {
    dir: string; releaseId: string; version: string; target: string; totalBytes: number;
    features: Array<{ id: string; title: string; summary: string; freshDefault: string; dependsOn: string[]; bytes: number; requires: string[]; system: Array<{ name: string; kind: string }> }>;
};
export type InstallRecord = {
    installed: boolean; status?: string;
    record: null | {
        installationId: string; origin: string; createdAt: string; updatedAt: string | null; revision: number;
        layout: string | null; roots: Record<InstallRootRole, string> | null;
        release: { releaseId: string; version?: string; features: string[]; [key: string]: unknown } | null;
        database: { engine: string; external?: boolean } | null;
        updater: { kind: string } | null;
        services: Array<{ kind: string; name: string }>;
        dependencies: Array<{ name: string; ownedBy: string }>;
    };
};
export type InstallFinding = { code: string; severity: 'block' | 'warn' | 'info'; detail: string };
export type InstallStepRecord = { name: string; status: string; at?: string; detail?: { code?: string } };
export type InstallOperation = {
    id: string; kind: string; status: string; revision: number | string | null;
    plan: {
        action?: string; noop?: boolean; installationId?: string;
        preflight?: { ok: boolean; findings: InstallFinding[] };
        target?: { layout: string; roots: Record<string, string>; database: { engine: string }; features: string[]; update?: { mode: string; channel: string } | null; previousRoots?: Record<string, string> };
        source?: { bytes?: number; files?: number } | null;
        steps?: Array<{ name: string; privileged?: string }>;
        changes?: { roots?: boolean; layout?: boolean; config?: string[] };
        config?: { settings: string[]; secretCount: number };
        keepData?: boolean;
        removes?: Array<{ role: string; path: string; scope: string }>;
        retainedData?: { roots: string[]; paths?: string[]; existing?: boolean };
        exclusiveDependencies?: string[]; systemDependenciesLeft?: string[];
        database?: { engine: string; action: string };
        services?: Array<{ kind: string; name: string; action?: string }>;
        unknownServices?: Array<{ name?: string }>;
        confirmation?: { required: boolean; satisfied: boolean };
        current?: { present: boolean; healthy: boolean; code: string | null };
        registerService?: boolean;
        [key: string]: unknown;
    };
    steps: InstallStepRecord[];
    createdAt?: string; updatedAt?: string;
    error?: { code: string; message: string };
};

// Maintenance journeys (documentation/backup_and_restore.md, data_reset.md, db_migration.md): backup, restore, reset, migration
export type BackupFileSet = { id: string; label: string; files: number; bytes?: number; known?: boolean };
export type BackupInspection = {
    dir: string; format?: string; createdAt: string | null; version: string | null; engine: string; engineMatches: boolean;
    fingerprintMatches: boolean; schemaChangeNeedsAcceptance: boolean; tables: number; rows: number; fileSets: BackupFileSet[];
    configIncluded: boolean; configEncrypted: boolean; archiveEncrypted: boolean; envSecretsToReenter: string[];
    quiesced: boolean | null; integrity: { ok: boolean; problems: string[] };
    target: { engine: string; installationRecorded: boolean; dataRootMatches: boolean | null };
    restorable: boolean; blocks: string[]; warnings: string[];
};
export type RestoreRetained = { kind: string; id: string; path: string };
export type RestoreStatusView = {
    id: string; status: string; archive: string; archiveCreatedAt: string | null; engine: string; schemaChanged: boolean;
    startedAt: string | null; completedAt: string | null; resumes: number;
    mutate: Record<string, { done: boolean; at: string | null }>;
    failure: { step: string; substep?: string; code: string; at?: string } | null;
    retained: RestoreRetained[]; advice: string | null;
};
export type BackupStatus = {
    engine: string; installation: { recorded: boolean; installationId: string | null }; suggestedDir: string | null;
    restore: RestoreStatusView | null; restoreProblem: string | null;
};
export type MaintenanceView = {
    active: boolean; stale?: boolean; phase?: string | null; operationId?: string | null; fence?: number; mutateBegun?: boolean;
    [key: string]: unknown;
};
export type ResetPreview = {
    scope: 'instance' | 'feature'; feature: string | null; digest: string; confirm: string | null; empty: boolean; featureActive: boolean | null;
    tables: { cleared: Array<{ table: string; rows?: number }>; partial: unknown[]; cascading: unknown[]; kept: Array<{ table: string; reason?: string }>; recreated: unknown[] };
    derived: unknown; files: Array<{ id: string; label: string; owner: string; inBackup: boolean; location: string; files?: number; bytes?: number }>;
    keptFiles: Array<{ id: string; reason?: string }>; neverTouched: unknown;
    backup: { required: boolean; verified: string; includesConfig: boolean; configEncrypted: boolean };
    boundary: string; steps: string[];
};
export type MigrationReportItem = { code: string; detail?: unknown; extension?: string; action?: string };
export type MigrationStatus = {
    state: string; rollbackLimit: string; problem?: string | null;
    rollback: { possible: boolean; reason?: string; boundary?: string; needsTarget?: boolean };
    id?: string; startedAt?: string | null; updatedAt?: string | null;
    progress?: { tablesDone: number; tablesTotal: number; rowsCopied: number; current: string | null } | null;
    failure?: { step?: string; code?: string } | null;
    maintenance?: { operationId: string; fence: number; enteredByMigration: boolean } | null;
};
export type MigrationPreflight = {
    ready: boolean; blocks: MigrationReportItem[]; provisioning: MigrationReportItem[]; warnings: MigrationReportItem[];
    estimate?: { tables?: number; rows?: number; bytes?: number } | null; rollbackLimit?: string;
    target?: { reachable?: boolean; serverVersion?: string | null; [key: string]: unknown } | null;
};

// Connecting to an existing PostgreSQL server (documentation/database_connection.md).
export type DockerDatabaseOperationKind = 'database.docker.provision' | 'database.docker.start' | 'database.docker.stop' | 'database.docker.repair' | 'database.docker.reconfigure';
export type NativeDatabaseOperationKind = 'database.native.provision' | 'database.native.start' | 'database.native.stop' | 'database.native.repair' | 'database.native.relocate';
export type DatabaseOperationKind = 'database.provision' | 'database.schema.apply' | 'database.connect' | DockerDatabaseOperationKind | NativeDatabaseOperationKind;
export type DatabaseFinding = { code: string; detail: string; remediation?: string; [key: string]: unknown };
export type DatabaseExtensionState = { available: boolean; installed: boolean; trusted: boolean | null; state: string; summary: string; canCreate: boolean };
export type DatabaseSchemaState = {
    name: string; exists: boolean; state: 'missing-schema' | 'empty' | 'goobster-current' | 'goobster-older' | 'goobster-newer' | 'foreign';
    fingerprint: string | null; expectedFingerprint: string; tables: number; foreign: string[]; missingTables: string[]; missingColumns: string[]; extraColumns: string[];
};
export type DatabaseProvisioningStep = { action: string; reason: string; statements: string[] };
export type DatabaseReport = {
    target: { host: string; port: number; database: string; schema: string; user: string; local?: boolean; tls: { mode: string; ca: boolean } };
    reachable: boolean;
    auth: 'ok' | 'wrong-credentials' | 'database-missing' | 'permission-denied' | 'tls-failed' | 'unreachable';
    code: string | null;
    server: { version: number; text: string; supported: boolean; minimum: number } | null;
    client: { pg: string | null };
    tls: { requested: string; effective: string; encrypted: boolean | null; protocol: string | null; verified: boolean };
    role: { user: string; superuser: boolean; createDatabase: boolean; createRole: boolean } | null;
    privileges: { connect: boolean; createInDatabase: boolean; createInSchema: boolean };
    schema: DatabaseSchemaState | null;
    extensions: Record<string, DatabaseExtensionState> | null;
    active: boolean;
    verdict: {
        ok: boolean; next: string; blocks: DatabaseFinding[]; warnings: DatabaseFinding[]; notes: DatabaseFinding[];
        provisioning: { required: DatabaseProvisioningStep[]; dba: string[] };
    };
};
export type DatabaseStatus = {
    engine: 'sqlite' | 'postgres';
    record: { engine: string | null; external: boolean | null } | null;
    mismatch: boolean;
    layout: string | null;
    pairedRefusesSqlite: boolean;
    connection: { host: string; port: number; database: string; user: string; schema?: string; source: string; tls?: unknown } | null;
    overlay: { present: boolean; problem?: unknown };
    overridden: boolean;
    sqlite: { present: boolean; readable: boolean; empty: boolean; tables: number; rows: number; bookkeepingRows: number; populated: string[] } | null;
    migration: { state: string };
    maintenance: { active: boolean; phase: string | null; stale: boolean } | null;
    managed: boolean;
    storage: { owner: 'installation' | 'external'; external: boolean };
};
export type DatabaseConnectionBody = {
    host: string; port?: number; database: string; schema?: string; user: string; password: string; tls?: { mode: string; caFile?: string };
};

// The PostgreSQL instance the installer runs in Docker (documentation/docker_postgres.md).
export type DockerFinding = { code: string; detail: string; remedy?: string | null; severity?: string };
export type DockerContainerSummary = {
    exists: boolean; running: boolean; status: string; health: string; port: number | null; bind: string | null; image: string | null;
    imagePinned: boolean; restartPolicy: string | null; memoryBytes: number; startedAt: string | null;
    data: { kind: 'volume' | 'path'; name: string | null; source: string | null } | null;
};
export type DockerDaemonReport = {
    cli: { present: boolean; version: string | null };
    daemon: { reachable: boolean; code: string | null; serverVersion: string | null; flavor: string | null; rootless: boolean };
    platform: { os: string; arch: string; daemonOs: string | null; daemonArch: string | null; platform: string | null; supported: boolean; pullBytes: number | null };
    image: { reference: string; humanReference: string; digest: string; postgresMajor: number; pulled: boolean | null; pullBytes: number | null };
    backupTools: { ok: boolean; code: string; version: string | null; remedy: string | null } | null;
    storage: { path: string | null; freeBytes: number | null; requiredBytes: number | null };
    verdict: { ok: boolean; blocks: DockerFinding[]; warnings: DockerFinding[]; notes: DockerFinding[]; next: string };
};
export type DockerRecord = {
    step: string; complete: boolean; image: { reference: string; major: number; minor: number | null };
    request: { port: number; bind: string; storage: { kind: 'volume' | 'path'; path?: string }; role: string; database: string; memoryMb: number | null };
    created: { network: boolean; volume: boolean; container: boolean }; dataInitialised: boolean; updatedAt: string | null;
};
export type DockerStatus = {
    daemon: DockerDaemonReport;
    names: { container: string; volume: string; network: string; template: boolean };
    record: DockerRecord | null;
    recordProblem: unknown;
    owned: { container: DockerContainerSummary | null; volume: boolean; network: boolean; foreign: Array<{ kind: string; name: string | null }> } | null;
    connected: boolean;
};

// The PostgreSQL cluster the installer runs natively on this machine (documentation/native_postgres.md).
export type NativeFinding = { code: string; detail: string; remedy?: string | null; severity?: string };
export type NativePackageState = { names: string[]; installed: boolean; version: string | null; availability: string | null };
export type NativeHostReport = {
    supported: boolean; reason: string | null; remedy: string | null;
    distro: { id: string; version: string | null; family: 'debian' | 'rhel'; arch: string | null; raspberryPi: boolean; label: string | null; tested: boolean } | null;
    packageManager: string | null; major: number | null;
    packages: Record<string, NativePackageState> | null;
    clusters: Array<{ version: number | null; name: string; port: number | null; online: boolean; owned: boolean; dataDirectory?: string }>;
    systemd: unknown; selinux: unknown;
    backupTools: { ok: boolean; code: string; version: string | null; remedy: string | null } | null;
    storage: { path: string | null; exists: boolean; isDirectory: boolean; empty: boolean; freeBytes: number | null; requiredBytes: number | null; mountIssues: Array<{ code: string; severity: string }>; reachableByPostgres: boolean | null; blockedAt: string | null; candidate: boolean } | null;
    layout: { socketDir: string; binDir: string; defaultDataParent: string } | null;
};
export type NativeRecord = {
    step: string; complete: boolean; family: string;
    cluster: { name: string; service: string | null; dataDirectory: string; port: number; bind: string; role: string; database: string };
    relocation: { from: string; to: string; step: string } | null;
    updatedAt: string | null;
};
export type NativeStatus = {
    host: NativeHostReport;
    elevation: { implemented: boolean; kind: string; available: boolean; reason: string | null };
    names: { cluster: string; service: string | null; dataDirectory: string | null; configDirectory?: string; template: boolean };
    record: NativeRecord | null;
    recordProblem: unknown;
    owned: { exists: boolean; online: boolean; port: number | null; version: number | null } | null;
    connected: boolean;
};
