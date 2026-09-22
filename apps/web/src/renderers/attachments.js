import { accountFetch, ACCOUNT_STORAGE_CHANGED } from '../lib/browserAccount';
/**
 * Inline renderers for tool-generated / found-on-the-web file attachments
 * (shared by the Study, the Parlor, and history reloads via Markdown.tsx).
 *
 *   image                 → <figure> with the picture and a caption line
 *                           (credit / license / source link)
 *   csv, tsv              → a table card: header row, first rows, sortable
 *                           columns, row count, download
 *   md                    → a preview card rendering the Markdown
 *   json/txt/code/yaml/…  → a preview card with highlighted source
 *   everything else       → the download chip
 *
 * Files are fetched from the owner-bound `/api/app/files/:id` route with
 * the session cookie, parsed in the browser, and never executed: table
 * cells and code are text nodes, Markdown goes through the escape-first
 * renderer. Every preview is bounded (rows, characters) so a large file
 * stays cheap to open.
 *
 * Rendering is a reconciliation, not an append: `renderAttachments` keys
 * every card by a durable attachment id (the file id in the URL, else
 * URL + name) and keeps an existing card whose attachment is unchanged.
 * A parent rerender - a new array instance, a changed callback, a
 * streaming update - therefore never refetches, never duplicates a card
 * or a toggle, and never loses a collapse or sort choice. UI state
 * (collapsed, sort column) lives in a module-level store keyed the same
 * way, so it also survives the card being rebuilt after a history reload.
 * In-flight fetches carry an AbortController: a card that is replaced or
 * unmounted aborts its request, and a late response can never write into
 * a card it does not belong to.
 */

import { renderMarkdown } from './markdown.js';
import { highlight } from './highlight.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)$/i;
const CSV_EXT = /\.(csv|tsv)$/i;
const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;
const TEXT_EXT = /\.(txt|log|json|jsonl|ndjson|geojson|ya?ml|toml|xml|ini|cfg|conf|env|sql|sh|bash|zsh|py|js|mjs|cjs|ts|tsx|jsx|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|lua|r|dart|css|scss|less|rst|tex|csv)$/i;

const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLS = 40;
const MAX_PREVIEW_CHARS = 12_000;
const MAX_FETCH_BYTES = 6 * 1024 * 1024;

/**
 * A text/Markdown preview is "long" - and starts collapsed - past either
 * bound. Short files open expanded so a config snippet is readable at once.
 */
export const LONG_PREVIEW_LINES = 40;
export const LONG_PREVIEW_CHARS = 2_500;

const LANG_BY_EXT = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
    c: 'c', cc: 'cpp', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp', php: 'php', lua: 'lua', r: 'r', dart: 'dart',
    sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', json: 'json', jsonl: 'json', ndjson: 'json', geojson: 'json',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'html', css: 'css', scss: 'css', less: 'css', ini: 'ini', cfg: 'ini',
    conf: 'ini', env: 'bash', txt: '', log: '', rst: '', tex: ''
};

