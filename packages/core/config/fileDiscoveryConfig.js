/**
 * Files found on the web for the user (the findImages / fetchWebFile /
 * showSavedFiles tools): download caps, accepted types, and provider
 * identification. Every knob is a hard ceiling - the model never chooses
 * how big a download may be or which content types are acceptable.
 */

const { MAX_ARTIFACT_BYTES } = require('./kgArtifactConfig');

let version = '1.0.0';
try {
    version = require('../../../package.json').version || version;
} catch { /* workspace layout without a root package.json */ }

/** Hard cap on any single downloaded file (shares the artifact ceiling). */
const MAX_FILE_BYTES = MAX_ARTIFACT_BYTES;

/** Images the model may ask for in one findImages call. */
const MAX_IMAGES_PER_CALL = 4;
const DEFAULT_IMAGES_PER_CALL = 2;

/** Saved files re-displayed by one showSavedFiles call. */
const MAX_RECALL_PER_CALL = 4;

/** Redirect hops fetchWebFile will re-vet (each hop goes back through assessUrl + resolvePinned). */
const MAX_REDIRECTS = 3;

/** Whole-transfer wall clock for one download. */
const FETCH_TIMEOUT_MS = 30_000;

/** Provider API calls (search, not the download). */
const SEARCH_TIMEOUT_MS = 15_000;

/** Search hits smaller than this on either side are skipped (icons, thumbnails). */
const MIN_IMAGE_DIMENSION = 200;

/** Width requested for Wikimedia thumbnails - big enough to look at, small enough to store. */
const THUMB_WIDTH = 1024;

/** Characters of a text-shaped file echoed back to the model as a preview. */
const PREVIEW_CHARS = 1500;

/** CSV rows summarized for the model. */
const PREVIEW_ROWS = 5;

/**
 * Wikimedia's API etiquette asks for an identifying User-Agent with a
 * contact URL; a generic one gets throttled.
 */
const USER_AGENT = `Goobster/${version} (https://github.com/nervous-rob/goobster; self-hosted Discord companion)`;

/** Content-type prefixes fetchWebFile accepts. Web PAGES are not files. */
const ALLOWED_CONTENT_TYPES = [
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
    'text/plain', 'text/csv', 'text/tab-separated-values', 'text/markdown', 'text/x-markdown',
    'text/x-python', 'text/javascript', 'text/x-yaml', 'text/yaml', 'text/xml',
    'application/json', 'application/ld+json', 'application/x-ndjson', 'application/geo+json',
    'application/csv', 'application/x-csv',
    'application/xml', 'application/x-yaml', 'application/yaml', 'application/toml',
    'application/javascript', 'application/x-javascript',
    'application/pdf',
    // Servers routinely mislabel data files; accepted only when the URL's
    // extension is a known text/data type (see fileDiscoveryService).
    'application/octet-stream'
];

/** Types refused even though the file route could store them: they execute on the app origin. */
const REFUSED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'image/svg+xml'];

/** Extensions that make an `application/octet-stream` answer acceptable. */
const OCTET_STREAM_EXTENSIONS = new Set([
    'csv', 'tsv', 'txt', 'md', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'xml',
    'py', 'js', 'ts', 'sh', 'sql', 'log', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'
]);

/** File extension picked when the URL has none, keyed by content type. */
const EXTENSION_BY_MIME = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
    'text/plain': 'txt', 'text/csv': 'csv', 'application/csv': 'csv', 'application/x-csv': 'csv',
    'text/tab-separated-values': 'tsv', 'text/markdown': 'md', 'text/x-markdown': 'md',
    'application/json': 'json', 'application/ld+json': 'json', 'application/geo+json': 'json',
    'application/x-ndjson': 'jsonl', 'application/xml': 'xml', 'text/xml': 'xml',
    'application/x-yaml': 'yaml', 'application/yaml': 'yaml', 'text/x-yaml': 'yaml', 'text/yaml': 'yaml',
    'application/toml': 'toml', 'application/javascript': 'js', 'application/x-javascript': 'js',
    'text/javascript': 'js', 'text/x-python': 'py', 'application/pdf': 'pdf'
};

/** Reverse of EXTENSION_BY_MIME (first mime wins) plus the aliases servers never label. */
const MIME_BY_EXTENSION = Object.entries(EXTENSION_BY_MIME).reduce((acc, [mime, ext]) => {
    if (!acc[ext]) acc[ext] = mime;
    return acc;
}, {
    jpeg: 'image/jpeg', yml: 'application/yaml', jsonl: 'application/x-ndjson', ndjson: 'application/x-ndjson',
    tsv: 'text/tab-separated-values', sh: 'text/plain', sql: 'text/plain', ts: 'text/plain', log: 'text/plain'
});

module.exports = {
    MAX_FILE_BYTES,
    MIME_BY_EXTENSION,
    MAX_IMAGES_PER_CALL,
    DEFAULT_IMAGES_PER_CALL,
    MAX_RECALL_PER_CALL,
    MAX_REDIRECTS,
    FETCH_TIMEOUT_MS,
    SEARCH_TIMEOUT_MS,
    MIN_IMAGE_DIMENSION,
    THUMB_WIDTH,
    PREVIEW_CHARS,
    PREVIEW_ROWS,
    USER_AGENT,
    ALLOWED_CONTENT_TYPES,
    REFUSED_CONTENT_TYPES,
    OCTET_STREAM_EXTENSIONS,
    EXTENSION_BY_MIME
};
