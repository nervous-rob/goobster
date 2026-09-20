/**
 * Native authentication for the shared-instance release (Increment B).
 *
 * Everything a person needs to use Goobster without Discord: operator-issued
 * single-use invitations, username + password registration and login,
 * operator-issued recovery links, credential enrollment for existing Discord
 * users, and the account-side rules for connecting/disconnecting Discord.
 * Spec: documentation/shared_instance_product_spec.md (§5, §6);
 * reference: documentation/identity.md.
 *
 * Design points
 * - Tokens (invites, recovery, OAuth link state) are stored hashed; the raw
 *   value is returned exactly once to the caller who created it.
 * - Redemption is one conditional UPDATE, so concurrent attempts have
 *   exactly one winner on both SQLite and Postgres.
 * - Login returns a neutral error for a bad name or password and is
 *   throttled per login name and per client address through the shared
 *   `web_rate_events` window - the same budget every api replica sees.
 * - Everything except Discord link/unlink sits behind the
 *   `identity.nativeLogin` release gate.
 */

const crypto = require('node:crypto');
const db = require('../db');
const identityConfig = require('../config/identityConfig');
const identityService = require('./identityService');
const { IdentityError } = identityService;
const { hashPassword, verifyPassword, needsRehash } = require('../utils/passwordHashing');
const { consumeWindow } = require('../utils/slidingWindowLimit');

const LOGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const PASSWORD_MAX_LENGTH = 256;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_NAME = 10;
const LOGIN_MAX_PER_ADDRESS = 40;
const REGISTER_MAX_PER_ADDRESS = 10;
const RECOVERY_MAX_PER_ADDRESS = 10;

// Long passwords people still pick. Composition rules are deliberately
// absent (OWASP); a length floor plus this list plus "not your login name"
// is the policy. Breach-corpus checks need the network and are not done.
const DENY_LIST = new Set([
    'password12345678', 'password123456789', 'passwordpassword', 'qwertyuiopasdfgh',
    'qwertyuiopasdfghjkl', 'correcthorsebatterystaple', 'letmeinletmeinletmein',
    'iloveyouiloveyou', 'administratoradmin', 'welcome123456789', 'changemechangeme',
    'goobstergoobster', 'discorddiscorddiscord', '123456789012345', '1234567890123456',
    'abcdefghijklmnop', 'abcdefghijklmnopqrstuvwxyz', 'thisismypassword', 'mypasswordisstrong',
    'passw0rdpassw0rd', 'trustno1trustno1', 'openthedooropen'
]);

