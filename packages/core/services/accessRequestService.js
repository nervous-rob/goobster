/**
 * Access requests: "let me in" from a signed-in person without an account.
 *
 * With `identity.requireAccount` on, a Discord member who signs in to the
 * portal is a valid session with no entitlement (`403 NO_ACCOUNT`). Instead
 * of leaving them at a dead end - or steering them into an empty second
 * account through open sign-up - they ask the host from that page. The
 * request lands in every active operator's Inbox (`inboxService.deliver`,
 * kind `system`) and, when this installation has Discord, in their DMs
 * with Approve / Decline buttons. Approval IS the migration grant
 * (`identityService.grantAccount`, entitlement `migration`): the person's
 * history under their Discord identity stays theirs.
 *
 * One open request per person. The shared-installation cap gate still
 * applies at approval (`DAILY_CAP_REQUIRED`), and a refused approval leaves
 * the request pending for the host to retry once Host -> Limits has a cap.
 * Every resolution writes one `operator_audit` row (`access.approve` /
 * `access.decline`) whichever surface it came from. Spec:
 * documentation/identity.md ("Asking to join").
 */

const db = require('../db');
const identityConfig = require('../config/identityConfig');
const logger = require('../utils/logger');
const { toGateway } = require('../gateway');
const { discord } = require('../utils/optionalModule');

const SOURCE_TYPE = 'access_request';
const MAX_NOTE = 280;
const DECLINE_COOLDOWN_HOURS = 24;
const BUTTON_TYPE = 'accessreq';

class AccessRequestError extends Error {
    constructor(status, code, message, details = null) {
        super(message);
        this.name = 'AccessRequestError';
        this.status = status;
        this.code = code;
        if (details) this.details = details;
    }
}

function nowUtc() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function utcPlusHours(base, hours) {
    return new Date(new Date(`${base.replace(' ', 'T')}Z`).getTime() + hours * 3600_000)
        .toISOString().slice(0, 19).replace('T', ' ');
}

class AccessRequestService {
    constructor() {
        this.AccessRequestError = AccessRequestError;
        this.SOURCE_TYPE = SOURCE_TYPE;
        this.BUTTON_TYPE = BUTTON_TYPE;
        this.MAX_NOTE = MAX_NOTE;
    }

    // --- The requester --------------------------------------------------------

    /**
     * Ask the host for an account. Idempotent while a request is open.
     * @param {{ principalId: string, note?: string|null, gateway?: object|null }} params
     * @returns {Promise<{ request: object, created: boolean, notified: number }>}
     */
    async request({ principalId, note = null, gateway = null }) {
        const identity = require('./identityService');
        const id = String(principalId ?? '');
        const principal = await identity.getPrincipal(id);
        if (!principal) throw new AccessRequestError(404, 'PRINCIPAL_NOT_FOUND', 'That principal does not exist.');
        if (!identityConfig.requireAccount) {
            throw new AccessRequestError(409, 'NOT_NEEDED', 'This installation lets you in without an account - just reload.');
        }
        const account = await identity.getAccount(id);
        if (account) {
            throw new AccessRequestError(409, 'ALREADY_MEMBER', account.status === 'active'
                ? 'You already have an account here - reload to continue.'
                : 'This account has been disabled by the host.');
        }
        const cleanNote = note == null ? null : String(note).trim().slice(0, MAX_NOTE) || null;

        const open = await this._pendingFor(id);
        if (open) return { request: await this._public(open), created: false, notified: 0 };

        const latest = await this._latestFor(id);
        if (latest?.status === 'declined' && latest.resolvedAt) {
            const retryAt = utcPlusHours(latest.resolvedAt, DECLINE_COOLDOWN_HOURS);
            if (retryAt > nowUtc()) {
                throw new AccessRequestError(429, 'REQUEST_COOLDOWN',
                    'The host declined your last request. You can ask again tomorrow.', { retryAt });
            }
        }

        const rowId = await db.insert(
            'INSERT INTO access_requests (principalId, note) VALUES (@principalId, @note)',
            { principalId: id, note: cleanNote }
        );
        const row = await this._row(rowId);
        const notified = await this._notifyOperators(row, principal, gateway);
        return { request: await this._public(row), created: true, notified };
    }

