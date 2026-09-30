/**
 * Personal access tokens for the read-only MCP server.
 *
 * The raw secret is returned once from `create` and stored only as a
 * SHA-256 (the web session pattern). A token is bound to one principal
 * and the `read` scope. Revocation and /forget-me both make it stop
 * resolving. Nothing here writes a ledger row: a label is not a prompt,
 * and the secret never lands in a log.
 */

const crypto = require('node:crypto');
const db = require('../db');
const mcpConfig = require('../config/mcpConfig');

const TOKEN_BYTES = 32;
const TOKEN_RE = /^gst_[A-Za-z0-9_-]{43}$/;
const LABEL_MAX = 80;

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

function publicRow(row) {
    return {
        id: row.id,
        label: row.label,
        tokenPrefix: row.tokenPrefix,
        scope: row.scope,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt || null,
        revokedAt: row.revokedAt || null
    };
}

class McpTokenService {
    constructor() {
        /** @type {Map<number, number>} token id -> last touch epoch ms */
        this._touched = new Map();
    }

    /**
     * Mint a read-only token. The plaintext is only in the return value.
     * @param {{ userId: string, label: string }} params
     */
    async create({ userId, label }) {
        const owner = String(userId || '').trim();
        if (!owner) throw new McpTokenError(400, 'BAD_USER', 'A token needs an owner.');
        const clean = cleanLabel(label);
        const cap = mcpConfig.maxTokensPerUser;
        const existing = await db.get(
            `SELECT COUNT(*) AS c FROM mcp_tokens
             WHERE userId = @userId AND revokedAt IS NULL`,
            { userId: owner }
        );
        if (Number(existing?.c || 0) >= cap) {
            throw new McpTokenError(409, 'TOO_MANY_TOKENS',
                `You already have ${cap} active MCP tokens. Revoke one before creating another.`);
        }
        const token = `gst_${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`;
        const id = await db.insert(
            `INSERT INTO mcp_tokens (tokenHash, userId, label, tokenPrefix, scope)
             VALUES (@tokenHash, @userId, @label, @tokenPrefix, 'read')`,
            {
                tokenHash: hashToken(token),
                userId: owner,
                label: clean,
                tokenPrefix: token.slice(0, 12)
            }
        );
        const row = await db.get(
            `SELECT id, label, tokenPrefix, scope, createdAt, lastUsedAt, revokedAt
             FROM mcp_tokens WHERE id = @id`,
            { id }
        );
        return { token, ...publicRow(row) };
    }

    /** Active tokens for one person, newest first. Never includes the secret. */
    async list({ userId }) {
        const rows = await db.all(
            `SELECT id, label, tokenPrefix, scope, createdAt, lastUsedAt, revokedAt
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
     * Resolve a raw bearer secret to its owner. Unknown, malformed, and
     * revoked secrets all return null. A successful resolve records
     * lastUsedAt at most once a minute.
     * @returns {Promise<{ id: number, userId: string, label: string, scope: string }|null>}
     */
    async authenticate(rawToken) {
        if (typeof rawToken !== 'string' || !TOKEN_RE.test(rawToken)) return null;
        const row = await db.get(
            `SELECT id, userId, label, scope FROM mcp_tokens
             WHERE tokenHash = @tokenHash AND revokedAt IS NULL AND scope = 'read'`,
            { tokenHash: hashToken(rawToken) }
        );
        if (!row) return null;
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
            id: row.id,
            userId: row.userId,
            label: row.label,
            scope: row.scope
        };
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
