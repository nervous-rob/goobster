const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildDocumentation, renderPage, resolveLink, sourceFile } = require('../apps/web/docs/build.cjs');
const { searchDocumentation } = require('../apps/web/src/docs/search.cjs');
const rooms = require('../apps/web/src/lib/rooms.cjs');
const ROOT = path.resolve(__dirname, '..');
const page = { id: 'guide', title: 'Guide', source: 'documentation/guide.md', group: 'Guides' };

describe('public documentation compiler', () => {
    test('builds the curated real corpus without runtime configuration or database access', () => {
        const corpus = buildDocumentation(ROOT);
        expect(corpus.pages[0].id).toBe('getting-started');
        expect(corpus.pages.length).toBeGreaterThan(25);
        expect(corpus.pages.every((p) => p.source === 'README.md' || p.source.startsWith('documentation/'))).toBe(true);
        expect(corpus.pages.some((p) => /operator\/|data\/|product_naming|redesign_plan/.test(p.source))).toBe(false);
        expect(corpus.pages.find((p) => p.id === 'getting-started').html).toContain('/app/docs/knowledge');
        expect(rooms.resolveRoom('/app/docs/getting-started')).toBe('docs');
        expect(rooms.PRIMARY_ROOMS).toHaveLength(7);
    });

    test.each(['config.json', 'data/self-docs/private.md', '../README.md', 'documentation/../../config.json', '/etc/passwd'])('rejects unpublished sources: %s', (source) => {
        expect(() => sourceFile(ROOT, source)).toThrow(/not public/);
    });

    test('rejects missing files, file and directory symlinks, duplicate ids, and duplicate sources', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-docs-'));
        try {
            fs.mkdirSync(path.join(root, 'documentation'));
            fs.writeFileSync(path.join(root, 'secret.md'), '# Secret');
            fs.symlinkSync(path.join(root, 'secret.md'), path.join(root, 'documentation/leak.md'));
            fs.symlinkSync(root, path.join(root, 'documentation/linked'));
            expect(() => sourceFile(root, 'documentation/leak.md')).toThrow(/symlink/);
            expect(() => sourceFile(root, 'documentation/linked/secret.md')).toThrow(/symlink/);
            expect(() => sourceFile(root, 'documentation/missing.md')).toThrow();
            const groups = [{ title: 'One', pages: [['guide', 'Guide', 'README.md'], ['guide', 'Other', 'documentation/guide.md']] }];
            expect(() => buildDocumentation(root, groups)).toThrow(/Duplicate/);
            groups[0].pages[1] = ['other', 'Other', 'README.md'];
            expect(() => buildDocumentation(root, groups)).toThrow(/Duplicate/);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    test('escapes HTML, refuses unsafe links and image URLs, and preserves code literally', () => {
        const rendered = renderPage(page, '<script>alert(1)</script>\n\n[x](javascript:alert) ![bad](data:text/html;base64,eA==)\n\n[external](https://example.com)\n\n```html\n<img onerror="alert(1)">\n```', new Map(), null);
        expect(rendered.html).not.toContain('<script>');
        expect(rendered.html).not.toMatch(/(?:href|src)="(?:javascript|data):/);
        expect(rendered.html).not.toContain('<img onerror');
        expect(rendered.html).toContain('&lt;script&gt;');
        expect(rendered.html).toContain('rel="noopener noreferrer"');
    });

    test('generates collision-free anchors and searches real sections, not fenced headings', () => {
        const rendered = renderPage(page, '---\ntitle: Test\n---\n# Guide\n## Repeat\nOne\n## Repeat\nTwo\n## Repeat-1\nThree\n```md\n## Not a heading\n```\n###### Deep heading\nText', new Map(), null);
        expect(rendered.headings.map((h) => h.anchor)).toEqual(['guide', 'repeat', 'repeat-1', 'repeat-1-1', 'deep-heading']);
        expect(rendered.html).not.toContain('title: Test');
        expect(rendered.sections.find((s) => s.anchor === 'repeat-1-1').text).toContain('Not a heading');
        expect(() => renderPage(page, '---\nbad: [\n---\n# Body', new Map(), null)).toThrow();
        expect(() => renderPage(page, '---\ntitle: Open', new Map(), null)).toThrow(/Unclosed/);
    });

    test('rewrites relative wiki links and keeps non-published sources on the matching revision', () => {
        const targets = new Map([['README.md', { id: 'install' }], ['documentation/guide.md', page]]);
        expect(resolveLink('../README.md#setup', page.source, targets, 'abc')).toBe('/app/docs/install#setup');
        expect(resolveLink('guide.md#repeat', page.source, targets, 'abc')).toBe('/app/docs/guide#repeat');
        expect(resolveLink('adr/0001-hardening-cycle.md', page.source, targets, 'abc')).toBe('https://github.com/nervous-rob/goobster/blob/abc/documentation/adr/0001-hardening-cycle.md');
        expect(resolveLink('#section', page.source, targets, 'abc')).toBe('#section');
        expect(resolveLink('/app/chat', page.source, targets, 'abc')).toBe('/app/chat');
        for (const unsafe of ['//evil.test', '\\evil.test', 'javascript:alert(1)', 'data:text/html,hi', '../../private.md', '%2e%2e/%2e%2e/private.md']) {
            expect(resolveLink(unsafe, page.source, targets, 'abc')).toBeNull();
        }
    });
});

describe('local section search', () => {
    const pages = [
        { id: 'notes', title: 'Knowledge', group: 'Using', sections: [{ anchor: 'privacy', heading: 'Privacy', text: 'Deleting a note leaves other copies. Configure selfDocs.operatorDir on the host.' }] },
        { id: 'privacy', title: 'Privacy', group: 'Using', sections: [{ anchor: 'copies', heading: 'Deleting copies', text: 'Knowledge and notes have separate controls.' }] }
    ];
    test('ranks title/heading matches, requires all query terms, handles identifiers and caps results', () => {
        expect(searchDocumentation(pages, 'privacy')[0].pageId).toBe('privacy');
        expect(searchDocumentation(pages, 'DELETING NOTE').map((result) => result.anchor)).toEqual(['copies', 'privacy']);
        expect(searchDocumentation(pages, 'selfDocs.operatorDir')[0].pageId).toBe('notes');
        expect(searchDocumentation(pages, 'privacy', 1)).toHaveLength(1);
        expect(searchDocumentation(pages, 'privacy unicorn')).toEqual([]);
        expect(searchDocumentation(pages, '   ')).toEqual([]);
        expect(searchDocumentation(pages, '[.*]')).toEqual([]);
    });
});
