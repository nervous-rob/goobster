/**
 * Application identity (shared-instance Increment A).
 *
 * Every surface - web session, Discord interaction, automation - resolves
 * to one canonical principal. Legacy principals reuse the Discord snowflake
 * as their id, so nothing keyed on userId / dm:<userId> / USER:<userId> has
 * to move; native principals (created by the future invitation flow) get an
 * opaque `usr_<uuid>` id. The id format grants no authority: portal entry
 * needs an app_accounts row (the entitlement), and guild access still needs
 * a linked Discord identity plus a real membership check.
 *
 * Spec: documentation/shared_instance_product_spec.md (sections 4-5).
 * Shipped behaviour: documentation/identity.md.
 */

const crypto = require('node:crypto');
const db = require('../db');
const identityConfig = require('../config/identityConfig');
const { isAssistantId } = require('./assistantIdentity');

const SNOWFLAKE = /^\d{5,20}$/;
const NATIVE_ID = /^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENTITLEMENTS = ['invite', 'migration', 'bootstrap', 'open'];
const ROLES = ['member', 'operator'];
const SURFACES = ['web', 'discord', 'automation'];

/**
 * Where legacy owner ids live. `expr` extracts the bare id from the column
 * and `where` narrows the rows to the ones that carry one. The report and
 * the backfill walk the same list so their counts agree.
 */
const OWNER_COLUMNS = [
    { table: 'users', column: 'discordId', nameColumn: 'username' },
    { table: 'UserPreferences', column: 'userId' },
    { table: 'user_settings', column: 'userId' },
    { table: 'web_sessions', column: 'userId' },
    { table: 'web_conversations', column: 'userId' },
    { table: 'conversation_contexts', column: 'userId' },
    { table: 'followed_sources', column: 'userId' },
    { table: 'web_share_links', column: 'userId' },
    { table: 'web_applets', column: 'userId' },
    { table: 'web_generated_files', column: 'userId' },
    { table: 'memory_embeddings', column: 'authorId' },
    { table: 'memory_embeddings', column: 'guildId', expr: 'substr(guildId, 4)', where: "guildId LIKE 'dm:%'" },
    { table: 'guild_settings', column: 'guildId', expr: 'substr(guildId, 4)', where: "guildId LIKE 'dm:%'" },
    { table: 'kg_nodes', column: 'scopeKey', expr: 'substr(scopeKey, 6)', where: "scopeKey LIKE 'USER:%'" },
    { table: 'kg_artifacts', column: 'authorId' },
    { table: 'followups', column: 'userId' },
    { table: 'automations', column: 'userId' },
    { table: 'observatory_projects', column: 'userId' },
    { table: 'project_members', column: 'userId' },
    { table: 'parlor_personas', column: 'ownerId' },
    { table: 'parlor_members', column: 'userId' },
    { table: 'user_friends', column: 'ownerId' },
    { table: 'user_integrations', column: 'userId' },
    { table: 'attention_policies', column: 'userId' },
    { table: 'spitball_expeditions', column: 'userId' },
    { table: 'knowledge_transfers', column: 'userId' }
];

class IdentityError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'IdentityError';
        this.status = status;
        this.code = code;
    }
}

function nowUtc() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

class IdentityService {
    constructor() {
        this.IdentityError = IdentityError;
        this.ENTITLEMENTS = ENTITLEMENTS;
        this.ROLES = ROLES;
        this.SURFACES = SURFACES;
    }

    // --- Id shapes ---------------------------------------------------------

    /** @param {unknown} id */
    isSnowflake(id) {
        return SNOWFLAKE.test(String(id ?? ''));
    }

    /** @param {unknown} id */
    isNativeId(id) {
        return NATIVE_ID.test(String(id ?? ''));
    }

    /** Anything a principal id may look like today. */
    isPrincipalId(id) {
        return this.isSnowflake(id) || this.isNativeId(id);
    }

    /** A fresh, non-Discord-shaped principal id. */
    newNativeId() {
        return `usr_${crypto.randomUUID()}`;
    }