const FILE_ROUTE = /\/api\/app\/files\/([^/?#]+)/;

function extensionOf(name) {
    const base = String(name || '').split(/[/\\]/).pop() || '';
    const idx = base.lastIndexOf('.');
    return idx >= 0 ? base.slice(idx + 1).toLowerCase() : '';
}

/** Which renderer a file gets: explicit `kind` from the server wins, else the extension decides. */
export function attachmentKind(file) {
    const name = file?.name || '';
    if (file?.kind === 'image' || (!name && !file?.kind) || IMAGE_EXT.test(name)) return 'image';
    if (file?.kind === 'csv' || CSV_EXT.test(name)) return 'csv';
    if (file?.kind === 'markdown' || MARKDOWN_EXT.test(name)) return 'markdown';
    if (file?.kind === 'code' || file?.kind === 'document' || TEXT_EXT.test(name)) return 'text';
    return 'file';
}

/**
 * Durable identity of an attachment: the file id from the owner-bound
 * route when present, else URL + name. Never the array or object identity.
 * @param {{ url?: string, name?: string }} file
 * @returns {string}
 */
export function attachmentKey(file) {
    const url = String(file?.url || '');
    const match = FILE_ROUTE.exec(url);
    if (match) return `file:${match[1]}`;
    return `url:${url}|${String(file?.name || '')}`;
}

/** Everything that, if changed, means the card must be rebuilt. */
export function attachmentSignature(file) {
    return [file?.url, file?.name, file?.caption, file?.sourceUrl, file?.kind]
        .map(v => String(v ?? ''))
        .join('\u0001');
}

/** Signature of a whole list - a cheap effect dependency for React callers. */
export function attachmentsSignature(attachments) {
    return (Array.isArray(attachments) ? attachments : [])
        .filter(f => f?.url)
        .map(f => `${attachmentKey(f)}\u0002${attachmentSignature(f)}`)
        .join('\u0003');
}

// ---------------------------------------------------------------------------
// Per-attachment UI state (collapsed, sort) - outside the disposable DOM.

const uiState = new Map();
if (typeof window !== 'undefined') window.addEventListener(ACCOUNT_STORAGE_CHANGED, () => uiState.clear());

function stateFor(key) {
    let state = uiState.get(key);
    if (!state) {
        state = {};
        uiState.set(key, state);
    }
    return state;
}

/** Forget remembered collapse/sort choices (tests, sign-out). */
export function resetAttachmentState() {
    uiState.clear();
}

/** Read-only peek at the remembered state of one attachment (tests). */
export function peekAttachmentState(file) {
    const state = uiState.get(attachmentKey(file));
    return state ? { ...state } : null;
}

// ---------------------------------------------------------------------------
// In-flight fetch bookkeeping per card element.

const controllers = new WeakMap();

function abortCard(card) {
    const controller = controllers.get(card);
    if (controller) {
        controller.abort();
        controllers.delete(card);
    }
}

function isAbort(error) {
    return error?.name === 'AbortError';
}

// ---------------------------------------------------------------------------

function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function downloadLink(file, label = '⬇ Download') {
    const link = el('a', 'file-card-action', label);
    link.href = file.url;
    link.download = file.name || 'file';
    return link;
}

function sourceLink(file) {
    if (!file.sourceUrl) return null;
    const link = el('a', 'file-card-action', `↗ ${hostOf(file.sourceUrl) || 'source'}`);
    link.href = file.sourceUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
}

function captionNode(file) {
    if (!file.caption && !file.sourceUrl) return null;
    const cap = el('figcaption', 'attachment-caption');
    if (file.caption) cap.append(el('span', null, file.caption));
    if (file.sourceUrl) {
        if (file.caption) cap.append(document.createTextNode(' · '));
        const link = el('a', null, hostOf(file.sourceUrl) || 'source');
        link.href = file.sourceUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        cap.append(link);
    }
    return cap;
}

function renderImage(file) {
    const img = document.createElement('img');
    img.className = 'attachment';
    img.src = file.url;
    img.alt = file.caption || file.name || 'attachment';
    img.loading = 'lazy';
    const caption = captionNode(file);
    if (!caption) return img;
    const figure = el('figure', 'attachment-figure');
    figure.append(img, caption);
    return figure;
}

let cardSeq = 0;

/** Card frame shared by the table and preview renderers. */
function fileCard(file, icon, subtitle) {
    const card = el('div', 'file-card');
    card.dataset.kind = attachmentKind(file);
    const head = el('div', 'file-card-head');
    const title = el('div', 'file-card-title');
    title.append(el('span', 'file-card-icon', icon), el('span', 'file-card-name', file.name || 'file'));
    if (subtitle) title.append(el('span', 'file-card-sub', subtitle));
    head.append(title);
    const actions = el('div', 'file-card-actions');
    const src = sourceLink(file);
    if (src) actions.append(src);
    actions.append(downloadLink(file));
    head.append(actions);
    const body = el('div', 'file-card-body');
    body.id = `file-card-body-${++cardSeq}`;
    body.append(el('div', 'file-card-loading', 'Loading…'));
    card.append(head, body);
    if (file.caption) card.append(el('div', 'file-card-caption', file.caption));
    return { card, head, body, title, actions };
}

async function fetchText(url, { signal } = {}) {
    const response = await accountFetch(url, { credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_FETCH_BYTES) throw new Error('too large to preview');
    return await response.text();
}

/**
 * Start the card's fetch. Resolves to the text, or to null when the card
 * was replaced/unmounted meanwhile (the caller then does nothing) - a
 * genuine failure renders the error. Aborts are never shown as errors.
 */
async function loadCardText(card, body, url) {
    const controller = new AbortController();
    controllers.set(card, controller);
    try {
        const text = await fetchText(url, { signal: controller.signal });
        if (controller.signal.aborted || controllers.get(card) !== controller) return null;
        return text;
    } catch (error) {
        if (isAbort(error) || controller.signal.aborted || controllers.get(card) !== controller) return null;
        body.replaceChildren(el('div', 'file-card-error', `Could not load the preview (${error.message}).`));
        return null;
    } finally {
        if (controllers.get(card) === controller) controllers.delete(card);
    }
}

/** RFC 4180-ish parser: quoted fields, doubled quotes, CRLF, bounded rows. */
export function parseDelimited(text, delimiter = ',', maxRows = Infinity) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const src = String(text || '');
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"') {
                if (src[i + 1] === '"') { field += '"'; i += 1; continue; }
                quoted = false; continue;
            }
            field += ch; continue;
        }
        if (ch === '"') { quoted = true; continue; }
        if (ch === delimiter) { row.push(field); field = ''; continue; }
        if (ch === '\r') continue;
        if (ch === '\n') {
            row.push(field); field = '';
            if (row.some(cell => cell !== '')) rows.push(row);
            row = [];
            if (rows.length > maxRows) return { rows, truncated: true };
            continue;
        }
        field += ch;
    }
    if (field !== '' || row.length > 0) {
        row.push(field);
        if (row.some(cell => cell !== '')) rows.push(row);
    }
    return { rows, truncated: false };
}