    /**
     * What the requester sees on the "Almost in" page.
     * @returns {Promise<{ request: object|null, pending: boolean, member: boolean, canRequest: boolean, retryAt: string|null }>}
     */
    async statusFor(principalId) {
        const identity = require('./identityService');
        const id = String(principalId ?? '');
        const account = await identity.getAccount(id);
        const latest = await this._latestFor(id);
        const pending = latest?.status === 'pending';
        let retryAt = null;
        if (latest?.status === 'declined' && latest.resolvedAt) {
            const until = utcPlusHours(latest.resolvedAt, DECLINE_COOLDOWN_HOURS);
            if (until > nowUtc()) retryAt = until;
        }
        return {
            request: latest ? await this._public(latest) : null,
            pending,
            member: Boolean(account && account.status === 'active'),
            canRequest: identityConfig.requireAccount && !account && !pending && !retryAt,
            retryAt
        };
    }

    // --- The host -------------------------------------------------------------

    /** Every open request, oldest first (Host -> Accounts). */
    async listPending() {
        const rows = await db.all(
            `SELECT * FROM access_requests WHERE status = 'pending' ORDER BY createdAt, id`
        );
        return Promise.all(rows.map(row => this._public(row)));
    }

    async get(id) {
        const row = await this._row(id);
        if (!row) throw new AccessRequestError(404, 'NOT_FOUND', 'No such access request.');
        return this._public(row);
    }

    /**
     * Approve: grant the account, close the request, tell the person.
     * @param {{ id: number|string, resolvedBy: string, gateway?: object|null, via?: 'host'|'inbox'|'discord' }} params
     */
    async approve({ id, resolvedBy, gateway = null, via = 'host' }) {
        const identity = require('./identityService');
        const row = await this._row(id);
        if (!row) throw new AccessRequestError(404, 'NOT_FOUND', 'No such access request.');
        if (row.status !== 'pending') {
            throw new AccessRequestError(409, 'ALREADY_RESOLVED', `This request was already ${row.status}.`);
        }
        // The grant is the real change; the cap gate may refuse it
        // (DAILY_CAP_REQUIRED) and then the request simply stays open.
        const { created } = await identity.grantAccount({ principalId: row.principalId, entitlement: 'migration', role: 'member' });
        const won = await this._resolve(row.id, 'approved', resolvedBy);
        if (!won) return this.get(row.id);
        await require('./operatorAuditService').record({
            action: 'access.approve', actor: resolvedBy, target: row.principalId,
            detail: { requestId: row.id, role: 'member', entitlement: 'migration', created: Boolean(created), via }
        });
        await this._notifyRequester(row, 'approved', gateway);
        return this.get(row.id);
    }

    /** Decline: close the request without a grant, tell the person (neutrally). */
    async decline({ id, resolvedBy, gateway = null, via = 'host' }) {
        const row = await this._row(id);
        if (!row) throw new AccessRequestError(404, 'NOT_FOUND', 'No such access request.');
        if (row.status !== 'pending') {
            throw new AccessRequestError(409, 'ALREADY_RESOLVED', `This request was already ${row.status}.`);
        }
        const won = await this._resolve(row.id, 'declined', resolvedBy);
        if (!won) return this.get(row.id);
        await require('./operatorAuditService').record({
            action: 'access.decline', actor: resolvedBy, target: row.principalId,
            detail: { requestId: row.id, via }
        });
        await this._notifyRequester(row, 'declined', gateway);
        return this.get(row.id);
    }

    /**
     * The host granted the account some other way (Host -> Accounts, the
     * CLI): close any open request as approved and tell the person. The
     * grant itself is already audited by its route; nothing is re-recorded.
     * @returns {Promise<number>} requests closed
     */
    async settleForPrincipal({ principalId, resolvedBy = null, gateway = null }) {
        const rows = await db.all(
            `SELECT * FROM access_requests WHERE principalId = @principalId AND status = 'pending'`,
            { principalId: String(principalId) }
        );
        let closed = 0;
        for (const row of rows) {
            if (await this._resolve(row.id, 'approved', resolvedBy)) {
                closed += 1;
                await this._notifyRequester(row, 'approved', gateway);
            }
        }
        return closed;
    }

    // --- Discord buttons ------------------------------------------------------