    // --- Principals --------------------------------------------------------

    /**
     * @param {string} id
     * @returns {Promise<{ id: string, displayName: string|null, createdAt: string, updatedAt: string }|null>}
     */
    async getPrincipal(id) {
        if (!this.isPrincipalId(id)) return null;
        return await db.get(
            'SELECT id, displayName, createdAt, updatedAt FROM principals WHERE id = @id',
            { id: String(id) }
        ) || null;
    }

    /**
     * Make sure a Discord user has a principal (id = the snowflake) and a
     * linked `discord` identity. Idempotent; never grants an account.
     * @param {{ discordId: string, displayName?: string|null }} params
     * @returns {Promise<{ id: string, created: boolean }>}
     */
    async ensureLegacyPrincipal({ discordId, displayName = null }) {
        const id = String(discordId ?? '');
        if (!this.isSnowflake(id)) {
            throw new IdentityError(400, 'BAD_PRINCIPAL', 'A Discord user id is required for a legacy principal.');
        }
        const name = displayName ? String(displayName).slice(0, 100) : null;
        return db.transaction(async (tx) => {
            const inserted = await tx.run(
                `INSERT INTO principals (id, displayName) VALUES (@id, @name)
                 ON CONFLICT (id) DO NOTHING`,
                { id, name }
            );
            if (!inserted.changes && name) {
                await tx.run(
                    `UPDATE principals SET displayName = @name, updatedAt = @now
                     WHERE id = @id AND (displayName IS NULL OR displayName = '')`,
                    { id, name, now: nowUtc() }
                );
            }
            await tx.run(
                `INSERT INTO auth_identities (principalId, provider, issuer, subject)
                 VALUES (@id, 'discord', '', @id)
                 ON CONFLICT (provider, issuer, subject) DO NOTHING`,
                { id }
            );
            return { id, created: inserted.changes > 0 };
        });
    }

    /**
     * Create a principal that is not tied to Discord. No account is
     * granted; the invitation flow (Increment B) does that explicitly.
     * @param {{ displayName?: string|null, id?: string }} [params]
     */
    async createNativePrincipal({ displayName = null, id = null } = {}) {
        const principalId = id || this.newNativeId();
        if (!this.isNativeId(principalId)) {
            throw new IdentityError(400, 'BAD_PRINCIPAL', 'Native principal ids look like usr_<uuid>.');
        }
        await db.run(
            'INSERT INTO principals (id, displayName) VALUES (@id, @name)',
            { id: principalId, name: displayName ? String(displayName).slice(0, 100) : null }
        );
        return { id: principalId, displayName, created: true };
    }

    // --- External identities -----------------------------------------------

    /**
     * Which principal owns an external identity, if any. Legacy Discord
     * users resolve to themselves once `ensureLegacyPrincipal` has run.
     * @param {{ provider?: string, issuer?: string, subject: string }} params
     * @returns {Promise<string|null>}
     */
    async resolveExternal({ provider = 'discord', issuer = '', subject }) {
        if (!subject) return null;
        const row = await db.get(
            `SELECT principalId FROM auth_identities
             WHERE provider = @provider AND issuer = @issuer AND subject = @subject`,
            { provider, issuer, subject: String(subject) }
        );
        return row?.principalId || null;
    }

    /**
     * Link an external identity to a principal. Refuses to move a subject
     * that already belongs to a different principal (no silent merges).
     * @param {{ principalId: string, provider: string, issuer?: string, subject: string }} params
     */
    async linkExternal({ principalId, provider, issuer = '', subject }) {
        if (!(await this.getPrincipal(principalId))) {
            throw new IdentityError(404, 'PRINCIPAL_NOT_FOUND', 'That principal does not exist.');
        }
        const owner = await this.resolveExternal({ provider, issuer, subject });
        if (owner && owner !== principalId) {
            throw new IdentityError(409, 'IDENTITY_CONFLICT',
                'That external identity already belongs to another account.');
        }
        if (owner) return { linked: false, principalId };
        await db.run(
            `INSERT INTO auth_identities (principalId, provider, issuer, subject)
             VALUES (@principalId, @provider, @issuer, @subject)`,
            { principalId, provider, issuer, subject: String(subject) }
        );
        return { linked: true, principalId };
    }

