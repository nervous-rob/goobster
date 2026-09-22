/**
 * Guided-tutorial state machine (Increment F1).
 *
 * Per-account, per-tutorial, versioned progress with optimistic concurrency
 * (generation + revision) and idempotent events. Tour events touch only the
 * tutorial_* tables — they never call a provider, send an invitation, or
 * write user knowledge. Sample demonstrations (F2) stay isolated.
 *
 * Contract: documentation/guided_tutorials_spec.md.
 */

const db = require('../db');
const catalogModule = require('../config/tutorialCatalog');

const {
    TUTORIAL_BY_ID,
    ACTIONS,
    capabilityMet,
    isTutorialPermitted
} = catalogModule;

/** @type {typeof catalogModule | null} */
let catalogOverride = null;

function catalog() {
    return catalogOverride || catalogModule;
}

/** Jest-only: swap the catalog so the state machine can be exercised with steps. */
function _setCatalogForTests(next) {
    catalogOverride = next;
}

class TutorialError extends Error {
    constructor(status, code, message, details = null) {
        super(message);
        this.name = 'TutorialError';
        this.status = status;
        this.code = code;
        if (details) this.details = details;
    }
}

function emptyProgress(accountId, tutorialId, version) {
    return {
        accountId,
        tutorialId,
        version,
        generation: 1,
        revision: 0,
        status: 'not_started',
        currentStepId: null,
        completedStepIds: [],
        skippedStepIds: [],
        unavailableStepIds: [],
        updatedAt: null
    };
}

