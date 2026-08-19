/**
 * Knowledge-graph artifact storage limits and classification.
 * Spec: documentation/user_knowledge_graph.md (Artifacts section)
 */

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_INCOMING_ATTACHMENTS = 4;
const MAX_EXTRACTED_TEXT = 8000;
const MAX_ARTIFACTS_PER_SCOPE = 120;

const CODE_EXTENSIONS = new Set([
    'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
    'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh',
    'sql', 'yaml', 'yml', 'toml', 'json', 'xml', 'html', 'htm', 'css', 'scss', 'less',
    'vue', 'svelte', 'lua', 'pl', 'r', 'dart', 'ex', 'exs', 'md'
]);

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);

const DOCUMENT_EXTENSIONS = new Set(['txt', 'csv', 'log', 'rst', 'tex']);

const ARTIFACT_KINDS = ['image', 'pdf', 'markdown', 'code', 'document', 'other'];

function extensionOf(name) {
    const base = String(name || '').split(/[/\\]/).pop() || '';
    const idx = base.lastIndexOf('.');
    return idx >= 0 ? base.slice(idx + 1).toLowerCase() : '';
}

function classifyArtifactKind({ name, mimeType } = {}) {
    const mime = String(mimeType || '').toLowerCase();
    const ext = extensionOf(name);
    if (mime.startsWith('image/')) return 'image';
    if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
    if (MARKDOWN_EXTENSIONS.has(ext) || mime.includes('markdown')) return 'markdown';
    if (CODE_EXTENSIONS.has(ext)) return 'code';
    if (DOCUMENT_EXTENSIONS.has(ext) || mime.startsWith('text/')) return 'document';
    return 'other';
}

function sanitizeFilename(name) {
    const base = String(name || 'attachment').split(/[/\\]/).pop() || 'attachment';
    return base.replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 120) || 'attachment';
}

module.exports = {
    MAX_ARTIFACT_BYTES,
    MAX_INCOMING_ATTACHMENTS,
    MAX_EXTRACTED_TEXT,
    MAX_ARTIFACTS_PER_SCOPE,
    ARTIFACT_KINDS,
    classifyArtifactKind,
    sanitizeFilename,
    extensionOf
};
