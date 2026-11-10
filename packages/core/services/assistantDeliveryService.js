/**
 * Delivery of delegated work beyond the portal (DA-9).
 *
 * Every person-audience update is on Home and has one Inbox envelope.
 * Whether it also leaves the portal is the responsibility's interruption
 * rule, read when the decision is made (so changing the rule applies to
 * what is still waiting):
 *
 *   home       nothing leaves the portal (the default, and the rule of any
 *              update that belongs to no responsibility)
 *   digest     findings and open requests go into the day's digest
 *   immediate  an open request is one contact per gate occurrence;
 *              findings go into the day's digest. A finding never
 *              contacts anyone by itself.
 *
 * Both ways out are `attentionService.requestContact()`: the person's
 * quiet hours, daily cap and cooldown apply, Attention being off stops
 * them, and each one spends the same budget Attention's own notices do.
 * A refusal leaves the update waiting; it is tried again on the next pass.
 *
 * `assistant_updates.outbound*` records the one time a material revision
 * (or a gate occurrence) left the portal, claimed before anything is sent,
 * so the same update never goes out both as a digest entry and as a
 * contact. Going out is delivery: receipts keep `deliveredRevision` and
 * never touch `acknowledgedRevision`, so Home stays highlighted until the
 * person has actually looked.
 *
 * Spec: documentation/delegated_delivery.md
 */

const db = require('../db');
const logger = require('../utils/logger');
const { features } = require('../features/featureState');
const { localMinuteInZone } = require('../config/userSettingsSchema');

const REASON = 'assistant';
const MODES = ['home', 'digest', 'immediate'];
/** 09:00 on the person's quiet-hours clock, unless they chose a time. */
const DEFAULT_DIGEST_MINUTE = require('../config/attentionConfig').HEARTBEAT.digestMinute;
/** An open request not contacted about within this window goes to the digest instead. */
const CONTACT_WINDOW_HOURS = 48;
/** Updates older than this never go out; they stay on Home and in the Inbox. */
const DIGEST_WINDOW_DAYS = 7;
const DIGEST_MAX_ENTRIES = 50;
const DIGEST_LISTED = 10;
const SCAN_MAX = 500;
const DIGEST_RETENTION_DAYS = 90;
const DIGEST_SOURCE_TYPE = 'assistant_digest';
/**
 * A responsibility the person stopped, or never started, sends nothing
 * out: its updates stay on Home and in the Inbox. Resuming a paused one
 * makes what is still waiting eligible again.
 */
const SILENT_STATUSES = ['DRAFT', 'PAUSED', 'REVOKED', 'ARCHIVED'];
/** Refusals that will not change within a pass: stop asking for this person. */
const HOLDS = ['ATTENTION_OFF', 'OUTBOUND_OFF', 'QUIET_HOURS', 'CONTACT_CAP', 'COOLDOWN', 'NO_CHANNEL'];

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseJson(raw, fallback) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
}

/** The interruption rule of a responsibility's stored rules. */
function modeOf(rulesJson) {
    const mode = parseJson(rulesJson, {})?.interruption;
    return mode === 'digest' || mode === 'immediate' ? mode : 'home';
}