    /** @param {string} principalId */
    async listExternal(principalId) {
        return db.all(
            `SELECT provider, issuer, subject, createdAt FROM auth_identities
             WHERE principalId = @principalId ORDER BY id`,
            { principalId: String(principalId) }
        );
    }

    /**
     * Remove every identity of one provider from a native principal. Legacy
     * principals are refused: their id *is* the Discord subject, so the link
     * cannot be removed without changing who they are.
     * @param {{ principalId: string, provider: string }} params
     * @returns {Promise<number>} rows removed
     */
    async unlinkExternal({ principalId, provider }) {
        if (this.isSnowflake(principalId)) {
            throw new IdentityError(409, 'LEGACY_IDENTITY',
                'This account is identified by its Discord id, so Discord cannot be disconnected from it.');
        }
        const result = await db.run(
            'DELETE FROM auth_identities WHERE principalId = @principalId AND provider = @provider',
            { principalId: String(principalId), provider }
        );
        return result.changes;
    }

    // --- Accounts (the entitlement) ----------------------------------------

    /**
     * @param {string} principalId
     * @returns {Promise<{ principalId, loginName, status, role, entitlement, credentialVersion, sessionVersion, createdAt, updatedAt }|null>}
     */
    async getAccount(principalId) {
        if (!this.isPrincipalId(principalId)) return null;
        return await db.get(
            `SELECT principalId, loginName, status, role, entitlement, credentialVersion,
                    sessionVersion, createdAt, updatedAt
             FROM app_accounts WHERE principalId = @principalId`,
            { principalId: String(principalId) }
        ) || null;
    }

    /**
     * Grant an application account. Idempotent: an existing account is
     * returned untouched (roles are changed with `setAccountRole`, never
     * implicitly by a repeated grant).
     * @param {{ principalId: string, entitlement: 'invite'|'migration'|'bootstrap'|'open', role?: 'member'|'operator', loginName?: string|null }} params
     */
    async grantAccount({ principalId, entitlement, role = 'member', loginName = null }) {
        if (!ENTITLEMENTS.includes(entitlement)) {
            throw new IdentityError(400, 'BAD_ENTITLEMENT', `entitlement must be one of ${ENTITLEMENTS.join(', ')}.`);
        }
        if (!ROLES.includes(role)) {
            throw new IdentityError(400, 'BAD_ROLE', `role must be one of ${ROLES.join(', ')}.`);
        }
        if (!(await this.getPrincipal(principalId))) {
            throw new IdentityError(404, 'PRINCIPAL_NOT_FOUND', 'That principal does not exist.');
        }
        return db.transaction(async tx => {
            await require('./usageBudgetService').assertAccountCreation(tx, principalId);
            const existing = await tx.get('SELECT * FROM app_accounts WHERE principalId = @principalId', { principalId });
            if (existing) return { account: existing, created: false };
            await tx.run(
                `INSERT INTO app_accounts (principalId, loginName, role, entitlement)
                 VALUES (@principalId, @loginName, @role, @entitlement)`,
                { principalId, loginName: loginName ? String(loginName).toLowerCase() : null, role, entitlement }
            );
            return { account: await this.getAccount(principalId), created: true };
        });
    }

    /** @param {string} principalId @param {'active'|'disabled'} status */
    async setAccountStatus(principalId, status) {
        if (!['active', 'disabled'].includes(status)) {
            throw new IdentityError(400, 'BAD_STATUS', 'status must be active or disabled.');
        }
        const result = await db.run(
            `UPDATE app_accounts SET status = @status, sessionVersion = sessionVersion + 1, updatedAt = @now
             WHERE principalId = @principalId`,
            { principalId, status, now: nowUtc() }
        );
        if (!result.changes) {
            throw new IdentityError(404, 'ACCOUNT_NOT_FOUND', 'That principal has no application account.');
        }
        if (status === 'disabled') {
            // A disabled account cannot keep using sessions it already holds.
            await db.run('DELETE FROM web_sessions WHERE userId = @principalId', { principalId });
        }
        return this.getAccount(principalId);
    }

