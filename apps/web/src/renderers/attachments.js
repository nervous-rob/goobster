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

const LANG_BY_EXT = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
    c: 'c', cc: 'cpp', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp', php: 'php', lua: 'lua', r: 'r', dart: 'dart',
    sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', json: 'json', jsonl: 'json', ndjson: 'json', geojson: 'json',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'html', css: 'css', scss: 'css', less: 'css', ini: 'ini', cfg: 'ini',
    conf: 'ini', env: 'bash', txt: '', log: '', rst: '', tex: ''
};

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

function renderImage(bubble, file) {
    const img = document.createElement('img');
    img.className = 'attachment';
    img.src = file.url;
    img.alt = file.caption || file.name || 'attachment';
    img.loading = 'lazy';
    const caption = captionNode(file);
    if (!caption) {
        bubble.appendChild(img);
        return;
    }
    const figure = el('figure', 'attachment-figure');
    figure.append(img, caption);
    bubble.appendChild(figure);
}

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
    body.append(el('div', 'file-card-loading', 'Loading…'));
    card.append(head, body);
    if (file.caption) card.append(el('div', 'file-card-caption', file.caption));
    return { card, head, body, title };
}

async function fetchText(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_FETCH_BYTES) throw new Error('too large to preview');
    return await response.text();
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

async function renderCsv(bubble, file) {
    const delimiter = extensionOf(file.name) === 'tsv' ? '\t' : ',';
    const { card, body, title } = fileCard(file, '▦', null);
    bubble.appendChild(card);
    let text;
    try {
        text = await fetchText(file.url);
    } catch (error) {
        body.replaceChildren(el('div', 'file-card-error', `Could not load the table (${error.message}).`));
        return;
    }
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

    const sortState = { col: -1, dir: 'asc' };
    const draw = () => {
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
}

async function renderTextPreview(bubble, file, kind) {
    const ext = extensionOf(file.name);
    const { card, body, title } = fileCard(file, kind === 'markdown' ? '📝' : '📄', null);
    bubble.appendChild(card);
    let text;
    try {
        text = await fetchText(file.url);
    } catch (error) {
        body.replaceChildren(el('div', 'file-card-error', `Could not load the preview (${error.message}).`));
        return;
    }
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
    body.replaceChildren(...children);

    // Collapse/expand: long previews start collapsed to a scrollable height.
    const toggle = el('button', 'file-card-action', 'Collapse');
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
        const collapsed = card.classList.toggle('collapsed');
        toggle.textContent = collapsed ? 'Expand' : 'Collapse';
    });
    card.querySelector('.file-card-actions')?.prepend(toggle);
}

function renderChip(bubble, file) {
    const link = el('a', 'file-chip', `⬇ ${file.name}`);
    link.href = file.url;
    link.download = file.name;
    bubble.appendChild(link);
}

/**
 * Append the attachments of one message to its bubble.
 * @param {HTMLElement} bubble
 * @param {Array<{ url: string, name?: string, caption?: string, sourceUrl?: string, kind?: string }>} attachments
 */
export function renderAttachments(bubble, attachments = []) {
    for (const file of attachments) {
        if (!file?.url) continue;
        // No name means an older registration - assume image (the only
        // kind that existed before download chips).
        const kind = attachmentKind(file);
        if (kind === 'image') renderImage(bubble, file);
        else if (kind === 'csv') void renderCsv(bubble, file);
        else if (kind === 'markdown' || kind === 'text') void renderTextPreview(bubble, file, kind);
        else renderChip(bubble, file);
    }
}
