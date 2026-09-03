/**
 * Shared caps and line-windowing for tool results.
 *
 * File-shaped tools (observatory `read`, `get_asset`, `readGithubFile`,
 * `readNotionPage`) return a line window instead of a silent head-clip.
 * Run stdout/stderr uses the same character budget. Transcript storage and
 * PRIOR TOOL RESULTS re-injection import these constants so a window the
 * model just saw is not recut to a few thousand characters on the next turn.
 */

/** Max characters of one tool result that reach the model and are persisted. */
const TOOL_RESULT_CHARS = 64_000;
/** stdout / stderr each, inside a run result (sandbox itself caps at 64 KB). */
const STREAM_CHARS = 32_000;
/** Per-result / whole-block caps when re-injecting prior transcripts. */
const PRIOR_RESULT_CHARS = 16_000;
const PRIOR_BLOCK_CHARS = 48_000;
/** Default / max line window for file reads. */
const DEFAULT_READ_LINES = 400;
const MAX_READ_LINES = 800;

function clampReadLimit(limit) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_READ_LINES;
    return Math.min(MAX_READ_LINES, Math.floor(n));
}

function clampReadOffset(offset) {
    const n = Number(offset);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.floor(n);
}

/**
 * Slice a text body into a 1-based line window, with a hard character cap
 * so one enormous line cannot blow the prompt.
 * @param {string} text
 * @param {{ offset?: number, limit?: number, maxChars?: number }} [opts]
 * @returns {{
 *   content: string,
 *   startLine: number,
 *   endLine: number,
 *   totalLines: number,
 *   truncated: boolean,
 *   nextOffset: number|null,
 *   charCapped: boolean
 * }}
 */
function windowLines(text, { offset, limit, maxChars = TOOL_RESULT_CHARS } = {}) {
    const raw = text == null ? '' : String(text);
    const lines = raw.split('\n');
    const totalLines = lines.length;
    const start = clampReadOffset(offset);
    if (start > totalLines) {
        return {
            content: '',
            startLine: start,
            endLine: totalLines,
            totalLines,
            truncated: false,
            nextOffset: null,
            charCapped: false
        };
    }
    const maxLines = clampReadLimit(limit);
    let slice = lines.slice(start - 1, start - 1 + maxLines);
    let charCapped = false;
    let content = slice.join('\n');
    if (content.length > maxChars) {
        while (slice.length > 1 && slice.join('\n').length > maxChars) {
            slice = slice.slice(0, -1);
        }
        content = slice.join('\n');
        if (content.length > maxChars) {
            content = content.slice(0, maxChars);
        }
        charCapped = true;
    }
    const endLine = start - 1 + slice.length;
    return {
        content,
        startLine: start,
        endLine,
        totalLines,
        truncated: endLine < totalLines || charCapped,
        nextOffset: endLine < totalLines ? endLine + 1 : null,
        charCapped
    };
}

/**
 * Human + model header for a line window, plus a fenced body.
 * @param {Object} params
 * @param {string} params.label - path or asset label (never an absolute path)
 * @param {number|null} [params.size]
 * @param {ReturnType<typeof windowLines>} params.window
 * @param {string} [params.fence] - highlight.js / markdown fence language
 */
function formatTextWindow({ label, size = null, window: win, fence = '' }) {
    if (win.startLine > win.totalLines) {
        return `${label} has ${win.totalLines} line${win.totalLines === 1 ? '' : 's'}; `
            + `offset=${win.startLine} is past the end.`;
    }
    const sizeBit = size != null ? ` (${size} bytes)` : '';
    const lines = [
        `${label} lines ${win.startLine}-${win.endLine} of ${win.totalLines}${sizeBit}`
    ];
    if (win.nextOffset) {
        lines.push(`… more remains; continue with offset=${win.nextOffset}`);
    } else if (win.charCapped) {
        lines.push('… this window hit the character cap; raise limit or read a narrower range');
    }
    lines.push('', `\`\`\`${fence || ''}`, win.content, '```');
    return lines.join('\n');
}

/**
 * Clip a stdout/stderr stream. The suffix says how much was omitted so the
 * model can decide to write the rest to a file and `read` it.
 * @param {string} text
 * @param {{ max?: number, hint?: string }} [opts]
 */
function clipStream(text, { max = STREAM_CHARS, hint = 'truncated' } = {}) {
    const raw = text == null ? '' : String(text);
    if (raw.length <= max) return raw;
    return `${raw.slice(0, max)}\n… [${hint}; ${raw.length - max} chars omitted]`;
}

const FENCE_BY_EXT = {
    '.py': 'python',
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.jsx': 'jsx',
    '.md': 'markdown',
    '.json': 'json',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.sh': 'bash',
    '.bash': 'bash',
    '.html': 'html',
    '.htm': 'html',
    '.css': 'css',
    '.sql': 'sql',
    '.toml': 'toml',
    '.xml': 'xml',
    '.csv': 'csv',
    '.tsv': 'tsv',
    '.txt': '',
    '.log': '',
    '.svg': 'xml'
};

function fenceLanguage(nameOrExt, fallback = '') {
    if (fallback) return fallback;
    const raw = String(nameOrExt || '');
    const ext = raw.startsWith('.') ? raw.toLowerCase() : require('node:path').extname(raw).toLowerCase();
    return FENCE_BY_EXT[ext] || '';
}

module.exports = {
    TOOL_RESULT_CHARS,
    STREAM_CHARS,
    PRIOR_RESULT_CHARS,
    PRIOR_BLOCK_CHARS,
    DEFAULT_READ_LINES,
    MAX_READ_LINES,
    clampReadLimit,
    clampReadOffset,
    windowLines,
    formatTextWindow,
    clipStream,
    fenceLanguage
};
