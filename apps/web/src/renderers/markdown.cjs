/**
 * Small, safe Markdown renderer for chat bubbles. Everything is
 * HTML-escaped first; only markup this module generates is ever injected.
 * Covers what an LLM actually emits: fenced code, inline code, headings,
 * bold/italic/strikethrough, links, lists (loose, lazy-continued, one
 * level of nesting), blockquotes, tables, rules, and LaTeX math (emitted
 * as placeholder spans; math.js typesets them with KaTeX, and the escaped
 * TeX source is the graceful fallback).
 *
 * CommonJS so the parser is unit-testable under Jest; markdown.js is the
 * ESM façade that injects the syntax highlighter.
 */

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Pull LaTeX segments out of the text (after fenced code, before escaping)
 * and stash them for placeholder re-insertion. Supported delimiters:
 * $$..$$ and \[..\] (display), \(..\) (inline), and a conservative
 * single-$ inline form that refuses to match across whitespace-adjacent
 * dollar signs, so "$5 and $10" stays plain text.
 */
function extractMath(text, stash) {
    return text
        .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => stash(tex, true))
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => stash(tex, true))
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => stash(tex, false))
        .replace(/(^|[^$\\])\$(?!\s)([^$\n]+?)(?<![\s\\])\$(?![$\d])/g,
            (_, before, tex) => before + stash(tex, false));
}

/** Inline transforms, applied to already-escaped text. */
function renderInline(text) {
    // Inline code first so its contents escape further styling
    const codeSpans = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
        codeSpans.push(`<code>${code}</code>`);
        return `\uE000${codeSpans.length - 1}\uE000`;
    });

    text = text
        // [text](http url) - http(s) only, new tab
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
            '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        // bare URLs
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
            '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_]+)__/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
        .replace(/~~([^~]+)~~/g, '<del>$1</del>');

    return text.replace(/\uE000(\d+)\uE000/g, (_, i) => codeSpans[Number(i)]);
}

const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;

/**
 * Classify a line as a list item, or null.
 * @returns {{ type: 'ul'|'ol', indent: number, number: number|null, text: string }|null}
 */
function parseListItem(line) {
    const bullet = line.match(BULLET_RE);
    if (bullet) return { type: 'ul', indent: bullet[1].length, number: null, text: bullet[2] };
    const ordered = line.match(ORDERED_RE);
    if (ordered) return { type: 'ol', indent: ordered[1].length, number: Number(ordered[2]), text: ordered[3] };
    return null;
}

/**
 * Render an accumulated list (see the state machine in renderMarkdown).
 * Ordered lists carry `start` so numbering follows the author even when a
 * list was split by structure the parser could not absorb; the browser
 * then counts up from there.
 */
function renderList(list) {
    const startAttr = list.type === 'ol' && Number.isInteger(list.start) && list.start !== 1
        ? ` start="${list.start}"`
        : '';
    const items = list.items.map((item) => {
        let body = renderInline(item.lines.join('<br>'));
        for (const child of item.children) body += renderList(child);
        return `<li>${body}</li>`;
    });
    return `<${list.type}${startAttr}>${items.join('')}</${list.type}>`;
}

/**
 * @param {{ highlight: (code: string, lang: string) => string }} deps -
 *   `highlight` returns HTML-escaped (optionally highlighted) code.
 * @returns {(source: string) => string}
 */
