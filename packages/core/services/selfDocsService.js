/**
 * Self-knowledge: Goobster's own documentation as a queryable corpus.
 *
 * The repository's Markdown (README, documentation/**, including the
 * authored skill guides under documentation/skills/) plus any operator
 * notes under data/self-docs/ are chunked by heading and seeded into the
 * `self_docs` table - idempotently, keyed on a content hash, so a restart
 * with unchanged docs writes nothing. The `consultDocs` tool reads it.
 *
 * Retrieval is hybrid and degrades gracefully: BM25 keyword ranking always
 * works (no keys, no network); when an embedding backend is configured,
 * chunk vectors are backfilled in the background and fused in with
 * reciprocal-rank fusion. Vectors are tagged with their model and only
 * compared against a query embedded by the same model (memoryService's
 * rule). None of this is per-user data, so no privacy erasure path applies.
 *
 * The in-memory corpus index is transient, re-derivable state (rebuilt
 * from the table on demand, invalidated by a seed in this process, and
 * expired on a short TTL so the api process notices a bot re-seed).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const db = require('../db');
const config = require('../config/selfDocsConfig');
const { windowLines } = require('../utils/toolResultWindow');

const KINDS = ['guide', 'reference', 'standards', 'decision', 'skill'];
const CACHE_TTL_MS = 5 * 60 * 1000;
const LEXICAL_CANDIDATES = 40;
const SEMANTIC_CANDIDATES = 40;
const SEMANTIC_MIN_SCORE = 0.25;
const RRF_K = 60;
const MAX_CHUNKS_PER_DOC = 3;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/**
 * Kind multipliers on the keyword score: procedures and how-tos answer
 * most questions; decision records and plans describe history, so they
 * yield to the living docs when both match.
 */
const KIND_WEIGHT = { skill: 1.15, guide: 1.05, reference: 1, standards: 1, decision: 0.75 };

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'it', 'its', 'this', 'that',
    'with', 'as', 'by', 'be', 'are', 'was', 'were', 'at', 'from', 'how', 'do', 'does', 'did', 'i',
    'you', 'my', 'your', 'we', 'our', 'they', 'their', 'he', 'she', 'his', 'her', 'them', 'what',
    'which', 'who', 'when', 'where', 'why', 'can', 'could', 'should', 'would', 'will', 'shall',
    'may', 'might', 'have', 'has', 'had', 'been', 'being', 'into', 'than', 'then', 'there', 'these',
    'those', 'so', 'if', 'but', 'about', 'also', 'any', 'all', 'some', 'such', 'just', 'via', 'per',
    'me', 'us', 'am', 'up', 'out', 'get', 'got', 'one', 'two', 'ok'
]);

