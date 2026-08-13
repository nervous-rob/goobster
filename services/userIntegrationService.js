/**
 * Per-user platform integrations (the ChatGPT-style "connectors"): personal
 * API tokens for Notion and GitHub, connected through the web portal's
 * Integrations dialog and stored per Discord user id in SQLite
 * (user_integrations). The raw token is stored because it is replayed
 * against the provider's API on every tool call - the same trust model as
 * config.json's GITHUB_TOKEN, scoped to one user. /forget-me deletes the
 * rows outright (privacyService).
 *
 * Connecting verifies the token live against the provider (GET /user on
 * GitHub, GET /v1/users/me on Notion) and snapshots a display label so the
 * UI can show "Connected as ...". Tokens are never sent back to clients.
 */

const db = require('../db');

const TOKEN_MIN_LENGTH = 8;
const TOKEN_MAX_LENGTH = 300;

/** Machine-readable integration error (the PanelError pattern). */
class IntegrationError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'IntegrationError';
        this.status = status;
        this.code = code;
    }
}

/**
 * The integration catalog. `verify` exchanges a candidate token for a
 * display label, throwing on anything but a valid token. Providers are
 * lazy-required so this module stays cheap to load (smoke-test rule).
 */
const PROVIDERS = {
    github: {
        name: 'GitHub',
        description: 'Search code and read files in any repository your account can access, straight from chat.',
        tokenHint: 'Fine-grained personal access token (github.com → Settings → Developer settings). Read-only Contents access is enough.',
        docsUrl: 'https://github.com/settings/personal-access-tokens',
        async verify(token) {
            const githubService = require('./githubService');
            const viewer = await githubService.withToken(token).getViewer();
            return viewer?.login ? `@${viewer.login}` : 'GitHub account';
        }
    },
    notion: {
        name: 'Notion',
        description: 'Search your Notion workspace and read pages, so answers can be grounded in your own notes and docs.',
        tokenHint: 'Internal integration secret (notion.so/profile/integrations). Share the pages you want Goobster to see with that integration.',
        docsUrl: 'https://www.notion.so/profile/integrations',
        async verify(token) {
            const notionService = require('./notionService');
            const viewer = await notionService.getViewer(token);
            const workspace = viewer?.workspaceName;
            const name = viewer?.name || 'Notion integration';
            return workspace ? `${name} · ${workspace}` : name;
        }
    }
};

class UserIntegrationService {
    /** Provider keys the catalog knows about. */
    get providerKeys() {
        return Object.keys(PROVIDERS);
    }

    _requireProvider(provider) {
        const entry = PROVIDERS[String(provider || '').toLowerCase()];
        if (!entry) {
            throw new IntegrationError(404, 'NO_SUCH_PROVIDER',
                `Unknown integration "${provider}". Available: ${this.providerKeys.join(', ')}.`);
        }
        return { key: String(provider).toLowerCase(), ...entry };
    }

    /**
     * The full catalog with per-user connection status - what the web
     * portal's Integrations dialog renders. Tokens are never included.
     * @param {string} userId - Discord user snowflake
     * @returns {Array<{provider, name, description, tokenHint, docsUrl, connected, account, connectedAt}>}
     */
    list(userId) {
        const rows = db.all(
            'SELECT provider, accountLabel, createdAt FROM user_integrations WHERE userId = @userId',
            { userId }
        );
        const byProvider = new Map(rows.map(row => [row.provider, row]));
        return this.providerKeys.map(key => {
            const meta = PROVIDERS[key];
            const row = byProvider.get(key) || null;
            return {
                provider: key,
                name: meta.name,
                description: meta.description,
                tokenHint: meta.tokenHint,
                docsUrl: meta.docsUrl,
                connected: Boolean(row),
                account: row?.accountLabel ?? null,
                connectedAt: row?.createdAt ?? null
            };
        });
    }

    /**
     * Connect (or replace) one integration: verify the token live against
     * the provider, then store it with the account label snapshot.
     * @param {Object} params - { userId, provider, token }
     * @returns {Promise<Object>} the updated catalog entry (no token)
     */
    async connect({ userId, provider, token }) {
        const entry = this._requireProvider(provider);
        const clean = String(token ?? '').trim();
        if (clean.length < TOKEN_MIN_LENGTH || clean.length > TOKEN_MAX_LENGTH || /\s/.test(clean)) {
            throw new IntegrationError(400, 'BAD_TOKEN',
                `That doesn't look like a valid ${entry.name} token.`);
        }

        let accountLabel;
        try {
            accountLabel = await entry.verify(clean);
        } catch (error) {
            throw new IntegrationError(400, 'VERIFY_FAILED',
                `${entry.name} rejected that token: ${error.message}`);
        }

        db.run(
            `INSERT INTO user_integrations (userId, provider, token, accountLabel)
             VALUES (@userId, @provider, @token, @accountLabel)
             ON CONFLICT(userId, provider) DO UPDATE SET
                 token = @token,
                 accountLabel = @accountLabel,
                 updatedAt = datetime('now')`,
            { userId, provider: entry.key, token: clean, accountLabel }
        );
        return this.list(userId).find(item => item.provider === entry.key);
    }

    /**
     * Disconnect one integration (deletes the stored token).
     * @param {Object} params - { userId, provider }
     * @returns {{disconnected: boolean}}
     */
    disconnect({ userId, provider }) {
        const entry = this._requireProvider(provider);
        const result = db.run(
            'DELETE FROM user_integrations WHERE userId = @userId AND provider = @provider',
            { userId, provider: entry.key }
        );
        return { disconnected: result.changes > 0 };
    }

    /**
     * The stored token for one integration, or null when not connected.
     * Stamps lastUsedAt so the audit trail shows live usage.
     * @param {string} userId
     * @param {string} provider
     * @returns {string|null}
     */
    getToken(userId, provider) {
        const entry = this._requireProvider(provider);
        const row = db.get(
            'SELECT token FROM user_integrations WHERE userId = @userId AND provider = @provider',
            { userId, provider: entry.key }
        );
        if (!row) return null;
        db.run(
            `UPDATE user_integrations SET lastUsedAt = datetime('now')
             WHERE userId = @userId AND provider = @provider`,
            { userId, provider: entry.key }
        );
        return row.token;
    }

    /**
     * Connection status without touching lastUsedAt (for prompt/tool gating).
     * @param {string} userId
     * @returns {{github: boolean, notion: boolean}}
     */
    connectedProviders(userId) {
        const rows = db.all(
            'SELECT provider FROM user_integrations WHERE userId = @userId', { userId }
        );
        const connected = new Set(rows.map(row => row.provider));
        const out = {};
        for (const key of this.providerKeys) out[key] = connected.has(key);
        return out;
    }
}

module.exports = new UserIntegrationService();
module.exports.IntegrationError = IntegrationError;
module.exports.UserIntegrationService = UserIntegrationService;