    /** @param {string} principalId @param {'member'|'operator'} role */
    async setAccountRole(principalId, role) {
        if (!ROLES.includes(role)) {
            throw new IdentityError(400, 'BAD_ROLE', `role must be one of ${ROLES.join(', ')}.`);
        }
        const result = await db.run(
            'UPDATE app_accounts SET role = @role, updatedAt = @now WHERE principalId = @principalId',
            { principalId, role, now: nowUtc() }
        );
        if (!result.changes) {
            throw new IdentityError(404, 'ACCOUNT_NOT_FOUND', 'That principal has no application account.');
        }
        return this.getAccount(principalId);
    }

    /** Active account present? (The entitlement check behind `requireAccount`.) */
    async isEntitled(principalId) {
        const account = await this.getAccount(principalId);
        return Boolean(account && account.status === 'active');
    }

    /**
     * Operator view: every application account with its principal's display
     * name, linked providers, and whether native credentials exist. Safe
     * metadata only - no hashes, no tokens.
     */
    async listAccounts() {
        const rows = await db.all(
            `SELECT a.principalId, a.loginName, a.status, a.role, a.entitlement, a.createdAt, a.updatedAt,
                    p.displayName,
                    (SELECT COUNT(*) FROM password_credentials c WHERE c.principalId = a.principalId) AS credentialCount,
                    (SELECT COUNT(*) FROM auth_identities i WHERE i.principalId = a.principalId AND i.provider = 'discord') AS discordCount,
                    e.address AS emailAddress, e.verifiedAt AS emailVerifiedAt
             FROM app_accounts a
             JOIN principals p ON p.id = a.principalId
             LEFT JOIN account_emails e ON e.principalId = a.principalId
             ORDER BY a.createdAt, a.principalId`
        );
        return rows.map(row => ({
            principalId: row.principalId,
            displayName: row.displayName || null,
            loginName: row.loginName || null,
            status: row.status,
            role: row.role,
            entitlement: row.entitlement,
            hasPassword: Number(row.credentialCount) > 0,
            discordLinked: this.isSnowflake(row.principalId) || Number(row.discordCount) > 0,
            email: row.emailAddress ? { address: row.emailAddress, verified: Boolean(row.emailVerifiedAt) } : null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt
        }));
    }

    /**
     * The public face of one member of this installation, or null when the
     * id does not name an active account. Name and id only - never the
     * login name, email, role, or providers (spec §6: people search never
     * enumerates private account details).
     * @param {string} principalId
     * @returns {Promise<{ id: string, name: string }|null>}
     */
    async describeMember(principalId) {
        if (!this.isPrincipalId(principalId)) return null;
        const row = await db.get(
            `SELECT p.id, p.displayName, a.loginName
             FROM app_accounts a JOIN principals p ON p.id = a.principalId
             WHERE a.principalId = @id AND a.status = 'active'`,
            { id: String(principalId) }
        );
        if (!row) return null;
        return { id: row.id, name: row.displayName || row.loginName || `Member ${row.id.slice(-6)}` };
    }