function nowUtc() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function utcIn(ms) {
    return new Date(Date.now() + ms).toISOString().slice(0, 19).replace('T', ' ');
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function newToken() {
    return crypto.randomBytes(32).toString('base64url');
}

class NativeAuthService {
    get enabled() {
        return identityConfig.nativeLogin;
    }

    /** Throw unless the release gate is open. */
    assertEnabled() {
        if (!this.enabled) {
            throw new IdentityError(503, 'NATIVE_LOGIN_DISABLED',
                'Username and password sign-in is not enabled on this installation.');
        }
    }

    // --- Validation ----------------------------------------------------------

    /**
     * Normalise and validate a login name. Lower-case, 3-32 chars from
     * [a-z0-9._-], and never shaped like a principal id.
     * @param {string} raw
     * @returns {string}
     */
    normalizeLoginName(raw) {
        const name = String(raw ?? '').trim().toLowerCase();
        if (!LOGIN_NAME_RE.test(name)) {
            throw new IdentityError(400, 'BAD_LOGIN_NAME',
                'Login names are 3-32 characters: letters, digits, dots, dashes, or underscores, starting with a letter or digit.');
        }
        if (/^\d+$/.test(name) || name.startsWith('usr_')) {
            throw new IdentityError(400, 'BAD_LOGIN_NAME', 'That login name looks like an internal id; pick another.');
        }
        return name;
    }

    /**
     * @param {string} password
     * @param {{ loginName?: string|null }} [ctx]
     */
    validatePassword(password, { loginName = null } = {}) {
        const value = String(password ?? '');
        const min = identityConfig.passwordMinLength;
        if (value.length < min) {
            throw new IdentityError(400, 'WEAK_PASSWORD', `Passwords need at least ${min} characters - a phrase works well.`);
        }
        if (value.length > PASSWORD_MAX_LENGTH) {
            throw new IdentityError(400, 'WEAK_PASSWORD', `Passwords are limited to ${PASSWORD_MAX_LENGTH} characters.`);
        }
        const lowered = value.toLowerCase();
        if (DENY_LIST.has(lowered.replace(/\s+/g, '')) || /^(.)\1+$/.test(value)) {
            throw new IdentityError(400, 'WEAK_PASSWORD', 'That password is too common; choose something less guessable.');
        }
        if (loginName && lowered.includes(String(loginName).toLowerCase())) {
            throw new IdentityError(400, 'WEAK_PASSWORD', 'Your password must not contain your login name.');
        }
    }

    // --- Invitations ---------------------------------------------------------

    /**
     * Issue a single-use invitation. The raw token is returned once.
     * @param {{ issuedBy: string, role?: 'member'|'operator', ttlHours?: number, note?: string|null }} params
     */
    async createInvite({ issuedBy, role = 'member', ttlHours = identityConfig.inviteTtlHours, note = null }) {
        this.assertEnabled();
        if (!['member', 'operator'].includes(role)) {
            throw new IdentityError(400, 'BAD_ROLE', 'role must be member or operator.');
        }
        const hours = Math.min(24 * 30, Math.max(1, Number(ttlHours) || identityConfig.inviteTtlHours));
        const token = newToken();
        const id = await db.insert(
            `INSERT INTO account_invites (tokenHash, issuedBy, role, note, expiresAt)
             VALUES (@tokenHash, @issuedBy, @role, @note, @expiresAt)`,
            {
                tokenHash: sha256(token),
                issuedBy: String(issuedBy),
                role,
                note: note ? String(note).slice(0, 200) : null,
                expiresAt: utcIn(hours * 60 * 60 * 1000)
            }
        );
        const row = await db.get('SELECT * FROM account_invites WHERE id = @id', { id });
        return { token, invite: this._inviteView(row) };
    }

    _inviteView(row) {
        const expired = Date.parse(`${row.expiresAt.replace(' ', 'T')}Z`) <= Date.now();
        let state = 'open';
        if (row.revokedAt) state = 'revoked';
        else if (row.consumedAt) state = 'redeemed';
        else if (expired) state = 'expired';
        return {
            id: Number(row.id),
            role: row.role,
            note: row.note || null,
            issuedBy: row.issuedBy,
            expiresAt: row.expiresAt,
            createdAt: row.createdAt,
            consumedAt: row.consumedAt || null,
            consumedBy: row.consumedBy || null,
            revokedAt: row.revokedAt || null,
            state
        };
    }

    /** Every invitation, newest first (operator view; hashes never leave the row). */
    async listInvites() {
        const rows = await db.all('SELECT * FROM account_invites ORDER BY id DESC LIMIT 200');
        return rows.map(row => this._inviteView(row));
    }

    /** @param {number} id */
    async revokeInvite(id) {
        const result = await db.run(
            `UPDATE account_invites SET revokedAt = @now
             WHERE id = @id AND revokedAt IS NULL AND consumedAt IS NULL`,
            { id: Number(id), now: nowUtc() }
        );
        if (!result.changes) {
            throw new IdentityError(404, 'INVITE_NOT_FOUND', 'No open invitation with that id.');
        }
        return this._inviteView(await db.get('SELECT * FROM account_invites WHERE id = @id', { id: Number(id) }));
    }

    /**
     * What the invitation page shows before the person commits: role and
     * expiry only. Does not consume.
     * @param {string} token
     */
    async inspectInvite(token) {
        this.assertEnabled();
        const row = await db.get(
            'SELECT * FROM account_invites WHERE tokenHash = @tokenHash',
            { tokenHash: sha256(String(token || '')) }
        );
        const view = row ? this._inviteView(row) : null;
        if (!view || view.state !== 'open') {
            throw new IdentityError(404, 'INVITE_INVALID', 'This invitation link is not valid - it may have been used, revoked, or expired.');
        }
        return {
            role: view.role,
            expiresAt: view.expiresAt,
            installation: { id: identityConfig.installationId, name: identityConfig.installationName },
            passwordMinLength: identityConfig.passwordMinLength
        };
    }

    /**
     * Redeem an invitation: create a native principal, grant the account,
     * store the credential. Atomic - a race for the same token admits one
     * person; a taken login name leaves the invitation open.
     * @param {{ token: string, loginName: string, password: string, displayName?: string|null, address?: string|null }} params
     * @returns {Promise<{ principalId: string, loginName: string, displayName: string|null, role: string }>}
     */
    async register({ token, loginName, password, displayName = null, address = null }) {
        this.assertEnabled();
        await this._throttle('native_register_addr', address, REGISTER_MAX_PER_ADDRESS, 60 * 60 * 1000);
        const name = this.normalizeLoginName(loginName);
        this.validatePassword(password, { loginName: name });
        if (await this.findAccountByLoginName(name)) {
            throw new IdentityError(409, 'LOGIN_NAME_TAKEN', 'That login name is already in use.');
        }
        const credential = await hashPassword(password, { logN: identityConfig.passwordCostLog2 });
        const display = displayName ? String(displayName).trim().slice(0, 100) : name;
        const principalId = identityService.newNativeId();

        const result = await db.transaction(async (tx) => {
            const claimed = await tx.run(
                `UPDATE account_invites SET consumedAt = @now, consumedBy = @principalId
                 WHERE tokenHash = @tokenHash AND consumedAt IS NULL AND revokedAt IS NULL AND expiresAt > @now`,
                { tokenHash: sha256(String(token || '')), now: nowUtc(), principalId }
            );
            if (claimed.changes !== 1) {
                throw new IdentityError(404, 'INVITE_INVALID', 'This invitation link is not valid - it may have been used, revoked, or expired.');
            }
            const invite = await tx.get(
                'SELECT role FROM account_invites WHERE tokenHash = @tokenHash',
                { tokenHash: sha256(String(token || '')) }
            );
            await tx.run(
                'INSERT INTO principals (id, displayName) VALUES (@id, @name)',
                { id: principalId, name: display }
            );
            try {
                await tx.run(
                    `INSERT INTO app_accounts (principalId, loginName, role, entitlement)
                     VALUES (@principalId, @loginName, @role, 'invite')`,
                    { principalId, loginName: name, role: invite.role }
                );
            } catch (error) {
                if (/unique|duplicate/i.test(String(error?.message))) {
                    throw new IdentityError(409, 'LOGIN_NAME_TAKEN', 'That login name is already in use.');
                }
                throw error;
            }
            await tx.run(
                `INSERT INTO password_credentials (principalId, hash, paramsJson) VALUES (@principalId, @hash, @params)`,
                { principalId, hash: credential.hash, params: JSON.stringify(credential.params) }
            );
            return { principalId, loginName: name, displayName: display, role: invite.role };
        });
        return result;
    }

    // --- Credentials ---------------------------------------------------------

    /** @param {string} loginName */
    async findAccountByLoginName(loginName) {
        const name = String(loginName ?? '').trim().toLowerCase();
        if (!name) return null;
        return await db.get(
            'SELECT principalId, loginName, status, role, sessionVersion FROM app_accounts WHERE loginName = @name',
            { name }
        ) || null;
    }

    /** @param {string} principalId */
    async hasPassword(principalId) {
        const row = await db.get(
            'SELECT 1 AS present FROM password_credentials WHERE principalId = @principalId',
            { principalId: String(principalId) }
        );
        return Boolean(row);
    }

    _hash(password) {
        return hashPassword(password, { logN: identityConfig.passwordCostLog2 });
    }

    /**
     * Persist an already-computed credential. Hashing happens *before* the
     * caller opens a transaction: on SQLite a transaction holds the write
     * lock for its whole duration, and scrypt takes ~100 ms.
     */
    async _storePassword(principalId, credential, tx = db) {
        await tx.run(
            `INSERT INTO password_credentials (principalId, hash, paramsJson, updatedAt)
             VALUES (@principalId, @hash, @params, @now)
             ON CONFLICT(principalId) DO UPDATE SET hash = excluded.hash, paramsJson = excluded.paramsJson, updatedAt = excluded.updatedAt`,
            { principalId, hash: credential.hash, params: JSON.stringify(credential.params), now: nowUtc() }
        );
    }

    /**
     * Check a password against a principal's stored credential. Re-hashes
     * transparently when the configured cost has gone up.
     * @param {string} principalId
     * @param {string} password
     */
    async checkPassword(principalId, password) {
        const row = await db.get(
            'SELECT hash FROM password_credentials WHERE principalId = @principalId',
            { principalId: String(principalId) }
        );
        if (!row) return false;
        const ok = await verifyPassword(password, row.hash);
        if (ok && needsRehash(row.hash, { logN: identityConfig.passwordCostLog2 })) {
            try { await this._storePassword(principalId, await this._hash(password)); } catch { /* best effort */ }
        }
        return ok;
    }

    /**
     * Set or change native credentials on an existing principal (the
     * enrollment path for Discord users, and the change-password path).
     * The route decides *proof*: a current password when one exists,
     * otherwise a recent authentication. This method enforces only the
     * account-side invariants.
     * @param {{ principalId: string, loginName?: string|null, password: string, currentPassword?: string|null }} params
     */
    async setCredentials({ principalId, loginName = null, password, currentPassword = null }) {
        this.assertEnabled();
        const principal = await identityService.getPrincipal(principalId);
        if (!principal) throw new IdentityError(404, 'PRINCIPAL_NOT_FOUND', 'That principal does not exist.');
        const account = await identityService.getAccount(principalId);
        if (!account) {
            throw new IdentityError(403, 'NO_ACCOUNT',
                'The host has not granted this account yet, so it cannot have a password.');
        }
        if (account.status !== 'active') {
            throw new IdentityError(403, 'ACCOUNT_DISABLED', 'This account has been disabled by the host.');
        }
        if (await this.hasPassword(principalId)) {
            if (!currentPassword || !(await this.checkPassword(principalId, currentPassword))) {
                throw new IdentityError(403, 'BAD_CREDENTIALS', 'Your current password is incorrect.');
            }
        }
        let name = account.loginName;
        if (loginName != null && loginName !== '') {
            name = this.normalizeLoginName(loginName);
        }
        if (!name) {
            throw new IdentityError(400, 'LOGIN_NAME_REQUIRED', 'Choose a login name to go with your password.');
        }
        this.validatePassword(password, { loginName: name });
        if (name !== account.loginName) {
            const taken = await this.findAccountByLoginName(name);
            if (taken && taken.principalId !== principalId) {
                throw new IdentityError(409, 'LOGIN_NAME_TAKEN', 'That login name is already in use.');
            }
        }
        const credential = await this._hash(password);
        await db.transaction(async (tx) => {
            if (name !== account.loginName) {
                try {
                    await tx.run(
                        'UPDATE app_accounts SET loginName = @name, updatedAt = @now WHERE principalId = @principalId',
                        { name, now: nowUtc(), principalId }
                    );
                } catch (error) {
                    if (/unique|duplicate/i.test(String(error?.message))) {
                        throw new IdentityError(409, 'LOGIN_NAME_TAKEN', 'That login name is already in use.');
                    }
                    throw error;
                }
            }
            await this._storePassword(principalId, credential, tx);
            await tx.run(
                'UPDATE app_accounts SET credentialVersion = credentialVersion + 1, updatedAt = @now WHERE principalId = @principalId',
                { now: nowUtc(), principalId }
            );
        });
        return { principalId, loginName: name };
    }

    // --- Login ---------------------------------------------------------------

    async _throttle(scope, subject, max, windowMs) {
        if (!subject) return;
        const admitted = await consumeWindow({ scope, subject: String(subject), max, windowMs });
        if (!admitted) {
            throw new IdentityError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Wait a few minutes and try again.');
        }
    }

    /**
     * Verify a login name + password. Neutral error for unknown names and
     * wrong passwords alike; the disabled state is only revealed after a
     * correct password. Throttled per name and per address.
     * @param {{ loginName: string, password: string, address?: string|null }} params
     * @returns {Promise<{ principalId: string, loginName: string, displayName: string|null }>}
     */
    async login({ loginName, password, address = null }) {
        this.assertEnabled();
        const name = String(loginName ?? '').trim().toLowerCase();
        const bad = () => new IdentityError(401, 'BAD_CREDENTIALS', 'Login name or password is incorrect.');
        if (!name || !password) throw bad();
        await this._throttle('native_login_addr', address, LOGIN_MAX_PER_ADDRESS, LOGIN_WINDOW_MS);
        await this._throttle('native_login_name', name, LOGIN_MAX_PER_NAME, LOGIN_WINDOW_MS);

        const account = await this.findAccountByLoginName(name);
        if (!account) {
            // Spend comparable time so a missing name is not distinguishable
            // by latency from a wrong password.
            await verifyPassword(password, DUMMY_HASH);
            throw bad();
        }
        if (!(await this.checkPassword(account.principalId, password))) throw bad();
        if (account.status !== 'active') {
            throw new IdentityError(403, 'ACCOUNT_DISABLED', 'This account has been disabled by the host.');
        }
        // A successful login clears the name's window so the person is not
        // locked out by their own earlier typos.
        await db.run(
            `DELETE FROM web_rate_events WHERE scope = 'native_login_name' AND subject = @name`, { name }
        );
        const principal = await identityService.getPrincipal(account.principalId);
        return { principalId: account.principalId, loginName: account.loginName, displayName: principal?.displayName || account.loginName };
    }

    // --- Recovery ------------------------------------------------------------

    /**
     * Operator-issued password reset. Audited (issuedBy), single-use,
     * short-lived; the raw token is returned once for the operator to hand
     * over out of band.
     * @param {{ principalId: string, issuedBy: string }} params
     */
    async issueRecovery({ principalId, issuedBy }) {
        this.assertEnabled();
        const account = await identityService.getAccount(principalId);
        if (!account) throw new IdentityError(404, 'ACCOUNT_NOT_FOUND', 'That principal has no application account.');
        const token = newToken();
        const expiresAt = utcIn(identityConfig.recoveryTtlMinutes * 60 * 1000);
        await db.run(
            `INSERT INTO recovery_tokens (tokenHash, principalId, purpose, issuedBy, expiresAt)
             VALUES (@tokenHash, @principalId, 'password_reset', @issuedBy, @expiresAt)`,
            { tokenHash: sha256(token), principalId: String(principalId), issuedBy: String(issuedBy), expiresAt }
        );
        return { token, expiresAt, principalId: String(principalId), loginName: account.loginName };
    }

    /**
     * Finish a reset: consume the token atomically, store the new password,
     * bump the account's session version (every existing session dies), and
     * drop the sessions outright.
     * @param {{ token: string, password: string, loginName?: string|null, address?: string|null }} params
     * @returns {Promise<{ principalId: string, loginName: string, displayName: string|null }>}
     */
    async completeRecovery({ token, password, loginName = null, address = null }) {
        this.assertEnabled();
        await this._throttle('native_recover_addr', address, RECOVERY_MAX_PER_ADDRESS, 60 * 60 * 1000);
        const tokenHash = sha256(String(token || ''));
        const pending = await db.get(
            `SELECT r.principalId, a.loginName FROM recovery_tokens r
             JOIN app_accounts a ON a.principalId = r.principalId
             WHERE r.tokenHash = @tokenHash AND r.consumedAt IS NULL AND r.expiresAt > @now`,
            { tokenHash, now: nowUtc() }
        );
        const invalid = () => new IdentityError(404, 'RECOVERY_INVALID', 'This reset link is not valid - it may have been used or expired.');
        if (!pending) throw invalid();
        let name = pending.loginName;
        if (loginName != null && loginName !== '') name = this.normalizeLoginName(loginName);
        if (!name) throw new IdentityError(400, 'LOGIN_NAME_REQUIRED', 'Choose a login name to go with your password.');
        this.validatePassword(password, { loginName: name });
        if (name !== pending.loginName) {
            const taken = await this.findAccountByLoginName(name);
            if (taken && taken.principalId !== pending.principalId) {
                throw new IdentityError(409, 'LOGIN_NAME_TAKEN', 'That login name is already in use.');
            }
        }
        const credential = await this._hash(password);
        await db.transaction(async (tx) => {
            const claimed = await tx.run(
                `UPDATE recovery_tokens SET consumedAt = @now
                 WHERE tokenHash = @tokenHash AND consumedAt IS NULL AND expiresAt > @now`,
                { tokenHash, now: nowUtc() }
            );
            if (claimed.changes !== 1) throw invalid();
            await this._storePassword(pending.principalId, credential, tx);
            await tx.run(
                `UPDATE app_accounts
                 SET loginName = @name, credentialVersion = credentialVersion + 1,
                     sessionVersion = sessionVersion + 1, updatedAt = @now
                 WHERE principalId = @principalId`,
                { name, now: nowUtc(), principalId: pending.principalId }
            );
            await tx.run('DELETE FROM web_sessions WHERE userId = @principalId', { principalId: pending.principalId });
        });
        const principal = await identityService.getPrincipal(pending.principalId);
        return { principalId: pending.principalId, loginName: name, displayName: principal?.displayName || name };
    }

    // --- Discord link intents ---------------------------------------------------

    /**
     * Start a "Connect Discord" flow: bind an OAuth state nonce to the
     * signed-in principal and session for ten minutes.
     * @param {{ principalId: string, sessionId: number|string, provider?: string }} params
     * @returns {Promise<{ state: string }>}
     */
    async beginLink({ principalId, sessionId, provider = 'discord' }) {
        if (identityService.isSnowflake(principalId)) {
            throw new IdentityError(409, 'LEGACY_IDENTITY',
                'This account is already its Discord identity; there is nothing to connect.');
        }
        const state = newToken();
        await db.run('DELETE FROM oauth_link_states WHERE expiresAt <= @now', { now: nowUtc() });
        await db.run(
            `INSERT INTO oauth_link_states (stateHash, principalId, sessionId, provider, expiresAt)
             VALUES (@stateHash, @principalId, @sessionId, @provider, @expiresAt)`,
            {
                stateHash: sha256(state),
                principalId: String(principalId),
                sessionId: Number(sessionId),
                provider,
                expiresAt: utcIn(10 * 60 * 1000)
            }
        );
        return { state };
    }

    /**
     * Consume a link intent for an OAuth callback. Returns null when the
     * state is not a link (a plain login), so the caller falls through.
     * Throws when the intent exists but belongs to a different session.
     * @param {{ state: string, principalId?: string|null, sessionId?: number|string|null }} params
     * @returns {Promise<{ principalId: string, provider: string }|null>}
     */
    async takeLink({ state, principalId = null, sessionId = null }) {
        const stateHash = sha256(String(state || ''));
        const row = await db.get('SELECT * FROM oauth_link_states WHERE stateHash = @stateHash', { stateHash });
        if (!row) return null;
        await db.run('DELETE FROM oauth_link_states WHERE stateHash = @stateHash', { stateHash });
        if (Date.parse(`${row.expiresAt.replace(' ', 'T')}Z`) <= Date.now()) {
            throw new IdentityError(400, 'LINK_EXPIRED', 'The connect request expired; start again from Settings.');
        }
        if (!principalId || row.principalId !== String(principalId) || Number(row.sessionId) !== Number(sessionId)) {
            throw new IdentityError(403, 'LINK_SESSION_MISMATCH',
                'This connect request was started from a different session. Start again from Settings.');
        }
        return { principalId: row.principalId, provider: row.provider };
    }

    /**
     * Disconnect a provider from a native principal. Refused unless a
     * working native sign-in (login name + password) remains.
     * @param {{ principalId: string, provider?: string }} params
     */
    async disconnect({ principalId, provider = 'discord' }) {
        const account = await identityService.getAccount(principalId);
        if (!account || !account.loginName || !(await this.hasPassword(principalId))) {
            throw new IdentityError(409, 'LAST_SIGN_IN_METHOD',
                'Set a login name and password first so you can still sign in after disconnecting Discord.');
        }
        const removed = await identityService.unlinkExternal({ principalId, provider });
        if (!removed) throw new IdentityError(404, 'NOT_LINKED', `No ${provider} identity is connected to this account.`);
        return { removed };
    }

    // --- Account summary -------------------------------------------------------

    /**
     * What Settings shows: sign-in methods and their state. Safe metadata only.
     * @param {string} principalId
     */
    async summary(principalId) {
        const [principal, account, external, hasPassword] = await Promise.all([
            identityService.getPrincipal(principalId),
            identityService.getAccount(principalId),
            identityService.listExternal(principalId),
            this.hasPassword(principalId)
        ]);
        const legacy = identityService.isSnowflake(principalId);
        const discord = external.find(row => row.provider === 'discord');
        return {
            principalId: String(principalId),
            kind: legacy ? 'legacy' : 'native',
            displayName: principal?.displayName || null,
            account: account
                ? { role: account.role, status: account.status, entitlement: account.entitlement, loginName: account.loginName || null }
                : null,
            nativeLogin: this.enabled,
            hasPassword,
            passwordMinLength: identityConfig.passwordMinLength,
            discord: {
                linked: legacy || Boolean(discord),
                subject: legacy ? String(principalId) : (discord?.subject || null),
                linkedAt: discord?.createdAt || null,
                // Legacy principals cannot unlink (their id is the subject);
                // native ones need a working native sign-in first.
                canDisconnect: !legacy && Boolean(discord) && Boolean(account?.loginName) && hasPassword,
                canConnect: !legacy && !discord
            }
        };
    }
}

// A well-formed hash that matches nothing; used to equalise timing for
// unknown login names.
const DUMMY_HASH = `scrypt$14$8$1$${Buffer.alloc(16, 7).toString('base64')}$${Buffer.alloc(32, 9).toString('base64')}`;

module.exports = new NativeAuthService();
module.exports.NativeAuthService = NativeAuthService;