function createMarkdownRenderer({ highlight }) {
    const highlightCode = typeof highlight === 'function' ? highlight : (code) => escapeHtml(code);

    return function renderMarkdown(source) {
        if (!source) return '';

        // Pull fenced code blocks out before any other processing
        const codeBlocks = [];
        let text = String(source).replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
            const language = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
            const body = code.replace(/\n$/, '');
            codeBlocks.push(`<pre${language}><code>${highlightCode(body, lang)}</code></pre>`);
            return `\uE001${codeBlocks.length - 1}\uE001`;
        });

        // Then math segments (code blocks win over math, math wins over inline
        // markdown - underscores and asterisks inside TeX must survive).
        const mathSpans = [];
        text = extractMath(text, (tex, display) => {
            const cls = display ? 'math math-display' : 'math';
            mathSpans.push(`<span class="${cls}" data-tex="${escapeHtml(tex)}">${escapeHtml(tex)}</span>`);
            return `\uE002${mathSpans.length - 1}\uE002`;
        });

        text = escapeHtml(text);

        const lines = text.split('\n');
        const html = [];
        let paragraph = [];
        let quote = [];
        let table = [];
        /**
         * The open list, if any. Items accumulate here (not straight into
         * `html`) so a blank line between items, a continuation line, or a
         * nested bullet can join the *same* list. Closing an <ol> on every
         * blank line is what made every LLM-style "1. **Header**\n\n2. ..."
         * list render as 1., 1., 1.
         * @type {{ type: 'ul'|'ol', start: number|null, indent: number,
         *          items: Array<{ lines: string[], children: Array<object> }>,
         *          blankPending: boolean }|null}
         */
        let list = null;

        const flushParagraph = () => {
            if (paragraph.length) {
                html.push(`<p>${renderInline(paragraph.join('<br>'))}</p>`);
                paragraph = [];
            }
        };
        const flushList = () => {
            if (list) { html.push(renderList(list)); list = null; }
        };
        const flushQuote = () => {
            if (quote.length) {
                html.push(`<blockquote>${renderInline(quote.join('<br>'))}</blockquote>`);
                quote = [];
            }
        };
        const flushTable = () => {
            if (table.length < 2) {
                for (const row of table) paragraph.push(row);
                table = [];
                return;
            }
            const parseRow = (row) => row.replace(/^\||\|$/g, '').split('|').map(c => renderInline(c.trim()));
            const header = parseRow(table[0]);
            const rows = table.slice(2).map(parseRow);
            let out = '<table><thead><tr>';
            out += header.map(h => `<th>${h}</th>`).join('');
            out += '</tr></thead><tbody>';
            for (const row of rows) out += `<tr>${row.map(c => `<td>${c}</td>`).join('')}</tr>`;
            out += '</tbody></table>';
            html.push(out);
            table = [];
        };
        const flushAll = () => { flushParagraph(); flushList(); flushQuote(); flushTable(); };

        const openList = (item) => {
            list = { type: item.type, start: item.number, indent: item.indent, items: [], blankPending: false };
        };
        const lastItem = () => list.items[list.items.length - 1];
        const addNested = (item) => {
            const parent = lastItem();
            const child = parent.children[parent.children.length - 1];
            if (child && child.type === item.type) {
                child.items.push({ lines: [item.text], children: [] });
            } else {
                parent.children.push({ type: item.type, start: item.number, items: [{ lines: [item.text], children: [] }] });
            }
        };

        for (const rawLine of lines) {
            const line = rawLine.replace(/\s+$/, '');
            const codeRef = line.match(/^\uE001(\d+)\uE001$/);
            const heading = line.match(/^(#{1,4})\s+(.*)$/);
            const item = parseListItem(line);
            const quoted = line.match(/^&gt;\s?(.*)$/);
            const rule = /^(-{3,}|\*{3,}|_{3,})$/.test(line.trim());
            const tableRow = /^\|.*\|$/.test(line.trim());
            const blank = !line.trim();
            const indented = /^\s{2,}|^\t/.test(rawLine);

            // Inside a list, decide whether this line belongs to it.
            if (list) {
                if (blank) {
                    // Loose list: keep the list open until we see what
                    // follows. Paragraph/quote/table are empty here.
                    list.blankPending = true;
                    continue;
                }
                if (item && item.indent >= list.indent + 2 && list.items.length) {
                    addNested(item);
                    list.blankPending = false;
                    continue;
                }
                if (item && item.type === list.type) {
                    list.items.push({ lines: [item.text], children: [] });
                    list.blankPending = false;
                    continue;
                }
                const structural = codeRef || heading || rule || quoted || tableRow || item;
                if (!structural && (indented || !list.blankPending)) {
                    // Continuation of the current item: an indented line, or
                    // (CommonMark "lazy continuation") plain text directly
                    // under the item with no blank line between.
                    const target = lastItem();
                    const children = target.children;
                    if (children.length) {
                        // Text after a nested list continues the nested item.
                        const nested = children[children.length - 1].items;
                        nested[nested.length - 1].lines.push(line.trim());
                    } else {
                        target.lines.push(list.blankPending ? `<br>${line.trim()}` : line.trim());
                    }
                    list.blankPending = false;
                    continue;
                }
                // Anything else ends the list and is processed normally.
                flushList();
            }

            if (codeRef) {
                flushAll();
                html.push(codeBlocks[Number(codeRef[1])]);
            } else if (blank) {
                flushAll();
            } else if (heading) {
                flushAll();
                const level = heading[1].length;
                html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
            } else if (rule) {
                flushAll();
                html.push('<hr>');
            } else if (quoted) {
                flushParagraph(); flushTable();
                quote.push(quoted[1]);
            } else if (item) {
                flushParagraph(); flushQuote(); flushTable();
                openList(item);
                list.items.push({ lines: [item.text], children: [] });
            } else if (tableRow) {
                flushParagraph(); flushQuote();
                table.push(line.trim());
            } else {
                flushQuote(); flushTable();
                paragraph.push(line);
            }
        }
        flushAll();

        return html.join('\n')
            .replace(/\uE002(\d+)\uE002/g, (_, i) => mathSpans[Number(i)]);
    };
}

module.exports = { createMarkdownRenderer, escapeHtml, renderInline, parseListItem };
