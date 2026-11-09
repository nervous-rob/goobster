/**
 * One list of every kind of scheduled or recurring work Goobster keeps in the
 * database, and which surfaces must know about it.
 *
 * Three places each enumerate scheduled work on their own:
 *  - missed-run recovery after a restore (instanceStateService.skipMissedSchedules),
 *  - the delegated-assistant process catalog (assistantProcessService.ADAPTERS),
 *  - the operator's Host -> Schedules panel (operatorScheduleService.KINDS).
 *
 * Each entry below names, per surface, the key that surface uses for the
 * kind, or `{ excluded: '<why>' }` when the kind deliberately is not there.
 * tests/scheduledWorkRegistry.test.js fails when a surface gains or loses a
 * kind without this file saying so, so adding a scheduler is one decision
 * per surface instead of three places to remember.
 *
 * Declarative only: this module owns no scheduling and is safe to require
 * from anywhere in core.
 *
 * Spec: documentation/operator_schedules.md ("Adding a new kind of scheduled work").
 */

const excluded = (why) => Object.freeze({ excluded: why });

const SCHEDULED_WORK = Object.freeze({
    automation: Object.freeze({
        table: 'automations',
        missedRecovery: ['automations'],
        processCatalog: 'automation',
        operatorPanel: 'automation'
    }),
    project_trigger: Object.freeze({
        table: 'project_triggers',
        missedRecovery: ['cronTriggers', 'eventTriggers'],
        processCatalog: 'project_trigger',
        operatorPanel: excluded('belongs to a user\'s private project')
    }),
    followup: Object.freeze({
        table: 'followups',
        missedRecovery: ['recurringFollowups', 'oneShotFollowups'],
        processCatalog: excluded('a reminder is a single delivery, not a process with a contract'),
        operatorPanel: 'followup'
    }),
    attention_watch: Object.freeze({
        table: 'attention_watches',
        missedRecovery: excluded('event-driven: no stored fire time to replay'),
        processCatalog: 'attention_watch',
        operatorPanel: excluded('private to its owner')
    }),
    followed_source: Object.freeze({
        table: 'followed_sources',
        missedRecovery: excluded('a late poll fetches once; nothing is replayed'),
        processCatalog: 'followed_source',
        operatorPanel: excluded('private to its owner')
    }),
    project_ci_watch: Object.freeze({
        table: 'project_ci_watches',
        missedRecovery: excluded('a late poll reads the current CI verdict once; nothing is replayed'),
        processCatalog: excluded('not adapted yet: reports through the project and the owner\'s Inbox'),
        operatorPanel: excluded('runs on its owner\'s own GitHub connection')
    })
});

/**
 * Tables that carry a next-time column but hold no scheduled work of their
 * own (retry and rate-limit state owned by a kind above).
 */
const NOT_SCHEDULED_WORK = Object.freeze({
    project_trigger_deliveries: 'retry state of a project_trigger delivery',
    source_fetch_hosts: 'per-host politeness delay for followed_source fetches'
});

const isExcluded = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.excluded);

/** The keys one surface expects, flattened across kinds. */
function surfaceKeys(surface) {
    const keys = [];
    for (const entry of Object.values(SCHEDULED_WORK)) {
        const value = entry[surface];
        if (isExcluded(value)) continue;
        keys.push(...(Array.isArray(value) ? value : [value]));
    }
    return keys;
}

module.exports = { SCHEDULED_WORK, NOT_SCHEDULED_WORK, surfaceKeys, isExcluded };
