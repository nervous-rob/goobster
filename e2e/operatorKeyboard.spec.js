/**
 * Keyboard-only walk of the setup wizard and the Host operator pages
 * (documentation/accessibility_review.md). Provider-free: the wizard runs
 * against a throwaway installation under the OS temp folder with a manager
 * started in-process (e2e/setupHarness.js), the Host pages against the e2e
 * portal. Every action here is a key press: Tab, Shift+Tab, Enter, Space and
 * Escape. The mouse is never used and nothing is installed.
 *
 * What it proves, per page: every control a person can act on is reachable by
 * Tab, each focused control has an accessible name and a visible focus
 * indicator, the page can be left by Tab (no trap), Enter and Space do what
 * the control says, a step change moves focus to the step heading, and the
 * confirm dialog closes on Escape without changing anything.
 *
 * What it does not prove: that a screen reader announces any of it sensibly,
 * or that colours meet contrast ratios. Those stay human checks.
 */
/* global document, getComputedStyle */
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { login, createSecondServer } = require('./helpers');
const { createSetupInstallation } = require('./setupHarness');
const { createManagerProcess, tempDir } = require('./hostHarness');

// Clear of the offsets hostOperator.spec.js uses (+110, +111, +120, +121).
const BASE = Number(process.env.GOOBSTER_E2E_PORT || 4173);
const PORTAL_PORT = Number(process.env.GOOBSTER_E2E_KEYBOARD_PORTAL_PORT || BASE + 130);
const MANAGER_PORT = Number(process.env.GOOBSTER_E2E_KEYBOARD_MANAGER_PORT || BASE + 131);
const OPERATOR = '99000000000000390';
const OPERATOR_NAME = 'Host operator';
const PASSWORD = 'plain-walnut-ladder-kettle-7';
const LOGIN = 'owner-one';

const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

test.setTimeout(180_000);

const installations = [];
test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('page-text', { body: await page.locator('body').innerText({ timeout: 3000 }).catch(() => '(no page)'), contentType: 'text/plain' }).catch(() => {});
    }
    while (installations.length) await installations.pop().destroy();
});

/**
 * One in-page routine answers both questions, so a focused control and the list of controls a page offers are
 * named by the same rule: aria-label, then aria-labelledby, then an associated label, then visible text.
 */
function inPage(page, args) {
    return page.evaluate(({ op, selector, within }) => {
        const nameOf = (el) => {
            const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' ').trim();
            const labels = el.labels ? [...el.labels].map((label) => label.innerText).join(' ').trim() : '';
            return (el.getAttribute('aria-label') || labelledBy || labels || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || '').replace(/\s+/g, ' ').trim();
        };
        const keyOf = (el) => `${el.tagName.toLowerCase()}|${el.id || ''}|${el.getAttribute('data-testid') || ''}|${nameOf(el)}`;
        if (op === 'focused') {
            const el = document.activeElement;
            if (!el || el === document.body) return null;
            const style = getComputedStyle(el);
            const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
            const shadow = Boolean(style.boxShadow) && style.boxShadow !== 'none';
            return { tag: el.tagName.toLowerCase(), name: nameOf(el), visibleFocus: (outline || shadow) && el.matches(':focus-visible'), key: keyOf(el) };
        }
        const root = document.querySelector(within) || document.body;
        return [...root.querySelectorAll(selector)]
            .filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.closest('[hidden]'))
            // A radio group is one tab stop; the arrow keys move inside it.
            .filter((el) => el.type !== 'radio' || el.checked || ![...root.querySelectorAll(`input[type="radio"][name="${el.name}"]`)].some((other) => other.checked))
            .filter((el) => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return (rect.width > 0 || rect.height > 0) && style.visibility !== 'hidden' && style.display !== 'none';
            })
            .map(keyOf);
    }, args);
}

/** What the keyboard is on right now: its accessible name and whether the browser draws a focus indicator. */
function focused(page) {
    return inPage(page, { op: 'focused' });
}

/** The controls inside `scope` a person can act on right now, keyed the way `focused` keys them. */
function actionable(page, scope) {
    return inPage(page, { op: 'actionable', selector: INTERACTIVE, within: scope });
}

/**
 * Press Tab until focus leaves `scope` or `limit` presses have been spent.
 * Returns each focused control in order. Fails the test when focus never
 * leaves, because that is a keyboard trap.
 */
