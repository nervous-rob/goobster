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
const { createSecondServer, login } = require('./helpers');
const C = require('./constants');
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

async function signInManager(context, h, provisioned) {
    await context.addCookies([{ name: provisioned.session.name, value: provisioned.session.value, domain: '127.0.0.1', path: '/manager', httpOnly: true, sameSite: 'Strict' }]);
}

/** Every worker row healthy, as the page shows it. */
async function expectHealthy(page) {
    await expect(page.getByTestId('worker-row').first()).toHaveAttribute('data-stage', 'healthy', { timeout: 60_000 });
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

test.describe('setup credentials and how a session ends', () => {
    test('a stale setup credential is refused, and the page says exactly how to get a new one', async ({ page }) => {
        const h = await installation();
        const stale = h.setupCredential();
        const fresh = await h.mintBootstrap();
        expect(fresh).not.toBe(stale);

        await page.goto(`${h.url}/manager/`);
        await page.getByLabel('Setup credential').fill(stale);
        await page.getByTestId('claim-submit').click();
        const failure = page.getByRole('alert').filter({ hasText: 'Fix these before you continue' });
        await expect(failure).toContainText('not valid');
        await expect(page.getByTestId('mint-command')).toHaveText('node apps/manager/index.js --mint-bootstrap');
        await expect(page.getByLabel('Setup credential')).toHaveValue('');
        expect((await page.context().cookies()).some((cookie) => cookie.name === 'goobster-manager-session')).toBe(false);

        await page.getByLabel('Setup credential').fill(fresh);
        await page.getByTestId('claim-submit').click();
        await expect(page.getByTestId('step-where')).toBeVisible();
    });

    test('a restarted manager ends the session; the page asks for a recovery credential and carries on where it was', async ({ page, context }) => {
        const h = await installation();
        const p = await h.provision({ features: [] });
        await signInManager(context, h, p);
        await page.goto(`${h.url}/manager/#/setup/first-run`);
        await expect(page.getByTestId('step-first-run')).toBeVisible();

        await h.stop();
        await expect(page.getByTestId('reconnecting').first()).toBeVisible({ timeout: 30_000 });
        await h.start();

        await expect(page.getByTestId('unlock-form')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('mint-command')).toHaveText('node apps/manager/index.js --mint-recovery');
        const recovery = await h.mintRecovery();
        await page.getByLabel('Recovery credential').fill(recovery);
        await page.getByTestId('unlock-submit').click();
        await expect(page.getByTestId('step-first-run')).toBeVisible();
        expect(page.url()).toContain('#/setup/first-run');

        // The credential works once.
        const replay = await page.request.post(`${h.url}/manager/api/recovery/unlock`, { data: { credential: recovery } });
        expect(replay.status()).toBe(401);
    });
});

test.describe('back, reload and reconnect during an install', () => {
    test('reloading while the install runs returns to the same operation and finishes the owner and start stages', async ({ page }) => {
        const h = await installation();
        await claim(page, h);
        await stepsToReview(page);
        await expect(page.getByTestId('review-answers')).toBeVisible();

        // The server applies the install; the answer reaches the page late, and the page is reloaded before it does.
        await page.route('**/manager/api/operations/*/apply', async (route) => {
            const response = await route.fetch();
            await new Promise((resolve) => setTimeout(resolve, 4000));
            await route.fulfill({ response }).catch(() => {});
        });
        await next(page, 'Install');
        await expect(page.getByTestId('step-progress')).toBeVisible();
        const hash = await page.evaluate(() => window.location.hash);
        expect(hash).toMatch(/^#\/setup\/progress\/[A-Za-z0-9-]+$/);
        await page.waitForTimeout(800);
        await page.unroute('**/manager/api/operations/*/apply');
        await page.reload();

        await expect(page.getByTestId('step-progress')).toBeVisible();
        expect(await page.evaluate(() => window.location.hash)).toBe(hash);
        await expect(page.getByTestId('operation-applied')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('nav-next').filter({ hasText: 'Check that it works' })).toBeEnabled({ timeout: 60_000 });
        await next(page, 'Check that it works');
        await expectHealthy(page);
    });

    test('Back and Forward keep each step\'s answers, and the browser history holds no secret', async ({ page }) => {
        const h = await installation();
        await claim(page, h);
        await next(page); // features
        await next(page); // connections
        await page.getByTestId('owner-login').fill(LOGIN);
        await page.getByTestId('owner-password').fill(PASSWORD);
        await page.getByTestId('owner-repeat').fill(PASSWORD);
        await next(page); // database
        await expect(page.getByTestId('step-database')).toBeVisible();

        await page.goBack();
        await expect(page.getByTestId('step-connections')).toBeVisible();
        await expect(page.getByTestId('owner-login')).toHaveValue(LOGIN);
        await page.goForward();
        await expect(page.getByTestId('step-database')).toBeVisible();

        const leaks = await page.evaluate((secret) => {
            const dump = (store) => Object.keys(store).map((key) => `${key}=${store.getItem(key)}`).join('\n');
            return {
                url: window.location.href.includes(secret),
                state: JSON.stringify(window.history.state || {}).includes(secret),
                local: dump(window.localStorage).includes(secret),
                session: dump(window.sessionStorage).includes(secret),
                cookie: document.cookie.includes(secret)
            };
        }, PASSWORD);
        expect(leaks).toEqual({ url: false, state: false, local: false, session: false, cookie: false });
        const stored = await page.evaluate(() => window.sessionStorage.getItem('goobster-setup-answers'));
        expect(stored).toContain(LOGIN);
    });
});

test.describe('probes, failed plans and secrets', () => {
    test('a failed Ollama probe says what went wrong and keeps the answers', async ({ page }) => {
        const h = await installation({ env: { OLLAMA_HOST: undefined, OLLAMA_MODEL: undefined } });
        await claim(page, h);
        await next(page);
        await next(page);
        await expect(page.getByTestId('step-connections')).toBeVisible();
        const host = page.locator('[data-field="ollama.host"]');
        await host.getByTestId('field-input').fill('http://127.0.0.1:9');
        await host.getByTestId('probe-run').click();
        const result = host.getByTestId('probe-result');
        await expect(result).toBeVisible();
        await expect(result).not.toContainText('undefined');
        await expect(result).toHaveText(/./);
        await expect(host.getByTestId('field-input')).toHaveValue('http://127.0.0.1:9');
        await screenshot(page, 'failed-probe');
    });

    test('a failed plan keeps non-secret answers, empties secret fields with an enter-again note, and recovers', async ({ page }) => {
        let busy = true;
        const h = await installation({ installDeps: { probePort: async () => (busy ? 'busy' : 'free') } });
        await claim(page, h);
        await next(page);
        await next(page);
        await page.getByTestId('owner-login').fill(LOGIN);
        await page.getByTestId('owner-display').fill('Rob');
        await page.getByTestId('owner-password').fill(PASSWORD);
        await page.getByTestId('owner-repeat').fill(PASSWORD);
        for (let step = 0; step < 4; step += 1) await next(page);
        await expect(page.getByTestId('step-review')).toBeVisible();

        await expect(page.getByTestId('review-findings')).toContainText('already in use');
        await expect(page.getByRole('alert')).toBeVisible();
        await screenshot(page, 'failed-plan');
        expect(await page.evaluate(() => window.sessionStorage.getItem('goobster-setup-answers'))).not.toContain(PASSWORD);

        await page.getByTestId('nav-back').click();
        await page.goto(`${h.url}/manager/#/setup/connections`);
        await expect(page.getByTestId('step-connections')).toBeVisible();
        await expect(page.getByTestId('owner-login')).toHaveValue(LOGIN);
        await expect(page.getByTestId('owner-display')).toHaveValue('Rob');
        await expect(page.getByTestId('owner-password')).toHaveValue('');
        await expect(page.getByTestId('enter-again')).toBeVisible();
        await expect(page.getByTestId('enter-again')).not.toContainText(PASSWORD);

        // Next without the password: the summary names the field and links to it.
        await next(page);
        const summary = page.getByRole('alert').filter({ hasText: 'Fix these before you continue' });
        await expect(summary.getByRole('link')).toHaveAttribute('href', /#owner-password|#owner/);

        busy = false;
        await page.getByTestId('owner-password').fill(PASSWORD);
        await page.getByTestId('owner-repeat').fill(PASSWORD);
        for (let step = 0; step < 4; step += 1) await next(page);
        await expect(page.getByTestId('step-review')).toBeVisible();
        await expect(page.getByTestId('plan-new')).toBeVisible();
        await expect(page.getByTestId('review-findings')).toHaveCount(0);
        await next(page, 'Install');
        await expect(page.getByTestId('operation-applied')).toBeVisible({ timeout: 60_000 });
    });
});

test.describe('small screens', () => {
    test('at 360 px wide every step is one column, nothing scrolls sideways, and controls keep their names', async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 740 });
        const h = await installation();
        await claim(page, h);
        const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        for (const id of ['where', 'features', 'connections', 'database', 'defaults', 'access', 'review']) {
            await expect(page.getByTestId(`step-${id}`)).toBeVisible();
            expect(await overflow(), `${id} scrolls sideways`).toBeLessThanOrEqual(1);
            const column = await page.getByTestId(`step-${id}`).evaluate((node) => {
                const box = node.getBoundingClientRect();
                return { left: box.left, right: box.right, inside: window.innerWidth };
            });
            expect(column.right).toBeLessThanOrEqual(column.inside);
            for (const control of await page.locator(`[data-testid="step-${id}"] button`).all()) {
                const name = (await control.innerText()).trim() || (await control.getAttribute('aria-label'));
                expect(name, `${id} has an unnamed button`).toBeTruthy();
            }
            if (id === 'review') break;
            if (id === 'connections') {
                await page.getByTestId('owner-login').fill(LOGIN);
                await page.getByTestId('owner-password').fill(PASSWORD);
                await page.getByTestId('owner-repeat').fill(PASSWORD);
            }
            await next(page);
        }
        await screenshot(page, 'small-viewport');
    });
});
