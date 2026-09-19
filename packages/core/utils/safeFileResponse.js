const path = require('node:path');

// Only passive media may render inline. Everything else is downloaded as
// plain text or opaque bytes, including old HTML/SVG artifacts. Never infer
// an executable response type from an untrusted file's extension.
const INLINE_TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm'
};
const TEXT_EXTENSIONS = new Set([
    '.txt', '.csv', '.tsv', '.md', '.markdown', '.json', '.jsonl', '.ndjson',
    '.yaml', '.yml', '.toml', '.xml', '.html', '.htm', '.xhtml', '.xht',
    '.svg', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.py',
    '.sh', '.sql', '.log'
]);

function safeFileResponseHeaders(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const inlineType = INLINE_TYPES[ext];
    const downloadName = encodeURIComponent(path.basename(filePath))
        .replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return {
        'Content-Type': inlineType || (TEXT_EXTENSIONS.has(ext)
            ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
        'Content-Disposition': inlineType ? 'inline' : `attachment; filename*=UTF-8''${downloadName}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Cache-Control': 'private, no-store'
    };
}

module.exports = { safeFileResponseHeaders };
