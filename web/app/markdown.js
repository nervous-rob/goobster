/**
 * Small, safe Markdown renderer for chat bubbles. Everything is
 * HTML-escaped first; only markup this module generates is ever injected.
 * Covers what an LLM actually emits: fenced code, inline code, headings,
 * bold/italic/strikethrough, links, lists, blockquotes, tables, rules.
 */

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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

/**
 * Render markdown to safe HTML.
 * @param {string} source
 * @returns {string}
 */
export function renderMarkdown(source) {
    if (!source) return '';

    // Pull fenced code blocks out before any other processing
    const codeBlocks = [];
    let text = String(source).replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        const language = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
        codeBlocks.push(`<pre${language}><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
        return `\uE001${codeBlocks.length - 1}\uE001`;
    });

    text = escapeHtml(text);

    const lines = text.split('\n');
    const html = [];
    let paragraph = [];
    let listType = null; // 'ul' | 'ol'
    let quote = [];
    let table = [];

    const flushParagraph = () => {
        if (paragraph.length) {
            html.push(`<p>${renderInline(paragraph.join('<br>'))}</p>`);
            paragraph = [];
        }
    };
    const flushList = () => {
        if (listType) { html.push(`</${listType}>`); listType = null; }
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

    for (const rawLine of lines) {
        const line = rawLine.replace(/\s+$/, '');
        const codeRef = line.match(/^\uE001(\d+)\uE001$/);
        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
        const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
        const quoted = line.match(/^&gt;\s?(.*)$/);
        const tableRow = /^\|.*\|$/.test(line.trim()) || /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line.trim());

        if (codeRef) {
            flushAll();
            html.push(codeBlocks[Number(codeRef[1])]);
        } else if (!line.trim()) {
            flushAll();
        } else if (heading) {
            flushAll();
            const level = heading[1].length;
            html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
            flushAll();
            html.push('<hr>');
        } else if (quoted) {
            flushParagraph(); flushList(); flushTable();
            quote.push(quoted[1]);
        } else if (bullet || ordered) {
            flushParagraph(); flushQuote(); flushTable();
            const type = bullet ? 'ul' : 'ol';
            if (listType !== type) { flushList(); html.push(`<${type}>`); listType = type; }
            html.push(`<li>${renderInline((bullet || ordered)[1])}</li>`);
        } else if (tableRow && /^\|.*\|$/.test(line.trim())) {
            flushParagraph(); flushList(); flushQuote();
            table.push(line.trim());
        } else {
            flushList(); flushQuote(); flushTable();
            paragraph.push(line);
        }
    }
    flushAll();

    return html.join('\n');
}
