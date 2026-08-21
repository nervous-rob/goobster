/**
 * The attention system — vocabulary, scoring weights, thresholds, and the
 * budgets that keep initiative from becoming nagging.
 *
 * Spec: documentation/attention.md
 */

/** Attention item kinds (the first-class open-loop concepts). */
const ITEM_KINDS = [
    'goal',
    'commitment',
    'deadline',
    'open_question',
    'waiting_for',
    'opportunity',
    'concern'
];

/**
 * Item lifecycle. A mined loop is uncertain on arrival and has to earn its
 * way up: candidate -> corroborated -> active -> resolved/abandoned. Only
 * corroborated-or-better items may produce outbound contact.
 */
const ITEM_STATES = ['candidate', 'corroborated', 'active', 'resolved', 'abandoned'];
const LIVE_STATES = ['candidate', 'corroborated', 'active'];
const CONTACTABLE_STATES = ['corroborated', 'active'];

/**
 * The initiative spectrum, least to most agency. This is the agency boundary:
 * a user's level (and optionally a per-item ceiling) caps what any single
 * intervention is allowed to do.
 *
 *  observe  — may notice and remember, never initiates contact
 *  nudge    — may surface likely-useful observations
 *  assist   — may additionally perform reversible/read-only work and report it
 *  delegate — may initiate pre-authorized classes of action
 */
const INITIATIVE_LEVELS = ['observe', 'nudge', 'assist', 'delegate'];
const INITIATIVE_RANK = { observe: 0, nudge: 1, assist: 2, delegate: 3 };

/** How loudly an intervention is allowed to land, quietest first. */
const DISPOSITIONS = ['inbox', 'mention', 'dm', 'urgent'];
const DISPOSITION_RANK = { inbox: 0, mention: 1, dm: 2, urgent: 3 };

/**
 * The loudest disposition each initiative level permits. `observe` can still
 * fill the inbox (the user asked to be able to look), it just never reaches
 * out; `nudge` and above may make contact.
 */
const MAX_DISPOSITION_BY_INITIATIVE = {
    observe: 'inbox',
    nudge: 'dm',
    assist: 'dm',
    delegate: 'urgent'
};

/**
 * Score bands for P = U x I x C x A - K.
 *
 * Calibrated to the range the product can actually reach, which is much
 * narrower than the unit interval: four independent factors multiplied
 * together stay small unless every one of them is high. A very strong
 * intervention (imminent deadline, clearly important, well understood, with
 * an obvious next step) lands near 0.7; a merely plausible one lands near
 * 0.2. Bands spaced for [0, 1] would leave everything above `inbox` unusable.
 *
 * Deliberately not "forever" numbers: the per-category calibration in
 * attentionService shifts the effective cut based on what the person actually
 * dismissed or acted on.
 *
 * `dm` is the top of the DM band, so it doubles as the urgent floor - set
 * high enough that interrupting is genuinely rare.
 */
const THRESHOLDS = {
    discard: 0.12,
    inbox: 0.28,
    mention: 0.45,
    dm: 0.75
};

/** Interruption-cost model (the K term). */
const INTERRUPTION = {
    /** Baseline cost of bothering someone at all. */
    base: 0.06,
    /** Added per notice already surfaced to this person today. */
    perRecentNotice: 0.05,
    /** Added while the contact cooldown is still running. */
    withinCooldown: 0.18,
    /** Added during the user's quiet hours (holds contact, not the inbox). */
    quietHours: 0.35,
    /** Cap so K can never swamp an genuinely urgent item entirely. */
    max: 0.6
};

/** Feedback-driven calibration, per category. */
const CALIBRATION = {
    /** Feedback rows older than this stop influencing the threshold. */
    windowDays: 30,
    /** Minimum feedback rows in the window before calibration applies. */
    minSamples: 4,
    /** Largest threshold shift calibration may apply, in either direction. */
    maxShift: 0.2,
    /** Threshold shift per unit of (dismiss rate - act rate). */
    shiftPerRate: 0.25
};

/** Deterministic candidate generation bounds. */
const CANDIDATES = {
    /** A deadline inside this window starts generating urgency. */
    deadlineHorizonHours: 72,
    /** Deadline urgency saturates at 1.0 this close in. */
    deadlineUrgentHours: 12,
    /** An active loop untouched this long counts as stalled. */
    staleLoopDays: 4,
    /** waiting_for items past this without evidence are worth a mention. */
    waitingForDays: 5,
    /** Terminal Observatory jobs newer than this are still news. */
    jobLookbackHours: 48,
    /** Contradictions found in the graph this recently are still news. */
    contradictionLookbackHours: 72,
    /**
     * Cap on what one generator may contribute to a sweep. Per-generator
     * rather than global so a person with many deadlines cannot starve the
     * generators that run after the deadline one - ranking should decide what
     * gets dropped, not registration order.
     */
    maxPerGenerator: 6,
    /** Runaway guard on the whole sweep (a misbehaving custom generator). */
    maxPerSweep: 48,
    /** Hard cap on candidates handed to the triage model in one call. */
    maxTriaged: 6
};

