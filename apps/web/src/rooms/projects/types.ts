/**
 * Payload shapes of the Projects routes. Field names are the API's
 * (`jobs`, `runningJobs`, `mission`); the UI shows them as Runs and Plan
 * (ADR 0009).
 */
export type Project = {
    id?: number;
    slug: string;
    name: string;
    /** The goal, in a sentence or two (observatory_projects.description). */
    description?: string | null;
    ownerId?: string;
    ownerName?: string | null;
    role?: 'owner' | 'collaborator';
    shared?: boolean;
    runningJobs?: number;
    totalJobs?: number;
    sizeMb?: number;
    quotaMb?: number;
    updatedAt?: string;
};

export type ProjectInvite = {
    id: number;
    slug: string;
    name?: string;
    ownerId?: string;
    inviterName?: string | null;
    inviterId?: string;
};

export type ContractCheck = {
    path: string;
    type?: string;
    minBytes?: number;
    ok: boolean;
    reason?: string | null;
    sizeBytes?: number | null;
};

export type ContractResult = { ok: boolean; checkedAt?: string; checks: ContractCheck[] };

/** One run (API: job). */
export type Job = {
    id: number;
    status: string;
    language?: string;
    segments?: number;
    resumeCount?: number;
    exitCode?: number | null;
    checkpointAt?: string;
    finishedAt?: string;
    lastHeartbeatAt?: string;
    error?: string | null;
    // Stable failure reason (EXIT_NONZERO, TIMED_OUT, CANCELLED, OUTPUT_CONTRACT_FAILED, ...)
    errorCode?: string | null;
    // Provenance: who started it and, for event-chained stages, the settled run it reacted to.
    startedBy?: string | null;
    triggerId?: number | null;
    parentJobId?: number | null;
    // Frozen output-contract verdict (null when the run declared no required outputs).
    outputContractResult?: ContractResult | null;
    stdoutTail?: string;
    stderrTail?: string;
};

export type FileRow = {
    path: string;
    size: number;
    url?: string;
    isVideo?: boolean;
    isImage?: boolean;
    modifiedAt?: string;
};

export type Detail = {
    project: Project;
    jobs: Job[];
    files: FileRow[];
    checkpoint?: string | null;
    totalFiles?: number;
};

export const STATUS_ICONS: Record<string, string> = {
    RUNNING: '🟢', COMPLETED: '✅', FAILED: '❌',
    TIMED_OUT: '⏱️', CANCELLED: '⏹️', INTERRUPTED: '💤'
};

/** The project a route names: its owner's principal id and its per-owner slug. */
export type ProjectRef = { ownerId: string; slug: string };
