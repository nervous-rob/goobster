/**
 * Guided tutorials (F1 framework + F2 authored E2/E4 tours). Settings Resume /
 * Replay / Reset, auto-start, unknown-id rejection, public share never starts
 * a tour, sample demos, Keep this example, and skip-one-step. No provider
 * calls — the harness seeds progress through /e2e/fixtures/tutorial-progress.
 */
const { test, expect } = require('@playwright/test');
const { login, openRoom } = require('./helpers');
const C = require('./constants');

async function seedTutorials(page) {
    const res = await page.request.post('/e2e/fixtures/tutorial-progress', {
        data: {
            userId: C.OWNER,
            autoStart: false,
            seedSideEffects: true,
            rows: [
                {
                    tutorialId: 'home.orientation',
                    version: 2,
                    status: 'paused',
                    generation: 1,
                    revision: 2,
                    currentStepId: 'doors',
                    completedStepIds: [],
                    skippedStepIds: []
                },
                {
                    tutorialId: 'chat.basics',
                    version: 2,
                    status: 'completed',
                    generation: 1,
                    revision: 3,
                    currentStepId: null,
                    completedStepIds: ['sample-answer', 'save-as-note', 'add-to-project']
                }
            ]
        }
    });
    expect(res.ok()).toBe(true);
}

