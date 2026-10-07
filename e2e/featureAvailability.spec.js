/**
 * Portal rooms, tools and tours reflect which features this installation has
 * made available (#321).
 *
 * The shared server Playwright starts is never changed. Host-disabled cases
 * run a second headless portal (its own port and data dir) whose features.json
 * switches Projects, Expeditions and Music off, then restart it with the file
 * removed to prove the navigation, the cards and the saved tour progress come
 * back. Three states stay distinct throughout: available, unavailable on this
 * installation, and hidden by the person.
 */
const { test, expect } = require('@playwright/test');
const { login, createSecondServer } = require('./helpers');
const C = require('./constants');
const { TUTORIAL_BY_ID } = require('@goobster/core/config/tutorialCatalog');

const SECOND_PORT = Number(process.env.GOOBSTER_E2E_PORT || 4173) + 100;
const TOUR = TUTORIAL_BY_ID['projects.basics'];
const NAV = (page) => page.getByRole('navigation', { name: 'Rooms' });
const UNAVAILABLE = /Not available on this installation/;

async function toolCard(page, id) {
    await page.goto('/app/tools');
    const card = page.locator(`.tools-card:has([data-tour="tool-${id}"])`);
    await expect(card).toBeVisible();
    return card;
}

test.describe('enabled: the shared installation offers everything it always did', () => {
    test.beforeEach(async ({ page }) => {
        await login(page);
    });

    test('navigation, Tools and Research are all available', async ({ page }) => {
        await expect(NAV(page).getByRole('link', { name: 'Projects' })).toBeVisible();
        const music = await toolCard(page, 'music');
        await expect(music).toHaveAttribute('data-available', 'true');
        await expect(music.getByTestId('tool-unavailable')).toHaveCount(0);

        await page.goto('/app/knowledge/notes');
        await expect(page.getByRole('link', { name: /Research/ }).first()).toBeVisible();
        await page.goto('/app/knowledge/research');
        await expect(page.getByTestId('feature-unavailable')).toHaveCount(0);
        await expect(page.locator('[data-tour="knowledge-research"]')).toBeVisible();
    });

    test('the sanitized status route reports the features', async ({ page }) => {
        const response = await page.request.get('/api/app/features');
        expect(response.ok()).toBe(true);
        const body = await response.json();
        expect(Object.keys(body)).toEqual(expect.arrayContaining(['source', 'revision', 'origin', 'error', 'features']));
        expect(body.features.projects.active).toBe(true);
        expect(body.features.music.active).toBe(true);
    });
});

