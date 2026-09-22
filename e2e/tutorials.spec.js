/**
 * Guided-tutorial framework (F1). Settings Resume / Replay / Reset one /
 * Reset all, auto-start preference, unknown-id rejection, public share
 * never starts a tour. No provider calls — the harness seeds progress
 * through /e2e/fixtures/tutorial-progress.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
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
                    status: 'paused',
                    generation: 1,
                    revision: 2,
                    currentStepId: 'greet',
                    completedStepIds: [],
                    skippedStepIds: []
                },
                {
                    tutorialId: 'chat.basics',
                    status: 'completed',
                    generation: 1,
                    revision: 3,
                    currentStepId: null,
                    completedStepIds: ['composer', 'save-note']
                }
            ]
        }
    });
    expect(res.ok()).toBe(true);
}

async function confirmModal(page) {
    const dialog = page.locator('[role="dialog"]').filter({ hasText: /Reset/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm' }).click();
}

test.beforeEach(async ({ page }) => {
    await login(page);
    await seedTutorials(page);
});

test('Settings lists tours; Resume, Replay, Reset one and Reset all work without touching notes or tools', async ({ page }) => {
    await page.goto('/app/settings/tutorials');
    await expect(page.getByRole('heading', { name: /Tutorials/ })).toBeVisible();
    await expect(page.locator('[data-tour="tutorial-list"]')).toBeVisible();

    const homeRow = page.locator('.tutorial-row[data-tutorial-id="home.orientation"]');
    const chatRow = page.locator('.tutorial-row[data-tutorial-id="chat.basics"]');
    await expect(homeRow).toContainText('Paused');
    await expect(chatRow).toContainText('Completed');

    // Resume opens the nonmodal panel for the paused tour.
    await homeRow.getByRole('button', { name: 'Resume' }).click();
    const panel = page.locator('[data-tour="tutorial-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-tutorial-id', 'home.orientation');
    await page.locator('[data-tour="tutorial-pause"]').click();
    await expect(panel).toHaveCount(0);

    // Reset one clears only home.orientation.
    await page.goto('/app/settings/tutorials');
    await expect(homeRow).toContainText('Paused');
    await homeRow.getByRole('button', { name: 'Reset' }).click();
    await confirmModal(page);
    await expect(homeRow).toContainText('Not started', { timeout: 10_000 });
    await expect(chatRow).toContainText('Completed');

    // Replay on chat clears it (empty catalog → stays not_started).
    await chatRow.getByRole('button', { name: 'Replay' }).click();
    await expect(chatRow).toContainText('Not started', { timeout: 10_000 });

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
                status: 'in_progress',
                generation: 1,
                revision: 1,
                currentStepId: 'greet'
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
    await page.request.post('/e2e/fixtures/tutorial-progress', {
        data: {
            rows: [{
                tutorialId: 'home.orientation',
                status: 'in_progress',
                generation: 1,
                revision: 1,
                currentStepId: 'greet'
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
    expect(!chat || chat.status === 'not_started').toBe(true);
    expect(payload.catalog.find((c) => c.id === 'admin.instance')).toBeUndefined();
});
