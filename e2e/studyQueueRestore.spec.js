/**
 * Study follow-up queue + in-flight restore: the React composer hydrates a
 * live snapshot and lists queued messages without waiting for settle.
 * The generating turn is stubbed at the HTTP layer (no AI, no Discord).
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const CONV_ID = 42;
const PROGRESS = {
    userContent: 'What is a Grassmannian?',
    draft: 'Looking that up…',
    typing: false,
    steps: [
        { type: 'text', content: 'Checking sources.' },
        {
            type: 'tool',
            name: 'performSearch',
            running: true,
            argsPreview: 'grassmannian'
        }
    ]
};

function sseFrame(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseBody(progress = PROGRESS, { done = false } = {}) {
    let body = sseFrame('start', { conversationId: CONV_ID, turnId: 'turn-restore-1' })
        + sseFrame('snapshot', progress);
    if (done) body += sseFrame('done', { ok: true });
    return body;
}

async function stubRestore(page, {
    turnInFlight = () => true,
    streamBody = () => sseBody()
} = {}) {
    await page.route(/\/api\/app\/chat\/turn$/, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const inFlight = turnInFlight();
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(inFlight
                ? {
                    inFlight: true,
                    elapsedMs: 42000,
                    conversationId: CONV_ID,
                    turnId: 'turn-restore-1',
                    progress: PROGRESS
                }
                : { inFlight: false })
        });
    });
    await page.route(/\/api\/app\/chat\/turn\/stream/, async (route) => {
        await route.fulfill({
            status: 200,
            headers: {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache'
            },
            body: streamBody()
        });
    });
    await page.route(/\/api\/app\/chat\/queue$/, async (route) => {
        const method = route.request().method();
        if (method === 'GET') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    items: [{
                        id: 9,
                        conversationId: CONV_ID,
                        position: 1,
                        message: 'Also compare to flag varieties',
                        imageCount: 0,
                        fileCount: 0,
                        incognito: false
                    }]
                })
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
                    title: 'Geometry',
                    messageCount: 1,
                    lastMessageAt: '2026-09-08 12:00:00'
                }]
            })
        });
    });
    await page.route(/\/api\/app\/chat\/history/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ messages: [] })
        });
    });
}

test('returning to Study restores live thoughts and shows the follow-up queue', async ({ page }) => {
    await login(page);
    await stubRestore(page);
    await page.goto(`/app/study/${CONV_ID}`);

    await expect(page.getByText('What is a Grassmannian?')).toBeVisible();
    await expect(page.getByText('Checking sources.')).toBeVisible();
    await expect(page.getByTitle('grassmannian')).toBeVisible();
    await expect(page.getByText('Looking that up…')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Queued messages' }))
        .toContainText('Also compare to flag varieties');
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Queue message' })).toBeVisible();
    await page.screenshot({ path: '/opt/cursor/artifacts/study_queue_restore.png', fullPage: true });
});

test('a dropped restore stream retries and then hydrates the next snapshot', async ({ page }) => {
    await login(page);
    let streams = 0;
    await stubRestore(page, {
        streamBody: () => {
            streams += 1;
            if (streams === 1) return sseBody();
            return sseBody({ ...PROGRESS, draft: 'Looking that up… more' });
        }
    });
    await page.goto(`/app/study/${CONV_ID}`);
    await expect(page.getByText('Looking that up…')).toBeVisible();
    await expect(page.getByText('Looking that up… more')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: 'Queue message' })).toBeVisible();
});

test('when the turn goes idle, a dropped restore stream clears Stop/Queue', async ({ page }) => {
    await login(page);
    let inFlight = true;
    await stubRestore(page, { turnInFlight: () => inFlight });
    await page.goto(`/app/study/${CONV_ID}`);
    await expect(page.getByRole('button', { name: 'Queue message' })).toBeVisible();
    inFlight = false;
    // Status polling is 5s while in-flight; wait for the idle fetch + reset.
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Queue message' })).toHaveCount(0);
});
