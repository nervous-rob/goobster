/**
 * A payload without Tavern, the Exchange and Projects ships a portal without
 * their chunks (#328, documentation/packaging.md). A second headless portal
 * serves a pruned copy of the built client (scripts/lib/frontendChunks.js
 * pruneDist, the same step package-runtime runs) with a features.json that
 * marks the three not installed, and the shell has to keep working: the core
 * rooms render, the excluded rooms are absent from navigation, their deep
 * links explain themselves, and a deleted chunk never becomes an uncaught
 * error or a reload loop.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { login, createSecondServer } = require('./helpers');
const C = require('./constants');
const catalog = require('@goobster/core/features/catalog');
const { pruneDist, readFeatureChunks } = require('../scripts/lib/frontendChunks');

const PORT = Number(process.env.GOOBSTER_E2E_PORT || 4173) + 200;
const SOURCE_DIST = path.join(__dirname, '..', 'apps', 'web', 'dist');
const EXCLUDED = ['tavern', 'exchange', 'projects'];
const NAV = (page) => page.getByRole('navigation', { name: 'Rooms' });

const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-e2e-reduced-dist-'));
const second = createSecondServer({ port: PORT });
let removed = [];

/** Collects everything a page should never produce in a reduced payload. */
function watch(page) {
    const seen = { pageErrors: [], deletedRequests: [], deletedFailures: [], navigations: 0 };
    const deleted = new Set(removed.map((file) => `/app/${file}`));
    page.on('pageerror', (error) => seen.pageErrors.push(String(error?.message || error)));
    page.on('request', (request) => {
        if (deleted.has(new URL(request.url()).pathname)) seen.deletedRequests.push(new URL(request.url()).pathname);
    });
    page.on('response', (response) => {
        if (deleted.has(new URL(response.url()).pathname)) seen.deletedFailures.push(response.status());
    });
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) seen.navigations += 1; });
    return seen;
}

async function expectUnavailable(page, target, feature) {
    const notice = page.getByTestId('feature-unavailable');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('data-feature', feature);
    await expect(notice).toContainText('Not available on this installation');
    await expect(NAV(page)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${target}$`));
}

test.describe('a payload without tavern, exchange and projects', () => {
    test.describe.configure({ mode: 'serial' });
    test.use({ baseURL: second.url });

    test.beforeAll(async () => {
        test.setTimeout(120_000);
        fs.cpSync(SOURCE_DIST, dist, { recursive: true });
        const installed = catalog.FEATURE_IDS.filter((id) => id !== 'core' && !EXCLUDED.includes(id));
        ({ removed } = pruneDist(dist, { installed }));
        const features = Object.fromEntries(EXCLUDED.map((id) => [id, { installed: false, active: false }]));
        await second.start({ features, env: { GOOBSTER_E2E_WEB_DIST: dist } });
    });

    test.afterAll(async () => {
        await second.stop();
        second.cleanup();
        fs.rmSync(dist, { recursive: true, force: true });
    });

    test('the pruned client has no exchange or projects files, and the server reports them not installed', async ({ page }) => {
        const chunks = readFeatureChunks(SOURCE_DIST).chunks;
        const owned = Object.keys(chunks).filter((file) => ['exchange', 'projects'].includes(chunks[file]));
        expect(owned.length).toBeGreaterThan(0);
        expect(removed).toEqual(expect.arrayContaining(owned));
        for (const file of owned) expect(fs.existsSync(path.join(dist, file))).toBe(false);
        for (const [file, feature] of Object.entries(chunks)) {
            if (!EXCLUDED.includes(feature)) expect(fs.existsSync(path.join(dist, file))).toBe(true);
        }
        const recorded = JSON.parse(fs.readFileSync(path.join(dist, 'installed-features.json'), 'utf8'));
        expect(recorded.features).not.toEqual(expect.arrayContaining(['projects']));

        await login(page);
        const missing = await page.request.get(`/app/${owned[0]}`);
        expect(missing.status()).toBe(404);
        const body = await (await page.request.get('/api/app/features')).json();
        for (const id of EXCLUDED) expect(body.features[id]).toMatchObject({ installed: false, active: false });
        expect(body.features.knowledge.active).toBe(true);
    });

    test('Home, Chat and Settings render, and the excluded rooms are absent from navigation', async ({ page }) => {
        const seen = watch(page);
        await login(page);
        await expect(page.getByRole('heading', { name: new RegExp(C.OWNER_NAME) })).toBeVisible();
        await expect(NAV(page).getByRole('link', { name: 'Projects' })).toHaveCount(0);
        await expect(NAV(page).getByRole('link', { name: 'Knowledge' })).toBeVisible();

        await NAV(page).getByRole('link', { name: 'Chat' }).click();
        await expect(page).toHaveURL(/\/app\/chat/);
        await expect(page.getByRole('textbox').first()).toBeVisible();

        await page.goto('/app/settings');
        await expect(page.getByRole('heading', { name: /Settings/ }).first()).toBeVisible();

        await page.goto('/app/tools');
        const trading = page.locator('.tools-card:has([data-tour="tool-trading"])');
        await expect(trading).toHaveAttribute('data-available', 'false');
        await expect(trading.getByTestId('tool-unavailable')).toContainText('Not available on this installation');
        await expect(trading.locator('a.tools-card-link')).toHaveCount(0);

        expect(seen.pageErrors).toEqual([]);
        expect(seen.deletedRequests).toEqual([]);
    });

    test('deep links to the excluded rooms render the unavailable state without loading their chunks', async ({ page }) => {
        const seen = watch(page);
        await login(page);
        for (const [target, feature] of [['/app/projects', 'projects'], ['/app/projects/42', 'projects'], ['/app/exchange', 'exchange']]) {
            await page.goto(target);
            await expectUnavailable(page, target, feature);
        }
        expect(seen.pageErrors).toEqual([]);
        expect(seen.deletedRequests).toEqual([]);
    });

    test('when the shell does not know yet, a deleted chunk lands on the unavailable state, not an error or a reload', async ({ browser }) => {
        // page.route cannot see requests the service worker answers.
        const context = await browser.newContext({ baseURL: second.url, serviceWorkers: 'block' });
        const page = await context.newPage();
        await login(page);
        const seen = watch(page);
        let refused = 0;
        await page.route('**/api/app/features', async (route) => {
            if (seen.deletedRequests.length > 0) return route.continue();
            refused += 1;
            return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"UNAVAILABLE"}}' });
        });
        await page.goto('/app/projects');
        const before = seen.navigations;
        await page.evaluate(() => { globalThis.__reducedPayloadMarker = 'kept'; });

        await expectUnavailable(page, '/app/projects', 'projects');
        await expect(page.getByTestId('feature-unavailable')).toContainText('not installed');
        expect(refused).toBeGreaterThan(0);
        expect(seen.deletedRequests.length).toBeGreaterThan(0);
        expect(seen.deletedFailures.length).toBeGreaterThan(0);
        expect(seen.deletedFailures.every((status) => status === 404)).toBe(true);

        await page.waitForTimeout(1_500);
        expect(await page.evaluate(() => globalThis.__reducedPayloadMarker)).toBe('kept');
        expect(seen.navigations).toBe(before);
        expect(seen.pageErrors).toEqual([]);
        await expect(page.getByRole('link', { name: 'Back to Home' })).toBeVisible();
        await context.close();
    });
});