function countDataRows(text) {
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n += 1;
    if (text.length > 0 && text[text.length - 1] !== '\n') n += 1;
    return Math.max(0, n - 1);
}

function compareCells(a, b) {
    const na = Number(a);
    const nb = Number(b);
    if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function buildTable(header, rows, onSort, sortState) {
    const table = el('table', 'csv-table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    header.forEach((label, col) => {
        const th = document.createElement('th');
        const btn = el('button', 'csv-sort', label || `col ${col + 1}`);
        btn.type = 'button';
        btn.title = 'Sort by this column';
        if (sortState.col === col) btn.dataset.dir = sortState.dir;
        btn.addEventListener('click', () => onSort(col));
        th.appendChild(btn);
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    const tbody = document.createElement('tbody');
    for (const row of rows) {
        const tr = document.createElement('tr');
        for (let col = 0; col < header.length; col++) {
            tr.appendChild(el('td', null, row[col] ?? ''));
        }
        tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    return table;
}

function renderCsv(file) {
    const delimiter = extensionOf(file.name) === 'tsv' ? '\t' : ',';
    const { card, body, title } = fileCard(file, '▦', null);
    const state = stateFor(attachmentKey(file));
    void (async () => {
        const text = await loadCardText(card, body, file.url);
        if (text == null) return;
        const { rows } = parseDelimited(text, delimiter, MAX_TABLE_ROWS + 1);
        if (rows.length === 0) {
            body.replaceChildren(el('div', 'file-card-error', 'The file is empty.'));
            return;
        }
        const totalRows = countDataRows(text);
        const header = rows[0].slice(0, MAX_TABLE_COLS);
        const data = rows.slice(1, MAX_TABLE_ROWS + 1).map(r => r.slice(0, MAX_TABLE_COLS));
        const shownRows = data.length;
        const colNote = rows[0].length > MAX_TABLE_COLS ? `, first ${MAX_TABLE_COLS} of ${rows[0].length} columns` : `, ${header.length} column${header.length === 1 ? '' : 's'}`;
        title.append(el('span', 'file-card-sub',
            `${totalRows.toLocaleString()} row${totalRows === 1 ? '' : 's'}${colNote}`));

        // Sort choice persists in the attachment state, so a rebuilt card
        // (history reload) and an untouched card (parent rerender) agree.
        if (!state.sort || state.sort.col >= header.length) state.sort = { col: -1, dir: 'asc' };
        const draw = () => {
            const sortState = state.sort;
            const sorted = sortState.col < 0 ? data : [...data].sort((a, b) => {
                const cmp = compareCells(a[sortState.col] ?? '', b[sortState.col] ?? '');
                return sortState.dir === 'asc' ? cmp : -cmp;
            });
            const wrap = el('div', 'csv-scroll');
            wrap.appendChild(buildTable(header, sorted, (col) => {
                if (sortState.col === col) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
                else { sortState.col = col; sortState.dir = 'asc'; }
                draw();
            }, sortState));
            const children = [wrap];
            if (totalRows > shownRows) {
                children.push(el('div', 'file-card-note', `Showing the first ${shownRows} of ${totalRows.toLocaleString()} rows - download for the rest.`));
            }
            body.replaceChildren(...children);
        };
        draw();
    })();
    return card;
}

/** Whether a text preview should start collapsed. */
export function isLongPreview(text) {
    const value = String(text || '');
    if (value.length > LONG_PREVIEW_CHARS) return true;
    let lines = 1;
    for (let i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) === 10 && ++lines > LONG_PREVIEW_LINES) return true;
    }
    return false;
}

function applyCollapsed(card, toggle, collapsed) {
    card.classList.toggle('collapsed', collapsed);
    toggle.textContent = collapsed ? 'Expand' : 'Collapse';
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function renderTextPreview(file, kind) {
    const ext = extensionOf(file.name);
    const { card, body, title, actions } = fileCard(file, kind === 'markdown' ? '📝' : '📄', null);
    const state = stateFor(attachmentKey(file));
    void (async () => {
        const text = await loadCardText(card, body, file.url);
        if (text == null) return;
        const lines = text.split('\n').length;
        title.append(el('span', 'file-card-sub', `${lines.toLocaleString()} line${lines === 1 ? '' : 's'}`));
        const truncated = text.length > MAX_PREVIEW_CHARS;
        const shown = truncated ? text.slice(0, MAX_PREVIEW_CHARS) : text;
        const content = el('div', 'file-card-preview');
        if (kind === 'markdown') {
            content.classList.add('file-card-markdown');
            content.innerHTML = renderMarkdown(shown);
        } else {
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.innerHTML = highlight(shown, LANG_BY_EXT[ext] ?? '');
            pre.appendChild(code);
            content.appendChild(pre);
        }
        const children = [content];
        if (truncated) children.push(el('div', 'file-card-note', 'Preview truncated - download for the full file.'));

        // Decide the initial state (remembered choice, else long → collapsed)
        // and apply it BEFORE the content is exposed, so a large document is
        // never painted expanded and folded a frame later.
        if (typeof state.collapsed !== 'boolean') state.collapsed = isLongPreview(text);
        const toggle = el('button', 'file-card-action file-card-toggle');
        toggle.type = 'button';
        toggle.setAttribute('aria-controls', body.id);
        toggle.setAttribute('aria-label', `Toggle preview of ${file.name || 'file'}`);
        toggle.addEventListener('click', () => {
            state.collapsed = !card.classList.contains('collapsed');
            applyCollapsed(card, toggle, state.collapsed);
        });
        applyCollapsed(card, toggle, state.collapsed);
        actions.prepend(toggle);
        body.replaceChildren(...children);
    })();
    return card;
}

function renderChip(file) {
    const link = el('a', 'file-chip', `⬇ ${file.name}`);
    link.href = file.url;
    link.download = file.name;
    return link;
}

function buildAttachment(file) {
    const kind = attachmentKind(file);
    let node;
    if (kind === 'image') node = renderImage(file);
    else if (kind === 'csv') node = renderCsv(file);
    else if (kind === 'markdown' || kind === 'text') node = renderTextPreview(file, kind);
    else node = renderChip(file);
    node.dataset.attachmentKey = attachmentKey(file);
    node.dataset.attachmentSig = attachmentSignature(file);
    return node;
}

/**
 * Reconcile the attachments of one message into `container`: keep cards
 * whose attachment is unchanged (same key and signature), build the new
 * ones, drop - and abort - the rest, and put them in list order. Safe to
 * call on every parent render.
 *
 * @param {HTMLElement} container
 * @param {Array<{ url: string, name?: string, caption?: string, sourceUrl?: string, kind?: string }>} attachments
 */
export function renderAttachments(container, attachments = []) {
    const wanted = [];
    const seen = new Set();
    for (const file of Array.isArray(attachments) ? attachments : []) {
        if (!file?.url) continue;
        const key = attachmentKey(file);
        if (seen.has(key)) continue;
        seen.add(key);
        wanted.push({ key, sig: attachmentSignature(file), file });
    }

    const existing = new Map();
    for (const child of Array.from(container.children)) {
        const key = child.dataset?.attachmentKey;
        if (key && !existing.has(key)) existing.set(key, child);
        else disposeNode(child);
    }

    const ordered = wanted.map(({ key, sig, file }) => {
        const current = existing.get(key);
        existing.delete(key);
        if (current && current.dataset.attachmentSig === sig) return current;
        if (current) disposeNode(current);
        return buildAttachment(file);
    });
    for (const stale of existing.values()) disposeNode(stale);

    // Move only what is out of place: an untouched card keeps its scroll
    // position, sort table, and focus.
    ordered.forEach((node, index) => {
        if (container.children[index] !== node) {
            container.insertBefore(node, container.children[index] || null);
        }
    });
}

function disposeNode(node) {
    abortCard(node);
    node.remove();
}

/** Abort every in-flight fetch under `container` and empty it (unmount). */
export function disposeAttachments(container) {
    if (!container) return;
    for (const child of Array.from(container.children)) disposeNode(child);
}