async function tabThrough(page, { scope, limit = 80 }) {
    const seen = [];
    // Start at the top of the scope: focus its container (not a tab stop itself) so the first Tab lands on its first control.
    await page.evaluate((within) => {
        const root = document.querySelector(within);
        root.setAttribute('tabindex', '-1');
        root.focus({ preventScroll: true });
    }, scope);
    for (let press = 0; press < limit; press += 1) {
        await page.keyboard.press('Tab');
        const now = await focused(page);
        if (!now) break;
        const inside = await page.evaluate((within) => {
            const root = document.querySelector(within);
            return Boolean(root && root.contains(document.activeElement));
        }, scope);
        if (!inside) {
            if (seen.length > 0) return seen;
            continue;
        }
        seen.push(now);
        if (press === limit - 1) throw new Error(`Focus never left ${scope} after ${limit} Tab presses: a keyboard trap. Last: ${now.key}`);
    }
    return seen;
}

function expectUsable(seen, where) {
    expect(seen.length, `${where}: nothing was reachable by Tab`).toBeGreaterThan(0);
    for (const control of seen) {
        expect(control.name, `${where}: a ${control.tag} has no accessible name`).not.toBe('');
        expect(control.visibleFocus, `${where}: "${control.name}" shows no focus indicator`).toBe(true);
    }
}

async function expectEverythingReached(page, scope, seen, where) {
    const reached = new Set(seen.map((control) => control.key));
    const expected = await actionable(page, scope);
    expect(expected.length, `${where}: no controls found`).toBeGreaterThan(0);
    for (const key of expected) {
        expect(reached.has(key), `${where}: "${key}" was not reached by Tab. Reached: ${[...reached].join(' ; ')}`).toBe(true);
    }
}

async function press(page, locator, key) {
    await locator.focus();
    await page.keyboard.press(key);
}