/** Float32Array -> BLOB and back (memoryService's storage convention). */
function vectorToBuffer(vector) {
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function bufferToVector(buffer, dims) {
    const copy = Buffer.from(buffer);
    return new Float32Array(copy.buffer, copy.byteOffset, dims);
}

/**
 * Very light English stemmer - enough to match "automations" to
 * "automation" and "enabling" / "enabled" / "enable" to one stem. Not
 * Porter; it only needs to be consistent between corpus and query.
 */
function stem(token) {
    if (token.length <= 3) return token;
    let t = token;
    if (t.endsWith('ies') && t.length > 4) t = `${t.slice(0, -3)}y`;
    else if (t.endsWith('ing') && t.length > 5) t = t.slice(0, -3);
    else if (t.endsWith('ed') && t.length > 4) t = t.slice(0, -2);
    else if (t.endsWith('es') && t.length > 4 && !t.endsWith('ses')) t = t.slice(0, -2);
    else if (t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
    if (t.endsWith('e') && t.length > 4) t = t.slice(0, -1);
    return t;
}

/**
 * Lowercased, stemmed tokens. Identifiers are indexed both whole and split
 * on camelCase / snake_case boundaries so "runCode" answers a query for
 * "run code" and one for "runcode".
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
    const out = [];
    const words = String(text || '').split(/[^A-Za-z0-9_]+/);
    for (const word of words) {
        if (!word) continue;
        const lower = word.toLowerCase();
        if (lower.length >= 2 && !STOP_WORDS.has(lower)) out.push(stem(lower));
        const parts = word.split(/_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/);
        if (parts.length > 1) {
            for (const part of parts) {
                const p = part.toLowerCase();
                if (p.length >= 2 && !STOP_WORDS.has(p)) out.push(stem(p));
            }
        }
    }
    return out;
}

function sha1(text) {
    return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

function clip(text, max) {
    const s = String(text || '').trim();
    return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function humanizeFileName(name) {
    return name.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function toPosix(p) {
    return p.split(path.sep).join('/');
}

/**
 * Stable document id from a repo-relative path: strip the extension, keep
 * the directory so operator docs (operator/...) never collide with shipped
 * ones.
 */
function slugFor(relPath) {
    return toPosix(relPath).replace(/\.md$/i, '').replace(/^\.\//, '');
}

/**
 * Split leading YAML front matter off a Markdown body.
 * @returns {{ meta: Object, body: string, error: string|null }}
 */
function splitFrontMatter(text) {
    const source = String(text || '').replace(/^\uFEFF/, '');
    if (!source.startsWith('---')) return { meta: {}, body: source, error: null };
    const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (!match) return { meta: {}, body: source, error: null };
    try {
        const parsed = YAML.parse(match[1]);
        const meta = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        return { meta, body: source.slice(match[0].length), error: null };
    } catch (error) {
        return { meta: {}, body: source.slice(match[0].length), error: `front matter: ${error.message}` };
    }
}

function inferKind(relPath) {
    const posix = toPosix(relPath).toLowerCase();
    const base = path.posix.basename(posix, '.md');
    if (posix.includes('/skills/')) return 'skill';
    // ADRs, design specs, plans, strategy and status notes record decisions
    // and history rather than describe the running software.
    if (posix.includes('/adr/') || /_spec$|_plan$|_strategy$|_status$/.test(base)) return 'decision';
    if (/standards|guidelines/.test(base)) return 'standards';
    if (/guide|setup|deployment|install|testing|troubleshoot/.test(base)) return 'guide';
    return 'reference';
}

/**
 * Split a Markdown body into heading-delimited chunks near `chunkChars`.
 * Fenced code blocks are never split or mistaken for headings. Small
 * neighbouring sections are merged; oversized sections are split on blank
 * lines, then on line boundaries as a last resort. Every chunk keeps the
 * heading lines it contains and carries a `Title > Section` breadcrumb.
 * @param {string} body
 * @param {{ title: string, chunkChars?: number }} opts
 * @returns {Array<{ headingPath: string, content: string }>}
 */
function chunkMarkdown(body, { title, chunkChars = config.chunkChars }) {
    const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
    const sections = [];
    let current = { path: [], lines: [] };
    let fence = null;
    let seenH1 = false;
    const stack = []; // [{ level, text }]

    const headingPath = () => {
        const names = stack.map(h => h.text).filter(t => t && t.toLowerCase() !== String(title).toLowerCase());
        return [title, ...names].filter(Boolean).join(' > ');
    };

    for (const line of lines) {
        const fenceMatch = line.match(/^\s*(```+|~~~+)/);
        if (fenceMatch) {
            if (!fence) fence = fenceMatch[1][0];
            else if (fenceMatch[1][0] === fence) fence = null;
            current.lines.push(line);
            continue;
        }
        const heading = !fence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (heading) {
            if (current.lines.some(l => l.trim())) sections.push({ path: headingPath(), lines: current.lines });
            const level = heading[1].length;
            while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
            // The first H1 is the document itself (its title may differ from
            // the front-matter title); later H1s are real top-level sections.
            if (level === 1 && !seenH1) seenH1 = true;
            else stack.push({ level, text: heading[2].replace(/[`*_]/g, '').trim() });
            current = { path: headingPath(), lines: [line] };
            continue;
        }
        current.lines.push(line);
    }
    if (current.lines.some(l => l.trim())) sections.push({ path: headingPath(), lines: current.lines });

    // Oversized sections -> paragraph-bounded pieces (never inside a fence).
    const pieces = [];
    for (const section of sections) {
        const text = section.lines.join('\n').trim();
        if (text.length <= chunkChars * 1.5) {
            pieces.push({ headingPath: section.path || title, content: text });
            continue;
        }
        for (const part of splitLong(section.lines, chunkChars)) {
            pieces.push({ headingPath: section.path || title, content: part });
        }
    }

    // Merge small neighbours so a doc of one-line sections is not 40 chunks.
    const merged = [];
    for (const piece of pieces) {
        const last = merged[merged.length - 1];
        if (last && last.content.length < chunkChars / 2
            && last.content.length + piece.content.length + 2 <= chunkChars) {
            last.content = `${last.content}\n\n${piece.content}`;
            last.headingPath = commonHeadingPrefix(last.headingPath, piece.headingPath) || title;
            continue;
        }
        merged.push({ ...piece });
    }
    return merged.filter(c => c.content.trim().length > 0);
}

