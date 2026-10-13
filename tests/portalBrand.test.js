/**
 * The portal spells the product name in exactly one place
 * (apps/web/brand.config.cjs) and the assistant's name nowhere: components
 * read both through src/lib/brand.ts. This keeps a rename a one-line change
 * and stops the literal creeping back into labels, placeholders and hints.
 *
 * Allowed: comments, identifiers that carry the word (`callGoobster`,
 * `connectToGoobster`), the `X-Goobster-*` protocol headers, lower-case
 * storage keys and asset paths (none of which is the capitalised word).
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web');
const SRC = path.join(WEB, 'src');
const brand = require(path.join(WEB, 'brand.config.cjs'));

const SKIP_FILES = new Set(['lib/brand.ts', 'lib/types.ts']);
const ALLOWED_LINE = /X-Goobster-/;
const WORD = /(?<![A-Za-z0-9_$])Goobster(?![A-Za-z0-9_])/;

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
    }
    return out;
}

function offendingLines() {
    const hits = [];
    for (const file of walk(SRC)) {
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        if (SKIP_FILES.has(rel) || rel.startsWith('music-lab/')) continue;
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
            const trimmed = line.trimStart();
            if (/^(\/\/|\*|\/\*|\{\/\*)/.test(trimmed)) return;
            if (!WORD.test(line) || ALLOWED_LINE.test(line)) return;
            hits.push(`${rel}:${i + 1}`);
        });
    }
    return hits;
}

describe('portal brand token', () => {
    test('brand.config.cjs names the product', () => {
        expect(typeof brand.productName).toBe('string');
        expect(brand.productName.trim().length).toBeGreaterThan(0);
    });

    test('no portal source spells the product or assistant name itself', () => {
        expect(offendingLines()).toEqual([]);
    });

    test('the HTML entries take the name from the build', () => {
        for (const page of ['index.html', 'setup.html']) {
            const html = fs.readFileSync(path.join(WEB, page), 'utf8');
            expect(html).toMatch(/<title>%PRODUCT_NAME%/);
            expect(html).not.toMatch(/<title>Goobster/);
        }
    });

    test('src/lib/brand.ts falls back to the configured name', () => {
        const source = fs.readFileSync(path.join(SRC, 'lib/brand.ts'), 'utf8');
        expect(source).toContain(`: '${brand.productName}'`);
    });
});
