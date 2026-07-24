const integrationsConfig = require('../config/integrationsConfig');

const API_BASE = 'https://api.github.com';
const HTTP_TIMEOUT_MS = 15_000;
// Contents fetched for chat/tool consumption are capped so a single file
// can never blow up a prompt (or a Pi's memory).
const MAX_FILE_BYTES = 100_000;

/** User-presentable GitHub errors (machine-readable code + friendly message). */
class GitHubError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'GitHubError';
        this.code = code;
    }
}

/**
 * Read-only GitHub REST v3 wrapper (plain fetch, no SDK — same pattern as
 * anthropicService). A fine-grained PAT is optional: public-repo reads work
 * keyless, a token raises rate limits and unlocks code search and private
 * repos. All methods throw GitHubError; callers surface `.message` directly.
 */
class GitHubService {
    get _token() {
        return integrationsConfig.github.token;
    }

    /** True when a token is configured (higher limits, code search, private repos). */
    hasToken() {
        return Boolean(this._token);
    }

    /**
     * Normalize and validate an "owner/name" repo reference.
     * Accepts a bare owner/name or a full github.com URL.
     * @throws {GitHubError} BAD_REPO
     */
    parseRepo(input) {
        let cleaned = String(input || '').trim();
        const urlMatch = cleaned.match(/github\.com[/:]([^/]+\/[^/#?]+)/i);
        if (urlMatch) cleaned = urlMatch[1];
        cleaned = cleaned.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cleaned)) {
            throw new GitHubError('BAD_REPO', `"${input}" doesn't look like an owner/name GitHub repository.`);
        }
        return cleaned;
    }

    async _request(apiPath, { params = null, accept = 'application/vnd.github+json' } = {}) {
        const url = new URL(`${API_BASE}${apiPath}`);
        for (const [key, value] of Object.entries(params || {})) {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }

        const headers = {
            Accept: accept,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'GoobsterBot/1.0'
        };
        if (this._token) headers.Authorization = `Bearer ${this._token}`;

        let response;
        try {
            response = await fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
        } catch (error) {
            throw new GitHubError('UNAVAILABLE', 'GitHub is unreachable right now.', { cause: error });
        }

        if (response.status === 404) {
            throw new GitHubError('NOT_FOUND', 'GitHub returned 404 — repo, item, or path not found (private repos need a token).');
        }
        if (response.status === 401) {
            throw new GitHubError('BAD_TOKEN', 'GitHub rejected the configured token (401).');
        }
        if (response.status === 403 || response.status === 429) {
            const remaining = response.headers.get('x-ratelimit-remaining');
            throw new GitHubError(
                remaining === '0' ? 'RATE_LIMITED' : 'FORBIDDEN',
                remaining === '0'
                    ? 'GitHub rate limit hit — add a GITHUB_TOKEN to raise it.'
                    : 'GitHub refused the request (403).'
            );
        }
        if (!response.ok) {
            throw new GitHubError('UNAVAILABLE', `GitHub request failed (${response.status}).`);
        }
        return response.json();
    }

    /** Repository overview (name, description, stars, forks, open issues, default branch). */
    async getRepo(rawRepo) {
        const repo = this.parseRepo(rawRepo);
        return this._request(`/repos/${repo}`);
    }

    /** Recent commits, newest first. */
    async listCommits(rawRepo, { since = null, limit = 10 } = {}) {
        const repo = this.parseRepo(rawRepo);
        return this._request(`/repos/${repo}/commits`, { params: { since, per_page: limit } });
    }

    /** Pull requests (state: open|closed|all). */
    async listPullRequests(rawRepo, { state = 'open', limit = 10 } = {}) {
        const repo = this.parseRepo(rawRepo);
        return this._request(`/repos/${repo}/pulls`, { params: { state, per_page: limit } });
    }

    /** One pull request with stats (additions, deletions, changed_files). */
    async getPullRequest(rawRepo, number) {
        const repo = this.parseRepo(rawRepo);
        return this._request(`/repos/${repo}/pulls/${Number(number)}`);
    }

    /** Files touched by a pull request (path + patch stats), capped. */
    async listPullRequestFiles(rawRepo, number, { limit = 30 } = {}) {
        const repo = this.parseRepo(rawRepo);
        return this._request(`/repos/${repo}/pulls/${Number(number)}/files`, { params: { per_page: limit } });
    }

    /** Issues (GitHub's endpoint also returns PRs; callers may filter on pull_request). */
    async listIssues(rawRepo, { state = 'open', limit = 10 } = {}) {
        const repo = this.parseRepo(rawRepo);
        return this._request(`/repos/${repo}/issues`, { params: { state, per_page: limit } });
    }

    /** One issue by number. */
    async getIssue(rawRepo, number) {
        const repo = this.parseRepo(rawRepo);
        return this._request(`/repos/${repo}/issues/${Number(number)}`);
    }

    /**
     * Code search scoped to one repo. Requires a token (GitHub's search API
     * rejects anonymous code search).
     * @returns {Promise<Array<{path, url, repository}>>}
     */
    async searchCode(rawRepo, query, { limit = 8 } = {}) {
        if (!this.hasToken()) {
            throw new GitHubError('TOKEN_REQUIRED', 'GitHub code search needs a GITHUB_TOKEN configured.');
        }
        const repo = this.parseRepo(rawRepo);
        const data = await this._request('/search/code', {
            params: { q: `${query} repo:${repo}`, per_page: limit }
        });
        return (data.items || []).map(item => ({
            path: item.path,
            url: item.html_url,
            repository: item.repository?.full_name || repo
        }));
    }

    /**
     * Fetch a file's text content at an optional ref. Size-capped; binary or
     * oversized files are refused rather than truncated mid-encoding.
     * @returns {Promise<{path, ref, size, content}>}
     */
    async getFileContent(rawRepo, filePath, { ref = null } = {}) {
        const repo = this.parseRepo(rawRepo);
        const cleanPath = String(filePath || '').replace(/^\/+/, '');
        const data = await this._request(
            `/repos/${repo}/contents/${cleanPath.split('/').map(encodeURIComponent).join('/')}`,
            { params: { ref } }
        );
        if (Array.isArray(data)) {
            throw new GitHubError('IS_DIRECTORY', `"${cleanPath}" is a directory, not a file.`);
        }
        if (data.size > MAX_FILE_BYTES) {
            throw new GitHubError('TOO_LARGE', `"${cleanPath}" is ${data.size} bytes — too large to fetch (max ${MAX_FILE_BYTES}).`);
        }
        if (data.encoding !== 'base64' || typeof data.content !== 'string') {
            throw new GitHubError('UNAVAILABLE', `Couldn't decode "${cleanPath}" (unexpected encoding).`);
        }
        return {
            path: data.path,
            ref: ref || null,
            size: data.size,
            content: Buffer.from(data.content, 'base64').toString('utf8')
        };
    }
}

module.exports = new GitHubService();
module.exports.GitHubError = GitHubError;
module.exports.GitHubService = GitHubService;
