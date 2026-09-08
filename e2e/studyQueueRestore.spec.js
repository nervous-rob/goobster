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
    streamBody = () => sseBody(),
    statusWhenInFlight = null,
    onStreamRequest = () => {}
} = {}) {
    await page.route(/\/api\/app\/chat\/turn$/, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const inFlight = turnInFlight();
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(inFlight
                ? (statusWhenInFlight || {
                    inFlight: true,
                    elapsedMs: 42000,
                    conversationId: CONV_ID,
                    turnId: 'turn-restore-1',
                    progress: PROGRESS
                })
                : { inFlight: false })
        });
    });
    await page.route(/\/api\/app\/chat\/turn\/stream/, async (route) => {
        onStreamRequest(route.request());
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

test('a restore retry whose first events belong to a later turn does not hydrate them', async ({ page }) => {
    await login(page);
    const streamUrls = [];
    let streams = 0;
    await stubRestore(page, {
        onStreamRequest: (request) => { streamUrls.push(request.url()); },
        streamBody: () => {
            streams += 1;
            if (streams === 1) return sseBody();
            return sseFrame('start', { conversationId: CONV_ID, turnId: 'turn-b' })
                + sseFrame('snapshot', {
                    userContent: 'queued follow-up',
                    draft: 'Turn B draft',
                    typing: false,
                    steps: []
                });
        }
    });
    await page.goto(`/app/study/${CONV_ID}`);
    await expect(page.getByText('Looking that up…')).toBeVisible();
    await expect(page.getByText('What is a Grassmannian?')).toBeVisible();
    await expect.poll(() => streams, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);
    await expect(page.getByText('Turn B draft')).toHaveCount(0);
    await expect(page.getByText('queued follow-up')).toHaveCount(0);
    await expect(page.getByText('Looking that up…')).toBeVisible();
    expect(streamUrls.length).toBeGreaterThanOrEqual(2);
    for (const url of streamUrls) {
        expect(url).toContain('turnId=turn-restore-1');
    }
    await page.screenshot({ path: '/opt/cursor/artifacts/study_restore_ignores_later_turn.png', fullPage: true });
});

test('idle cleanup keeps the incognito transcript', async ({ page }) => {
    await login(page);
    let inFlight = true;
    const incognitoProgress = {
        userContent: 'Secret question',
        draft: 'A private draft…',
        typing: false,
        steps: []
    };
    await stubRestore(page, {
        turnInFlight: () => inFlight,
        statusWhenInFlight: {
            inFlight: true,
            elapsedMs: 8000,
            conversationId: null,
            turnId: 'turn-incog-1',
            progress: incognitoProgress
        },
        streamBody: () => sseFrame('start', { conversationId: null, turnId: 'turn-incog-1' })
            + sseFrame('snapshot', incognitoProgress)
    });
    await page.goto('/app/study');
    await page.getByRole('button', { name: /Incognito/i }).click();
    await expect(page.getByText(/messages here aren't saved/)).toBeVisible();
    await expect(page.getByText('Secret question')).toBeVisible();
    await expect(page.getByText('A private draft…')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Queue message' })).toBeVisible();
    inFlight = false;
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Queue message' })).toHaveCount(0);
    await expect(page.getByText('Secret question')).toBeVisible();
    await expect(page.getByText('A private draft…')).toBeVisible();
    await page.screenshot({ path: '/opt/cursor/artifacts/study_incognito_idle_keeps_transcript.png', fullPage: true });
});