/** "A > B > C" + "A > B > D" -> "A > B" (merged chunks keep the breadcrumb they share). */
function commonHeadingPrefix(a, b) {
    const pa = String(a || '').split(' > ');
    const pb = String(b || '').split(' > ');
    const out = [];
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
        if (pa[i] !== pb[i]) break;
        out.push(pa[i]);
    }
    return out.join(' > ');
}

/** Split lines into <= ~max-char parts at blank lines outside fences, then at line ends. */
function splitLong(lines, max) {
    const paragraphs = [];
    let buf = [];
    let fence = null;
    for (const line of lines) {
        const fenceMatch = line.match(/^\s*(```+|~~~+)/);
        if (fenceMatch) {
            if (!fence) fence = fenceMatch[1][0];
            else if (fenceMatch[1][0] === fence) fence = null;
        }
        if (!fence && line.trim() === '') {
            if (buf.length) paragraphs.push(buf.join('\n'));
            buf = [];
            continue;
        }
        buf.push(line);
    }
    if (buf.length) paragraphs.push(buf.join('\n'));

    const parts = [];
    let cur = '';
    const flush = () => { if (cur.trim()) parts.push(cur.trim()); cur = ''; };
    for (const paragraph of paragraphs) {
        if (paragraph.length > max * 1.5) {
            flush();
            // A single huge paragraph (long bullet list, table): cut at line ends.
            let acc = '';
            for (const line of paragraph.split('\n')) {
                if (acc && acc.length + line.length + 1 > max) { parts.push(acc.trim()); acc = ''; }
                acc += (acc ? '\n' : '') + line;
            }
            if (acc.trim()) parts.push(acc.trim());
            continue;
        }
        if (cur && cur.length + paragraph.length + 2 > max) flush();
        cur += (cur ? '\n\n' : '') + paragraph;
    }
    flush();
    return parts;
}

/**
 * The text under the first heading whose title contains `needle`
 * (case-insensitive, or matching on stemmed tokens), up to the next heading
 * of the same or a higher level. Fenced code is skipped when scanning.
 * @returns {string|null}
 */
function extractSection(text, needle) {
    const wanted = String(needle || '').toLowerCase().trim();
    const wantedTokens = tokenize(wanted).join(' ');
    if (!wanted) return null;
    const lines = String(text || '').split('\n');
    let fence = null;
    let start = -1;
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fenceMatch = line.match(/^\s*(```+|~~~+)/);
        if (fenceMatch) {
            if (!fence) fence = fenceMatch[1][0];
            else if (fenceMatch[1][0] === fence) fence = null;
            continue;
        }
        if (fence) continue;
        const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (!heading) continue;
        if (start === -1) {
            const title = heading[2].replace(/[`*_]/g, '').toLowerCase();
            if (title.includes(wanted) || (wantedTokens && tokenize(title).join(' ').includes(wantedTokens))) {
                start = i;
                level = heading[1].length;
            }
        } else if (heading[1].length <= level) {
            return lines.slice(start, i).join('\n').trim();
        }
    }
    return start === -1 ? null : lines.slice(start).join('\n').trim();
}

/**
 * Parse one Markdown document into its seedable form.
 * @param {string} text - raw file contents
 * @param {{ relPath: string, chunkChars?: number }} opts
 * @returns {{ slug, relPath, title, kind, summary, useWhen, tags, chunks, warnings }}
 */
function parseDoc(text, { relPath, chunkChars }) {
    const { meta, body, error } = splitFrontMatter(text);
    const warnings = error ? [error] : [];
    const firstH1 = body.match(/^#\s+(.+?)\s*$/m);
    const title = clip(meta.title || (firstH1 && firstH1[1].replace(/[`*_]/g, '')) || humanizeFileName(path.basename(relPath)), 160);

    let kind = String(meta.kind || '').toLowerCase().trim();
    if (kind && !KINDS.includes(kind)) {
        warnings.push(`unknown kind "${kind}" (allowed: ${KINDS.join(', ')})`);
        kind = '';
    }
    if (!kind) kind = inferKind(relPath);

    const firstParagraph = body
        .split(/\n\s*\n/)
        .map(p => p.trim())
        .find(p => p && !p.startsWith('#') && !p.startsWith('```') && !p.startsWith('|') && !p.startsWith('<!--'));
    const summary = clip(meta.summary || (firstParagraph || '').replace(/\s+/g, ' '), 320) || null;
    const useWhen = meta.when || meta.useWhen ? clip(meta.when || meta.useWhen, 320) : null;
    const rawTags = Array.isArray(meta.tags) ? meta.tags : String(meta.tags || '').split(/[,\s]+/);
    const tags = [...new Set(rawTags.map(t => String(t).toLowerCase().trim()).filter(Boolean))];

    const chunks = chunkMarkdown(body, { title, chunkChars }).map(chunk => ({
        ...chunk,
        hash: sha1(`${chunk.headingPath}\n${chunk.content}`)
    }));
    if (chunks.length === 0) warnings.push('document has no content');
    if (kind === 'skill' && !meta.summary) warnings.push('skill docs need a front-matter summary');

    return { slug: slugFor(relPath), relPath: toPosix(relPath), title, kind, summary, useWhen, tags, chunks, warnings };
}