test.describe('setup wizard, keyboard only', () => {
    test('the sign-in page: Tab order, focus indicator, Enter submits, and the next step takes focus', async ({ page }) => {
        const h = await createSetupInstallation();
        installations.push(h);
        await page.goto(`${h.url}/manager/`);
        await expect(page.getByRole('heading', { name: 'Set up Goobster' })).toBeVisible();

        const seen = await tabThrough(page, { scope: 'main' });
        expectUsable(seen, 'setup sign-in');
        const order = seen.map((control) => control.name);
        expect(order[0]).toMatch(/Setup credential/);
        expect(order.indexOf('What should this installation be called?')).toBeGreaterThan(0);
        await expectEverythingReached(page, 'main', seen, 'setup sign-in');

        await page.getByLabel('Setup credential').focus();
        await page.keyboard.type(h.setupCredential());
        await page.keyboard.press('Tab');
        await page.keyboard.type('Keyboard Goobster');
        await page.keyboard.press('Enter');
        const heading = page.getByRole('heading', { name: 'Where should Goobster go?' });
        await expect(heading).toBeVisible();
        await expect(heading).toBeFocused();
    });

    test('every setup step is reachable and leavable by Tab, names its controls, and Enter moves on', async ({ page }) => {
        const h = await createSetupInstallation();
        installations.push(h);
        await page.goto(`${h.url}/manager/`);
        await page.getByLabel('Setup credential').focus();
        await page.keyboard.type(h.setupCredential());
        await page.keyboard.press('Enter');
        await expect(page.getByRole('heading', { name: 'Where should Goobster go?' })).toBeFocused();

        const visited = [];
        for (const id of ['where', 'features', 'connections', 'database', 'defaults', 'access']) {
            const step = page.getByTestId(`step-${id}`);
            await expect(step).toBeVisible();
            await expect(step.locator('h2')).toBeFocused();

            const seen = await tabThrough(page, { scope: `[data-testid="step-${id}"]`, limit: 120 });
            expectUsable(seen, `setup step ${id}`);
            await expectEverythingReached(page, `[data-testid="step-${id}"]`, seen, `setup step ${id}`);
            visited.push(id);

            if (id === 'database') {
                const sqlite = page.getByTestId('engine-sqlite');
                await expect(sqlite).toBeChecked();
                await sqlite.focus();
                await page.keyboard.press('ArrowDown');
                await expect(page.getByTestId('engine-postgres-existing')).toBeChecked();
                await expect(page.getByTestId('engine-postgres-existing')).toBeFocused();
                await page.keyboard.press('ArrowUp');
                await expect(sqlite).toBeChecked();
            }
            if (id === 'connections') {
                for (const [testId, value] of [['owner-login', LOGIN], ['owner-password', PASSWORD], ['owner-repeat', PASSWORD]]) {
                    await page.getByTestId(testId).focus();
                    await page.keyboard.type(value);
                }
            }
            const next = page.getByTestId('nav-next');
            await expect(next).toBeEnabled();
            await press(page, next, 'Enter');
        }
        await expect(page.getByTestId('step-review')).toBeVisible();
        await expect(page.getByTestId('step-review').locator('h2')).toBeFocused();
        expect(visited).toEqual(['where', 'features', 'connections', 'database', 'defaults', 'access']);

        const review = await tabThrough(page, { scope: '[data-testid="step-review"]', limit: 120 });
        expectUsable(review, 'setup review');
        await expectEverythingReached(page, '[data-testid="step-review"]', review, 'setup review');
    });

    test('the step list marks the current step, earlier steps are links, and Enter goes back', async ({ page }) => {
        const h = await createSetupInstallation();
        installations.push(h);
        await page.goto(`${h.url}/manager/`);
        await page.getByLabel('Setup credential').focus();
        await page.keyboard.type(h.setupCredential());
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('step-where')).toBeVisible();
        await press(page, page.getByTestId('nav-next'), 'Enter');
        await expect(page.getByTestId('step-features')).toBeVisible();

        const stepper = page.getByRole('navigation', { name: 'Setup steps' });
        await expect(stepper.locator('[aria-current="step"]')).toHaveCount(1);
        await expect(stepper.getByTestId('stepper-features')).toHaveAttribute('aria-current', 'step');
        const back = stepper.getByTestId('stepper-where');
        await expect(back).toHaveAttribute('href', /setup\/where/);
        await press(page, back, 'Enter');
        await expect(page.getByTestId('step-where')).toBeVisible();
        await expect(page.getByTestId('step-where').locator('h2')).toBeFocused();
    });

    test('an incomplete step announces its problems and puts focus on them', async ({ page }) => {
        const h = await createSetupInstallation();
        installations.push(h);
        await page.goto(`${h.url}/manager/`);
        await page.getByLabel('Setup credential').focus();
        await page.keyboard.type(h.setupCredential());
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('step-where')).toBeVisible();
        for (const id of ['features', 'connections']) {
            await press(page, page.getByTestId('nav-next'), 'Enter');
            await expect(page.getByTestId(`step-${id}`)).toBeVisible();
        }
        for (const [testId, value] of [['owner-login', LOGIN], ['owner-password', PASSWORD], ['owner-repeat', 'a different password entirely']]) {
            await page.getByTestId(testId).focus();
            await page.keyboard.type(value);
        }
        await press(page, page.getByTestId('nav-next'), 'Enter');
        const summary = page.getByTestId('error-summary');
        await expect(summary).toBeVisible();
        await expect(summary).toHaveAttribute('role', 'alert');
        await expect(summary).toBeFocused();
        await page.keyboard.press('Tab');
        const link = await focused(page);
        expect(link.tag).toBe('a');
        expect(link.name.length).toBeGreaterThan(3);
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('owner-repeat')).toBeFocused();
    });
});

