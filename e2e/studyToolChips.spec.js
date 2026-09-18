/**
 * Observatory/project tool chips show action + target in the chip header
 * so a phone can read them without hovering.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const CONV_ID = 77;
const ARGS = '{"action":"read","project":"jwst-atlas","path":"src/notes.md"}';

const HISTORY = {
    messages: [
        {
            id: 1,
            role: 'user',
            content: 'Read the project notes',
            createdAt: '2026-09-18 12:00:00'
        },
        {
            id: 2,
            role: 'assistant',
            content: 'Here is what I found.',
            createdAt: '2026-09-18 12:00:08',
            steps: [
                {
                    type: 'tool',
                    name: 'observatory',
                    argsPreview: ARGS,
                    resultPreview: '12 lines from notes.md',
                    isError: false,
                    durationMs: 1400
                }
            ]
        }
    ]
};

function sseFrame(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function stubStudy(page, { history = HISTORY, progress = null } = {}) {
    await page.route(/\/api\/app\/chat\/turn$/, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(progress
                ? {
                    inFlight: true,
                    elapsedMs: 8000,
                    conversationId: CONV_ID,
                    turnId: 'turn-obs-1',
                    progress
                }
                : { inFlight: false })
        });
    });
    await page.route(/\/api\/app\/chat\/turn\/stream/, async (route) => {
        const body = progress
            ? sseFrame('start', { conversationId: CONV_ID, turnId: 'turn-obs-1' })
                + sseFrame('snapshot', progress)
            : sseFrame('done', { ok: true });
        await route.fulfill({
            status: 200,
            headers: {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache'
            },
            body
        });
    });
    await page.route(/\/api\/app\/chat\/queue$/, async (route) => {
        if (route.request().method() === 'GET') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ items: [] })
            });
            return;
        }
        await route.fallback();
    });
    await page.route(/\/api\/app\/chat\/conversations$/, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                conversations: [{
                    id: CONV_ID,
                    title: 'JWST atlas',
                    messageCount: 2,
                    lastMessageAt: '2026-09-18 12:00:08'
                }]
            })
        });
    });
    await page.route(/\/api\/app\/chat\/history/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(history)
        });
    });
}

test.describe('Study observatory chips', () => {
    test('history chips show project context without hovering', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await login(page);
        await stubStudy(page);
        await page.goto(`/app/study/${CONV_ID}`);

        await expect(page.getByText('Read the project notes')).toBeVisible();
        await page.getByRole('button', { name: /Thinking · 1 step/ }).click();

        const chip = page.locator('.tool-chip').first();
        await expect(chip).toContainText('Read');
        await expect(chip.locator('.tool-chip-context')).toHaveText('notes.md · jwst-atlas');
        await expect(chip).toBeVisible();
        await page.screenshot({ path: '/opt/cursor/artifacts/study_obs_chip_history.png', fullPage: true });
    });

    test('the live thinking header names the file and project', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await login(page);
        await stubStudy(page, {
            history: { messages: [] },
            progress: {
                userContent: 'Read the project notes',
                draft: '',
                typing: false,
                steps: [{
                    type: 'tool',
                    name: 'observatory',
                    running: true,
                    argsPreview: ARGS
                }]
            }
        });
        await page.goto(`/app/study/${CONV_ID}`);

        await expect(page.getByRole('button', { name: /Reading · notes\.md · jwst-atlas/ })).toBeVisible();
        await expect(page.locator('.tool-chip-context')).toHaveText('notes.md · jwst-atlas');
        await page.screenshot({ path: '/opt/cursor/artifacts/study_obs_chip_live.png', fullPage: true });
    });
});
