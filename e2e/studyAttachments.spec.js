/**
 * Markdown/CSV attachment previews keep their identity across rerenders.
 *
 * Regression: Markdown.tsx rebuilt the whole message DOM (innerHTML) in one
 * effect keyed on `attachments` and every callback prop, so any parent
 * render - a composer keystroke recreated `onSaveToProject` - destroyed the
 * cards, refetched the files, and lost the collapse state; long previews
 * also started expanded despite the "start collapsed" intent.
 *
 * Two layers: the renderer harness drives `renderAttachments` directly
 * (reconciliation, abort, stale responses, disposal); the Study page proves
 * the React wiring (typing in the composer no longer touches the cards).
 */
/* global window */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const LONG_MD = `# Projects\n\n${Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} about project_trigger_deliveries and RETRYABLE backoff.`).join('\n\n')}\n`;
const SHORT_MD = '# Note\n\nJust two lines.\n';
const CSV = 'city,population\nParis,2102650\nLyon,522250\nNice,342669\n';

function fileUrl(id) {
    return `/api/app/files/${id}`;
}

/**
 * Serve the fake files and count requests per id. `delays` holds a promise
 * resolver per id so a spec can hold a response open.
 */
async function stubFiles(page, { delays = {} } = {}) {
    const counts = {};
    const aborted = [];
    page.on('requestfailed', (request) => {
        const m = /\/api\/app\/files\/([^/?#]+)/.exec(request.url());
        if (m) aborted.push(m[1]);
    });
    await page.route(/\/api\/app\/files\/([^/?#]+)$/, async (route) => {
        const id = /\/api\/app\/files\/([^/?#]+)$/.exec(route.request().url())[1];
        counts[id] = (counts[id] || 0) + 1;
        if (delays[id]) await delays[id];
        const body = id.startsWith('long') ? LONG_MD
            : id.startsWith('short') ? SHORT_MD
                : id.startsWith('csv') ? CSV
                    : id.startsWith('stale') ? 'STALE CONTENT\n'
                        : id.startsWith('fresh') ? 'FRESH CONTENT\n'
                            : 'plain\n';
        const contentType = id.startsWith('csv') ? 'text/csv' : 'text/markdown';
        try {
            await route.fulfill({ status: 200, contentType, body });
        } catch { /* the page aborted the request - expected in the abort specs */ }
    });
    return { counts, aborted };
}

async function openHarness(page) {
    await page.goto('/e2e/attachments-harness');
    await page.waitForFunction(() => window.__ready === true);
}

/** Call renderAttachments in the page with a fresh array instance every time. */
async function render(page, attachments) {
    await page.evaluate((list) => {
        window.__att.renderAttachments(window.__container, list.map(f => ({ ...f })));
    }, attachments);
}

test.describe('attachment renderer (harness)', () => {
    test.beforeEach(async ({ page }) => {
        await openHarness(page);
        await page.evaluate(() => window.__att.resetAttachmentState());
    });

    test('long previews start collapsed, short ones expanded, and the toggle is accessible', async ({ page }) => {
        await stubFiles(page);
        await render(page, [
            { url: fileUrl('long-1'), name: 'projects.md', kind: 'markdown' },
            { url: fileUrl('short-1'), name: 'note.md', kind: 'markdown' }
        ]);
        const long = page.locator('.file-card', { hasText: 'projects.md' });
        const short = page.locator('.file-card', { hasText: 'note.md' });
        await expect(long.locator('.file-card-toggle')).toHaveText('Expand');
        await expect(long).toHaveClass(/collapsed/);
        await expect(long.locator('.file-card-toggle')).toHaveAttribute('aria-expanded', 'false');
        await expect(long.locator('.file-card-toggle')).toHaveAttribute('aria-label', 'Toggle preview of projects.md');
        const controls = await long.locator('.file-card-toggle').getAttribute('aria-controls');
        expect(await long.locator('.file-card-body').getAttribute('id')).toBe(controls);

        await expect(short.locator('.file-card-toggle')).toHaveText('Collapse');
        await expect(short).not.toHaveClass(/collapsed/);
        await expect(short.locator('.file-card-toggle')).toHaveAttribute('aria-expanded', 'true');
        await expect(short.locator('.file-card-markdown h1')).toHaveText('Note');
        await page.screenshot({ path: '/opt/cursor/artifacts/attachments_initial_collapse.png' });

        await long.locator('.file-card-toggle').click();
        await expect(long).not.toHaveClass(/collapsed/);
        await expect(long.locator('.file-card-toggle')).toHaveText('Collapse');
        await expect(long.locator('.file-card-toggle')).toHaveAttribute('aria-expanded', 'true');
        await long.locator('.file-card-toggle').click();
        await expect(long).toHaveClass(/collapsed/);
        await expect(long.locator('.file-card-toggle')).toHaveText('Expand');
        await expect(long.locator('.file-card-toggle')).toHaveAttribute('aria-expanded', 'false');
    });

    test('a new array instance with the same files neither refetches nor resets state', async ({ page }) => {
        const { counts } = await stubFiles(page);
        const files = [{ url: fileUrl('long-2'), name: 'projects.md', kind: 'markdown', caption: 'docs' }];
        await render(page, files);
        const card = page.locator('.file-card');
        await expect(card.locator('.file-card-toggle')).toHaveText('Expand');
        await card.locator('.file-card-toggle').click();
        await expect(card).not.toHaveClass(/collapsed/);

        for (let i = 0; i < 10; i++) await render(page, files);
        await expect(page.locator('.file-card')).toHaveCount(1);
        await expect(page.locator('.file-card-toggle')).toHaveCount(1);
        await expect(card).not.toHaveClass(/collapsed/);
        await expect(card.locator('.file-card-toggle')).toHaveText('Collapse');
        expect(counts['long-2']).toBe(1);

        await card.locator('.file-card-toggle').click();
        for (let i = 0; i < 5; i++) await render(page, files);
        await expect(card).toHaveClass(/collapsed/);
        expect(counts['long-2']).toBe(1);
    });

    test('a rebuilt card remembers the collapse choice (history reload)', async ({ page }) => {
        const { counts } = await stubFiles(page);
        const files = [{ url: fileUrl('long-3'), name: 'projects.md', kind: 'markdown' }];
        await render(page, files);
        await page.locator('.file-card-toggle').click();
        await expect(page.locator('.file-card')).not.toHaveClass(/collapsed/);

        await page.evaluate(() => window.__att.disposeAttachments(window.__container));
        await expect(page.locator('.file-card')).toHaveCount(0);
        await render(page, files);
        await expect(page.locator('.file-card-toggle')).toHaveText('Collapse');
        await expect(page.locator('.file-card')).not.toHaveClass(/collapsed/);
        expect(counts['long-3']).toBe(2);
    });

    test('replacing an attachment aborts the old request and a stale response cannot win', async ({ page }) => {
        let releaseStale;
        const staleGate = new Promise((resolve) => { releaseStale = resolve; });
        const { counts, aborted } = await stubFiles(page, { delays: { 'stale-1': staleGate } });

        // Same file id (same key) with a changed caption = a replaced card.
        await render(page, [{ url: fileUrl('stale-1'), name: 'report.md', kind: 'markdown', caption: 'v1' }]);
        await expect(page.locator('.file-card-loading')).toHaveText('Loading…');
        await render(page, [{ url: fileUrl('stale-1'), name: 'report.md', kind: 'markdown', caption: 'v2' }]);
        // The replacement also hits stale-1 (held open); let a different,
        // fresh body land through a second replacement to prove ordering.
        await render(page, [{ url: fileUrl('fresh-1'), name: 'report.md', kind: 'markdown', caption: 'v3' }]);
        await expect(page.locator('.file-card')).toHaveCount(1);
        await expect(page.locator('.file-card-preview')).toContainText('FRESH CONTENT');

        releaseStale();
        await page.waitForTimeout(150);
        await expect(page.locator('.file-card')).toHaveCount(1);
        await expect(page.locator('.file-card-preview')).toContainText('FRESH CONTENT');
        await expect(page.locator('.file-card-preview')).not.toContainText('STALE');
        await expect(page.locator('.file-card-error')).toHaveCount(0);
        expect(counts['stale-1']).toBe(2);
        expect(aborted.filter(id => id === 'stale-1').length).toBeGreaterThanOrEqual(1);
    });

    test('disposing during a fetch mutates nothing and logs no error', async ({ page }) => {
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const { aborted } = await stubFiles(page, { delays: { 'long-4': gate } });

        await render(page, [{ url: fileUrl('long-4'), name: 'projects.md', kind: 'markdown' }]);
        await expect(page.locator('.file-card-loading')).toBeVisible();
        await page.evaluate(() => window.__att.disposeAttachments(window.__container));
        await expect(page.locator('#attachments')).toBeEmpty();
        release();
        await page.waitForTimeout(150);
        await expect(page.locator('#attachments')).toBeEmpty();
        expect(errors).toEqual([]);
        expect(aborted).toContain('long-4');
    });

    test('CSV sort state survives unrelated rerenders; links and other kinds still render', async ({ page }) => {
        const { counts } = await stubFiles(page);
        const files = [
            { url: fileUrl('csv-1'), name: 'cities.csv', kind: 'csv', sourceUrl: 'https://data.example.org/cities.csv' },
            { url: fileUrl('img-1'), name: 'pillars.png', kind: 'image', caption: 'Pillars of Creation', sourceUrl: 'https://commons.example.org/wiki/File:Pillars.png' },
            { url: fileUrl('bin-1'), name: 'archive.zip' }
        ];
        await render(page, files);
        const csv = page.locator('.file-card[data-kind="csv"]');
        await expect(csv.locator('tbody tr').first()).toContainText('Paris');
        await csv.getByRole('button', { name: 'population' }).click();
        await expect(csv.locator('tbody tr').first()).toContainText('Nice');
        await expect(csv.getByRole('button', { name: 'population' })).toHaveAttribute('data-dir', 'asc');

        for (let i = 0; i < 5; i++) await render(page, files);
        await expect(csv.locator('tbody tr').first()).toContainText('Nice');
        await expect(csv.getByRole('button', { name: 'population' })).toHaveAttribute('data-dir', 'asc');
        expect(counts['csv-1']).toBe(1);
        await expect(page.locator('.file-card')).toHaveCount(1);

        const download = csv.locator('a.file-card-action', { hasText: 'Download' });
        await expect(download).toHaveAttribute('href', fileUrl('csv-1'));
        await expect(download).toHaveAttribute('download', 'cities.csv');
        const source = csv.locator('a.file-card-action', { hasText: 'data.example.org' });
        await expect(source).toHaveAttribute('href', 'https://data.example.org/cities.csv');
        await expect(source).toHaveAttribute('rel', 'noopener noreferrer');

        await expect(page.locator('figure.attachment-figure img.attachment')).toHaveAttribute('src', fileUrl('img-1'));
        await expect(page.locator('.attachment-caption')).toContainText('Pillars of Creation');
        await expect(page.locator('a.file-chip')).toHaveAttribute('download', 'archive.zip');
        await page.screenshot({ path: '/opt/cursor/artifacts/attachments_csv_image_chip.png' });

        // Dropping a file removes exactly that card.
        await render(page, files.slice(1));
        await expect(page.locator('.file-card')).toHaveCount(0);
        await expect(page.locator('figure.attachment-figure')).toHaveCount(1);
        await expect(page.locator('a.file-chip')).toHaveCount(1);
    });
});

const CONV_ID = 91;
const HISTORY = {
    messages: [
        { id: 1, role: 'user', content: 'Fetch the projects doc and the cities table', createdAt: '2026-09-19 12:00:00' },
        {
            id: 2,
            role: 'assistant',
            content: 'Here they are.',
            createdAt: '2026-09-19 12:00:08',
            attachments: [
                { url: fileUrl('long-study'), name: 'projects.md', kind: 'markdown', caption: 'Observatory projects documentation' },
                { url: fileUrl('csv-study'), name: 'cities.csv', kind: 'csv' }
            ]
        }
    ]
};

function sseFrame(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function stubStudy(page) {
    await page.route(/\/api\/app\/chat\/turn$/, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ inFlight: false }) });
    });
    await page.route(/\/api\/app\/chat\/turn\/stream/, async (route) => {
        await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
            body: sseFrame('done', { ok: true })
        });
    });
    await page.route(/\/api\/app\/chat\/queue$/, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
    });
    await page.route(/\/api\/app\/chat\/conversations$/, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ conversations: [{ id: CONV_ID, title: 'Projects doc', messageCount: 2, lastMessageAt: '2026-09-19 12:00:08' }] })
        });
    });
    await page.route(/\/api\/app\/chat\/history/, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HISTORY) });
    });
}

test.describe('Study attachments', () => {
    test('composer keystrokes no longer rebuild, refetch, or un-collapse attachment previews', async ({ page }) => {
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await login(page);
        const { counts } = await stubFiles(page);
        await stubStudy(page);
        await page.goto(`/app/study/${CONV_ID}`);

        const card = page.locator('.file-card[data-kind="markdown"]');
        const csv = page.locator('.file-card[data-kind="csv"]');
        await expect(card).toHaveClass(/collapsed/);
        await expect(card.locator('.file-card-toggle')).toHaveText('Expand');
        await expect(csv.locator('tbody tr').first()).toContainText('Paris');
        await page.screenshot({ path: '/opt/cursor/artifacts/study_attachment_collapsed.png', fullPage: true });

        await card.locator('.file-card-toggle').click();
        await expect(card).not.toHaveClass(/collapsed/);
        await csv.getByRole('button', { name: 'population' }).click();
        await expect(csv.locator('tbody tr').first()).toContainText('Nice');

        // Every keystroke rerenders StudyRoom → ChatTranscript → Markdown with
        // a fresh onSaveToProject identity: the regression trigger.
        const composer = page.getByPlaceholder(/Message Goobster/);
        await composer.click();
        await composer.pressSequentially('does this survive typing?', { delay: 15 });
        await expect(composer).toHaveValue('does this survive typing?');

        await expect(card).not.toHaveClass(/collapsed/);
        await expect(card.locator('.file-card-toggle')).toHaveText('Collapse');
        await expect(csv.locator('tbody tr').first()).toContainText('Nice');
        await expect(page.locator('.file-card')).toHaveCount(2);
        await expect(page.locator('.file-card-toggle')).toHaveCount(1);
        expect(counts['long-study']).toBe(1);
        expect(counts['csv-study']).toBe(1);
        await page.screenshot({ path: '/opt/cursor/artifacts/study_attachment_after_typing.png', fullPage: true });

        await card.locator('.file-card-toggle').click();
        await composer.pressSequentially(' yes', { delay: 15 });
        await expect(card).toHaveClass(/collapsed/);
        await expect(card.locator('.file-card-toggle')).toHaveText('Expand');
        expect(counts['long-study']).toBe(1);

        await expect(card.locator('a.file-card-action', { hasText: 'Download' })).toHaveAttribute('href', fileUrl('long-study'));
        await expect(page.locator('.md-body p', { hasText: 'Here they are.' })).toBeVisible();
        expect(errors).toEqual([]);
    });
});