test.describe('Host operator pages, keyboard only', () => {
    test.describe.configure({ mode: 'serial' });

    const dir = tempDir('goobster-e2e-keyboard-');
    const portal = createSecondServer({ port: PORTAL_PORT, dataDir: dir });
    const manager = createManagerProcess({ dir, port: MANAGER_PORT });
    test.use({ baseURL: portal.url });

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        await manager.start();
        await manager.claim();
        await portal.start({
            features: { economy: true, exchange: true, gambling: false, projects: true, music: true, push: true },
            env: {
                GOOBSTER_MANAGER_URL: manager.url,
                GOOBSTER_CONFIG_PATH: path.join(dir, 'config.json')
            }
        });
    });

    test.afterAll(async () => {
        await portal.stop();
        await manager.stop();
        portal.cleanup();
    });

    const PAGES = [
        ['overview', 'Overview'],
        ['features', 'Features'],
        ['connections', 'Connections'],
        ['defaults', 'Instance Defaults'],
        ['installation', 'Installation'],
        ['database', 'Database'],
        ['maintenance', 'Maintenance']
    ];

    test('the page list is a labelled navigation: Tab reaches each page, Enter opens it, the current one is marked', async ({ page }) => {
        await login(page, { userId: OPERATOR, name: OPERATOR_NAME });
        await page.goto('/app/host');
        await expect(page.getByRole('heading', { name: 'Host', exact: true })).toBeVisible();
        const tabs = page.getByRole('navigation', { name: 'Host pages' });
        await expect(tabs.getByRole('link')).toHaveCount(PAGES.length);

        const seen = await tabThrough(page, { scope: '[data-testid="host-tabs"]', limit: 200 });
        expectUsable(seen, 'host pages');
        expect(seen.map((control) => control.name)).toEqual(PAGES.map(([, label]) => label));

        for (const [id, label] of PAGES) {
            await press(page, tabs.getByRole('link', { name: label, exact: true }), 'Enter');
            await expect(page).toHaveURL(id === 'overview' ? /\/app\/host\/?$/ : new RegExp(`/app/host/${id}$`));
            await expect(tabs.locator('[aria-current="page"]')).toHaveText(label);
        }
    });

    for (const [id, label] of PAGES) {
        test(`${label}: every control is reachable by Tab, named, shows focus, and Tab can leave the page`, async ({ page }) => {
            await login(page, { userId: OPERATOR, name: OPERATOR_NAME });
            await page.goto(id === 'overview' ? '/app/host' : `/app/host/${id}`);
            await expect(page.getByRole('heading', { name: 'Host', exact: true })).toBeVisible();
            await expect(page.locator('.host-body h2, .host-body section').first()).toBeVisible();
            await page.waitForLoadState('networkidle');

            const seen = await tabThrough(page, { scope: '.host-body', limit: 400 });
            expectUsable(seen, `Host ${label}`);
            await expectEverythingReached(page, '.host-body', seen, `Host ${label}`);
        });
    }

    test('the Accounts list: a confirm dialog opens by Enter and closes by Escape or Cancel without changing anything', async ({ page }) => {
        await login(page, { userId: OPERATOR, name: OPERATOR_NAME });
        await page.goto('/app/host');
        await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
        const rows = page.getByTestId('host-account-row');
        await expect(rows.first()).toBeVisible();
        const colleague = rows.filter({ hasText: 'native-colleague' });
        await expect(colleague).toHaveCount(1);
        await expect(colleague).toContainText('· member · active ·');

        const makeOperator = colleague.getByRole('button', { name: 'Make operator' });
        await press(page, makeOperator, 'Enter');
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('operator (host)');
        await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeVisible();
        const inDialog = () => page.evaluate(() => Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement)));
        await expect(dialog).toHaveAccessibleName(/operator \(host\)/);
        await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
        for (const key of ['Tab', 'Shift+Tab']) {
            for (let tabs = 0; tabs < 6; tabs += 1) {
                await page.keyboard.press(key);
                expect(await inDialog(), `${key} stays within the open modal`).toBe(true);
            }
        }
        const reachable = await dialog.evaluate((node) => [...node.querySelectorAll('button')].length);
        expect(reachable).toBe(2);

        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(makeOperator).toBeFocused();
        await expect(colleague).toContainText('· member · active ·');
        await expect(colleague.getByRole('button', { name: 'Make operator' })).toBeVisible();

        // Another confirm, closed with its Cancel button by Enter: no reset link is issued.
        await press(page, colleague.getByRole('button', { name: 'Reset link' }), 'Enter');
        await expect(page.getByRole('dialog')).toBeVisible();
        await press(page, page.getByRole('dialog').getByRole('button', { name: 'Cancel' }), 'Enter');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(makeOperator).toBeFocused();
        await expect(page.getByText('Reset link for native-colleague')).toHaveCount(0);
    });

    test('the Features page: Space switches a feature and the preview button follows the change', async ({ page }) => {
        await login(page, { userId: OPERATOR, name: OPERATOR_NAME });
        await page.goto('/app/host/features');
        await expect(page.getByRole('heading', { name: 'Host', exact: true })).toBeVisible();
        const toggles = page.getByTestId('host-feature-toggle');
        await expect(page.getByTestId('manager-unavailable')).toHaveCount(0);
        await expect(toggles.first()).toBeEnabled();
        const first = toggles.first();
        const was = await first.isChecked();
        await first.focus();
        await page.keyboard.press('Space');
        expect(await first.isChecked()).toBe(!was);
        await page.keyboard.press('Space');
        expect(await first.isChecked()).toBe(was);
        await expect(page.getByTestId('host-features-preview')).toBeDisabled();
    });
});
