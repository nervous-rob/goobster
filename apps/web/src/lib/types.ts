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
    bot: { id: string; name: string } | null;
    scopes: Scope[];
    maxInputLength: number;
    features: { observatory?: boolean; spitball?: boolean };
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

export type UserNote = {
    id: number;
    type: string;
    label: string;
    content?: string | null;
    salience?: number;
    confidence?: number;
    source?: string;
    tags: string[];
    createdAt?: string;
    updatedAt?: string;
};

export type NotesPayload = {
    notes: UserNote[];
    total: number;
    cap: number;
    types: Array<{ type: string; c: number }>;
    sources: Array<{ source: string; c: number }>;
    tags: Array<{ name: string; uses: number }>;
    nodeTypes: string[];
    nodeSources: string[];
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
    maxInputLength: number;
    nextClient?: boolean;
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

export type ChatMessage = {
    id: number;
    role: 'user' | 'assistant' | 'system';
    content: string;
    createdAt: string;
    attachments?: Array<{ url: string; name?: string }>;
    isError?: boolean;
    steps?: TurnStep[];
};

export type ApiErrorShape = {
    status: number;
    code: string;
    message: string;
    details?: unknown;
};