    /**
     * Approve / Decline pressed on the DM (routed from interactionCreate).
     * Only an active operator may resolve; anybody else keeps the buttons
     * for someone who can. Returns the edit for the DM, or null.
     */
    async handleButton(action, id, interaction) {
        const operator = await this._operatorForDiscordUser(interaction.user.id);
        if (!operator) {
            await interaction.followUp({ content: '❌ Only the host can resolve access requests.', ephemeral: true }).catch(() => {});
            return null;
        }
        const row = await this._row(id);
        if (!row) return { content: '⌛ This access request no longer exists.', embeds: [], components: [] };
        if (row.status !== 'pending') {
            const who = row.resolvedBy ? await this._nameFor(row.resolvedBy) : 'the host';
            return { content: `⌛ Already ${row.status} by ${who}.`, embeds: [], components: [] };
        }
        const gateway = toGateway(interaction.client);
        const name = await this._nameFor(row.principalId);
        if (action === 'decline') {
            await this.decline({ id: row.id, resolvedBy: operator, gateway, via: 'discord' });
            return { content: `🚫 Declined by <@${interaction.user.id}>. ${name} has been told.`, embeds: [], components: [] };
        }
        if (action !== 'approve') return null;
        try {
            await this.approve({ id: row.id, resolvedBy: operator, gateway, via: 'discord' });
        } catch (error) {
            // Most likely the cap gate: the request stays open, the buttons stay.
            const hint = error?.code === 'DAILY_CAP_REQUIRED'
                ? ' Set a daily token cap in Host → Limits, then press Approve again.'
                : '';
            await interaction.followUp({ content: `⚠️ ${error.message}${hint}`, ephemeral: true }).catch(() => {});
            return null;
        }
        return { content: `✅ Approved by <@${interaction.user.id}>. ${name} now has an account.`, embeds: [], components: [] };
    }

    // --- Inbox presentation ---------------------------------------------------

    /**
     * The access requests behind the items in a page, keyed by sourceId,
     * so the operator's Inbox can offer Approve / Decline on a pending one
     * and show the outcome on a resolved one.
     * @param {Array<{ sourceType: string|null, sourceId: string|null }>} rows
     * @returns {Promise<Map<string, object>>}
     */
    async describeForRows(rows) {
        const ids = [...new Set(rows
            .filter(row => row.sourceType === SOURCE_TYPE && row.sourceId != null && /^\d+$/.test(String(row.sourceId)))
            .map(row => Number(row.sourceId)))];
        const map = new Map();
        if (ids.length === 0) return map;
        const params = {};
        const marks = ids.map((id, index) => { params[`id${index}`] = id; return `@id${index}`; });
        const found = await db.all(`SELECT * FROM access_requests WHERE id IN (${marks.join(', ')})`, params);
        for (const row of found) map.set(String(row.id), await this._public(row));
        return map;
    }

    // --- Internals ------------------------------------------------------------

    async _row(id) {
        const n = Number(id);
        if (!Number.isSafeInteger(n) || n < 1) return null;
        return await db.get('SELECT * FROM access_requests WHERE id = @id', { id: n }) || null;
    }

    async _pendingFor(principalId) {
        return await db.get(
            `SELECT * FROM access_requests WHERE principalId = @principalId AND status = 'pending' ORDER BY id DESC LIMIT 1`,
            { principalId }
        ) || null;
    }

    async _latestFor(principalId) {
        return await db.get(
            'SELECT * FROM access_requests WHERE principalId = @principalId ORDER BY id DESC LIMIT 1',
            { principalId }
        ) || null;
    }

    /** One winner: the UPDATE only matches while the row is still pending. */
    async _resolve(id, status, resolvedBy) {
        const now = nowUtc();
        const result = await db.run(
            `UPDATE access_requests
             SET status = @status, resolvedBy = @resolvedBy, resolvedAt = @now, updatedAt = @now
             WHERE id = @id AND status = 'pending'`,
            { id, status, resolvedBy: resolvedBy == null ? null : String(resolvedBy), now }
        );
        return result.changes > 0;
    }

    async _public(row) {
        const identity = require('./identityService');
        const principal = await identity.getPrincipal(row.principalId);
        return {
            id: row.id,
            principalId: row.principalId,
            displayName: principal?.displayName || null,
            discordId: await this._discordSubject(row.principalId),
            note: row.note || null,
            status: row.status,
            resolvedBy: row.resolvedBy || null,
            resolvedByName: row.resolvedBy ? await this._nameFor(row.resolvedBy) : null,
            resolvedAt: row.resolvedAt || null,
            createdAt: row.createdAt
        };
    }

    async _nameFor(principalId) {
        const identity = require('./identityService');
        const principal = await identity.getPrincipal(principalId);
        return principal?.displayName || String(principalId);
    }

    async _discordSubject(principalId) {
        const identity = require('./identityService');
        if (identity.isSnowflake(principalId)) return String(principalId);
        const linked = await db.get(
            `SELECT subject FROM auth_identities
             WHERE principalId = @principalId AND provider = 'discord' ORDER BY id LIMIT 1`,
            { principalId }
        ).catch(() => null);
        return linked?.subject || null;
    }

