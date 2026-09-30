/**
 * Personal access tokens for the read-only MCP server.
 *
 * The raw secret is returned once from `create` and stored only as a
 * SHA-256 (the web session pattern). A token is bound to one principal
 * and one scope: `read` (every read-only tool) or `docs` (documentation
 * only, for clients whose output you would rather keep away from your
 * private workspace). A token may carry an expiry. Revocation, expiry,
 * and /forget-me all make it stop resolving. Nothing here writes a
 * ledger row: a label is not a prompt, and the secret never lands in a log.
 */

const crypto = require('node:crypto');
const db = require('../db');
const mcpConfig = require('../config/mcpConfig');

const TOKEN_BYTES = 32;
const TOKEN_RE = /^gst_[A-Za-z0-9_-]{43}$/;
const LABEL_MAX = 80;
const DAY_MS = 86_400_000;

const SCOPES = Object.freeze({
    read: {
        id: 'read',
        label: 'Everything (read-only)',
        description: 'Documentation, memories, facts, knowledge notes, projects, inbox, and research.'
    },
    docs: {
        id: 'docs',
        label: 'Documentation only',
        description: 'Goobster\'s own manual. Nothing from your private workspace.'
    }
});

class McpTokenError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'McpTokenError';
        this.status = status;
        this.code = code;
    }
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/** UTC `YYYY-MM-DD HH:MM:SS`, the format every timestamp column uses. */
function sqlTime(date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function cleanLabel(label) {
    let text = '';
    for (const char of String(label ?? '')) {
        const code = char.codePointAt(0);
        if (code <= 31 || code === 127) continue;
        text += char;
    }
    text = text.trim();
    if (!text) throw new McpTokenError(400, 'BAD_LABEL', 'A token needs a label, so you can tell them apart.');
    if (text.length > LABEL_MAX) {
        throw new McpTokenError(400, 'BAD_LABEL', `Keep the label to ${LABEL_MAX} characters.`);
    }
    return text;
}

function cleanScope(scope) {
    if (scope === undefined || scope === null || scope === '') return 'read';
    const value = String(scope).trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(SCOPES, value)) {
        throw new McpTokenError(400, 'BAD_SCOPE', `Scope must be one of: ${Object.keys(SCOPES).join(', ')}.`);
    }
    return value;
}

/**
 * Omitted means the configured default. `0` means the token never expires.
 * @returns {string|null} UTC text, or null for no expiry
 */
function resolveExpiry(expiresInDays) {
    let days;
    if (expiresInDays === undefined || expiresInDays === null || expiresInDays === '') {
        days = mcpConfig.defaultTokenDays;
    } else {
        days = Number(expiresInDays);
        if (!Number.isInteger(days) || days < 0 || days > mcpConfig.maxTokenDays) {
            throw new McpTokenError(400, 'BAD_EXPIRY',
                `Choose 0 (never) or 1 to ${mcpConfig.maxTokenDays} days.`);
        }
    }
    if (days === 0) return null;
    return sqlTime(new Date(Date.now() + days * DAY_MS));
}

function isExpired(row, now = sqlTime(new Date())) {
    return Boolean(row.expiresAt) && String(row.expiresAt) <= now;
}

function publicRow(row) {
    return {
        id: row.id,
        label: row.label,
        tokenPrefix: row.tokenPrefix,
        scope: row.scope,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt || null,
        revokedAt: row.revokedAt || null,
        expiresAt: row.expiresAt || null,
        expired: isExpired(row)
    };
}

const PUBLIC_COLUMNS = 'id, label, tokenPrefix, scope, createdAt, lastUsedAt, revokedAt, expiresAt';

class McpTokenService {
    constructor() {
        /** @type {Map<number, number>} token id -> last touch epoch ms */
        this._touched = new Map();
    }

