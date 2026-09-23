/**
 * Installation-wide state that outlives a process: the `instance_state`
 * table, and the one flag built on it that the rest of the runtime honours -
 * **paused** (documentation/backup_and_restore.md).
 *
 * A restore brings the instance back paused. While paused, the core
 * runtime starts no scheduled worker and runs no startup catch-up, so
 * nothing that came due during the downtime fires. Interactive use (the
 * portal, sign-in, chat) keeps working; the Host room shows the state and
 * offers Resume. Resuming first moves every missed schedule to its next
 * future occurrence, then clears the flag - so an automation that should
 * have run three times while the box was down runs at its next time, once.
 *
 * Every process reads the flag from the database (pollers in
 * runtime/coreRuntime.js), so bot and api agree without a new bus.
 */

const db = require('../db');
const { CronExpressionParser } = require('cron-parser');
const logger = require('../utils/logger');

const KEY_PAUSED = 'paused';
const KEY_LAST_RESTORE = 'lastRestore';
const KEY_LAST_RESUME = 'lastResume';

function utcText(date = new Date()) {
    return new Date(date).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function utcTextToMs(text) {
    if (!text) return NaN;
    return Date.parse(`${String(text).replace(' ', 'T')}Z`);
}

/** The first cron fire strictly after `now`, or null for an unusable schedule. */
function nextCronFire(schedule, now) {
    try {
        return CronExpressionParser.parse(schedule, { tz: 'UTC', currentDate: now }).next().toDate();
    } catch {
        return null;
    }
}

class InstanceStateService {
    // --- Key/value ---------------------------------------------------------

    /**
     * @param {string} key
     * @returns {Promise<*>} the parsed value, or null when unset
     */
    async get(key) {
        const row = await db.get('SELECT valueJson FROM instance_state WHERE key = @key', { key });
        if (!row) return null;
        try {
            return JSON.parse(row.valueJson);
        } catch {
            return null;
        }
    }

    /** Upsert a JSON-serializable value. */
    async set(key, value) {
        await db.run(
            `INSERT INTO instance_state (key, valueJson, updatedAt)
             VALUES (@key, @valueJson, datetime('now'))
             ON CONFLICT (key) DO UPDATE SET valueJson = excluded.valueJson, updatedAt = datetime('now')`,
            { key, valueJson: JSON.stringify(value ?? null) }
        );
    }

    async remove(key) {
        return (await db.run('DELETE FROM instance_state WHERE key = @key', { key })).changes;
    }

    // --- Paused ------------------------------------------------------------

    /**
     * Pause the instance. Idempotent: a second pause keeps the first record.
     * @param {{reason: string, by?: string|null, detail?: Object}} params
     * @returns {Promise<Object>} the pause record
     */
    async pause({ reason, by = null, detail = {} }) {
        const existing = await this.getPause();
        if (existing) return existing;
        const record = { reason: String(reason || 'operator'), since: utcText(), by: by == null ? null : String(by), detail };
        await this.set(KEY_PAUSED, record);
        await this._audit(record.reason === 'restore' ? 'instance.restore' : 'instance.pause', by, {
            reason: record.reason,
            archive: detail?.archive ?? undefined,
            interrupted: detail?.interrupted ?? undefined
        });
        return record;
    }

    /**
     * operator_audit row for an instance change. `by` is a principal id
     * from the Host room or a tool name from a CLI; only the former is an
     * actor, the latter is kept as detail.
     */
    async _audit(action, by, detail = {}) {
        const identityService = require('./identityService');
        const isPrincipal = by != null && identityService.isPrincipalId(String(by));
        await require('./operatorAuditService').record({
            action,
            actor: isPrincipal ? String(by) : null,
            detail: { ...detail, ...(by != null && !isPrincipal ? { via: String(by) } : {}) }
        });
    }

    /** @returns {Promise<Object|null>} the pause record, or null when running */
    async getPause() {
        const value = await this.get(KEY_PAUSED);
        return value && typeof value === 'object' ? value : null;
    }

    /** @returns {Promise<boolean>} */
    async isPaused() {
        return (await this.getPause()) !== null;
    }

    /**
     * Resume: skip everything that came due while paused (and during the
     * downtime before the restore that set the flag), then clear the flag.
     * Returns what was skipped so the operator sees it. Safe to call when
     * not paused - it still skips stale schedules and records the call.
     * @param {{by?: string|null, now?: Date}} [params]
     */
    async resume({ by = null, now = new Date() } = {}) {
        const pause = await this.getPause();
        const skipped = await db.transaction(async () => {
            const outcome = await this.skipMissedSchedules({ now });
            await this.remove(KEY_PAUSED);
            const record = {
                at: utcText(now),
                by: by == null ? null : String(by),
                pausedSince: pause?.since || null,
                pauseReason: pause?.reason || null,
                skipped: outcome
            };
            await this.set(KEY_LAST_RESUME, record);
            return outcome;
        });
        await this._noticeMissedFollowups(skipped.followupNotices);
        await this._audit('instance.resume', by, {
            pausedSince: pause?.since || null,
            pauseReason: pause?.reason || null,
            skipped: Object.fromEntries(Object.entries(skipped).filter(([, value]) => typeof value === 'number'))
        });
        logger.info?.(`[instance] Resumed${pause ? ` (paused since ${pause.since} UTC, reason: ${pause.reason})` : ''}; `
            + `skipped ${skipped.automations} automation(s), ${skipped.cronTriggers} cron trigger(s), `
            + `${skipped.eventTriggers} event fire(s), ${skipped.recurringFollowups} recurring follow-up(s); `
            + `cancelled ${skipped.oneShotFollowups} one-shot follow-up(s)`);
        return { paused: null, skipped };
    }

    /**
     * Move every schedule whose fire time is in the past to its next future
     * occurrence, without running it. One-shot follow-ups have no next
     * occurrence: they are cancelled and their owner is told through the
     * Inbox (never silently). Event triggers get a SKIPPED delivery for each
     * settled job they never reacted to, so the startup catch-up cannot
     * replay them.
     * @param {{now?: Date}} [params]
     */
    async skipMissedSchedules({ now = new Date() } = {}) {
        const nowText = utcText(now);
        const result = {
            automations: 0, cronTriggers: 0, eventTriggers: 0,
            recurringFollowups: 0, oneShotFollowups: 0, followupNotices: []
        };

        for (const row of await db.all(
            'SELECT id, schedule FROM automations WHERE isEnabled = 1 AND nextRun IS NOT NULL AND nextRun <= @now',
            { now: nowText }
        )) {
            const next = nextCronFire(row.schedule, now);
            if (!next) continue;
            result.automations += (await db.run(
                'UPDATE automations SET nextRun = @next, updatedAt = CURRENT_TIMESTAMP WHERE id = @id AND nextRun <= @now',
                { next, id: row.id, now: nowText }
            )).changes;
        }

        for (const row of await db.all(
            `SELECT id, schedule FROM project_triggers
             WHERE kind = 'cron' AND isEnabled = 1 AND nextRun IS NOT NULL AND nextRun <= @now`,
            { now: nowText }
        )) {
            const next = nextCronFire(row.schedule, now);
            if (!next) continue;
            result.cronTriggers += (await db.run(
                `UPDATE project_triggers SET nextRun = @next, updatedAt = datetime('now')
                 WHERE id = @id AND nextRun <= @now`,
                { next, id: row.id, now: nowText }
            )).changes;
        }

        result.eventTriggers = await this._skipMissedEventFires(nowText);

        for (const row of await db.all(
            `SELECT id, userId, note, dueAt, recurMinutes FROM followups
             WHERE status = 'PENDING' AND dueAt <= @now`,
            { now: nowText }
        )) {
            if (row.recurMinutes) {
                const base = utcTextToMs(row.dueAt);
                const step = Number(row.recurMinutes) * 60_000;
                const missed = Math.max(0, Math.floor((now.getTime() - base) / step));
                const next = utcText(new Date(base + (missed + 1) * step));
                result.recurringFollowups += (await db.run(
                    `UPDATE followups SET dueAt = @next WHERE id = @id AND status = 'PENDING' AND dueAt = @dueAt`,
                    { next, id: row.id, dueAt: row.dueAt }
                )).changes;
                continue;
            }
            const cancelled = (await db.run(
                `UPDATE followups SET status = 'CANCELLED' WHERE id = @id AND status = 'PENDING'`,
                { id: row.id }
            )).changes;
            if (cancelled > 0) {
                result.oneShotFollowups += 1;
                if (row.userId) {
                    result.followupNotices.push({ id: row.id, userId: row.userId, note: row.note, dueAt: row.dueAt });
                }
            }
        }
        return result;
    }

    /** SKIPPED deliveries for settled jobs an enabled event trigger never fired on. */
    async _skipMissedEventFires(nowText) {
        const { matchesEventTrigger } = require('./projectTriggerService');
        let skipped = 0;
        const triggers = await db.all(
            `SELECT * FROM project_triggers WHERE kind = 'event' AND isEnabled = 1 ORDER BY id ASC`
        );
        for (const trigger of triggers) {
            const jobs = await db.all(
                `SELECT j.*, v.assetId AS assetId
                 FROM observatory_jobs j
                 LEFT JOIN project_asset_versions v ON v.id = j.assetVersionId
                 LEFT JOIN project_trigger_deliveries d ON d.triggerId = @triggerId AND d.sourceJobId = j.id
                 WHERE j.projectId = @projectId AND j.finishedAt IS NOT NULL AND j.finishedAt <= @now AND d.id IS NULL
                 ORDER BY j.id ASC`,
                { triggerId: trigger.id, projectId: trigger.projectId, now: nowText }
            );
            for (const job of jobs) {
                if (!matchesEventTrigger(trigger, job)) continue;
                skipped += (await db.run(
                    `INSERT INTO project_trigger_deliveries (triggerId, sourceJobId, projectId, status, attempts, detail)
                     VALUES (@triggerId, @sourceJobId, @projectId, 'SKIPPED', 0, 'missed while the instance was paused (restore)')
                     ON CONFLICT (triggerId, sourceJobId) DO NOTHING`,
                    { triggerId: trigger.id, sourceJobId: job.id, projectId: trigger.projectId }
                )).changes;
            }
        }
        return skipped;
    }

    /** Tell each owner which one-shot reminders were cancelled instead of firing late. */
    async _noticeMissedFollowups(notices) {
        if (!notices || notices.length === 0) return;
        let inbox;
        try {
            inbox = require('./inboxService');
        } catch {
            return;
        }
        for (const notice of notices) {
            try {
                await inbox.deliver({
                    userId: notice.userId,
                    kind: 'system',
                    title: 'A reminder was missed while the instance was paused',
                    body: `"${notice.note}" was due at ${notice.dueAt} UTC, during a restore. It was not delivered late and will not fire; set it again if you still want it.`,
                    source: { type: 'followup', id: notice.id },
                    link: '/activity/scheduled',
                    dedupeKey: `restore-missed-followup:${notice.id}`
                });
            } catch (error) {
                logger.warn?.(`[instance] Could not file the missed-reminder notice for follow-up #${notice.id}: ${error.message}`);
            }
        }
    }

    // --- Restore bookkeeping ------------------------------------------------

    async recordRestore(record) {
        await this.set(KEY_LAST_RESTORE, { at: utcText(), ...record });
    }

    /** Everything the Host room shows: pause state and the last restore / resume. */
    async describe() {
        return {
            paused: await this.getPause(),
            lastRestore: await this.get(KEY_LAST_RESTORE),
            lastResume: await this.get(KEY_LAST_RESUME)
        };
    }
}

module.exports = new InstanceStateService();
module.exports.InstanceStateService = InstanceStateService;
module.exports.KEY_PAUSED = KEY_PAUSED;
module.exports.nextCronFire = nextCronFire;
module.exports.utcText = utcText;
