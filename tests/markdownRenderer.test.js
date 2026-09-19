/**
 * Portal chat Markdown renderer (apps/web/src/renderers/markdown.cjs).
 *
 * The list cases pin the fix for numbered lists that rendered as
 * "1., 1., 1.": an LLM-style list puts a blank line between items and
 * often continues an item on the next line, and the renderer used to close
 * the <ol> at every blank line and every non-item line, so each item became
 * its own single-entry list.
 */
const { createMarkdownRenderer, parseListItem } = require('../apps/web/src/renderers/markdown.cjs');

const render = createMarkdownRenderer({ highlight: (code) => `H(${code})` });

function countTags(html, tag) {
    return (html.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
}

describe('ordered lists keep their numbering', () => {
    test('items separated by blank lines are one <ol>', () => {
        const html = render('Plan:\n\n1. **Fetch**\n\n2. **Process**\n\n3. **Publish**\n\nDone.');
        expect(countTags(html, 'ol')).toBe(1);
        expect(countTags(html, 'li')).toBe(3);
        expect(html).toContain('<ol><li><strong>Fetch</strong></li><li><strong>Process</strong></li><li><strong>Publish</strong></li></ol>');
        expect(html).toContain('<p>Done.</p>');
    });

    test('indented continuation lines belong to their item', () => {
        const html = render('1. **Fetch**\n   Pull the raw data.\n2. **Process**\n   Clean it up.');
        expect(countTags(html, 'ol')).toBe(1);
        expect(html).toContain('<li><strong>Fetch</strong><br>Pull the raw data.</li>');
        expect(html).toContain('<li><strong>Process</strong><br>Clean it up.</li>');
    });

    test('unindented text directly under an item is a lazy continuation', () => {
        const html = render('1. **Fetch**\nPull the raw data.\n2. **Process**\nClean it up.');
        expect(countTags(html, 'ol')).toBe(1);
        expect(countTags(html, 'li')).toBe(2);
        expect(html).not.toContain('<p>');
    });

    test('loose items with continuation paragraphs stay in one list', () => {
        const html = render('1. **Fetch**\n\n   Pull the raw data.\n\n2. **Process**\n\n   Clean it up.\n\nAfter.');
        expect(countTags(html, 'ol')).toBe(1);
        expect(countTags(html, 'li')).toBe(2);
        expect(html).toContain('<p>After.</p>');
    });

    test('a list that starts at another number carries start=', () => {
        expect(render('3. three\n4. four')).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
        expect(render('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
    });

    test('nested bullets render inside the parent item', () => {
        const html = render('1. Publish\n   - to the channel\n   - to the portal\n2. Celebrate');
        expect(html).toBe('<ol><li>Publish<ul><li>to the channel</li><li>to the portal</li></ul></li><li>Celebrate</li></ol>');
    });

    test('a plain paragraph after a blank line ends the list', () => {
        const html = render('1. one\n2. two\n\nNot part of the list.\n\n3. three');
        // The paragraph closes the list; the trailing item is a new list
        // but keeps the author's number.
        expect(html).toBe('<ol><li>one</li><li>two</li></ol>\n<p>Not part of the list.</p>\n<ol start="3"><li>three</li></ol>');
    });

    test('headings, rules, code, and quotes end a list even without a blank line', () => {
        expect(render('- a\n# Title')).toBe('<ul><li>a</li></ul>\n<h1>Title</h1>');
        expect(render('- a\n---')).toBe('<ul><li>a</li></ul>\n<hr>');
        expect(render('- a\n> quoted')).toBe('<ul><li>a</li></ul>\n<blockquote>quoted</blockquote>');
        expect(render('- a\n```\nx\n```')).toBe('<ul><li>a</li></ul>\n<pre><code>H(x)</code></pre>');
    });

    test('switching list type opens a new list', () => {
        expect(render('1. one\n- bullet')).toBe('<ol><li>one</li></ol>\n<ul><li>bullet</li></ul>');
    });

    test('parseListItem classifies bullets and numbers with indent', () => {
        expect(parseListItem('- x')).toEqual({ type: 'ul', indent: 0, number: null, text: 'x' });
        expect(parseListItem('  12) y')).toEqual({ type: 'ol', indent: 2, number: 12, text: 'y' });
        expect(parseListItem('plain')).toBeNull();
    });
});

describe('the rest of the renderer is unchanged', () => {
    test('escapes HTML and renders inline markup', () => {
        expect(render('<b>x</b> **bold** `code` [d](https://e.com)'))
            .toBe('<p>&lt;b&gt;x&lt;/b&gt; <strong>bold</strong> <code>code</code> <a href="https://e.com" target="_blank" rel="noopener noreferrer">d</a></p>');
    });

    test('tables and math placeholders still render', () => {
        const html = render('| a | b |\n|---|---|\n| 1 | 2 |\n\n$$x^2$$');
        expect(html).toContain('<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
        expect(html).toContain('<span class="math math-display" data-tex="x^2">x^2</span>');
    });

    test('fenced code uses the injected highlighter', () => {
        expect(render('```js\nlet a = 1;\n```')).toBe('<pre data-lang="js"><code>H(let a = 1;)</code></pre>');
    });

    test('empty input renders nothing', () => {
        expect(render('')).toBe('');
        expect(render(null)).toBe('');
    });
});