function parseJsonArray(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(String);
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

function rowToProgress(row) {
    if (!row) return null;
    return {
        accountId: row.accountId,
        tutorialId: row.tutorialId,
        version: Number(row.version),
        generation: Number(row.generation),
        revision: Number(row.revision),
        status: row.status,
        currentStepId: row.currentStepId || null,
        completedStepIds: parseJsonArray(row.completedStepIdsJson),
        skippedStepIds: parseJsonArray(row.skippedStepIdsJson),
        unavailableStepIds: parseJsonArray(row.unavailableStepIdsJson),
        updatedAt: row.updatedAt || null
    };
}

async function loadProgress(accountId, tutorialId, version, handle = db) {
    const row = await handle.get(
        `SELECT * FROM tutorial_progress
         WHERE accountId = @accountId AND tutorialId = @tutorialId AND version = @version`,
        { accountId, tutorialId, version }
    );
    return row ? rowToProgress(row) : emptyProgress(accountId, tutorialId, version);
}

async function saveProgress(progress, handle = db) {
    await handle.run(
        `INSERT INTO tutorial_progress (
            accountId, tutorialId, version, generation, revision, status,
            currentStepId, completedStepIdsJson, skippedStepIdsJson,
            unavailableStepIdsJson, updatedAt
         ) VALUES (
            @accountId, @tutorialId, @version, @generation, @revision, @status,
            @currentStepId, @completedStepIdsJson, @skippedStepIdsJson,
            @unavailableStepIdsJson, datetime('now')
         )
         ON CONFLICT(accountId, tutorialId, version) DO UPDATE SET
            generation = excluded.generation,
            revision = excluded.revision,
            status = excluded.status,
            currentStepId = excluded.currentStepId,
            completedStepIdsJson = excluded.completedStepIdsJson,
            skippedStepIdsJson = excluded.skippedStepIdsJson,
            unavailableStepIdsJson = excluded.unavailableStepIdsJson,
            updatedAt = excluded.updatedAt`,
        {
            accountId: progress.accountId,
            tutorialId: progress.tutorialId,
            version: progress.version,
            generation: progress.generation,
            revision: progress.revision,
            status: progress.status,
            currentStepId: progress.currentStepId,
            completedStepIdsJson: JSON.stringify(progress.completedStepIds || []),
            skippedStepIdsJson: JSON.stringify(progress.skippedStepIds || []),
            unavailableStepIdsJson: JSON.stringify(progress.unavailableStepIds || [])
        }
    );
    return loadProgress(progress.accountId, progress.tutorialId, progress.version, handle);
}

function resolveTutorial(tutorialId) {
    const cat = catalog();
    const tutorial = cat.TUTORIAL_BY_ID[tutorialId] || cat.TUTORIALS?.find((t) => t.id === tutorialId);
    if (!tutorial) {
        throw new TutorialError(404, 'UNKNOWN_TUTORIAL', `Unknown tutorial id: ${tutorialId}`);
    }
    return tutorial;
}

function stepById(tutorial, stepId) {
    return (tutorial.steps || []).find((s) => s.id === stepId) || null;
}

/**
 * Steps that apply under the caller's capabilities. Unavailable ones are
 * listed separately and never counted as completed.
 */
function partitionSteps(tutorial, caps) {
    const available = [];
    const unavailable = [];
    for (const step of tutorial.steps || []) {
        if (capabilityMet(step.requires, caps)) available.push(step);
        else unavailable.push(step.id);
    }
    return { available, unavailable };
}

function nextOpenStep(available, completed, skipped, unavailable) {
    const done = new Set([...completed, ...skipped, ...unavailable]);
    return available.find((s) => !done.has(s.id)) || null;
}

function finishStatus(skippedStepIds) {
    return (skippedStepIds || []).length > 0 ? 'finished_with_skips' : 'completed';
}

async function findEvent(accountId, tutorialId, version, eventId, handle = db) {
    return handle.get(
        `SELECT eventId, action, generation, revision, stepId, resultJson
         FROM tutorial_events
         WHERE accountId = @accountId AND tutorialId = @tutorialId
           AND version = @version AND eventId = @eventId`,
        { accountId, tutorialId, version, eventId }
    );
}

async function recordEvent(accountId, tutorialId, version, event, resultProgress, handle = db) {
    await handle.run(
        `INSERT INTO tutorial_events (
            accountId, tutorialId, version, eventId, action,
            generation, revision, stepId, resultJson, createdAt
         ) VALUES (
            @accountId, @tutorialId, @version, @eventId, @action,
            @generation, @revision, @stepId, @resultJson, datetime('now')
         )`,
        {
            accountId,
            tutorialId,
            version,
            eventId: event.eventId,
            action: event.action,
            generation: event.generation,
            revision: resultProgress.revision,
            stepId: event.stepId || null,
            resultJson: JSON.stringify(resultProgress)
        }
    );
}

/**
 * Apply one tutorial event. Retried eventIds return the stored result without
 * advancing again. A mismatched generation or revision is rejected so a stale
 * tab cannot restore a reset.
 */
async function applyEvent({
    accountId,
    tutorialId,
    eventId,
    generation,
    expectedRevision,
    stepId = null,
    action,
    caps = {}
}) {
    if (!accountId) throw new TutorialError(401, 'UNAUTHENTICATED', 'Sign in required.');
    if (!eventId || typeof eventId !== 'string' || eventId.length > 128) {
        throw new TutorialError(400, 'BAD_EVENT_ID', 'eventId is required (max 128 characters).');
    }
    if (!ACTIONS.includes(action)) {
        throw new TutorialError(400, 'BAD_ACTION', `action must be one of: ${ACTIONS.join(', ')}.`);
    }

    const tutorial = resolveTutorial(tutorialId);
    if (!isTutorialPermitted(tutorial, caps)) {
        throw new TutorialError(403, 'TUTORIAL_FORBIDDEN', 'This tutorial is not available for your account.');
    }

    const version = tutorial.version;
    const prior = await findEvent(accountId, tutorialId, version, eventId);
    if (prior) {
        // Idempotent replay: return the progress snapshot stored with the event.
        if (prior.resultJson) {
            try { return JSON.parse(prior.resultJson); } catch { /* fall through */ }
        }
        return loadProgress(accountId, tutorialId, version);
    }

    return db.transaction(async (tx) => {
        // Re-check inside the transaction for races.
        const raced = await findEvent(accountId, tutorialId, version, eventId, tx);
        if (raced) {
            if (raced.resultJson) {
                try { return JSON.parse(raced.resultJson); } catch { /* fall through */ }
            }
            return loadProgress(accountId, tutorialId, version, tx);
        }

        const current = await loadProgress(accountId, tutorialId, version, tx);

        if (Number(generation) !== Number(current.generation)) {
            throw new TutorialError(409, 'STALE_GENERATION',
                'This tutorial was reset. Reload progress and try again.',
                { generation: current.generation, revision: current.revision });
        }
        if (expectedRevision === undefined || expectedRevision === null
            || Number(expectedRevision) !== Number(current.revision)) {
            throw new TutorialError(409, 'STALE_REVISION',
                'Progress changed elsewhere. Reload and try again.',
                { generation: current.generation, revision: current.revision });
        }

        const { available, unavailable } = partitionSteps(tutorial, caps);
        let next = {
            ...current,
            unavailableStepIds: [...new Set([...(current.unavailableStepIds || []), ...unavailable])],
            completedStepIds: [...(current.completedStepIds || [])],
            skippedStepIds: [...(current.skippedStepIds || [])]
        };

        if (action === 'start') {
            if (available.length === 0) {
                throw new TutorialError(409, 'NO_APPLICABLE_STEPS',
                    'This tutorial has no applicable steps right now.');
            }
            const first = nextOpenStep(available, next.completedStepIds, next.skippedStepIds, next.unavailableStepIds);
            if (!first) {
                // Everything already done or unavailable — treat as finished.
                next.status = finishStatus(next.skippedStepIds);
                next.currentStepId = null;
            } else {
                next.status = 'in_progress';
                next.currentStepId = first.id;
            }
        } else if (action === 'complete_step' || action === 'skip_step') {
            if (!stepId) {
                throw new TutorialError(400, 'BAD_STEP', 'stepId is required for this action.');
            }
            if (!stepById(tutorial, stepId)) {
                throw new TutorialError(400, 'UNKNOWN_STEP', `Unknown step id: ${stepId}`);
            }
            if (next.status === 'not_started' || next.status === 'skipped') {
                throw new TutorialError(409, 'NOT_IN_PROGRESS', 'Start the tutorial before advancing steps.');
            }
            if (action === 'complete_step') {
                if (!next.completedStepIds.includes(stepId)) next.completedStepIds.push(stepId);
                next.skippedStepIds = next.skippedStepIds.filter((id) => id !== stepId);
            } else {
                // skip_step records a skip — never marks the step done.
                if (!next.skippedStepIds.includes(stepId)) next.skippedStepIds.push(stepId);
                next.completedStepIds = next.completedStepIds.filter((id) => id !== stepId);
            }
            const open = nextOpenStep(available, next.completedStepIds, next.skippedStepIds, next.unavailableStepIds);
            if (open) {
                next.status = 'in_progress';
                next.currentStepId = open.id;
            } else {
                next.status = finishStatus(next.skippedStepIds);
                next.currentStepId = null;
            }
        } else if (action === 'pause') {
            if (next.status === 'not_started') {
                throw new TutorialError(409, 'NOT_IN_PROGRESS', 'Nothing to pause.');
            }
            if (next.status === 'completed' || next.status === 'finished_with_skips' || next.status === 'skipped') {
                throw new TutorialError(409, 'ALREADY_FINISHED', 'This tutorial is already finished.');
            }
            next.status = 'paused';
        } else if (action === 'skip_tutorial') {
            next.status = 'skipped';
            next.currentStepId = null;
        } else if (action === 'finish') {
            if (next.status === 'not_started') {
                throw new TutorialError(409, 'NOT_IN_PROGRESS', 'Start the tutorial before finishing.');
            }
            next.status = finishStatus(next.skippedStepIds);
            next.currentStepId = null;
        }

        next.revision = Number(current.revision) + 1;
        const saved = await saveProgress(next, tx);
        await recordEvent(accountId, tutorialId, version, {
            eventId,
            action,
            generation: current.generation,
            stepId
        }, saved, tx);
        return saved;
    });
}

async function resetOne({ accountId, tutorialId, caps = {} }) {
    if (!accountId) throw new TutorialError(401, 'UNAUTHENTICATED', 'Sign in required.');
    const tutorial = resolveTutorial(tutorialId);
    if (!isTutorialPermitted(tutorial, caps)) {
        throw new TutorialError(403, 'TUTORIAL_FORBIDDEN', 'This tutorial is not available for your account.');
    }
    const version = tutorial.version;
    return db.transaction(async (tx) => {
        const current = await loadProgress(accountId, tutorialId, version, tx);
        const cleared = {
            ...emptyProgress(accountId, tutorialId, version),
            generation: Number(current.generation) + 1,
            revision: 0
        };
        return saveProgress(cleared, tx);
    });
}

async function resetAll({ accountId, caps = {} }) {
    if (!accountId) throw new TutorialError(401, 'UNAUTHENTICATED', 'Sign in required.');
    const cat = catalog();
    const permitted = (cat.TUTORIALS || []).filter((t) => isTutorialPermitted(t, caps));
    const results = [];
    await db.transaction(async (tx) => {
        for (const tutorial of permitted) {
            const current = await loadProgress(accountId, tutorial.id, tutorial.version, tx);
            const cleared = {
                ...emptyProgress(accountId, tutorial.id, tutorial.version),
                generation: Number(current.generation) + 1,
                revision: 0
            };
            results.push(await saveProgress(cleared, tx));
        }
    });
    return { progress: results };
}

async function getPreferences(accountId) {
    const row = await db.get(
        'SELECT autoStart, orientationOfferedAt, updatedAt FROM tutorial_preferences WHERE accountId = @accountId',
        { accountId }
    );
    return {
        autoStart: row ? Boolean(row.autoStart) : true,
        orientationOfferedAt: row?.orientationOfferedAt || null,
        updatedAt: row?.updatedAt || null
    };
}

async function patchPreferences(accountId, { autoStart } = {}) {
    if (!accountId) throw new TutorialError(401, 'UNAUTHENTICATED', 'Sign in required.');
    if (autoStart === undefined) {
        throw new TutorialError(400, 'BAD_PREFERENCES', 'Send autoStart.');
    }
    if (typeof autoStart !== 'boolean') {
        throw new TutorialError(400, 'BAD_PREFERENCES', 'autoStart must be a boolean.');
    }
    const existing = await getPreferences(accountId);
    await db.run(
        `INSERT INTO tutorial_preferences (accountId, autoStart, orientationOfferedAt, updatedAt)
         VALUES (@accountId, @autoStart, @orientationOfferedAt, datetime('now'))
         ON CONFLICT(accountId) DO UPDATE SET
            autoStart = excluded.autoStart,
            updatedAt = excluded.updatedAt`,
        {
            accountId,
            autoStart: autoStart ? 1 : 0,
            orientationOfferedAt: existing.orientationOfferedAt
        }
    );
    return getPreferences(accountId);
}

async function markOrientationOffered(accountId) {
    if (!accountId) return null;
    const existing = await getPreferences(accountId);
    if (existing.orientationOfferedAt) return existing;
    await db.run(
        `INSERT INTO tutorial_preferences (accountId, autoStart, orientationOfferedAt, updatedAt)
         VALUES (@accountId, 1, datetime('now'), datetime('now'))
         ON CONFLICT(accountId) DO UPDATE SET
            orientationOfferedAt = COALESCE(tutorial_preferences.orientationOfferedAt, excluded.orientationOfferedAt),
            updatedAt = excluded.updatedAt`,
        { accountId }
    );
    return getPreferences(accountId);
}

/**
 * Permitted catalog entries plus progress rows and the auto-start preference.
 */
async function listForAccount({ accountId, caps = {} }) {
    if (!accountId) throw new TutorialError(401, 'UNAUTHENTICATED', 'Sign in required.');
    const cat = catalog();
    const tutorials = (cat.TUTORIALS || []).filter((t) => isTutorialPermitted(t, caps));
    const progress = [];
    for (const tutorial of tutorials) {
        progress.push(await loadProgress(accountId, tutorial.id, tutorial.version));
    }
    const preferences = await getPreferences(accountId);
    return {
        catalog: tutorials.map((t) => ({
            id: t.id,
            roomId: t.roomId,
            version: t.version,
            title: t.title,
            hostOnly: Boolean(t.hostOnly),
            stepIds: (t.steps || []).map((s) => s.id),
            // F1: steps are empty; F2 fills demonstration metadata. The
            // shell still needs anchors when a later package adds them.
            steps: (t.steps || []).map((s) => ({
                id: s.id,
                anchorId: s.anchorId || null
            })),
            launchable: (t.steps || []).some((s) => capabilityMet(s.requires, caps))
        })),
        progress,
        preferences
    };
}

async function forgetUser(userId, handle = db) {
    const progress = (await handle.run(
        'DELETE FROM tutorial_progress WHERE accountId = @userId', { userId }
    )).changes;
    const events = (await handle.run(
        'DELETE FROM tutorial_events WHERE accountId = @userId', { userId }
    )).changes;
    const preferences = (await handle.run(
        'DELETE FROM tutorial_preferences WHERE accountId = @userId', { userId }
    )).changes;
    const feedback = (await handle.run(
        'DELETE FROM tutorial_feedback WHERE accountId = @userId', { userId }
    )).changes;
    return { progress, events, preferences, feedback };
}

async function countUserData(userId) {
    const progress = (await db.get(
        'SELECT COUNT(*) AS c FROM tutorial_progress WHERE accountId = @userId', { userId }
    )).c;
    const events = (await db.get(
        'SELECT COUNT(*) AS c FROM tutorial_events WHERE accountId = @userId', { userId }
    )).c;
    const preferences = (await db.get(
        'SELECT COUNT(*) AS c FROM tutorial_preferences WHERE accountId = @userId', { userId }
    )).c;
    const feedback = (await db.get(
        'SELECT COUNT(*) AS c FROM tutorial_feedback WHERE accountId = @userId', { userId }
    )).c;
    return { progress, events, preferences, feedback };
}

async function summarizeForUser(userId) {
    const counts = await countUserData(userId);
    const byStatus = await db.all(
        `SELECT status, COUNT(*) AS c FROM tutorial_progress
         WHERE accountId = @userId GROUP BY status`,
        { userId }
    );
    return {
        progressRows: counts.progress,
        eventRows: counts.events,
        feedbackRows: counts.feedback,
        hasPreferences: counts.preferences > 0,
        byStatus: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.c)]))
    };
}

module.exports = {
    TutorialError,
    applyEvent,
    resetOne,
    resetAll,
    listForAccount,
    getPreferences,
    patchPreferences,
    markOrientationOffered,
    forgetUser,
    countUserData,
    summarizeForUser,
    loadProgress,
    emptyProgress,
    // Test seam — production callers must not use this.
    _setCatalogForTests,
    // Re-export for callers that already hold the service.
    resolveTutorial,
    isTutorialPermitted: (tutorialId, caps) => {
        try {
            return isTutorialPermitted(resolveTutorial(tutorialId), caps);
        } catch {
            return false;
        }
    }
};