    /**
     * Native people discovery (shared-instance Increment C): members of
     * this installation whose display name or login name starts with the
     * query. Only active accounts are eligible, the caller must hold one,
     * a query of at least two characters is required (no browsing the
     * whole roster), and the result carries name and id only.
     *
     * @param {{ actorId: string, q: string, exclude?: string[], limit?: number }} params
     * @returns {Promise<Array<{ id: string, name: string, source: 'member' }>>}
     */
    async searchPeople({ actorId, q, exclude = [], limit = 20 }) {
        const query = String(q ?? '').trim().toLowerCase();
        if (query.length < 2) return [];
        const caller = await this.getAccount(actorId);
        if (!caller || caller.status !== 'active') return [];
        const bounded = Math.max(1, Math.min(Number(limit) || 20, 50));
        const escaped = query.replace(/[\\%_]/g, ch => `\\${ch}`);
        const rows = await db.all(
            `SELECT p.id, p.displayName, a.loginName
             FROM app_accounts a JOIN principals p ON p.id = a.principalId
             WHERE a.status = 'active'
               AND (LOWER(COALESCE(p.displayName, '')) LIKE @prefix ESCAPE '\\'
                    OR LOWER(COALESCE(a.loginName, '')) LIKE @prefix ESCAPE '\\')
             ORDER BY COALESCE(p.displayName, a.loginName) ASC, p.id ASC
             LIMIT ${bounded + exclude.length + 1}`,
            { prefix: `${escaped}%` }
        );
        const blocked = new Set([String(actorId), ...exclude.map(String)]);
        return rows
            .filter(row => !blocked.has(String(row.id)))
            .slice(0, bounded)
            .map(row => ({
                id: row.id,
                name: row.displayName || row.loginName || `Member ${String(row.id).slice(-6)}`,
                source: 'member'
            }));
    }

    /**
     * One-time operator bootstrap from `identity.operators` (config.json) or
     * `GOOBSTER_IDENTITY_OPERATORS`. Idempotent: existing accounts are
     * promoted to operator, new ones are created with the `bootstrap`
     * entitlement. Never runs implicitly on startup.
     * @param {string[]} [ids]
     */
    async bootstrapOperators(ids = identityConfig.operators) {
        const outcome = { granted: [], promoted: [], unchanged: [], rejected: [] };
        for (const raw of ids || []) {
            const id = String(raw).trim();
            if (!this.isSnowflake(id)) { outcome.rejected.push(id); continue; }
            await this.ensureLegacyPrincipal({ discordId: id });
            const existing = await this.getAccount(id);
            if (!existing) {
                await this.grantAccount({ principalId: id, entitlement: 'bootstrap', role: 'operator' });
                outcome.granted.push(id);
            } else if (existing.role !== 'operator') {
                await this.setAccountRole(id, 'operator');
                outcome.promoted.push(id);
            } else {
                outcome.unchanged.push(id);
            }
        }
        return outcome;
    }

    // --- Actor context -----------------------------------------------------

    /**
     * The request/job context every service call should carry. The actor
     * is never taken from a client-supplied field; callers pass the id the
     * session or gateway already authenticated.
     *
     * @param {{ principalId: string, surface: 'web'|'discord'|'automation', sessionId?: string|null, externalActor?: { provider: string, subject: string }|null, requireAccount?: boolean }} params
     * @returns {Promise<{ actorId: string, installationId: string, surface: string, sessionId: string|null, externalActor: { provider: string, subject: string }|null, account: { role: string, status: string, entitlement: string }|null }>}
     */
    async resolveActor({ principalId, surface, sessionId = null, externalActor = null, requireAccount = identityConfig.requireAccount }) {
        const actorId = String(principalId ?? '');
        if (!this.isPrincipalId(actorId)) {
            throw new IdentityError(400, 'BAD_PRINCIPAL', 'Unknown principal id shape.');
        }
        if (!SURFACES.includes(surface)) {
            throw new IdentityError(400, 'BAD_SURFACE', `surface must be one of ${SURFACES.join(', ')}.`);
        }
        const account = await this.getAccount(actorId);
        if (account && account.status !== 'active') {
            throw new IdentityError(403, 'ACCOUNT_DISABLED', 'This account has been disabled by the host.');
        }
        if (requireAccount && !account) {
            throw new IdentityError(403, 'NO_ACCOUNT',
                'You are signed in, but this installation has not granted you an account yet.');
        }
        let external = externalActor;
        if (!external) {
            if (this.isSnowflake(actorId)) {
                // Legacy compatibility: the principal id IS the Discord subject.
                external = { provider: 'discord', subject: actorId };
            } else {
                const linked = await db.get(
                    `SELECT subject FROM auth_identities
                     WHERE principalId = @actorId AND provider = 'discord' ORDER BY id LIMIT 1`,
                    { actorId }
                );
                external = linked ? { provider: 'discord', subject: linked.subject } : null;
            }
        }
        return {
            actorId,
            installationId: identityConfig.installationId,
            surface,
            sessionId: sessionId || null,
            externalActor: external,
            account: account
                ? { role: account.role, status: account.status, entitlement: account.entitlement, sessionVersion: Number(account.sessionVersion) }
                : null
        };
    }