class SelfDocsService {
    constructor() {
        this._cache = null;
        this._seededOnce = false;
        this._embeddingWarned = false;
    }

    get enabled() {
        return config.enabled;
    }

    // --- Corpus on disk ------------------------------------------------------

    /**
     * Enumerate the Markdown files that make up the corpus.
     * @param {{ sources?: string[], operatorDir?: string|null, workspaceRoot?: string }} [opts]
     * @returns {Array<{ relPath: string, absPath: string }>}
     */
    collectSources({ sources = config.sources, operatorDir = config.operatorDir, workspaceRoot = config.workspaceRoot } = {}) {
        const files = [];
        const seen = new Set();
        const add = (absPath, relPath) => {
            const key = toPosix(relPath);
            if (seen.has(key)) return;
            seen.add(key);
            files.push({ relPath: key, absPath });
        };
        const walk = (dir, relBase) => {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                const abs = path.join(dir, entry.name);
                const rel = path.join(relBase, entry.name);
                if (entry.isDirectory()) walk(abs, rel);
                else if (entry.isFile() && /\.md$/i.test(entry.name)) add(abs, rel);
            }
        };
        for (const source of sources) {
            const abs = path.isAbsolute(source) ? source : path.join(workspaceRoot, source);
            let stat;
            try { stat = fs.statSync(abs); } catch { continue; }
            // Absolute sources inside the workspace keep their repo-relative
            // path; ones outside it (tests, mounted volumes) use the basename
            // so slugs never start with "../".
            const inside = abs.startsWith(workspaceRoot + path.sep);
            const rel = path.isAbsolute(source)
                ? (inside ? path.relative(workspaceRoot, abs) : path.basename(abs))
                : source;
            if (stat.isDirectory()) walk(abs, rel);
            else if (/\.md$/i.test(abs)) add(abs, rel);
        }
        if (operatorDir) walk(operatorDir, 'operator');
        return files;
    }

    /**
     * Read and parse the whole corpus (no database access).
     * @returns {Array<ReturnType<typeof parseDoc>>}
     */
    loadCorpus(opts = {}) {
        const docs = [];
        for (const file of this.collectSources(opts)) {
            let text;
            try { text = fs.readFileSync(file.absPath, 'utf8'); } catch { continue; }
            if (!text.trim()) continue;
            docs.push(parseDoc(text, { relPath: file.relPath, chunkChars: opts.chunkChars }));
        }
        return docs;
    }

    /**
     * Build-time check: every doc parses, has a title and content, and no
     * two files map to one slug. Skill docs must declare a summary.
     * @returns {{ ok: boolean, docs: number, chunks: number, problems: string[] }}
     */
    validateCorpus(opts = {}) {
        const docs = this.loadCorpus(opts);
        const problems = [];
        const slugs = new Map();
        for (const doc of docs) {
            for (const warning of doc.warnings) problems.push(`${doc.relPath}: ${warning}`);
            if (slugs.has(doc.slug)) problems.push(`${doc.relPath}: slug "${doc.slug}" collides with ${slugs.get(doc.slug)}`);
            slugs.set(doc.slug, doc.relPath);
        }
        if (docs.length === 0) problems.push('no documentation found - check selfDocs.sources');
        return {
            ok: problems.length === 0,
            docs: docs.length,
            chunks: docs.reduce((n, d) => n + d.chunks.length, 0),
            problems
        };
    }

    // --- Seeding ---------------------------------------------------------------

    /**
     * Upsert the corpus into `self_docs`. Idempotent: unchanged chunks are
     * left alone (their embeddings survive), changed chunks are rewritten
     * with their vector cleared, trailing and vanished chunks are deleted.
     * Runs under the `self_docs_seed` singleton lock so two bot processes
     * on Postgres never interleave.
     * @returns {Promise<{ acquired: boolean, docs?: number, chunks?: number, inserted?: number, updated?: number, deleted?: number, unchanged?: number }>}
     */
    async seed(opts = {}) {
        const docs = this.loadCorpus(opts);
        const lock = await db.withSingletonLock('self_docs_seed', async () => {
            const existing = await db.all('SELECT id, slug, chunkIndex, contentHash FROM self_docs');
            const byKey = new Map(existing.map(row => [`${row.slug}\u0000${row.chunkIndex}`, row]));
            const stats = { docs: docs.length, chunks: 0, inserted: 0, updated: 0, deleted: 0, unchanged: 0 };

            await db.transaction(async (tx) => {
                const liveSlugs = new Set();
                for (const doc of docs) {
                    liveSlugs.add(doc.slug);
                    const meta = {
                        slug: doc.slug,
                        relPath: doc.relPath,
                        title: doc.title,
                        kind: doc.kind,
                        summary: doc.summary,
                        useWhen: doc.useWhen,
                        tags: JSON.stringify(doc.tags)
                    };
                    for (let i = 0; i < doc.chunks.length; i++) {
                        const chunk = doc.chunks[i];
                        stats.chunks++;
                        const row = byKey.get(`${doc.slug}\u0000${i}`);
                        if (row && row.contentHash === chunk.hash) {
                            stats.unchanged++;
                            continue;
                        }
                        if (row) {
                            await tx.run(
                                `UPDATE self_docs
                                 SET relPath = @relPath, title = @title, kind = @kind, summary = @summary,
                                     useWhen = @useWhen, tags = @tags, headingPath = @headingPath,
                                     content = @content, contentHash = @contentHash,
                                     embedding = NULL, dims = NULL, model = NULL,
                                     updatedAt = CURRENT_TIMESTAMP
                                 WHERE id = @id`,
                                { ...meta, id: row.id, headingPath: chunk.headingPath, content: chunk.content, contentHash: chunk.hash }
                            );
                            stats.updated++;
                        } else {
                            await tx.run(
                                `INSERT INTO self_docs (slug, relPath, title, kind, summary, useWhen, tags, chunkIndex, headingPath, content, contentHash)
                                 VALUES (@slug, @relPath, @title, @kind, @summary, @useWhen, @tags, @chunkIndex, @headingPath, @content, @contentHash)`,
                                { ...meta, chunkIndex: i, headingPath: chunk.headingPath, content: chunk.content, contentHash: chunk.hash }
                            );
                            stats.inserted++;
                        }
                    }
                    const trailing = await tx.run(
                        'DELETE FROM self_docs WHERE slug = @slug AND chunkIndex >= @count',
                        { slug: doc.slug, count: doc.chunks.length }
                    );
                    stats.deleted += trailing.changes || 0;
                    // Title / kind / summary can change without any chunk changing.
                    await tx.run(
                        `UPDATE self_docs SET relPath = @relPath, title = @title, kind = @kind,
                             summary = @summary, useWhen = @useWhen, tags = @tags
                         WHERE slug = @slug`,
                        meta
                    );
                }
                for (const slug of new Set(existing.map(row => row.slug))) {
                    if (liveSlugs.has(slug)) continue;
                    const gone = await tx.run('DELETE FROM self_docs WHERE slug = @slug', { slug });
                    stats.deleted += gone.changes || 0;
                }
            });
            this.invalidateCache();
            this._seededOnce = true;
            return stats;
        });
        return lock.acquired ? { acquired: true, ...lock.result } : { acquired: false };
    }

    /**
     * Startup hook: seed when enabled, then backfill embeddings in the
     * background (never blocks the ready handler, never throws).
     * @param {{ logger?: Object }} [opts]
     */
    async seedOnStartup({ logger } = {}) {
        if (!config.enabled || !config.seedOnStartup) return null;
        const result = await this.seed();
        if (result.acquired && config.embeddings) {
            setImmediate(() => {
                this.backfillEmbeddings()
                    .then(done => {
                        if (done.embedded > 0 && logger) {
                            logger.info(`Self-docs: embedded ${done.embedded} chunk(s) with ${done.model}`);
                        }
                    })
                    .catch(() => { /* best-effort; keyword ranking still works */ });
            });
        }
        return result;
    }

    /**
     * Seed lazily if the table is empty (the api process may start before
     * the bot ever ran). Cheap after the first call.
     */
    async ensureSeeded() {
        if (this._seededOnce || !config.enabled) return;
        const row = await db.get('SELECT COUNT(*) AS n FROM self_docs');
        if (Number(row?.n || 0) === 0) {
            await this.seed();
        }
        this._seededOnce = true;
    }

    /**
     * Embed chunks that have no vector for the current embedding model.
     * Stops at the first backend failure (no backend, Ollama down) and
     * reports it instead of throwing; keyword ranking is unaffected.
     * @param {{ batchSize?: number, maxBatches?: number }} [opts]
     * @returns {Promise<{ embedded: number, remaining: number, model: string|null, error: string|null }>}
     */
    async backfillEmbeddings({ batchSize = 32, maxBatches = 200 } = {}) {
        const embeddingService = require('./embeddingService');
        let model;
        try {
            model = embeddingService.getModelId();
        } catch (error) {
            return { embedded: 0, remaining: 0, model: null, error: error.message };
        }
        let embedded = 0;
        let error = null;
        for (let batch = 0; batch < maxBatches; batch++) {
            const rows = await db.all(
                `SELECT id, title, headingPath, content FROM self_docs
                 WHERE embedding IS NULL OR model IS NULL OR model != @model
                 ORDER BY id LIMIT @limit`,
                { model, limit: batchSize }
            );
            if (rows.length === 0) break;
            let results;
            try {
                results = await embeddingService.embedBatch(rows.map(row => `${row.headingPath || row.title}\n${row.content}`));
            } catch (err) {
                error = err.message;
                break;
            }
            await db.transaction(async (tx) => {
                for (let i = 0; i < rows.length; i++) {
                    const { vector, model: usedModel } = results[i];
                    await tx.run(
                        'UPDATE self_docs SET embedding = @embedding, dims = @dims, model = @model WHERE id = @id',
                        { id: rows[i].id, embedding: vectorToBuffer(vector), dims: vector.length, model: usedModel }
                    );
                }
            });
            embedded += rows.length;
            if (rows.length < batchSize) break;
        }
        if (embedded > 0) this.invalidateCache();
        const left = await db.get(
            'SELECT COUNT(*) AS n FROM self_docs WHERE embedding IS NULL OR model IS NULL OR model != @model',
            { model }
        );
        return { embedded, remaining: Number(left?.n || 0), model, error };
    }

    // --- Retrieval -------------------------------------------------------------

    invalidateCache() {
        this._cache = null;
    }

    async _corpus() {
        if (this._cache && Date.now() - this._cache.loadedAt < CACHE_TTL_MS) return this._cache;
        const rows = await db.all(
            `SELECT id, slug, relPath, title, kind, summary, useWhen, tags, chunkIndex, headingPath, content, embedding, dims, model
             FROM self_docs ORDER BY slug, chunkIndex`
        );
        const docs = rows.map(row => {
            const counts = new Map();
            const push = (tokens, weight) => {
                for (const token of tokens) counts.set(token, (counts.get(token) || 0) + weight);
            };
            push(tokenize(row.title), 3);
            push(tokenize(row.headingPath), 2);
            push(tokenize(safeTags(row.tags).join(' ')), 2);
            push(tokenize(row.content), 1);
            let length = 0;
            for (const n of counts.values()) length += n;
            return {
                id: row.id,
                slug: row.slug,
                relPath: row.relPath,
                title: row.title,
                kind: row.kind,
                summary: row.summary,
                useWhen: row.useWhen,
                tags: safeTags(row.tags),
                chunkIndex: row.chunkIndex,
                headingPath: row.headingPath,
                content: row.content,
                counts,
                length,
                vector: row.embedding && row.dims ? bufferToVector(row.embedding, row.dims) : null,
                model: row.model || null
            };
        });
        const df = new Map();
        for (const doc of docs) for (const term of doc.counts.keys()) df.set(term, (df.get(term) || 0) + 1);
        const avgLength = docs.length ? docs.reduce((n, d) => n + d.length, 0) / docs.length : 0;
        this._cache = { loadedAt: Date.now(), docs, df, avgLength };
        return this._cache;
    }

    _bm25(corpus, queryTerms) {
        const { docs, df, avgLength } = corpus;
        const N = docs.length;
        const scored = [];
        for (const doc of docs) {
            let score = 0;
            for (const term of queryTerms) {
                const tf = doc.counts.get(term);
                if (!tf) continue;
                const n = df.get(term) || 0;
                const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
                const norm = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / (avgLength || 1)));
                score += idf * (tf * (BM25_K1 + 1)) / norm;
            }
            if (score > 0) scored.push({ doc, score: score * (KIND_WEIGHT[doc.kind] || 1) });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored;
    }

    async _semantic(corpus, query) {
        if (!config.embeddings) return null;
        const withVectors = corpus.docs.filter(d => d.vector);
        if (withVectors.length === 0) return null;
        try {
            const embeddingService = require('./embeddingService');
            const { vector, model } = await embeddingService.embed(query.slice(0, 2000));
            const { cosineSimilarity } = embeddingService;
            const scored = withVectors
                .filter(d => d.model === model && d.vector.length === vector.length)
                .map(doc => ({ doc, score: cosineSimilarity(vector, doc.vector) }))
                .filter(entry => entry.score >= SEMANTIC_MIN_SCORE);
            if (scored.length === 0) return null;
            scored.sort((a, b) => b.score - a.score);
            return scored;
        } catch {
            return null; // no backend reachable - keyword ranking carries the query
        }
    }

    /**
     * Hybrid search over every chunk.
     * @param {{ query: string, kind?: string|null, limit?: number }} params
     * @returns {Promise<{ mode: 'hybrid'|'keyword'|'none', results: Array<{ slug, relPath, title, kind, headingPath, content, score }> }>}
     */
    async search({ query, kind = null, limit = 5 }) {
        const text = String(query || '').trim();
        if (!text) return { mode: 'none', results: [] };
        const bounded = Math.max(1, Math.min(Number(limit) || 5, config.maxSearchResults));
        const corpus = await this._corpus();
        const filtered = kind && KINDS.includes(kind)
            ? { ...corpus, docs: corpus.docs.filter(d => d.kind === kind) }
            : corpus;
        if (filtered.docs.length === 0) return { mode: 'none', results: [] };

        const lexical = this._bm25(filtered, [...new Set(tokenize(text))]).slice(0, LEXICAL_CANDIDATES);
        const semantic = (await this._semantic(filtered, text))?.slice(0, SEMANTIC_CANDIDATES) || null;

        const fused = new Map();
        const add = (list) => {
            list.forEach(({ doc, score }, rank) => {
                const entry = fused.get(doc.id) || { doc, score: 0, lexical: 0, cosine: 0 };
                entry.score += 1 / (RRF_K + rank + 1);
                if (list === lexical) entry.lexical = score; else entry.cosine = score;
                fused.set(doc.id, entry);
            });
        };
        add(lexical);
        if (semantic) add(semantic);

        const ranked = [...fused.values()].sort((a, b) => b.score - a.score);
        const perDoc = new Map();
        const results = [];
        for (const entry of ranked) {
            const n = perDoc.get(entry.doc.slug) || 0;
            if (n >= MAX_CHUNKS_PER_DOC) continue;
            perDoc.set(entry.doc.slug, n + 1);
            results.push({
                slug: entry.doc.slug,
                relPath: entry.doc.relPath,
                title: entry.doc.title,
                kind: entry.doc.kind,
                headingPath: entry.doc.headingPath,
                chunkIndex: entry.doc.chunkIndex,
                content: entry.doc.content,
                score: Math.round(entry.score * 10000) / 10000,
                lexical: Math.round(entry.lexical * 1000) / 1000,
                cosine: Math.round(entry.cosine * 1000) / 1000
            });
            if (results.length >= bounded) break;
        }
        return { mode: semantic ? 'hybrid' : 'keyword', results };
    }

    /**
     * The document index (one row per doc), optionally one kind only.
     * @param {{ kind?: string|null }} [params]
     */
    async listDocs({ kind = null } = {}) {
        const corpus = await this._corpus();
        const byDoc = new Map();
        for (const chunk of corpus.docs) {
            if (kind && chunk.kind !== kind) continue;
            const entry = byDoc.get(chunk.slug) || {
                slug: chunk.slug,
                relPath: chunk.relPath,
                title: chunk.title,
                kind: chunk.kind,
                summary: chunk.summary,
                useWhen: chunk.useWhen,
                tags: chunk.tags,
                chunks: 0,
                chars: 0
            };
            entry.chunks++;
            entry.chars += chunk.content.length;
            byDoc.set(chunk.slug, entry);
        }
        return [...byDoc.values()].sort((a, b) =>
            KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.title.localeCompare(b.title));
    }

    /**
     * Resolve a loose reference (slug, path, file name, or title) to a doc.
     * @returns {Promise<{ slug, relPath, title, kind }|null>}
     */
    async resolveDoc(ref) {
        const wanted = String(ref || '').trim();
        if (!wanted) return null;
        const docs = await this.listDocs();
        const norm = (s) => String(s || '').toLowerCase().replace(/\.md$/i, '').replace(/^\.\//, '');
        const target = norm(wanted);
        const exact = docs.find(d => norm(d.slug) === target || norm(d.relPath) === target || d.title.toLowerCase() === target);
        if (exact) return exact;
        const suffix = target.length >= 3
            ? docs.find(d => norm(d.slug).endsWith(`/${target}`) || norm(d.slug).endsWith(target))
            : null;
        if (suffix) return suffix;
        const terms = new Set(tokenize(wanted));
        if (terms.size === 0) return null;
        let best = null;
        for (const doc of docs) {
            const titleTerms = new Set([...tokenize(doc.title), ...tokenize(doc.slug)]);
            let hits = 0;
            for (const term of terms) if (titleTerms.has(term)) hits++;
            const score = hits / terms.size;
            if (score > (best?.score || 0)) best = { doc, score };
        }
        return best && best.score >= 0.5 ? best.doc : null;
    }

    /**
     * Read one document (or the sections under one heading) as a line
     * window, the same contract as the other file-shaped tools.
     * @param {{ ref: string, section?: string|null, offset?: number, limit?: number }} params
     * @returns {Promise<{ doc, window, sectionMatched: boolean, sections: string[] }|null>}
     */
    async readDoc({ ref, section = null, offset, limit }) {
        const doc = await this.resolveDoc(ref);
        if (!doc) return null;
        const corpus = await this._corpus();
        const chunks = corpus.docs.filter(c => c.slug === doc.slug);
        const sections = [...new Set(chunks.map(c => c.headingPath))];
        let selected = chunks;
        let sectionMatched = false;
        if (section) {
            const needle = String(section).toLowerCase().trim();
            const needleTokens = tokenize(needle).join(' ');
            const hits = chunks.filter(c => (needle && c.headingPath.toLowerCase().includes(needle))
                || (needleTokens && tokenize(c.headingPath).join(' ').includes(needleTokens)));
            if (hits.length > 0) {
                selected = hits;
                sectionMatched = true;
            }
        }
        let text = selected.map(c => c.content).join('\n\n');
        if (section && !sectionMatched) {
            // Small sections merge into one chunk, so also look for the heading
            // itself and cut at the next heading of the same or higher level.
            const cut = extractSection(chunks.map(c => c.content).join('\n\n'), section);
            if (cut) {
                text = cut;
                sectionMatched = true;
            }
        }
        return { doc, window: windowLines(text, { offset, limit }), sectionMatched, sections };
    }

    /** Corpus counts for the health/stats surfaces and the seed script. */
    async stats() {
        const rows = await db.all('SELECT kind, COUNT(*) AS chunks, COUNT(DISTINCT slug) AS docs FROM self_docs GROUP BY kind');
        let model = null;
        try { model = require('./embeddingService').getModelId(); } catch { /* no backend */ }
        const embedded = model
            ? await db.get('SELECT COUNT(*) AS n FROM self_docs WHERE model = @model', { model })
            : { n: 0 };
        return {
            docs: rows.reduce((n, r) => n + Number(r.docs), 0),
            chunks: rows.reduce((n, r) => n + Number(r.chunks), 0),
            byKind: Object.fromEntries(rows.map(r => [r.kind, { docs: Number(r.docs), chunks: Number(r.chunks) }])),
            embedded: Number(embedded?.n || 0),
            embeddingModel: model
        };
    }
}

function safeTags(json) {
    if (Array.isArray(json)) return json;
    try {
        const parsed = JSON.parse(json || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

module.exports = new SelfDocsService();
module.exports.KINDS = KINDS;
module.exports.parseDoc = parseDoc;
module.exports.chunkMarkdown = chunkMarkdown;
module.exports.tokenize = tokenize;
module.exports.splitFrontMatter = splitFrontMatter;
module.exports.slugFor = slugFor;