async function confirmModal(page) {
    const dialog = page.locator('[role="dialog"]').filter({ hasText: /Reset|Keep/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm' }).click();
}

test.beforeEach(async ({ page }) => {
    await login(page);
    await seedTutorials(page);
});

test('Settings lists tours; Resume, Replay, Reset one and Reset all work without touching notes or tools', async ({ page }) => {
    await page.goto('/app/settings/tutorials');
    await expect(page.getByRole('heading', { name: 'Tutorials', exact: true })).toBeVisible();
    await expect(page.locator('[data-tour="tutorial-list"]')).toBeVisible();

    const homeRow = page.locator('.tutorial-row[data-tutorial-id="home.orientation"]');
    const chatRow = page.locator('.tutorial-row[data-tutorial-id="chat.basics"]');
    await expect(homeRow).toContainText('Paused');
    await expect(chatRow).toContainText('Completed');

    // Resume opens the nonmodal panel for the paused tour with authored step copy.
    await homeRow.getByRole('button', { name: 'Resume' }).click();
    const panel = page.locator('[data-tour="tutorial-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-tutorial-id', 'home.orientation');
    await expect(panel.locator('[data-tour="tutorial-step-title"]')).toContainText('Three doors');
    await page.locator('[data-tour="tutorial-pause"]').click();
    await expect(panel).toHaveCount(0);

    // Reset one clears only home.orientation.
    await page.goto('/app/settings/tutorials');
    await expect(homeRow).toContainText('Paused');
    await homeRow.getByRole('button', { name: 'Reset' }).click();
    await confirmModal(page);
    await expect(homeRow).toContainText('Not started', { timeout: 10_000 });
    await expect(chatRow).toContainText('Completed');

    // Replay on chat clears completed progress and restarts (F2 steps are launchable).
    await chatRow.getByRole('button', { name: 'Replay' }).click();
    await expect(page.locator('[data-tour="tutorial-panel"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-tour="tutorial-panel"]')).toHaveAttribute('data-tutorial-id', 'chat.basics');
    await page.locator('[data-tour="tutorial-pause"]').click();
    await page.goto('/app/settings/tutorials');
    await expect(chatRow).toContainText(/In progress|Paused|Not started/, { timeout: 10_000 });

    // Re-seed, then Reset all.
    await seedTutorials(page);
    await page.goto('/app/settings/tutorials');
    await expect(homeRow).toContainText('Paused');
    await page.locator('[data-tour="tutorial-reset-all"]').click();
    await confirmModal(page);
    await expect(homeRow).toContainText('Not started', { timeout: 10_000 });
    await expect(chatRow).toContainText('Not started');

    // Side effects untouched: hidden tool survives Reset all.
    const settings = await page.request.get('/api/app/settings');
    expect(settings.ok()).toBe(true);
    const appearance = (await settings.json()).sections.appearance.values;
    expect(appearance.hiddenToolRooms).toContain('music');

    const note = await page.request.get(
        `/api/app/spitball/notes?scope=${encodeURIComponent(`dm:${C.OWNER}`)}&view=knowledge`
    );
    expect(note.ok()).toBe(true);
    const notePayload = await note.json();
    expect(notePayload.notes.some((n) => n.label === C.TUTORIAL_SIDE_NOTE)).toBe(true);

    // Auto-start toggle
    const toggle = page.locator('[data-tour="tutorial-auto-start"]');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
});

test('an unknown tutorial id is rejected; a public share never starts a tour', async ({ page }) => {
    const bad = await page.request.post('/api/app/tutorials/made.up/events', {
        data: {
            eventId: 'e2e-unknown',
            generation: 1,
            expectedRevision: 0,
            action: 'start'
        }
    });
    expect(bad.status()).toBe(404);
    const body = await bad.json();
    expect(body.error.code).toBe('UNKNOWN_TUTORIAL');

    await page.request.post('/e2e/fixtures/tutorial-progress', {
        data: {
            rows: [{
                tutorialId: 'home.orientation',
                version: 2,
                status: 'in_progress',
                generation: 1,
                revision: 1,
                currentStepId: 'doors'
            }]
        }
    });
    const reset = await page.request.post('/api/app/tutorials/home.orientation/reset');
    expect(reset.ok()).toBe(true);
    const stale = await page.request.post('/api/app/tutorials/home.orientation/events', {
        data: {
            eventId: 'e2e-stale',
            generation: 1,
            expectedRevision: 1,
            action: 'pause'
        }
    });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error.code).toBe('STALE_GENERATION');

    await page.context().clearCookies();
    await page.goto('/app/share/not-a-real-token');
    await expect(page.locator('[data-tour="tutorial-panel"]')).toHaveCount(0);
    await expect(page.locator('[data-tour="tutorial-offer"]')).toHaveCount(0);
});

test('skipping one tutorial via the API leaves another not_started', async ({ page }) => {
    // Clear the beforeEach seed so chat stays not_started while we skip home.
    await page.request.post('/api/app/tutorials/reset');
    await page.request.post('/e2e/fixtures/tutorial-progress', {
        data: {
            autoStart: false,
            rows: [{
                tutorialId: 'home.orientation',
                version: 2,
                status: 'in_progress',
                generation: 1,
                revision: 1,
                currentStepId: 'doors'
            }]
        }
    });
    const skipped = await page.request.post('/api/app/tutorials/home.orientation/events', {
        data: {
            eventId: 'e2e-skip-home',
            generation: 1,
            expectedRevision: 1,
            action: 'skip_tutorial'
        }
    });
    expect(skipped.ok()).toBe(true);
    expect((await skipped.json()).status).toBe('skipped');

    const list = await page.request.get('/api/app/tutorials');
    expect(list.ok()).toBe(true);
    const payload = await list.json();
    const chat = payload.progress.find((p) => p.tutorialId === 'chat.basics');
    expect(chat?.status || 'not_started').toBe('not_started');
    expect(payload.catalog.find((c) => c.id === 'admin.instance')).toBeUndefined();
    expect(payload.sample?.id).toBe('weekend-field-notebook');
});

test('authored demos, skip step, and Keep this example work without a provider', async ({ page }) => {
    await page.request.post('/api/app/tutorials/reset');
    await page.request.post('/e2e/fixtures/tutorial-progress', {
        data: {
            autoStart: false,
            rows: [{
                tutorialId: 'chat.basics',
                version: 2,
                status: 'in_progress',
                generation: 1,
                revision: 1,
                currentStepId: 'sample-answer',
                completedStepIds: [],
                skippedStepIds: []
            }]
        }
    });

    await page.goto('/app/settings/tutorials');
    const chatRow = page.locator('.tutorial-row[data-tutorial-id="chat.basics"]');
    await chatRow.getByRole('button', { name: 'Resume' }).click();

    const panel = page.locator('[data-tour="tutorial-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-tutorial-id', 'chat.basics');
    await expect(panel.locator('[data-tour="tutorial-step-title"]')).toContainText('A sample answer');
    await expect(panel.locator('[data-tour="tutorial-demo"]')).toContainText('no provider call');
    await expect(panel.locator('[data-tour="tutorial-demo"]')).toContainText('coastal walk');

    // Skip one step — records a skip, advances to save-as-note.
    await panel.locator('[data-tour="tutorial-skip-step"]').click();
    await expect(panel).toHaveAttribute('data-step-id', 'save-as-note', { timeout: 10_000 });
    await expect(panel.locator('[data-tour="tutorial-step-title"]')).toContainText('Save as note');
    await expect(panel.locator('[data-tour="tutorial-demo"]')).toBeVisible();
    await expect(panel.locator('[data-tour="tutorial-keep-example"]')).toBeVisible();

    // Keep this example is the only knowledge write.
    const keepResp = page.waitForResponse((res) =>
        res.url().includes('/api/app/tutorials/keep-example') && res.request().method() === 'POST'
    );
    await panel.locator('[data-tour="tutorial-keep-example"]').click();
    await confirmModal(page);
    const kept = await keepResp;
    expect(kept.ok()).toBe(true);
    await expect(page.locator('#toast')).toContainText('Tide-pool anemones', { timeout: 10_000 });

    const notes = await page.request.get(
        `/api/app/spitball/notes?scope=${encodeURIComponent(`dm:${C.OWNER}`)}&view=knowledge`
    );
    expect(notes.ok()).toBe(true);
    const payload = await notes.json();
    expect(payload.notes.some((n) => n.label === 'Tide-pool anemones')).toBe(true);

    // Next advances without a provider call.
    await panel.locator('[data-tour="tutorial-next"]').click();
    await expect(panel).toHaveAttribute('data-step-id', 'add-to-project', { timeout: 10_000 });
    await expect(panel.locator('[data-tour="tutorial-finish"]')).toBeVisible();
    await panel.locator('[data-tour="tutorial-finish"]').click();
    await expect(panel).toHaveCount(0, { timeout: 10_000 });

    const list = await page.request.get('/api/app/tutorials');
    const chat = (await list.json()).progress.find((p) => p.tutorialId === 'chat.basics');
    expect(chat.status).toMatch(/completed|finished_with_skips/);
    expect(chat.skippedStepIds).toContain('sample-answer');
    expect(chat.completedStepIds).toContain('save-as-note');
});

test('a step spotlights its anchor and offers a hop to another view of the same room', async ({ page }) => {
    await page.request.post('/api/app/tutorials/reset');
    await page.request.post('/e2e/fixtures/tutorial-progress', {
        data: {
            autoStart: false,
            rows: [{
                tutorialId: 'knowledge.basics',
                version: 2,
                status: 'in_progress',
                generation: 1,
                revision: 1,
                currentStepId: 'create-note',
                completedStepIds: [],
                skippedStepIds: []
            }]
        }
    });

    // Resume from Settings, then hop to the Notes view where the anchor lives.
    await page.goto('/app/settings/tutorials');
    await page.locator('.tutorial-row[data-tutorial-id="knowledge.basics"]').getByRole('button', { name: 'Resume' }).click();
    const panel = page.locator('[data-tour="tutorial-panel"]');
    await expect(panel).toHaveAttribute('data-step-id', 'create-note');
    // Settings is another room: the panel links to Knowledge · Notes.
    await expect(panel.locator('[data-tour="tutorial-goto"]')).toContainText('Knowledge · Notes');
    await panel.locator('[data-tour="tutorial-goto"]').click();

    // On Notes the New note button is the anchor: spotlighted, and no hop link.
    const anchor = page.locator('[data-tour="knowledge-new-note"]');
    await expect(anchor).toHaveClass(/tour-target/, { timeout: 10_000 });
    await expect(panel.locator('[data-tour="tutorial-goto"]')).toHaveCount(0);

    // The next step lives on the Map view of the same room: hop link, no spotlight left behind.
    await panel.locator('[data-tour="tutorial-next"]').click();
    await expect(panel).toHaveAttribute('data-step-id', 'connect-tags', { timeout: 10_000 });
    await expect(anchor).not.toHaveClass(/tour-target/);
    await expect(panel.locator('[data-tour="tutorial-goto"]')).toContainText('Knowledge · Map');
    await panel.locator('[data-tour="tutorial-goto"]').click();
    await expect(page).toHaveURL(/\/app\/knowledge\/map/);
    await expect(panel).toHaveAttribute('data-step-id', 'connect-tags');
    await expect(page.locator('[data-tour="knowledge-map"]')).toHaveClass(/tour-target/, { timeout: 10_000 });
    await expect(panel.locator('[data-tour="tutorial-goto"]')).toHaveCount(0);
});

test('progress pointing at a step the catalog no longer has offers Start over instead of a dead end', async ({ page }) => {
    await page.request.post('/api/app/tutorials/reset');
    await page.request.post('/e2e/fixtures/tutorial-progress', {
        data: {
            autoStart: false,
            rows: [{
                tutorialId: 'knowledge.basics',
                version: 2,
                status: 'in_progress',
                generation: 1,
                revision: 3,
                currentStepId: 'renamed-away',
                completedStepIds: [],
                skippedStepIds: []
            }]
        }
    });

    await page.goto('/app/settings/tutorials');
    await page.locator('.tutorial-row[data-tutorial-id="knowledge.basics"]').getByRole('button', { name: 'Resume' }).click();
    const panel = page.locator('[data-tour="tutorial-panel"]');
    await expect(panel.locator('[data-tour="tutorial-stale-step"]')).toBeVisible();
    await expect(panel.locator('[data-tour="tutorial-next"]')).toHaveCount(0);
    await panel.locator('[data-tour="tutorial-start-over"]').click();
    await expect(panel).toHaveAttribute('data-step-id', 'create-note', { timeout: 10_000 });
    await expect(panel.locator('[data-tour="tutorial-step-title"]')).toContainText('A kept note');
});


test('home and room offers remain independent within one session', async ({ page }) => {
    await page.request.post('/api/app/tutorials/reset');
    await page.request.post('/e2e/fixtures/tutorial-progress', { data: { autoStart: true, rows: [] } });
    await page.goto('/app/');
    const offer = page.locator('[data-tour="tutorial-offer"]');
    await expect(offer).toBeVisible();
    await page.locator('[data-tour="tutorial-offer-start"]').click();
    const panel = page.locator('[data-tour="tutorial-panel"]');
    await expect(panel).toHaveAttribute('data-tutorial-id', 'home.orientation');
    await expect(panel).toHaveAttribute('data-step-id', 'doors');
    while (await panel.locator('[data-tour="tutorial-next"]').count()) {
        const step = await panel.getAttribute('data-step-id');
        await panel.locator('[data-tour="tutorial-next"]').click();
        await expect(panel).not.toHaveAttribute('data-step-id', step);
    }
    await panel.locator('[data-tour="tutorial-finish"]').click();
    await expect(panel).toHaveCount(0);
    await openRoom(page, 'Chat');
    await expect(offer).toContainText('Chat basics');
    await page.locator('[data-tour="tutorial-offer-dismiss"]').click();
    await expect(offer).toHaveCount(0);
    await openRoom(page, 'Knowledge');
    await expect(offer).toBeVisible();
    await page.locator('[data-tour="tutorial-offer-start"]').click();
    await expect(panel).toHaveAttribute('data-tutorial-id', 'knowledge.basics');
    await page.keyboard.press('Escape');
    await openRoom(page, 'Chat');
    await expect(offer).toHaveCount(0);
    await openRoom(page, 'Knowledge');
    await expect(panel).toHaveCount(0);
    await expect(offer).toHaveCount(0);
});

test('late and replaced anchors stay highlighted, and reduced motion disables animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/app/settings/tutorials');
    await page.locator('.tutorial-row[data-tutorial-id="home.orientation"]').getByRole('button', { name: 'Resume' }).click();
    // Delay the real Home response beyond the former 1.85-second retry window.
    await page.route('**/api/app/home', async route => {
        const response = await route.fetch();
        await new Promise(resolve => setTimeout(resolve, 2500));
        await route.fulfill({ response });
    });
    await page.locator('[data-tour="tutorial-goto"]').click();
    const anchor = page.locator('[data-tour="home-create"]');
    await expect(anchor).toHaveClass(/tour-target/);
    await expect(anchor).toHaveCSS('animation-name', 'none');
    // Replace an anchor on the same route, as a loading/refetch boundary can do.
    await anchor.evaluate(el => {
        const replacement = el.cloneNode(true);
        replacement.classList.remove('tour-target');
        el.replaceWith(replacement);
    });
    await expect(anchor).toHaveClass(/tour-target/);
    await page.locator('[data-tour="tutorial-next"]').click();
    await expect(anchor).not.toHaveClass(/tour-target/);
    await expect(page.locator('[data-tour="home-private"]')).toHaveClass(/tour-target/);
});