    /**
     * Synchronous context for bot ingress: the Discord user id is both the
     * legacy principal id and the retained external subject. No database
     * work happens on the message path.
     * @param {string} discordUserId
     */
    discordActor(discordUserId) {
        const subject = String(discordUserId ?? '');
        if (!this.isSnowflake(subject)) {
            throw new IdentityError(400, 'BAD_PRINCIPAL', 'A Discord user id is required.');
        }
        return {
            actorId: subject,
            installationId: identityConfig.installationId,
            surface: 'discord',
            sessionId: null,
            externalActor: { provider: 'discord', subject },
            account: null
        };
    }

    /**
     * Discord subject to use when calling Discord APIs on behalf of an actor
     * (mentions, DMs, guild checks). Null for a native principal with no
     * linked Discord identity - callers must degrade, not invent an id.
     * @param {{ actorId: string, externalActor?: { provider: string, subject: string }|null }} actor
     */
    discordSubjectFor(actor) {
        if (actor?.externalActor?.provider === 'discord') return actor.externalActor.subject;
        return this.isSnowflake(actor?.actorId) ? actor.actorId : null;
    }

    // --- Legacy migration --------------------------------------------------

    /**
     * Distinct owner ids across every identity-bearing table, with the
     * display name when the users table knows one.
     * @returns {Promise<{ owners: Map<string, { rows: number, tables: Set<string>, name: string|null }>, tables: Array<{ table: string, column: string, rows: number, owners: number }> }>}
     */
    async _inventory() {
        const owners = new Map();
        const tables = [];
        for (const spec of OWNER_COLUMNS) {
            const expr = spec.expr || spec.column;
            const where = spec.where ? `WHERE ${spec.where}` : `WHERE ${spec.column} IS NOT NULL AND ${spec.column} != ''`;
            const nameSelect = spec.nameColumn ? `, MAX(${spec.nameColumn}) AS name` : ', NULL AS name';
            let rows;
            try {
                rows = await db.all(
                    `SELECT ${expr} AS ownerId, COUNT(*) AS rowCount${nameSelect}
                     FROM ${spec.table} ${where} GROUP BY ${expr}`
                );
            } catch (error) {
                // A table missing from an older database is a report line, not a crash.
                tables.push({ table: spec.table, column: spec.column, rows: 0, owners: 0, error: error.message });
                continue;
            }
            let total = 0;
            for (const row of rows) {
                const id = String(row.ownerId ?? '');
                if (!id) continue;
                total += Number(row.rowCount) || 0;
                const entry = owners.get(id) || { rows: 0, tables: new Set(), name: null };
                entry.rows += Number(row.rowCount) || 0;
                entry.tables.add(`${spec.table}.${spec.column}`);
                if (row.name && !entry.name) entry.name = String(row.name);
                owners.set(id, entry);
            }
            tables.push({ table: spec.table, column: spec.column, rows: total, owners: rows.length });
        }
        return { owners, tables };
    }