function localDay(now, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const part = type => parts.find(p => p.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
}

class AssistantDeliveryService {
    constructor() {
        this.MODES = MODES;
        this.DEFAULT_DIGEST_MINUTE = DEFAULT_DIGEST_MINUTE;
        this._gateway = null;
        this._attached = false;
    }

    /**
     * Make this process the one that sends (the steward's process). Until
     * then `contactNow()` leaves a new request for the steward's next pass,
     * so a web-only process never spends a contact it could only half send.
     */
    attach({ gateway = null } = {}) {
        this._gateway = gateway || null;
        this._attached = true;
    }

    detach() {
        this._gateway = null;
        this._attached = false;
    }

    /**
     * The person's day and minute on the clock their quiet hours use:
     * their timezone when quiet hours are local, otherwise UTC.
     */
    async clock(userId, now = new Date()) {
        let timeZone = null;
        try {
            const userSettingsService = require('./userSettingsService');
            const [mode, zone] = await Promise.all([
                userSettingsService.getPreference(userId, 'quietHoursTzMode'),
                userSettingsService.getPreference(userId, 'timezone')
            ]);
            if (mode === 'local' && zone) timeZone = zone;
        } catch { /* UTC */ }
        if (timeZone) {
            try {
                return { day: localDay(now, timeZone), minute: localMinuteInZone(now, timeZone), timeZone };
            } catch { /* an unknown zone falls back to UTC */ }
        }
        return { day: now.toISOString().slice(0, 10), minute: now.getUTCHours() * 60 + now.getUTCMinutes(), timeZone: null };
    }

    /**
     * Updates that could still leave the portal: filed in the Inbox at
     * their current revision, not yet sent at it, unseen, not snoozed,
     * under a responsibility of the same person that is not stopped and
     * whose rule is not `home`.
     */
    async _pending({ now, id = null, userId = null }) {
        const filters = [
            "u.audienceKind = 'user'",
            'u.inboxItemId IS NOT NULL',
            'u.envelopeRevision >= u.materialRevision',
            'u.outboundRevision < u.materialRevision',
            'u.updatedAt >= @since',
            `r.status NOT IN (${SILENT_STATUSES.map(status => `'${status}'`).join(', ')})`,
            'COALESCE(c.acknowledgedRevision, 0) < u.materialRevision',
            '(c.snoozedUntil IS NULL OR c.snoozedUntil <= @now)',
            `(r.rulesJson LIKE '%"interruption":"digest"%' OR r.rulesJson LIKE '%"interruption":"immediate"%')`
        ];
        const params = {
            now: utcText(now),
            since: utcText(new Date(now.getTime() - DIGEST_WINDOW_DAYS * 86_400_000)),
            cap: SCAN_MAX
        };
        if (id) {
            filters.push('u.id = @id');
            params.id = Number(id);
        }
        if (userId) {
            filters.push('u.audienceUserId = @userId');
            params.userId = String(userId);
        }
        const rows = await db.all(
            `SELECT u.id, u.audienceUserId, u.title, u.materialRevision, u.sequence, u.gateJson, u.gateResolvedAt,
                    u.inboxItemId, u.outboundRevision, u.outboundOccurrence, u.outboundKind, u.outboundAt, u.updatedAt,
                    r.rulesJson
             FROM assistant_updates u
             JOIN assistant_responsibilities r ON r.id = u.responsibilityId AND r.ownerUserId = u.audienceUserId
             LEFT JOIN assistant_update_receipts c ON c.updateId = u.id AND c.userId = u.audienceUserId
             WHERE ${filters.join(' AND ')}
             ORDER BY u.sequence LIMIT @cap`,
            params
        );
        const contactSince = utcText(new Date(now.getTime() - CONTACT_WINDOW_HOURS * 3_600_000));
        const out = [];
        for (const row of rows) {
            const mode = modeOf(row.rulesJson);
            if (mode === 'home') continue;
            const gate = parseJson(row.gateJson, null);
            const occurrence = gate ? Number(gate.occurrence) || 1 : null;
            // One way out per gate occurrence, whatever was revised since.
            if (gate && Number(row.outboundOccurrence) >= occurrence) continue;
            const open = Boolean(gate && !row.gateResolvedAt);
            const route = mode === 'immediate' && open && row.updatedAt >= contactSince ? 'contact' : 'digest';
            out.push({ ...row, mode, occurrence, open, route });
        }
        return out;
    }

    /**
     * Take the one way out for this revision. False when another pass (or
     * another process) already took it.
     */
    async _claim(row, kind, now) {
        const result = await db.run(
            `UPDATE assistant_updates
             SET outboundKind = @kind, outboundRevision = @revision, outboundAt = @now,
                 outboundOccurrence = CASE WHEN @occurrence > outboundOccurrence THEN @occurrence ELSE outboundOccurrence END
             WHERE id = @id AND materialRevision = @revision AND outboundRevision < @revision`,
            { id: row.id, kind, revision: Number(row.materialRevision), occurrence: Number(row.occurrence || 0), now: utcText(now) }
        );
        return result.changes === 1;
    }

    /** Give a claim back: nothing was sent, so the update waits again. */
    async _release(row, kind) {
        await db.run(
            `UPDATE assistant_updates
             SET outboundKind = @previousKind, outboundRevision = @previousRevision,
                 outboundOccurrence = @previousOccurrence, outboundAt = @previousAt
             WHERE id = @id AND outboundKind = @kind AND outboundRevision = @revision`,
            {
                id: row.id, kind, revision: Number(row.materialRevision),
                previousKind: row.outboundKind || null,
                previousRevision: Number(row.outboundRevision || 0),
                previousOccurrence: Number(row.outboundOccurrence || 0),
                previousAt: row.outboundAt || null
            }
        );
    }

    /** Whether delegated work may reach this person outside the portal at all. */
    async _open(userId) {
        if (features.enforcedOff('assistant')) return false;
        if (await require('./assistantControlService').isPaused()) return false;
        return require('./assistantAccessService').allows(String(userId), 'delivery');
    }

    /** One contact for one open request. @returns {Promise<{ sent: boolean, code: string|null }>} */
    async _contact(row, now) {
        const attention = require('./attentionService');
        if (!(await this._claim(row, 'contact', now))) return { sent: false, code: 'TAKEN' };
        const outcome = await attention.requestContact({
            userId: row.audienceUserId,
            reason: REASON,
            updateId: row.id,
            urgent: false,
            gateway: this._gateway,
            inboxItemId: row.inboxItemId,
            now: now.getTime()
        });
        if (!outcome.attempted) {
            await this._release(row, 'contact');
            return { sent: false, code: outcome.code };
        }
        await require('./assistantUpdateService').markDelivered({
            userId: row.audienceUserId, id: row.id, revision: row.materialRevision
        });
        return { sent: true, code: outcome.code };
    }

    /**
     * Contact about one update right after its envelope was filed, when
     * its rule is `immediate`, it carries an open request and this process
     * sends. Never throws; anything not sent now waits for `sweep()`.
     */
    async contactNow({ id, now = new Date() } = {}) {
        try {
            if (!this._attached || !id) return { sent: false, code: 'DEFERRED' };
            const [row] = await this._pending({ now, id });
            if (!row || row.route !== 'contact') return { sent: false, code: 'NOT_DUE' };
            if (!(await this._open(row.audienceUserId))) return { sent: false, code: 'CLOSED' };
            return await this._contact(row, now);
        } catch (error) {
            logger.warn?.(`[assistant delivery] immediate contact failed: ${error.message}`);
            return { sent: false, code: 'ERROR' };
        }
    }

    /**
     * The steward's delivery step: contacts still owed for open requests,
     * then each person's digest when it is due.
     * @returns {Promise<{ contacts: number, digests: number, held: number }>}
     */
    async sweep({ now = new Date() } = {}) {
        const result = { contacts: 0, digests: 0, held: 0 };
        if (features.enforcedOff('assistant')) return result;
        const rows = await this._pending({ now });
        if (!rows.length) return result;
        const byUser = new Map();
        for (const row of rows) {
            if (!byUser.has(row.audienceUserId)) byUser.set(row.audienceUserId, []);
            byUser.get(row.audienceUserId).push(row);
        }
        for (const [userId, list] of byUser) {
            try {
                if (!(await this._open(userId))) {
                    result.held += list.length;
                    continue;
                }
                const outcome = await this._sweepUser(userId, list, now);
                result.contacts += outcome.contacts;
                result.digests += outcome.digests;
                result.held += outcome.held;
            } catch (error) {
                logger.warn?.(`[assistant delivery] pass failed for one person: ${error.message}`);
            }
        }
        return result;
    }

    /**
     * Whether a contact could go out right now, asked before anything is
     * claimed so a person who is held is not rewritten on every pass.
     */
    async _reachable(userId, now) {
        const attention = require('./attentionService');
        const allowed = await attention.contactAllowed({ userId, reason: REASON, now: now.getTime() });
        if (!allowed.allowed) return { ok: false, policy: null };
        const channels = await attention.contactChannels({ userId, gateway: this._gateway });
        return { ok: channels.push || channels.discord, policy: allowed.policy };
    }

    async _sweepUser(userId, list, now) {
        const outcome = { contacts: 0, digests: 0, held: 0 };
        const reach = await this._reachable(userId, now);
        if (!reach.ok) {
            outcome.held = list.length;
            return outcome;
        }
        const policy = reach.policy;
        const contacts = list.filter(row => row.route === 'contact');
        for (let index = 0; index < contacts.length; index += 1) {
            const sent = await this._contact(contacts[index], now);
            if (sent.sent) {
                outcome.contacts += 1;
            } else if (HOLDS.includes(sent.code)) {
                outcome.held += contacts.length - index;
                break;
            }
        }
        const digest = await this._digest(userId, policy, list.filter(row => row.route === 'digest'), now);
        outcome.digests += digest.sent ? 1 : 0;
        outcome.held += digest.held;
        return outcome;
    }

    /**
     * Send today's digest when it is due: once the person's digest time has
     * passed, for what was waiting at that time. Nothing waiting sends
     * nothing and records nothing; `assistant_digests` holds one row per
     * person and day, so a second digest cannot be sent.
     */
    async _digest(userId, policy, candidates, now) {
        const none = { sent: false, held: 0 };
        if (!candidates.length) return none;
        const digestMinute = Number.isInteger(policy.digestMinute) ? policy.digestMinute : DEFAULT_DIGEST_MINUTE;
        const { day, minute } = await this.clock(userId, now);
        if (minute < digestMinute) return none;
        // The instant today's digest time passed. Later updates are tomorrow's.
        const cutoff = utcText(new Date(Math.floor(now.getTime() / 60_000) * 60_000 - (minute - digestMinute) * 60_000 + 59_000));
        const entries = candidates.filter(row => row.updatedAt <= cutoff).slice(0, DIGEST_MAX_ENTRIES);
        if (!entries.length) return none;
        if (await db.get('SELECT id FROM assistant_digests WHERE userId = @userId AND day = @day', { userId, day })) return none;
        // A contact made a moment ago in this pass started the cooldown.
        if (!(await this._reachable(userId, now)).ok) return { sent: false, held: entries.length };

        let digestId;
        try {
            digestId = await db.insert(
                'INSERT INTO assistant_digests (userId, day, updateIdsJson) VALUES (@userId, @day, @ids)',
                { userId, day, ids: '[]' }
            );
        } catch {
            return none; // another process is sending this day's digest
        }
        const claimed = [];
        for (const row of entries) {
            if (await this._claim(row, 'digest', now)) claimed.push(row);
        }
        const giveBack = async () => {
            for (const row of claimed) await this._release(row, 'digest');
            await db.run('DELETE FROM assistant_digests WHERE id = @id AND sentAt IS NULL', { id: digestId });
        };
        if (!claimed.length) {
            await giveBack();
            return none;
        }
        let outcome;
        try {
            outcome = await require('./attentionService').requestContact({
                userId,
                reason: REASON,
                refId: `digest:${day}`,
                urgent: false,
                gateway: this._gateway,
                item: this._digestItem(claimed, day),
                now: now.getTime()
            });
        } catch (error) {
            outcome = { attempted: false, code: 'ERROR' };
            logger.warn?.(`[assistant delivery] digest failed: ${error.message}`);
        }
        if (!outcome.attempted) {
            await giveBack();
            return { sent: false, held: claimed.length };
        }
        const updates = require('./assistantUpdateService');
        for (const row of claimed) await updates.markDelivered({ userId, id: row.id, revision: row.materialRevision });
        await db.run(
            'UPDATE assistant_digests SET updateIdsJson = @ids, inboxItemId = @itemId, sentAt = @now WHERE id = @id',
            { id: digestId, ids: JSON.stringify(claimed.map(row => Number(row.id))), itemId: outcome.inboxItemId ?? null, now: utcText(now) }
        );
        return { sent: true, held: 0 };
    }

    /** The digest as an Inbox item: a count, the first titles, and where to look. */
    _digestItem(rows, day) {
        const count = rows.length;
        const lines = rows.slice(0, DIGEST_LISTED).map(row => `- ${row.title}${row.open ? ' (waiting for your decision)' : ''}`);
        if (count > DIGEST_LISTED) lines.push(`- and ${count - DIGEST_LISTED} more`);
        return {
            kind: 'notice',
            title: count === 1 ? '1 update from your delegated work' : `${count} updates from your delegated work`,
            body: `${lines.join('\n')}\n\nThey are on Home, and each one is in your Inbox.`,
            source: { type: DIGEST_SOURCE_TYPE, id: day },
            link: '/home',
            dedupeKey: `${DIGEST_SOURCE_TYPE}:${day}`
        };
    }

    /** Retention: digests 90 days; the contact ledger its own 30 days. */
    async prune({ now = new Date() } = {}) {
        const digests = (await db.run(
            'DELETE FROM assistant_digests WHERE createdAt < @cutoff',
            { cutoff: utcText(new Date(now.getTime() - DIGEST_RETENTION_DAYS * 86_400_000)) }
        )).changes || 0;
        const contacts = await require('./attentionService').pruneContacts({ now: now.getTime() });
        return { digests, contacts };
    }
}

module.exports = new AssistantDeliveryService();
module.exports.AssistantDeliveryService = AssistantDeliveryService;
module.exports.MODES = MODES;
module.exports.modeOf = modeOf;
module.exports.DEFAULT_DIGEST_MINUTE = DEFAULT_DIGEST_MINUTE;
module.exports.CONTACT_WINDOW_HOURS = CONTACT_WINDOW_HOURS;
module.exports.DIGEST_WINDOW_DAYS = DIGEST_WINDOW_DAYS;
module.exports.DIGEST_RETENTION_DAYS = DIGEST_RETENTION_DAYS;
module.exports.DIGEST_SOURCE_TYPE = DIGEST_SOURCE_TYPE;
module.exports.SILENT_STATUSES = SILENT_STATUSES;