    /**
     * Mint a read-only token. The plaintext is only in the return value.
     * @param {{ userId: string, label: string, scope?: 'read'|'docs', expiresInDays?: number }} params
     */
    async create({ userId, label, scope, expiresInDays }) {
        const owner = String(userId || '').trim();
        if (!owner) throw new McpTokenError(400, 'BAD_USER', 'A token needs an owner.');
        const clean = cleanLabel(label);
        const cleanedScope = cleanScope(scope);
        const expiresAt = resolveExpiry(expiresInDays);
        const cap = mcpConfig.maxTokensPerUser;
        const existing = await db.get(
            `SELECT COUNT(*) AS c FROM mcp_tokens
             WHERE userId = @userId AND revokedAt IS NULL
               AND (expiresAt IS NULL OR expiresAt > @now)`,
            { userId: owner, now: sqlTime(new Date()) }
        );
        if (Number(existing?.c || 0) >= cap) {
            throw new McpTokenError(409, 'TOO_MANY_TOKENS',
                `You already have ${cap} active MCP tokens. Revoke one before creating another.`);
        }
        const token = `gst_${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`;
        const id = await db.insert(
            `INSERT INTO mcp_tokens (tokenHash, userId, label, tokenPrefix, scope, expiresAt)
             VALUES (@tokenHash, @userId, @label, @tokenPrefix, @scope, @expiresAt)`,
            {
                tokenHash: hashToken(token),
                userId: owner,
                label: clean,
                tokenPrefix: token.slice(0, 12),
                scope: cleanedScope,
                expiresAt
            }
        );
        const row = await db.get(
            `SELECT ${PUBLIC_COLUMNS} FROM mcp_tokens WHERE id = @id`,
            { id }
        );
        return { token, ...publicRow(row) };
    }

    /**
     * One person's tokens that have not been revoked, newest first. Expired
     * tokens stay listed (flagged) so they can be cleaned up. Never includes
     * the secret.
     */
    async list({ userId }) {
        const rows = await db.all(
            `SELECT ${PUBLIC_COLUMNS}
             FROM mcp_tokens
             WHERE userId = @userId AND revokedAt IS NULL
             ORDER BY id DESC`,
            { userId: String(userId) }
        );
        return rows.map(publicRow);
    }

    /**
     * Revoke one of the caller's tokens. A missing or already-revoked row
     * is the same 404, so ids are not an oracle for other people.
     */
    async revoke({ userId, id }) {
        const tokenId = Number(id);
        if (!Number.isInteger(tokenId) || tokenId < 1) {
            throw new McpTokenError(404, 'NOT_FOUND', 'No such token.');
        }
        const result = await db.run(
            `UPDATE mcp_tokens SET revokedAt = datetime('now')
             WHERE id = @id AND userId = @userId AND revokedAt IS NULL`,
            { id: tokenId, userId: String(userId) }
        );
        if (!result.changes) throw new McpTokenError(404, 'NOT_FOUND', 'No such token.');
        this._touched.delete(tokenId);
        return { revoked: true, id: tokenId };
    }

    /**
     * Resolve a raw bearer secret. `expired` is distinct from `invalid` so a
     * client holding a real, lapsed secret is told to mint a new one; the
     * hash matched, so this reveals nothing to someone without the secret.
     * A successful resolve records lastUsedAt at most once a minute.
     * @returns {Promise<{ status: 'ok', session: { id: number, userId: string, label: string, scope: string } }
     *   | { status: 'expired' } | { status: 'invalid' }>}
     */
    async resolve(rawToken) {
        if (typeof rawToken !== 'string' || !TOKEN_RE.test(rawToken)) return { status: 'invalid' };
        const row = await db.get(
            `SELECT id, userId, label, scope, expiresAt FROM mcp_tokens
             WHERE tokenHash = @tokenHash AND revokedAt IS NULL`,
            { tokenHash: hashToken(rawToken) }
        );
        if (!row || !Object.prototype.hasOwnProperty.call(SCOPES, row.scope)) return { status: 'invalid' };
        if (isExpired(row)) return { status: 'expired' };
        const now = Date.now();
        const previous = this._touched.get(row.id) || 0;
        if (now - previous > 60_000) {
            this._touched.set(row.id, now);
            try {
                await db.run(
                    `UPDATE mcp_tokens SET lastUsedAt = datetime('now')
                     WHERE id = @id AND revokedAt IS NULL`,
                    { id: row.id }
                );
            } catch {
                // A usage timestamp must not fail an otherwise valid read.
            }
        }
        return {
            status: 'ok',
            session: {
                id: row.id,
                userId: row.userId,
                label: row.label,
                scope: row.scope
            }
        };
    }

    /**
     * Resolve to a session, or null for anything that should not read
     * (unknown, malformed, revoked, expired).
     */
    async authenticate(rawToken) {
        const outcome = await this.resolve(rawToken);
        return outcome.status === 'ok' ? outcome.session : null;
    }

    /** /forget-me: every token for this person, active or revoked. */
    async forgetUser(userId, handle = db) {
        const result = await handle.run(
            'DELETE FROM mcp_tokens WHERE userId = @userId',
            { userId: String(userId) }
        );
        return result.changes;
    }

    _resetForTests() {
        this._touched.clear();
    }
}

module.exports = new McpTokenService();
module.exports.McpTokenError = McpTokenError;
module.exports.SCOPES = SCOPES;