test.describe('a host turns features off, then back on', () => {
    test.describe.configure({ mode: 'serial' });

    const second = createSecondServer({ port: SECOND_PORT });
    test.use({ baseURL: second.url });

    test.beforeAll(async () => {
        test.setTimeout(120_000);
        await second.start({ features: { projects: false, expeditions: false, music: false } });
    });

    test.afterAll(async () => {
        await second.stop();
        second.cleanup();
    });

    test('host-disabled: the status route explains why, without secrets', async ({ page }) => {
        await login(page);
        const response = await page.request.get('/api/app/features');
        const body = await response.json();
        expect(body.features.projects).toMatchObject({ active: false, reasons: [{ code: 'DISABLED' }] });
        expect(body.features.knowledge.active).toBe(true);
        expect(JSON.stringify(body)).not.toMatch(/features\.json|\/tmp\//);
    });

    test('host-disabled: navigation omits the room, and the rest stays', async ({ page }) => {
        await login(page);
        await expect(NAV(page).getByRole('link', { name: 'Projects' })).toHaveCount(0);
        await expect(NAV(page).getByRole('link', { name: 'Chat' })).toBeVisible();
        await expect(NAV(page).getByRole('link', { name: 'Knowledge' })).toBeVisible();
        await expect(NAV(page).getByRole('link', { name: 'Tools' })).toBeVisible();
    });

    test('host-disabled: the Tools card is marked unavailable with its reason and a doc link', async ({ page }) => {
        await login(page);
        const music = await toolCard(page, 'music');
        await expect(music).toHaveAttribute('data-available', 'false');
        await expect(music.getByTestId('tool-unavailable')).toContainText(UNAVAILABLE);
        await expect(music.getByTestId('tool-unavailable')).toContainText('Music is turned off on this installation');
        await expect(music.locator('a.tools-card-link')).toHaveCount(0);
        await expect(music.locator('[aria-disabled="true"]')).toBeVisible();
        await expect(music.getByRole('link', { name: 'About Music' })).toHaveAttribute('href', /\/app\/docs\/music-lab$/);

        const decks = page.locator('.tools-card:has([data-tour="tool-decks"])');
        await expect(decks).toHaveAttribute('data-available', 'true');
        await expect(decks.getByTestId('tool-unavailable')).toHaveCount(0);
    });

    test('host-disabled: a deep link or old bookmark lands on an unavailable state inside the shell', async ({ page }) => {
        await login(page);
        for (const target of ['/app/projects', '/app/projects/42']) {
            await page.goto(target);
            const notice = page.getByTestId('feature-unavailable');
            await expect(notice).toBeVisible();
            await expect(notice).toHaveAttribute('data-feature', 'projects');
            await expect(notice).toContainText('Not available on this installation');
            await expect(notice).toContainText('Projects is turned off on this installation');
            await expect(page.getByRole('heading', { name: /Projects/ }).first()).toBeVisible();
            await expect(NAV(page)).toBeVisible();
            await expect(page).toHaveURL(new RegExp(`${target}$`));
            await expect(page.locator('#toast')).toHaveCount(0);
        }
        await page.getByRole('link', { name: 'Back to Home' }).click();
        await expect(page).toHaveURL(/\/app\/?$/);
        await expect(page.getByRole('heading', { name: new RegExp(C.OWNER_NAME) })).toBeVisible();
    });

    test('host-disabled: a nested view is unavailable while its room still works', async ({ page }) => {
        await login(page);
        await page.goto('/app/knowledge/notes');
        await expect(page.getByRole('heading', { name: /^Knowledge/ }).first()).toBeVisible();
        await expect(page.getByRole('link', { name: /Research/ })).toHaveCount(0);
        await expect(page.getByTestId('feature-unavailable')).toHaveCount(0);

        await page.goto('/app/knowledge/research');
        const notice = page.getByTestId('feature-unavailable');
        await expect(notice).toHaveAttribute('data-feature', 'expeditions');
        await expect(notice).toContainText('Expeditions is turned off on this installation');
        await expect(page).toHaveURL(/\/app\/knowledge\/research$/);
        await notice.getByRole('link', { name: 'Back to Notes' }).click();
        await expect(page).toHaveURL(/\/app\/knowledge\/notes$/);
    });

    test('user-hidden is its own state: not described as unavailable, and nothing else moves', async ({ page }) => {
        await login(page);
        await page.goto('/app/tools');
        const navBefore = await NAV(page).innerText();

        await page.getByRole('button', { name: 'Hide Card decks' }).click();
        await expect(page.locator('.tools-card:has([data-tour="tool-decks"])')).toHaveCount(0);

        const hidden = page.getByRole('region', { name: 'Hidden tools' });
        await expect(hidden).toContainText('Card decks');
        await expect(hidden).not.toContainText(UNAVAILABLE);
        await expect(hidden.getByRole('button', { name: 'Unhide Card decks' })).toBeEnabled();
        expect(await NAV(page).innerText()).toBe(navBefore);

        const music = page.locator('.tools-card:has([data-tour="tool-music"])');
        await expect(music.getByTestId('tool-unavailable')).toContainText(UNAVAILABLE);

        await hidden.getByRole('button', { name: 'Unhide Card decks' }).click();
        await expect(page.locator('.tools-card:has([data-tour="tool-decks"])')).toBeVisible();
    });

    test('tutorial-unavailable: the tour is listed as unavailable, cannot launch, and keeps its progress', async ({ page }) => {
        await login(page);
        const seeded = await page.request.post('/e2e/fixtures/tutorial-progress', {
            data: {
                userId: C.OWNER,
                rows: [{
                    tutorialId: TOUR.id,
                    version: TOUR.version,
                    status: 'paused',
                    currentStepId: TOUR.steps[1].id,
                    completedStepIds: [TOUR.steps[0].id]
                }]
            }
        });
        expect(seeded.ok()).toBe(true);

        await page.goto('/app/settings/tutorials');
        const row = page.locator(`.tutorial-row[data-tutorial-id="${TOUR.id}"]`);
        await expect(row).toBeVisible();
        await expect(row.getByTestId('tutorial-unavailable')).toContainText(UNAVAILABLE);
        await expect(row.getByTestId('tutorial-unavailable')).toContainText('Your progress is kept');
        await expect(row).toContainText('Paused');
        await expect(row.getByRole('button', { name: 'Resume' })).toHaveCount(0);
        await expect(row.getByRole('button', { name: 'Replay' })).toHaveCount(0);
        await expect(row.getByRole('button', { name: 'Reset' })).toBeDisabled();

        const open = page.locator('.tutorial-row[data-tutorial-id="chat.basics"]');
        await expect(open.getByTestId('tutorial-unavailable')).toHaveCount(0);

        const refused = await page.request.post(`/api/app/tutorials/${TOUR.id}/events`, {
            data: { eventId: 'evt_unavailable_1', generation: 1, expectedRevision: 1, action: 'start' }
        });
        expect(refused.status()).toBe(404);
        expect((await refused.json()).error.code).toBe('FEATURE_UNAVAILABLE');
        const reset = await page.request.post(`/api/app/tutorials/${TOUR.id}/reset`);
        expect(reset.status()).toBe(404);

        const listed = await (await page.request.get('/api/app/tutorials')).json();
        const entry = listed.catalog.find((tutorial) => tutorial.id === TOUR.id);
        expect(entry).toMatchObject({ available: false, launchable: false });
        expect(listed.progress.find((progress) => progress.tutorialId === TOUR.id))
            .toMatchObject({ status: 'paused', completedStepIds: [TOUR.steps[0].id] });
    });

    test('re-enable: after a restart the room, card, view and tour progress come back', async ({ page }) => {
        test.setTimeout(120_000);
        await second.restart({ features: null });
        await login(page);

        await expect(NAV(page).getByRole('link', { name: 'Projects' })).toBeVisible();

        const music = await toolCard(page, 'music');
        await expect(music).toHaveAttribute('data-available', 'true');
        await expect(music.getByTestId('tool-unavailable')).toHaveCount(0);

        await page.goto('/app/projects');
        await expect(page.getByTestId('feature-unavailable')).toHaveCount(0);
        await expect(page.getByRole('heading', { name: /^Projects/ }).first()).toBeVisible();

        await page.goto('/app/knowledge/research');
        await expect(page.getByTestId('feature-unavailable')).toHaveCount(0);
        await expect(page.locator('[data-tour="knowledge-research"]')).toBeVisible();

        await page.goto('/app/settings/tutorials');
        const row = page.locator(`.tutorial-row[data-tutorial-id="${TOUR.id}"]`);
        await expect(row.getByTestId('tutorial-unavailable')).toHaveCount(0);
        await expect(row).toContainText('Paused');
        await expect(row).toContainText('step 2 of');
        await expect(row.getByRole('button', { name: 'Resume' })).toBeVisible();
    });
});

test.describe('a host environment override turns one feature off', () => {
    const second = createSecondServer({ port: SECOND_PORT + 1 });
    test.use({ baseURL: second.url });

    test.beforeAll(async () => {
        test.setTimeout(120_000);
        await second.start({ env: { GOOBSTER_FEATURE_MUSIC: '0' } });
    });

    test.afterAll(async () => {
        await second.stop();
        second.cleanup();
    });

    test('the Tools card says a host setting turned it off', async ({ page }) => {
        await login(page);
        const music = await toolCard(page, 'music');
        await expect(music).toHaveAttribute('data-available', 'false');
        await expect(music.getByTestId('tool-unavailable')).toContainText('Music is turned off by a host setting');
        await expect(NAV(page).getByRole('link', { name: 'Projects' })).toBeVisible();
    });
});
