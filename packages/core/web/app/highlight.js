/**
 * Tiny dependency-free syntax highlighter for chat code blocks. One
 * sequential tokenizer (comments, strings, numbers, keywords, function
 * calls) with per-language keyword sets - not a full grammar, but it makes
 * LLM code output pleasant to read. All non-token text is HTML-escaped, so
 * the output is exactly as safe as escaping alone.
 */

const KEYWORDS = {
    javascript: 'const let var function return if else for while do switch case break continue new class extends super this typeof instanceof in of try catch finally throw async await yield import export from default null undefined true false static get set delete void',
    python: 'def return if elif else for while in not and or is None True False class import from as with try except finally raise lambda yield global nonlocal pass break continue assert del async await match case self',
    sql: 'select from where insert into values update set delete create table drop alter add index join left right inner outer on as order by group having limit offset and or not null primary key foreign references unique default check between like in exists union all distinct case when then else end',
    bash: 'if then else elif fi for while do done case esac function return exit echo local export readonly shift source set unset trap',
    json: 'true false null',
    css: '',
    html: '',
    rust: 'fn let mut const static struct enum impl trait for in while loop if else match return pub use mod crate super self async await move ref where type dyn box true false',
    go: 'func var const type struct interface map chan go defer return if else for range switch case break continue package import select true false nil',
    java: 'public private protected static final class interface extends implements new return if else for while do switch case break continue try catch finally throw throws void this super import package true false null',
    c: 'int char long short float double void unsigned signed struct union enum typedef static extern const return if else for while do switch case break continue sizeof NULL'
};
KEYWORDS.js = KEYWORDS.javascript;
KEYWORDS.jsx = KEYWORDS.javascript;
KEYWORDS.ts = KEYWORDS.javascript + ' interface type enum implements declare readonly namespace as is keyof';
KEYWORDS.typescript = KEYWORDS.ts;
KEYWORDS.tsx = KEYWORDS.ts;
KEYWORDS.py = KEYWORDS.python;
KEYWORDS.sh = KEYWORDS.bash;
KEYWORDS.shell = KEYWORDS.bash;
KEYWORDS.golang = KEYWORDS.go;
KEYWORDS.cpp = KEYWORDS.c + ' class public private protected template typename namespace using new delete true false nullptr';

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Highlight source code to safe HTML.
 * @param {string} code - raw (unescaped) source
 * @param {string} [lang]
 * @returns {string} HTML with <span class="hl-*"> tokens, fully escaped
 */
export function highlight(code, lang = '') {
    const language = String(lang || '').toLowerCase();
    const keywords = new Set((KEYWORDS[language] ?? KEYWORDS.javascript).split(' ').filter(Boolean));

    const lineComment = language === 'python' || language === 'py' || language === 'bash'
        || language === 'sh' || language === 'shell' ? '#'
        : language === 'sql' ? '--'
        : language === 'html' || language === 'css' ? null
        : '//';

    const parts = [];
    let i = 0;
    const n = code.length;
    let plain = '';
    const flushPlain = () => {
        if (!plain) return;
        // Split identifiers/numbers out of the plain run
        const chunk = plain.replace(/[A-Za-z_$][\w$]*|\b\d[\w.]*\b/g, (match) => {
            if (keywords.has(match)) return `\uE100${match}\uE101`;      // keyword
            if (/^\d/.test(match)) return `\uE102${match}\uE101`;        // number
            return match;
        });
        parts.push(escapeHtml(chunk)
            .replace(/\uE100([^\uE101]*)\uE101/g, '<span class="hl-kw">$1</span>')
            .replace(/\uE102([^\uE101]*)\uE101/g, '<span class="hl-num">$1</span>'));
        plain = '';
    };

    while (i < n) {
        const ch = code[i];
        const two = code.slice(i, i + 2);

        // Comments
        if (lineComment && code.startsWith(lineComment, i)
            && !(lineComment === '//' && code[i - 1] === ':')) { // don't eat URLs
            flushPlain();
            let end = code.indexOf('\n', i);
            if (end === -1) end = n;
            parts.push(`<span class="hl-com">${escapeHtml(code.slice(i, end))}</span>`);
            i = end;
            continue;
        }
        if (two === '/*' && lineComment === '//') {
            flushPlain();
            let end = code.indexOf('*/', i + 2);
            end = end === -1 ? n : end + 2;
            parts.push(`<span class="hl-com">${escapeHtml(code.slice(i, end))}</span>`);
            i = end;
            continue;
        }
        if (code.startsWith('<!--', i) && (language === 'html' || language === 'xml')) {
            flushPlain();
            let end = code.indexOf('-->', i + 4);
            end = end === -1 ? n : end + 3;
            parts.push(`<span class="hl-com">${escapeHtml(code.slice(i, end))}</span>`);
            i = end;
            continue;
        }

        // Strings
        if (ch === '"' || ch === "'" || ch === '`') {
            flushPlain();
            let j = i + 1;
            while (j < n) {
                if (code[j] === '\\') { j += 2; continue; }
                if (code[j] === ch) { j++; break; }
                // Non-template strings end at a newline (unterminated)
                if (code[j] === '\n' && ch !== '`') break;
                j++;
            }
            parts.push(`<span class="hl-str">${escapeHtml(code.slice(i, j))}</span>`);
            i = j;
            continue;
        }

        plain += ch;
        i++;
    }
    flushPlain();
    return parts.join('');
}