/** Personal heartbeat cadence and per-person budgets. */
const HEARTBEAT = {
    /** How often the personal loop wakes up. */
    tickMs: 10 * 60 * 1000,
    /** Delay before the first tick after boot (let the bot settle). */
    firstTickDelayMs: 3 * 60 * 1000,
    /** People evaluated per tick (bounds model spend on a busy instance). */
    maxUsersPerTick: 8,
    /** A person is not re-swept inside this window on the plain rotation. */
    sweepIntervalMs: 45 * 60 * 1000,
    /**
     * Floor for an event-accelerated sweep. Being dirtied lets a person jump
     * the rotation, but not bypass a minimum gap - otherwise a chatty channel
     * would sweep on every message.
     */
    dirtySweepIntervalMs: 10 * 60 * 1000,
    /** Default gap between outbound contacts (overridable per policy). */
    contactCooldownMinutes: 180,
    /** Default outbound contacts allowed per rolling day. */
    maxContactsPerDay: 3,
    /** Undelivered inbox notices retained per person before the oldest expire. */
    maxOpenNotices: 40,
    /** Surfaced-but-unopened notices older than this expire quietly. */
    noticeExpiryDays: 14
};

/** Watches (condition-triggered agent turns). */
const WATCHES = {
    /** Watches per person (armed). */
    maxPerUser: 10,
    /** A watch with no explicit expiry disarms itself after this long. */
    defaultTtlHours: 24 * 14,
    /** Concurrent watch turns per process (a turn is a full agent run). */
    maxConcurrentTurns: 2
};

/** The `attend` reflection pass: mining latent open loops out of memory. */
const ATTEND = {
    /** Raw memories reviewed per pass. */
    maxMemoriesReviewed: 60,
    /** Existing items shown to the model so it updates instead of duplicating. */
    maxItemsShown: 25,
    /** Caps on what one model response may change. */
    maxUpserts: 8,
    maxResolves: 6,
    /** Mined items land at or below this confidence - they are guesses. */
    maxMinedConfidence: 0.75
};

/** Field caps (storage discipline, mirrors the knowledge graph's limits). */
const MAX_SUBJECT_LENGTH = 120;
const MAX_GOAL_LENGTH = 500;
const MAX_UNRESOLVED_ITEMS = 8;
const MAX_UNRESOLVED_LENGTH = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_DETAIL_LENGTH = 1000;
const MAX_ITEMS_PER_USER = 120;

/**
 * Default agency boundaries per category. `confirm` means Goobster may
 * propose the action but a human has to approve it; `never` means it may not
 * be proposed proactively at all.
 */
const DEFAULT_BOUNDARIES = {
    general: { proactiveRead: true, proactiveCompute: false, externalWrite: 'confirm' },
    research: { proactiveRead: true, proactiveCompute: true, externalWrite: 'confirm' },
    observatory: { proactiveRead: true, proactiveCompute: true, externalWrite: 'confirm' },
    knowledge: { proactiveRead: true, proactiveCompute: true, externalWrite: 'confirm' },
    schedule: { proactiveRead: true, proactiveCompute: false, externalWrite: 'confirm' },
    github: { proactiveRead: true, proactiveCompute: true, externalWrite: 'never' }
};

const CATEGORIES = Object.keys(DEFAULT_BOUNDARIES);

module.exports = {
    ITEM_KINDS,
    ITEM_STATES,
    LIVE_STATES,
    CONTACTABLE_STATES,
    INITIATIVE_LEVELS,
    INITIATIVE_RANK,
    DISPOSITIONS,
    DISPOSITION_RANK,
    MAX_DISPOSITION_BY_INITIATIVE,
    THRESHOLDS,
    INTERRUPTION,
    CALIBRATION,
    CANDIDATES,
    HEARTBEAT,
    WATCHES,
    ATTEND,
    MAX_SUBJECT_LENGTH,
    MAX_GOAL_LENGTH,
    MAX_UNRESOLVED_ITEMS,
    MAX_UNRESOLVED_LENGTH,
    MAX_TITLE_LENGTH,
    MAX_DETAIL_LENGTH,
    MAX_ITEMS_PER_USER,
    DEFAULT_BOUNDARIES,
    CATEGORIES
};