    /** The principal behind a Discord user, when they are an active operator. */
    async _operatorForDiscordUser(discordUserId) {
        const identity = require('./identityService');
        const subject = String(discordUserId ?? '');
        if (!subject) return null;
        const principalId = await identity.resolveExternal({ subject })
            || (identity.isSnowflake(subject) ? subject : null);
        if (!principalId) return null;
        const account = await identity.getAccount(principalId);
        return account && account.role === 'operator' && account.status === 'active' ? principalId : null;
    }

    async _operators() {
        const rows = await db.all(
            `SELECT principalId FROM app_accounts WHERE role = 'operator' AND status = 'active' ORDER BY createdAt, principalId`
        );
        return rows.map(row => row.principalId);
    }

    _buttons(id) {
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = discord;
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`approve_${BUTTON_TYPE}_${id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`decline_${BUTTON_TYPE}_${id}`).setLabel('Decline').setStyle(ButtonStyle.Danger)
        );
    }

    _embed(row, name, discordId) {
        const { EmbedBuilder } = discord;
        const who = discordId ? `<@${discordId}> (${name})` : name;
        return new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`🔑 ${name} is asking to join ${identityConfig.installationName}`)
            .setDescription(
                `${who} signed in to the portal but has no account here yet.`
                + (row.note ? `\n\n> ${String(row.note).replace(/\n+/g, ' ')}` : '')
                + '\n\nApprove grants a member account (their Discord history stays theirs). '
                + 'Decline tells them the host did not let them in this time.')
            .setFooter({ text: `Access request #${row.id} • also in your Goobster Inbox` });
    }

    /** Every active operator gets one Inbox item (and the DM echo with buttons). */
    async _notifyOperators(row, principal, gateway) {
        const inbox = require('./inboxService');
        const name = principal.displayName || row.principalId;
        const discordId = await this._discordSubject(row.principalId);
        const resolvedGateway = toGateway(gateway);
        const body = [
            `**${name}**${discordId ? ` (Discord id \`${discordId}\`)` : ''} signed in to the portal but has no account on this installation yet.`,
            row.note ? `\n> ${String(row.note).replace(/\n+/g, ' ')}\n` : '',
            'Approving grants a member account - everything Goobster already knows about them from Discord stays with them. '
            + 'You can also grant or decline from Host → Accounts.'
        ].filter(Boolean).join('\n');
        let notified = 0;
        for (const operatorId of await this._operators()) {
            try {
                const outcome = await inbox.deliver({
                    userId: operatorId,
                    kind: 'system',
                    title: `${name} is asking to join`,
                    body,
                    source: { type: SOURCE_TYPE, id: row.id },
                    link: '/host',
                    dedupeKey: `${SOURCE_TYPE}:${row.id}`,
                    discord: resolvedGateway
                        ? { gateway: resolvedGateway, payload: { embeds: [this._embed(row, name, discordId)], components: [this._buttons(row.id)] } }
                        : false
                });
                if (outcome.created) notified += 1;
            } catch (error) {
                logger.warn?.(`[access-requests] Could not notify operator ${operatorId}: ${error.message}`);
            }
        }
        if (notified === 0) logger.warn?.(`[access-requests] Request #${row.id} has no operator to notify.`);
        return notified;
    }

    /** The outcome, to the person: their Inbox first, Discord as the echo. */
    async _notifyRequester(row, outcome, gateway) {
        const inbox = require('./inboxService');
        const approved = outcome === 'approved';
        try {
            await inbox.deliver({
                userId: row.principalId,
                kind: 'system',
                title: approved ? `You're in - welcome to ${identityConfig.installationName}` : 'The host did not grant access this time',
                body: approved
                    ? 'The host approved your request. Reload the portal (or open it again) and you are in - everything Goobster already knew about you from Discord is still here.'
                    : 'The host declined your request to join this installation. You can ask again tomorrow, or talk to them directly.',
                source: { type: SOURCE_TYPE, id: row.id },
                link: approved ? '/' : null,
                dedupeKey: `${SOURCE_TYPE}:${row.id}:${outcome}`,
                discord: toGateway(gateway) ? { gateway: toGateway(gateway) } : false
            });
        } catch (error) {
            logger.warn?.(`[access-requests] Could not tell the requester about #${row.id}: ${error.message}`);
        }
    }
}

module.exports = new AccessRequestService();
module.exports.AccessRequestError = AccessRequestError;
module.exports.SOURCE_TYPE = SOURCE_TYPE;