    /**
     * Read-only migration report: who owns data, which of them already have
     * a principal or an account, and which ids cannot be resolved.
     */
    async migrationReport() {
        const { owners, tables } = await this._inventory();
        const principalRows = await db.all('SELECT id FROM principals');
        const principals = new Set(principalRows.map(r => String(r.id)));
        const accountRows = await db.all('SELECT principalId, status, role FROM app_accounts');
        const accounts = new Map(accountRows.map(r => [String(r.principalId), r]));

        const summary = { total: owners.size, snowflake: 0, native: 0, unresolved: 0, withPrincipal: 0, withAccount: 0 };
        const unresolved = [];
        for (const [id, entry] of owners) {
            // The assistant's own transcript rows are not a person's data.
            if (isAssistantId(id)) continue;
            if (this.isSnowflake(id)) summary.snowflake += 1;
            else if (this.isNativeId(id)) summary.native += 1;
            else {
                summary.unresolved += 1;
                if (unresolved.length < 25) unresolved.push({ id, rows: entry.rows, tables: [...entry.tables] });
            }
            if (principals.has(id)) summary.withPrincipal += 1;
            if (accounts.has(id)) summary.withAccount += 1;
        }
        return {
            generatedAt: nowUtc(),
            installationId: identityConfig.installationId,
            requireAccount: identityConfig.requireAccount,
            tables,
            owners: summary,
            unresolved,
            principals: { total: principals.size },
            accounts: {
                total: accounts.size,
                active: accountRows.filter(r => r.status === 'active').length,
                disabled: accountRows.filter(r => r.status === 'disabled').length,
                operators: accountRows.filter(r => r.role === 'operator').length
            }
        };
    }

    /**
     * Create a principal (plus its `discord` identity) for every
     * snowflake-shaped owner found in the inventory. Idempotent and
     * deterministic - a second run creates nothing. Never grants accounts.
     */
    async backfillPrincipals() {
        const { owners } = await this._inventory();
        const outcome = { scanned: owners.size, created: 0, existing: 0, skipped: 0 };
        for (const [id, entry] of owners) {
            if (!this.isSnowflake(id)) { outcome.skipped += 1; continue; }
            const { created } = await this.ensureLegacyPrincipal({ discordId: id, displayName: entry.name });
            if (created) outcome.created += 1; else outcome.existing += 1;
        }
        return outcome;
    }

    // --- Erasure -----------------------------------------------------------

    /**
     * Remove a principal and everything hanging off it. Called from
     * privacyService.forgetUser inside its transaction.
     * @param {string} principalId
     * @param {{ run: Function }} [tx] transaction handle (defaults to db)
     */
    async erasePrincipal(principalId, tx = db) {
        const id = String(principalId);
        const counts = {};
        counts.passwordCredentials = (await tx.run(
            'DELETE FROM password_credentials WHERE principalId = @id', { id }
        )).changes;
        counts.recoveryTokens = (await tx.run(
            'DELETE FROM recovery_tokens WHERE principalId = @id OR issuedBy = @id', { id }
        )).changes;
        counts.oauthLinkStates = (await tx.run(
            'DELETE FROM oauth_link_states WHERE principalId = @id', { id }
        )).changes;
        // The address and its verification links; and any open sign-up
        // parked under that address (it carries no principal of its own).
        const email = await tx.get('SELECT normalized FROM account_emails WHERE principalId = @id', { id });
        if (email) {
            await tx.run('DELETE FROM pending_registrations WHERE emailNormalized = @normalized', { normalized: email.normalized });
        }
        counts.emailTokens = (await tx.run(
            'DELETE FROM email_tokens WHERE principalId = @id', { id }
        )).changes;
        counts.emails = (await tx.run(
            'DELETE FROM account_emails WHERE principalId = @id', { id }
        )).changes;
        // Invitations the person issued go with them; ones they redeemed
        // stay as the operator's audit trail minus the link to the person.
        counts.invitesIssued = (await tx.run(
            'DELETE FROM account_invites WHERE issuedBy = @id', { id }
        )).changes;
        await tx.run(
            'UPDATE account_invites SET consumedBy = NULL WHERE consumedBy = @id', { id }
        );
        counts.authIdentities = (await tx.run(
            'DELETE FROM auth_identities WHERE principalId = @id', { id }
        )).changes;
        counts.accounts = (await tx.run(
            'DELETE FROM app_accounts WHERE principalId = @id', { id }
        )).changes;
        counts.principals = (await tx.run(
            'DELETE FROM principals WHERE id = @id', { id }
        )).changes;
        return counts;
    }
}

module.exports = new IdentityService();
module.exports.IdentityError = IdentityError;
module.exports.OWNER_COLUMNS = OWNER_COLUMNS;
