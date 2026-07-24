const integrationsConfig = require('../config/integrationsConfig');

const API_BASE = 'https://api.cursor.com';
const HTTP_TIMEOUT_MS = 30_000;

/** Run states that will never change again (polling can stop). */
const TERMINAL_STATUSES = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);

/** User-presentable Cursor API errors (machine-readable code + friendly message). */
class CursorAgentError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'CursorAgentError';
        this.code = code;
    }
}

/**
 * Cursor Cloud Agents API (v1) wrapper: launch coding agents against GitHub
 * repos, send follow-up runs, poll run status, and cancel. Plain fetch with
 * Bearer auth — no SDK. Requires CURSOR_API_KEY; every method throws
 * CursorAgentError('NOT_CONFIGURED') without it (graceful degradation is the
 * caller's job: commands reply with the message, nothing crashes).
 */
class CursorAgentService {
    get _apiKey() {
        return integrationsConfig.cursor.apiKey;
    }

    isConfigured() {
        return Boolean(this._apiKey);
    }

    _assertConfigured() {
        if (!this.isConfigured()) {
            throw new CursorAgentError('NOT_CONFIGURED', 'The Cursor integration is not configured (set CURSOR_API_KEY).');
        }
    }

    async _request(apiPath, { method = 'GET', body = null, params = null } = {}) {
        this._assertConfigured();
        const url = new URL(`${API_BASE}${apiPath}`);
        for (const [key, value] of Object.entries(params || {})) {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }

        let response;
        try {
            response = await fetch(url, {
                method,
                headers: {
                    Authorization: `Bearer ${this._apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
            });
        } catch (error) {
            throw new CursorAgentError('UNAVAILABLE', 'The Cursor API is unreachable right now.', { cause: error });
        }

        if (response.status === 401) {
            throw new CursorAgentError('BAD_KEY', 'The Cursor API rejected the configured API key (401).');
        }
        if (response.status === 404) {
            throw new CursorAgentError('NOT_FOUND', 'Cursor agent or run not found.');
        }
        if (!response.ok) {
            let detail = '';
            try {
                const errBody = await response.json();
                detail = errBody?.error?.message || errBody?.message || '';
            } catch {
                // non-JSON error body
            }
            throw new CursorAgentError('API_ERROR', `Cursor API request failed (${response.status})${detail ? `: ${detail}` : '.'}`);
        }
        if (response.status === 204) return null;
        return response.json();
    }

    /**
     * Launch a new cloud agent against a GitHub repo.
     * @param {{prompt: string, repo: string, ref?: string, autoCreatePr?: boolean, model?: string}} opts
     *   `repo` is "owner/name"; `ref` defaults to the repo's default branch.
     * @returns {Promise<{agent: object, run: object}>}
     */
    async launchAgent({ prompt, repo, ref = null, autoCreatePr = true, model = null }) {
        const body = {
            prompt: { text: String(prompt) },
            repos: [{
                url: `https://github.com/${repo}`,
                ...(ref ? { startingRef: ref } : {})
            }],
            autoCreatePR: Boolean(autoCreatePr)
        };
        const modelId = model || integrationsConfig.cursor.defaultModel;
        if (modelId) body.model = { id: modelId };
        return this._request('/v1/agents', { method: 'POST', body });
    }

    /** Send a follow-up prompt to an existing agent (creates a new run). */
    async followUp(agentId, prompt) {
        return this._request(`/v1/agents/${encodeURIComponent(agentId)}/runs`, {
            method: 'POST',
            body: { prompt: { text: String(prompt) } }
        });
    }

    /** Durable agent metadata (name, repos, url, latestRunId). */
    async getAgent(agentId) {
        return this._request(`/v1/agents/${encodeURIComponent(agentId)}`);
    }

    /** Run status; terminal runs include `result`, `durationMs`, and `git.branches[]`. */
    async getRun(agentId, runId) {
        return this._request(`/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`);
    }

    /** Runs for an agent, newest first. */
    async listRuns(agentId, { limit = 20 } = {}) {
        const data = await this._request(`/v1/agents/${encodeURIComponent(agentId)}/runs`, { params: { limit } });
        return data.items || [];
    }

    /** Cancel an in-flight run. */
    async cancelRun(agentId, runId) {
        return this._request(`/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
    }

    /** Model IDs accepted by launchAgent. */
    async listModels() {
        const data = await this._request('/v1/models');
        return data.models || data.items || [];
    }

    /** True when a run status will never change again. */
    isTerminalStatus(status) {
        return TERMINAL_STATUSES.has(String(status || '').toUpperCase());
    }
}

module.exports = new CursorAgentService();
module.exports.CursorAgentError = CursorAgentError;
module.exports.CursorAgentService = CursorAgentService;
module.exports.TERMINAL_STATUSES = TERMINAL_STATUSES;
