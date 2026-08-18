/**
 * Read-only Notion REST wrapper (plain fetch, no SDK - the githubService
 * pattern). Every call takes the requesting user's personal integration
 * token (user_integrations via userIntegrationService); nothing here reads
 * global config, because Notion access is always per-user.
 *
 * All methods throw NotionError; callers surface `.message` directly.
 */

const API_BASE = 'https://api.notion.com';
const NOTION_VERSION = '2022-06-28';
const HTTP_TIMEOUT_MS = 15_000;
// Bounds for content fetched into a prompt (same philosophy as the GitHub
// file cap): a single page can never blow up the context window.
const MAX_PAGE_CHARS = 12_000;
const MAX_BLOCK_DEPTH = 3;
const MAX_BLOCK_REQUESTS = 12;

/** User-presentable Notion errors (machine-readable code + friendly message). */
class NotionError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'NotionError';
        this.code = code;
    }
}

/**
 * Normalize a page reference: a UUID (with or without dashes) or a Notion
 * URL whose last path segment ends in the 32-hex page id.
 * @throws {NotionError} BAD_PAGE_ID
 */
function normalizePageId(input) {
    const raw = String(input || '').trim();
    // Grab the last 32-hex run (URLs embed the id at the end of the slug)
    const match = raw.replace(/-/g, '').match(/[0-9a-f]{32}(?![0-9a-f])/gi);
    if (!match || match.length === 0) {
        throw new NotionError('BAD_PAGE_ID', `"${input}" doesn't look like a Notion page id or URL.`);
    }
    const hex = match[match.length - 1].toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Join a Notion rich_text array into plain text. */
function richTextToPlain(richText) {
    if (!Array.isArray(richText)) return '';
    return richText.map(part => part?.plain_text ?? '').join('');
}

/** Best-effort title for a page or database object. */
function titleOf(item) {
    if (item?.object === 'database') {
        return richTextToPlain(item.title) || 'Untitled database';
    }
    for (const prop of Object.values(item?.properties || {})) {
        if (prop?.type === 'title') {
            return richTextToPlain(prop.title) || 'Untitled';
        }
    }
    return 'Untitled';
}

/** Render one block as a markdown-ish line ('' = skip silently). */
function blockToText(block) {
    const type = block?.type;
    const data = block?.[type];
    switch (type) {
        case 'paragraph': return richTextToPlain(data?.rich_text);
        case 'heading_1': return `# ${richTextToPlain(data?.rich_text)}`;
        case 'heading_2': return `## ${richTextToPlain(data?.rich_text)}`;
        case 'heading_3': return `### ${richTextToPlain(data?.rich_text)}`;
        case 'bulleted_list_item': return `- ${richTextToPlain(data?.rich_text)}`;
        case 'numbered_list_item': return `1. ${richTextToPlain(data?.rich_text)}`;
        case 'to_do': return `- [${data?.checked ? 'x' : ' '}] ${richTextToPlain(data?.rich_text)}`;
        case 'toggle': return `> ${richTextToPlain(data?.rich_text)}`;
        case 'quote': return `> ${richTextToPlain(data?.rich_text)}`;
        case 'callout': return `> ${richTextToPlain(data?.rich_text)}`;
        case 'code': return `\`\`\`${data?.language || ''}\n${richTextToPlain(data?.rich_text)}\n\`\`\``;
        case 'divider': return '---';
        case 'child_page': return `[Sub-page: ${data?.title || 'Untitled'}]`;
        case 'child_database': return `[Database: ${data?.title || 'Untitled'}]`;
        case 'bookmark': return data?.url ? `[Bookmark: ${data.url}]` : '';
        case 'equation': return data?.expression ? `\\[${data.expression}\\]` : '';
        default: return '';
    }
}

class NotionService {
    async _request(token, apiPath, { method = 'GET', body = null, params = null } = {}) {
        const url = new URL(`${API_BASE}${apiPath}`);
        for (const [key, value] of Object.entries(params || {})) {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }

        let response;
        try {
            response = await fetch(url, {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Notion-Version': NOTION_VERSION,
                    ...(body ? { 'Content-Type': 'application/json' } : {})
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
            });
        } catch (error) {
            throw new NotionError('UNAVAILABLE', 'Notion is unreachable right now.', { cause: error });
        }

        if (response.status === 401) {
            throw new NotionError('BAD_TOKEN', 'Notion rejected the token (401) - reconnect the integration.');
        }
        if (response.status === 403) {
            throw new NotionError('FORBIDDEN', 'Notion refused the request (403) - the integration may lack access to that content.');
        }
        if (response.status === 404) {
            throw new NotionError('NOT_FOUND', 'Notion returned 404 - the page may not be shared with the integration.');
        }
        if (response.status === 429) {
            throw new NotionError('RATE_LIMITED', 'Notion rate limit hit - try again in a moment.');
        }
        if (!response.ok) {
            throw new NotionError('UNAVAILABLE', `Notion request failed (${response.status}).`);
        }
        return response.json();
    }

    /**
     * The token's own bot user - used to verify a token at connect time.
     * @returns {Promise<{name: string|null, workspaceName: string|null}>}
     */
    async getViewer(token) {
        const data = await this._request(token, '/v1/users/me');
        return {
            name: data?.name ?? null,
            workspaceName: data?.bot?.workspace_name ?? null
        };
    }

    /**
     * Workspace search across everything shared with the integration.
     * @returns {Promise<Array<{id, kind, title, url, lastEdited}>>}
     */
    async search(token, query, { limit = 8 } = {}) {
        const data = await this._request(token, '/v1/search', {
            method: 'POST',
            body: {
                query: String(query || '').slice(0, 200),
                page_size: Math.max(1, Math.min(Number(limit) || 8, 20))
            }
        });
        return (data.results || []).map(item => ({
            id: item.id,
            kind: item.object,
            title: titleOf(item),
            url: item.url || null,
            lastEdited: item.last_edited_time || null
        }));
    }

    /**
     * A page's title plus its content flattened to markdown-ish text.
     * Traversal is bounded (depth, request count, and character cap) so one
     * page can never blow up a prompt.
     * @returns {Promise<{id, title, url, content, truncated}>}
     */
    async getPageText(token, pageRef) {
        const pageId = normalizePageId(pageRef);
        const page = await this._request(token, `/v1/pages/${pageId}`);

        const lines = [];
        let chars = 0;
        let requests = 0;
        let truncated = false;

        const walk = async (blockId, depth) => {
            if (truncated || depth > MAX_BLOCK_DEPTH) return;
            let cursor;
            do {
                if (requests >= MAX_BLOCK_REQUESTS) { truncated = true; return; }
                requests += 1;
                const batch = await this._request(token, `/v1/blocks/${blockId}/children`, {
                    params: { page_size: 100, start_cursor: cursor }
                });
                for (const block of batch.results || []) {
                    const text = blockToText(block);
                    if (text) {
                        const indented = depth > 0 ? `${'  '.repeat(depth)}${text}` : text;
                        lines.push(indented);
                        chars += indented.length + 1;
                        if (chars > MAX_PAGE_CHARS) { truncated = true; return; }
                    }
                    if (block?.has_children && block.type !== 'child_page' && block.type !== 'child_database') {
                        await walk(block.id, depth + 1);
                        if (truncated) return;
                    }
                }
                cursor = batch.has_more ? batch.next_cursor : null;
            } while (cursor);
        };

        await walk(pageId, 0);

        return {
            id: pageId,
            title: titleOf(page),
            url: page.url || null,
            content: lines.join('\n'),
            truncated
        };
    }
}

module.exports = new NotionService();
module.exports.NotionError = NotionError;
module.exports.normalizePageId = normalizePageId;
