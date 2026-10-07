/**
 * The setup and maintenance wizard (documentation/setup_wizard.md), driven in
 * a real browser against a real installation manager and, after the install,
 * the real standalone `api` worker it starts. Each test builds its own
 * throwaway installation under the OS temp folder (e2e/setupHarness.js); the
 * only fake is the AI provider, a local stand-in for Ollama.
 */
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { createSetupInstallation, waitFor, REPLY } = require('./setupHarness');

const ARTIFACTS = process.env.GOOBSTER_E2E_ARTIFACTS || '/opt/cursor/artifacts';
const PASSWORD = 'plain-walnut-ladder-kettle-7';
const LOGIN = 'owner-one';

test.setTimeout(180_000);

const installations = [];
async function installation(options) {
    const h = await createSetupInstallation(options);
    installations.push(h);
    return h;
}
test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('page-text', { body: await page.locator('main').innerText({ timeout: 3000 }).catch(() => '(no page)'), contentType: 'text/plain' }).catch(() => {});
        for (const h of installations) await testInfo.attach('manager-log', { body: h.log, contentType: 'text/plain' }).catch(() => {});
    }
    while (installations.length) await installations.pop().destroy();
});

async function screenshot(page, name) {
    try {
        fs.mkdirSync(ARTIFACTS, { recursive: true });
        await page.screenshot({ path: path.join(ARTIFACTS, `330-${name}.png`), fullPage: true });
    } catch { /* artifacts are optional */ }
}

async function next(page, name = 'Continue') {
    const button = page.getByTestId('nav-next').filter({ hasText: name });
    await expect(button).toBeEnabled();
    await button.focus();
    await page.keyboard.press('Enter');
}

async function claim(page, h, label = 'My Goobster') {
    await page.goto(`${h.url}/manager/`);
    await expect(page.getByRole('heading', { name: 'Set up Goobster' })).toBeVisible();
    await page.getByLabel('Setup credential').fill(h.setupCredential());
    await page.getByLabel('What should this installation be called?').fill(label);
    await page.getByLabel('Setup credential').press('Enter');
    await expect(page.getByRole('heading', { name: 'Where should Goobster go?' })).toBeVisible();
}

async function stepsToReview(page, { ollama = null, owner = true } = {}) {
    await next(page); // where -> features
    await expect(page.getByTestId('step-features')).toBeVisible();
    await next(page); // features -> connections
    await expect(page.getByRole('heading', { name: 'Connect what you use' })).toBeVisible();
    if (ollama) {
        const host = page.locator('[data-field="ollama.host"]');
        await host.getByTestId('field-input').fill(ollama);
        await page.locator('[data-field="ollama.model"]').getByTestId('field-input').fill('llama3.2:3b');
    }
    if (owner) {
        await page.getByTestId('owner-login').fill(LOGIN);
        await page.getByTestId('owner-password').fill(PASSWORD);
        await page.getByTestId('owner-repeat').fill(PASSWORD);
    }
    await next(page); // connections -> database
    await expect(page.getByTestId('step-database')).toBeVisible();
    await next(page); // database -> defaults
    await expect(page.getByTestId('step-defaults')).toBeVisible();
    await next(page); // defaults -> access
    await expect(page.getByTestId('step-access')).toBeVisible();
    await next(page); // access -> review
    await expect(page.getByTestId('step-review')).toBeVisible();
}

test.describe('first-time setup', () => {
    test('a fresh installation goes from the setup credential to a first chat', async ({ page }) => {
        const h = await installation();
        await claim(page, h);

        const cookies = await page.context().cookies();
        const session = cookies.find((cookie) => cookie.name === 'goobster-manager-session');
        expect(session && session.httpOnly).toBe(true);

        await expect(page.getByTestId('release-choice')).toBeChecked();
        await stepsToReview(page);

        await expect(page.getByTestId('review-answers')).toContainText('standalone');
        await expect(page.getByTestId('review-answers')).toContainText(LOGIN);
        await screenshot(page, 'review');

        await next(page, 'Install');
        await expect(page.getByTestId('step-progress')).toBeVisible();
        await expect(page.getByTestId('operation-applied')).toBeVisible({ timeout: 90_000 });
        await screenshot(page, 'progress');

        await expect(page.getByTestId('owner-retry')).toHaveCount(0);
        await expect(page.getByTestId('nav-next').filter({ hasText: 'Check that it works' })).toBeEnabled({ timeout: 40_000 });
        await next(page, 'Check that it works');
        await expect(page.getByTestId('step-first-run')).toBeVisible();
        await expect(page.getByTestId('worker-row').first()).toHaveAttribute('data-stage', 'healthy', { timeout: 60_000 });
        await expect(page.locator('[data-testid="first-run-check"][data-ok="false"]')).toHaveCount(0);
        await next(page, 'Continue');
        await expect(page.getByTestId('step-done')).toBeVisible();
        const open = page.getByTestId('open-goobster');
        await expect(open).toBeEnabled({ timeout: 30_000 });
        await expect(page.getByTestId('portal-url')).toContainText(String(h.apiPort));
        await screenshot(page, 'done');

        await open.click();
        await expect(page).toHaveURL(new RegExp(`:${h.apiPort}/app`));
        await page.locator('#login-name').fill(LOGIN);
        await page.locator('#login-password').fill(PASSWORD);
        const signedIn = page.waitForResponse((response) => /\/api\/app\/auth\//.test(response.url()) && response.request().method() === 'POST');
        await page.locator('form.native-login button[type="submit"]').click();
        const answer = await signedIn;
        expect([answer.url(), answer.status(), (await answer.text()).slice(0, 200)]).toEqual([expect.any(String), 200, expect.any(String)]);
        await expect(page.locator('#login-name')).toHaveCount(0);
        await page.goto(`${h.portal}/app/chat`);
        const box = page.getByLabel('Message Goobster');
        await expect(box).toBeVisible({ timeout: 30_000 });
        await box.fill('Say hello to the new installation.');
        await box.press('Enter');
        await expect(page.getByRole('paragraph').filter({ hasText: REPLY })).toBeVisible({ timeout: 60_000 });
        expect(h.ollama.requests.some((line) => line.startsWith('POST /api/chat'))).toBe(true);
        await screenshot(page, 'first-chat');
    });
});
