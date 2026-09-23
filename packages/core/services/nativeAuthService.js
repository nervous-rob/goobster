/**
 * Native authentication for the shared-instance release (Increment B).
 *
 * Everything a person needs to use Goobster without Discord: operator-issued
 * single-use invitations, username + password registration and login,
 * operator-issued recovery links, credential enrollment for existing Discord
 * users, and the account-side rules for connecting/disconnecting Discord.
 * Increment B.1 adds an optional verified email per account, which unlocks
 * signing in by email, self-service password recovery, and - when the
 * operator chooses - open sign-up. All of that needs outbound mail
 * (services/mailService.js) and is hidden when none is configured.
 * Spec: documentation/shared_instance_product_spec.md (§5, §6);
 * reference: documentation/identity.md.
 *
 * Design points
 * - Tokens (invites, recovery, verification, OAuth link state) are stored
 *   hashed; the raw value is returned exactly once to the caller who
 *   created it, or leaves only inside the email it belongs in.
 * - Anything that emails someone answers the same way whether or not the
 *   address is known, so the API cannot be used to enumerate accounts.
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
const mailService = require('./mailService');
const { IdentityError } = identityService;
const { normalizeEmail } = mailService;
const { hashPassword, verifyPassword, needsRehash } = require('../utils/passwordHashing');
const { consumeWindow } = require('../utils/slidingWindowLimit');

const LOGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const PASSWORD_MAX_LENGTH = 256;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const LOGIN_MAX_PER_NAME = 10;
const LOGIN_MAX_PER_ADDRESS = 40;
const REGISTER_MAX_PER_ADDRESS = 10;
const RECOVERY_MAX_PER_ADDRESS = 10;
// Anything that sends mail is throttled per client address and per
// recipient, so the installation cannot be used to flood an inbox.
const SIGNUP_MAX_PER_ADDRESS = 5;
const MAIL_MAX_PER_RECIPIENT = 3;
const FORGOT_MAX_PER_ADDRESS = 5;
const VERIFY_SEND_MAX_PER_PRINCIPAL = 5;

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

    /**
     * Email features (verification, self-service recovery, open sign-up)
     * need native login, a mail provider, and an absolute public URL to
     * put in the links. The URL comes from `webapp.publicUrl`, never from
     * the request's Host header, so a forged header cannot poison a link.
     * @param {string|null} baseUrl
     */
    emailEnabled(baseUrl) {
        return this.enabled && mailService.enabled && Boolean(baseUrl);
    }

    /** Why email features are off (operator-facing), or null when on. */
    emailDisabledReason(baseUrl) {
        if (!this.enabled) return 'Password sign-in (identity.nativeLogin) is off.';
        if (!mailService.enabled) return mailService.describe().reason;
        if (!baseUrl) return 'webapp.publicUrl is not set, so emailed links would have no address.';
        return null;
    }

    assertEmailEnabled(baseUrl) {
        this.assertEnabled();
        if (!this.emailEnabled(baseUrl)) {
            throw new IdentityError(503, 'MAIL_DISABLED',
                'Email is not configured on this installation. Ask the host.');
        }
    }

    /**
     * Effective registration mode. 'open' only when the operator asked for
     * it *and* email can be verified; otherwise invitations, with one
     * warning so the misconfiguration is visible in the log.
     * @param {string|null} baseUrl
     * @returns {'invite'|'open'}
     */
    registrationMode(baseUrl) {
        if (identityConfig.registration !== 'open') return 'invite';
        if (this.emailEnabled(baseUrl)) return 'open';
        if (!this._warnedOpen) {
            this._warnedOpen = true;
            console.warn(`[identity] identity.registration is "open" but ${this.emailDisabledReason(baseUrl)} Falling back to invitations.`);
        }
        return 'invite';
    }

    // --- Validation ----------------------------------------------------------

    /**
     * Validate an email address, returning both the display form and the
     * normalized (lookup) form.
     * @param {string} raw
     * @returns {{ address: string, normalized: string }}
     */
    normalizeEmail(raw) {
        const normalized = normalizeEmail(raw);
        if (!normalized) {
            throw new IdentityError(400, 'BAD_EMAIL', 'That does not look like an email address.');
        }
        return { address: String(raw).trim(), normalized };
    }

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
            await require('./usageBudgetService').assertAccountCreation(tx);
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

    // All changes to an account's recovery authority take this lock first.
    // A no-op UPDATE locks the row on Postgres and the writer on SQLite.
    async _lockAccount(tx, principalId) {
        await tx.run('UPDATE app_accounts SET principalId = principalId WHERE principalId = @principalId', { principalId });
        return tx.get('SELECT * FROM app_accounts WHERE principalId = @principalId', { principalId });
    }

    async _revokeRecovery(tx, principalId) {
        await tx.run('DELETE FROM recovery_tokens WHERE principalId = @principalId AND consumedAt IS NULL', { principalId });
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
            try {
                const credential = await this._hash(password);
                // A concurrent reset must never be overwritten by a rehash
                // of the password that was correct when verification began.
                await db.run(
                    `UPDATE password_credentials SET hash = @hash, paramsJson = @params, updatedAt = @now
                     WHERE principalId = @principalId AND hash = @previous`,
                    { principalId, hash: credential.hash, params: JSON.stringify(credential.params), now: nowUtc(), previous: row.hash }
                );
            } catch { /* best effort */ }
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
            const current = await this._lockAccount(tx, principalId);
            if (!current || current.status !== 'active' || Number(current.credentialVersion) !== Number(account.credentialVersion)) {
                throw new IdentityError(403, 'BAD_CREDENTIALS', 'Your credentials changed. Sign in again before changing your password.');
            }
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
            await this._revokeRecovery(tx, principalId);
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
     * Verify a login name (or verified email address) + password. Neutral
     * error for unknown names and wrong passwords alike; the disabled state
     * is only revealed after a correct password. Throttled per identifier
     * and per address.
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

        const account = name.includes('@')
            ? await this.findAccountByEmail(name)
            : await this.findAccountByLoginName(name);
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
        const token = newToken();
        const expiresAt = utcIn(identityConfig.recoveryTtlMinutes * 60 * 1000);
        const account = await db.transaction(async (tx) => {
            const current = await this._lockAccount(tx, String(principalId));
            if (!current) throw new IdentityError(404, 'ACCOUNT_NOT_FOUND', 'That principal has no application account.');
            await tx.run(
                `INSERT INTO recovery_tokens (tokenHash, principalId, purpose, issuedBy, expiresAt)
                 VALUES (@tokenHash, @principalId, 'password_reset', @issuedBy, @expiresAt)`,
                { tokenHash: sha256(token), principalId: String(principalId), issuedBy: String(issuedBy), expiresAt }
            );
            return current;
        });
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
            await this._lockAccount(tx, pending.principalId);
            const claimed = await tx.run(
                `UPDATE recovery_tokens SET consumedAt = @now
                 WHERE tokenHash = @tokenHash AND consumedAt IS NULL AND expiresAt > @now`,
                { tokenHash, now: nowUtc() }
            );
            if (claimed.changes !== 1) throw invalid();
            await this._revokeRecovery(tx, pending.principalId);
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

    /**
     * Self-service reset by verified email. Always resolves the same way
     * whether or not the address is known - the answer goes to the inbox,
     * not to the caller - so accounts cannot be enumerated here. Throttled
     * per client address and per recipient.
     * @param {{ email: string, address?: string|null, baseUrl: string }} params
     * @returns {Promise<{ ok: true }>}
     */
    async requestRecovery({ email, address = null, baseUrl }) {
        this.assertEmailEnabled(baseUrl);
        const { normalized } = this.normalizeEmail(email);
        await this._throttle('native_forgot_addr', address, FORGOT_MAX_PER_ADDRESS, HOUR_MS);
        await this._throttle('native_mail_recipient', normalized, MAIL_MAX_PER_RECIPIENT, HOUR_MS);
        const account = await this.findAccountByEmail(normalized);
        if (!account || account.status !== 'active') return { ok: true };
        const token = newToken();
        const expiresAt = utcIn(identityConfig.recoveryTtlMinutes * 60 * 1000);
        const emailRow = await db.transaction(async (tx) => {
            const current = await this._lockAccount(tx, account.principalId);
            if (!current || current.status !== 'active') return null;
            // Resolve the recipient under the same lock used by address
            // changes, so a stale lookup cannot mint a link for an old inbox.
            const recipient = await tx.get(
                `SELECT address FROM account_emails
                 WHERE principalId = @principalId AND normalized = @normalized AND verifiedAt IS NOT NULL`,
                { principalId: account.principalId, normalized }
            );
            if (!recipient) return null;
            await tx.run(
                `INSERT INTO recovery_tokens (tokenHash, principalId, purpose, issuedBy, expiresAt)
                 VALUES (@tokenHash, @principalId, 'password_reset', @principalId, @expiresAt)`,
                { tokenHash: sha256(token), principalId: account.principalId, expiresAt }
            );
            return recipient;
        });
        if (!emailRow) return { ok: true };
        try {
            await mailService.send(this._mail('recover', {
                to: emailRow.address,
                url: `${baseUrl}/app/recover?token=${encodeURIComponent(token)}`,
                minutes: identityConfig.recoveryTtlMinutes,
                loginName: account.loginName
            }));
        } catch (error) {
            await db.run('DELETE FROM recovery_tokens WHERE tokenHash = @tokenHash', { tokenHash: sha256(token) });
            throw error;
        }
        return { ok: true };
    }

    // --- Email address -------------------------------------------------------

    /**
     * @param {string} principalId
     * @returns {Promise<{ address: string, normalized: string, verifiedAt: string|null, updatedAt: string }|null>}
     */
    async getEmail(principalId) {
        return await db.get(
            'SELECT address, normalized, verifiedAt, updatedAt FROM account_emails WHERE principalId = @principalId',
            { principalId: String(principalId) }
        ) || null;
    }

    /** Account behind a *verified* address, in the shape of findAccountByLoginName. */
    async findAccountByEmail(email) {
        const normalized = normalizeEmail(email);
        if (!normalized) return null;
        return await db.get(
            `SELECT a.principalId, a.loginName, a.status, a.role, a.sessionVersion
             FROM account_emails e JOIN app_accounts a ON a.principalId = e.principalId
             WHERE e.normalized = @normalized AND e.verifiedAt IS NOT NULL`,
            { normalized }
        ) || null;
    }

    /** Is a verification link for this address still outstanding? */
    async _verificationPending(principalId, normalized) {
        const row = await db.get(
            `SELECT 1 AS present FROM email_tokens
             WHERE principalId = @principalId AND normalized = @normalized
               AND consumedAt IS NULL AND expiresAt > @now`,
            { principalId, normalized, now: nowUtc() }
        );
        return Boolean(row);
    }

    async _reclaimUnverifiedEmail(tx, normalized, principalId) {
        // Recheck verifiedAt in the DELETE itself: verification racing this
        // claim must either win and preserve its owner, or find no address.
        const displaced = await tx.get(
            `DELETE FROM account_emails
             WHERE normalized = @normalized AND principalId <> @principalId AND verifiedAt IS NULL
             RETURNING principalId`,
            { normalized, principalId }
        );
        if (displaced) {
            await tx.run('DELETE FROM email_tokens WHERE principalId = @principalId AND normalized = @normalized',
                { principalId: displaced.principalId, normalized });
        }
    }

    /**
     * Set (or replace) the account's email address. The address starts
     * unverified: it cannot be used to sign in or recover until the link
     * mailed here is followed. An address another account has *claimed but
     * never verified* is taken over - unproven claims reserve nothing; a
     * verified one is refused. The route requires recent authentication.
     * @param {{ principalId: string, email: string, baseUrl: string }} params
     */
    async setEmail({ principalId, email, baseUrl }) {
        this.assertEmailEnabled(baseUrl);
        const account = await identityService.getAccount(principalId);
        if (!account) throw new IdentityError(403, 'NO_ACCOUNT', 'The host has not granted this account yet.');
        const { address, normalized } = this.normalizeEmail(email);
        const current = await this.getEmail(principalId);
        if (current && current.normalized === normalized && current.verifiedAt) {
            return { address: current.address, verified: true, sent: false };
        }
        await this._throttle('email_verify_send', principalId, VERIFY_SEND_MAX_PER_PRINCIPAL, HOUR_MS);
        await db.transaction(async (tx) => {
            await this._lockAccount(tx, principalId);
            await this._reclaimUnverifiedEmail(tx, normalized, principalId);
            const other = await tx.get(
                'SELECT principalId, verifiedAt FROM account_emails WHERE normalized = @normalized AND principalId <> @principalId',
                { normalized, principalId }
            );
            if (other) {
                throw new IdentityError(409, 'EMAIL_TAKEN', 'That email address is already verified on another account.');
            }
            try {
                await tx.run(
                    `INSERT INTO account_emails (principalId, address, normalized, verifiedAt, updatedAt)
                     VALUES (@principalId, @address, @normalized, NULL, @now)
                     ON CONFLICT(principalId) DO UPDATE SET address = excluded.address, normalized = excluded.normalized,
                         verifiedAt = NULL, updatedAt = excluded.updatedAt`,
                    { principalId, address, normalized, now: nowUtc() }
                );
            } catch (error) {
                if (/unique|duplicate/i.test(String(error?.message))) {
                    throw new IdentityError(409, 'EMAIL_TAKEN', 'That email address was claimed on another account meanwhile.');
                }
                throw error;
            }
            // Links mailed to the previous address die with it.
            await tx.run('DELETE FROM email_tokens WHERE principalId = @principalId', { principalId });
            await this._revokeRecovery(tx, principalId);
        });
        await this._sendVerification({ principalId, address, normalized, baseUrl });
        return { address, verified: false, sent: true };
    }

    /**
     * Mail a fresh verification link for the address on file. Throttled.
     * @param {{ principalId: string, baseUrl: string }} params
     */
    async resendVerification({ principalId, baseUrl }) {
        this.assertEmailEnabled(baseUrl);
        const current = await this.getEmail(principalId);
        if (!current) throw new IdentityError(404, 'NO_EMAIL', 'There is no email address on this account.');
        if (current.verifiedAt) return { address: current.address, verified: true, sent: false };
        await this._throttle('email_verify_send', principalId, VERIFY_SEND_MAX_PER_PRINCIPAL, HOUR_MS);
        await this._sendVerification({ principalId, address: current.address, normalized: current.normalized, baseUrl });
        return { address: current.address, verified: false, sent: true };
    }

    async _sendVerification({ principalId, address, normalized, baseUrl }) {
        const token = newToken();
        const minutes = identityConfig.emailVerifyTtlMinutes;
        await db.run(
            `INSERT INTO email_tokens (tokenHash, principalId, purpose, normalized, expiresAt)
             VALUES (@tokenHash, @principalId, 'verify', @normalized, @expiresAt)`,
            { tokenHash: sha256(token), principalId: String(principalId), normalized, expiresAt: utcIn(minutes * 60 * 1000) }
        );
        try {
            await mailService.send(this._mail('verify', {
                to: address,
                url: `${baseUrl}/app/verify-email?token=${encodeURIComponent(token)}`,
                minutes
            }));
        } catch (error) {
            await db.run('DELETE FROM email_tokens WHERE tokenHash = @tokenHash', { tokenHash: sha256(token) });
            throw error;
        }
    }

    /** Drop the address and any outstanding verification links. */
    async removeEmail(principalId) {
        const id = String(principalId);
        await db.transaction(async (tx) => {
            await this._lockAccount(tx, id);
            const result = await tx.run('DELETE FROM account_emails WHERE principalId = @id', { id });
            if (!result.changes) throw new IdentityError(404, 'NO_EMAIL', 'There is no email address on this account.');
            await tx.run('DELETE FROM email_tokens WHERE principalId = @id', { id });
            await this._revokeRecovery(tx, id);
        });
        return { removed: true };
    }

    /**
     * Follow a verification link. Two kinds of token land here: an open
     * sign-up's (the account is created now, and the caller gets a
     * session) and an existing account's (the address becomes verified;
     * no session - possession of an inbox is not a login).
     * @param {{ token: string, address?: string|null }} params
     * @returns {Promise<{ kind: 'registration', principalId: string, loginName: string, displayName: string }
     *   | { kind: 'verified', principalId: string, address: string }>}
     */
    async verifyEmail({ token, address = null }) {
        this.assertEnabled();
        await this._throttle('native_verify_addr', address, REGISTER_MAX_PER_ADDRESS, HOUR_MS);
        const tokenHash = sha256(String(token || ''));
        const invalid = () => new IdentityError(404, 'VERIFY_INVALID',
            'This verification link is not valid - it may have been used or expired.');

        const pendingSignup = await db.get(
            'SELECT * FROM pending_registrations WHERE tokenHash = @tokenHash AND expiresAt > @now',
            { tokenHash, now: nowUtc() }
        );
        if (pendingSignup) return this._completeSignup(pendingSignup, invalid);

        const pending = await db.get(
            `SELECT t.principalId, t.normalized FROM email_tokens t
             WHERE t.tokenHash = @tokenHash AND t.consumedAt IS NULL AND t.expiresAt > @now`,
            { tokenHash, now: nowUtc() }
        );
        if (!pending) throw invalid();
        const now = nowUtc();
        const result = await db.transaction(async (tx) => {
            // Only the address the link was mailed to becomes verified; if
            // the account moved to a new address meanwhile, this link is moot.
            // Lock address before token, matching unverified-claim reclamation.
            const updated = await tx.run(
                `UPDATE account_emails SET verifiedAt = @now, updatedAt = @now
                 WHERE principalId = @principalId AND normalized = @normalized`,
                { now, principalId: pending.principalId, normalized: pending.normalized }
            );
            if (updated.changes !== 1) throw invalid();
            const claimed = await tx.run(
                `UPDATE email_tokens SET consumedAt = @now
                 WHERE tokenHash = @tokenHash AND consumedAt IS NULL AND expiresAt > @now`,
                { tokenHash, now }
            );
            if (claimed.changes !== 1) throw invalid();
            return await tx.get('SELECT address FROM account_emails WHERE principalId = @principalId', { principalId: pending.principalId });
        });
        return { kind: 'verified', principalId: pending.principalId, address: result.address };
    }

    // --- Open sign-up ----------------------------------------------------------

    /**
     * Open registration, step one: park the sign-up until the address is
     * verified. Nothing is an account yet. The response is the same
     * whether the address is new or already belongs to someone (that
     * person gets a note instead), so this cannot enumerate accounts;
     * login names are checked openly - they are identifiers, not secrets.
     * @param {{ loginName: string, password: string, email: string, displayName?: string|null, address?: string|null, baseUrl: string }} params
     * @returns {Promise<{ ok: true }>}
     */
    async signup({ loginName, password, email, displayName = null, address = null, baseUrl }) {
        this.assertEnabled();
        if (this.registrationMode(baseUrl) !== 'open') {
            throw new IdentityError(403, 'REGISTRATION_CLOSED',
                'This installation is invitation-only. Ask the host for an invitation link.');
        }
        await this._throttle('native_signup_addr', address, SIGNUP_MAX_PER_ADDRESS, HOUR_MS);
        const name = this.normalizeLoginName(loginName);
        const { address: emailAddress, normalized } = this.normalizeEmail(email);
        this.validatePassword(password, { loginName: name });
        await this._throttle('native_mail_recipient', normalized, MAIL_MAX_PER_RECIPIENT, HOUR_MS);
        const now = nowUtc();
        await db.run('DELETE FROM pending_registrations WHERE expiresAt <= @now', { now });

        if (await this.findAccountByLoginName(name)) {
            throw new IdentityError(409, 'LOGIN_NAME_TAKEN', 'That login name is already in use.');
        }
        const reserved = await db.get(
            'SELECT 1 AS present FROM pending_registrations WHERE loginName = @name AND emailNormalized <> @normalized',
            { name, normalized }
        );
        if (reserved) throw new IdentityError(409, 'LOGIN_NAME_TAKEN', 'That login name is already in use.');

        const existing = await this.findAccountByEmail(normalized);
        if (existing) {
            const row = await this.getEmail(existing.principalId);
            try {
                await mailService.send(this._mail('already', {
                    to: row.address,
                    url: `${baseUrl}/app/forgot`,
                    loginName: existing.loginName
                }));
            } catch { /* the caller learns nothing either way */ }
            return { ok: true };
        }

        const display = displayName ? String(displayName).trim().slice(0, 100) : name;
        const credential = await this._hash(password);
        const token = newToken();
        const minutes = identityConfig.emailVerifyTtlMinutes;
        await db.transaction(async (tx) => {
            await tx.run('DELETE FROM pending_registrations WHERE emailNormalized = @normalized', { normalized });
            await tx.run(
                `INSERT INTO pending_registrations (tokenHash, loginName, displayName, emailAddress, emailNormalized, passwordHash, paramsJson, expiresAt)
                 VALUES (@tokenHash, @loginName, @displayName, @emailAddress, @normalized, @hash, @params, @expiresAt)`,
                {
                    tokenHash: sha256(token),
                    loginName: name,
                    displayName: display,
                    emailAddress,
                    normalized,
                    hash: credential.hash,
                    params: JSON.stringify(credential.params),
                    expiresAt: utcIn(minutes * 60 * 1000)
                }
            );
        });
        try {
            await mailService.send(this._mail('signup', {
                to: emailAddress,
                url: `${baseUrl}/app/verify-email?token=${encodeURIComponent(token)}`,
                minutes,
                loginName: name
            }));
        } catch (error) {
            await db.run('DELETE FROM pending_registrations WHERE tokenHash = @tokenHash', { tokenHash: sha256(token) });
            throw error;
        }
        return { ok: true };
    }

    /**
     * Open registration, step two: the verification link was followed.
     * Consume the pending row atomically (one winner) and create the
     * principal, the account (entitlement 'open'), the credential, and the
     * verified address in one transaction.
     */
    async _completeSignup(pending, invalid) {
        const now = nowUtc();
        return db.transaction(async (tx) => {
            await require('./usageBudgetService').assertAccountCreation(tx);
            const claimed = await tx.run(
                'DELETE FROM pending_registrations WHERE id = @id AND expiresAt > @now',
                { id: pending.id, now }
            );
            if (claimed.changes !== 1) throw invalid();
            const principalId = identityService.newNativeId();
            await this._reclaimUnverifiedEmail(tx, pending.emailNormalized, principalId);
            await tx.run(
                'INSERT INTO principals (id, displayName) VALUES (@id, @name)',
                { id: principalId, name: pending.displayName || pending.loginName }
            );
            try {
                await tx.run(
                    `INSERT INTO app_accounts (principalId, loginName, role, entitlement)
                     VALUES (@principalId, @loginName, 'member', 'open')`,
                    { principalId, loginName: pending.loginName }
                );
            } catch (error) {
                if (/unique|duplicate/i.test(String(error?.message))) {
                    throw new IdentityError(409, 'LOGIN_NAME_TAKEN',
                        'That login name was taken while your email was being verified. Sign up again with another one.');
                }
                throw error;
            }
            await tx.run(
                'INSERT INTO password_credentials (principalId, hash, paramsJson) VALUES (@principalId, @hash, @params)',
                { principalId, hash: pending.passwordHash, params: pending.paramsJson }
            );
            try {
                await tx.run(
                    `INSERT INTO account_emails (principalId, address, normalized, verifiedAt)
                     VALUES (@principalId, @address, @normalized, @now)`,
                    { principalId, address: pending.emailAddress, normalized: pending.emailNormalized, now }
                );
            } catch (error) {
                if (/unique|duplicate/i.test(String(error?.message))) {
                    throw new IdentityError(409, 'EMAIL_TAKEN', 'That email address was verified on another account meanwhile.');
                }
                throw error;
            }
            return {
                kind: 'registration',
                principalId,
                loginName: pending.loginName,
                displayName: pending.displayName || pending.loginName
            };
        });
    }

    // --- Mail templates --------------------------------------------------------

    /** Plain-text messages. The installation name is the only branding. */
    _mail(kind, { to, url, minutes, loginName }) {
        const site = identityConfig.installationName;
        const who = loginName ? ` (login name: ${loginName})` : '';
        const ttl = minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
        switch (kind) {
            case 'verify':
                return {
                    to,
                    subject: `${site}: confirm your email address`,
                    text: `Confirm that this address belongs to your ${site} account${who} by opening this link:\n\n${url}\n\nThe link works once and expires in ${ttl}. If you did not add this address, ignore this message and nothing changes.`
                };
            case 'signup':
                return {
                    to,
                    subject: `${site}: finish creating your account`,
                    text: `Welcome. Open this link to confirm your email address and finish creating your ${site} account${who}:\n\n${url}\n\nThe link works once and expires in ${ttl}. If you did not sign up, ignore this message - no account exists until the link is used.`
                };
            case 'already':
                return {
                    to,
                    subject: `${site}: you already have an account`,
                    text: `Someone (probably you) tried to sign up for ${site} with this address, but it already belongs to an account${who}.\n\nTo sign in, use that login name or this email address. Forgotten the password? Reset it here:\n\n${url}\n\nIf this was not you, no action is needed.`
                };
            case 'recover':
                return {
                    to,
                    subject: `${site}: reset your password`,
                    text: `A password reset was requested for your ${site} account${who}. Choose a new passphrase here:\n\n${url}\n\nThe link works once and expires in ${ttl}. Every other signed-in device is signed out when you use it. If you did not ask for this, ignore this message - your password stays as it is.`
                };
            case 'test':
                return {
                    to,
                    subject: `${site}: test message`,
                    text: `Outbound mail from ${site} is working. This message was sent by the host from the installation panel.`
                };
            default:
                throw new Error(`Unknown mail kind ${kind}`);
        }
    }

    /** Operator's smoke test: one message to an address of their choosing. */
    async sendTestMail({ to, issuedBy, baseUrl }) {
        this.assertEmailEnabled(baseUrl);
        const { address } = this.normalizeEmail(to);
        await this._throttle('mail_test', issuedBy, MAIL_MAX_PER_RECIPIENT, HOUR_MS);
        await mailService.send(this._mail('test', { to: address }));
        return { ok: true, provider: mailService.provider };
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
    async summary(principalId, { baseUrl = null } = {}) {
        const [principal, account, external, hasPassword, email] = await Promise.all([
            identityService.getPrincipal(principalId),
            identityService.getAccount(principalId),
            identityService.listExternal(principalId),
            this.hasPassword(principalId),
            this.getEmail(principalId)
        ]);
        const legacy = identityService.isSnowflake(principalId);
        const discord = external.find(row => row.provider === 'discord');
        const pendingVerification = email && !email.verifiedAt
            ? await this._verificationPending(String(principalId), email.normalized)
            : false;
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
            // Email: the address on file (if any), whether it has been
            // proven, and whether the installation can send mail at all.
            email: email
                ? { address: email.address, verified: Boolean(email.verifiedAt), pendingVerification, updatedAt: email.updatedAt }
                : null,
            mail: { enabled: this.emailEnabled(baseUrl), reason: this.emailDisabledReason(baseUrl) },
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
