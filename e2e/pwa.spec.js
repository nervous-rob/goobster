/**
 * The installed-app surface (documentation/pwa.md): the manifest and
 * worker are served for install, the worker takes control and answers
 * offline with the precached page, the shell shows the offline banner and
 * disables Send, a Web Share Target POST lands in a new chat, the app badge
 * mirrors the unread count, and Settings offers the install card and the
 * per-device browser-notification controls. No AI, no Discord, no push
 * service - the browser's own Notification permission is pre-granted so
 * the subscribe round-trip runs against the portal's own routes with a
 * fake push endpoint.
 */
/* global window, document, caches, Notification, DataTransfer */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

async function waitForController(page) {
    await page.waitForFunction(async () => {
        if (!('serviceWorker' in navigator)) return false;
        const reg = await navigator.serviceWorker.getRegistration('/app/');
        return Boolean(reg && reg.active && navigator.serviceWorker.controller);
    }, null, { timeout: 20_000 });
}

test('manifest, worker and offline page are installable and the worker controls the scope', async ({ page, request }) => {
    const manifest = await request.get('/app/manifest.webmanifest');
    expect(manifest.ok()).toBe(true);
    const json = await manifest.json();
    expect(json.start_url).toBe('/app/');
    expect(json.shortcuts.map(s => s.url)).toContain('/app/chat');
    expect(json.share_target.action).toBe('/app/share-target');

    const sw = await request.get('/app/sw.js');
    expect(sw.headers()['cache-control']).toBe('no-cache');
    expect(await sw.text()).toMatch(/const BUILD = '[0-9a-f]{12}'/);

    const offline = await request.get('/app/offline.html');
    expect(offline.ok()).toBe(true);
    expect(await offline.text()).toContain('You are offline');

    await login(page);
    await waitForController(page);
    const cacheNames = await page.evaluate(() => caches.keys());
    expect(cacheNames.some(name => /^goobster-app-[0-9a-f]{12}$/.test(name))).toBe(true);
});

test('offline: the banner shows, Send is disabled, and a navigation gets the offline page', async ({ page, context }) => {
    await login(page);
    await waitForController(page);
    await page.goto('/app/chat');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();

    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByTestId('offline-banner')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    await expect(page.getByText('You are offline. The draft stays here')).toBeVisible();

    // A cold navigation while offline is answered by the worker's precached page.
    const offlinePage = await context.newPage();
    await offlinePage.goto('/app/activity/inbox').catch(() => { /* the worker answers */ });
    await expect(offlinePage.getByRole('heading', { name: 'You are offline' })).toBeVisible();
    await offlinePage.close();

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByTestId('offline-banner')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
});

test('a Web Share Target POST lands in a new chat with the text in the composer and the file attached', async ({ page }) => {
    await login(page);
    await waitForController(page);
    // The OS would submit this form; the worker intercepts the POST in scope.
    await page.evaluate(() => {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = '/app/share-target';
        form.enctype = 'multipart/form-data';
        const add = (name, value) => {
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = name;
            input.value = value;
            form.appendChild(input);
        };
        add('title', 'Interesting article');
        add('text', 'Look at this');
        add('url', 'https://example.com/read');
        const files = document.createElement('input');
        files.type = 'file';
        files.name = 'files';
        const dt = new DataTransfer();
        dt.items.add(new File(['a,b\n1,2\n'], 'shared.csv', { type: 'text/csv' }));
        files.files = dt.files;
        form.appendChild(files);
        document.body.appendChild(form);
        form.submit();
    });
    await expect(page).toHaveURL(/\/app\/chat(\?|$)/);
    const composer = page.getByPlaceholder(/Message Goobster/);
    await expect(composer).toHaveValue(/Interesting article\nLook at this\nhttps:\/\/example\.com\/read/);
    await expect(page.getByText('shared.csv')).toBeVisible();
    await expect(page.getByText('Shared into a new chat.')).toBeVisible();
    // Consumed once: the share cache is gone.
    expect(await page.evaluate(() => caches.has('goobster-share-target'))).toBe(false);
});

test('the app badge follows the unread count', async ({ page }) => {
    await page.addInitScript(() => {
        window.__badge = [];
        navigator.setAppBadge = async (n) => { window.__badge.push(n); };
        navigator.clearAppBadge = async () => { window.__badge.push(0); };
    });
    await login(page);
    await page.waitForFunction(() => window.__badge.length > 0);
    const calls = await page.evaluate(() => window.__badge);
    // The seeded owner has unread inbox items; the badge equals the sidebar count.
    const sidebar = page.getByRole('navigation', { name: 'Rooms' }).locator('.nav-count').first();
    const shown = Number((await sidebar.textContent()).trim());
    expect(calls[calls.length - 1]).toBe(shown);
});

test('Settings offers the install card and per-device browser notifications that round-trip a subscription', async ({ page, context }) => {
    await context.grantPermissions(['notifications']);
    await page.addInitScript(() => {
        // The browser cannot reach a real push service in CI: a fake
        // PushManager on the registration hands back a stable, well-formed
        // subscription so the portal's own routes are what gets exercised.
        const fake = {
            endpoint: 'https://push.example.test/e2e/device-1',
            options: { applicationServerKey: null },
            toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } }; },
            async unsubscribe() { window.__pushSub = null; return true; }
        };
        window.__pushSub = null;
        const patch = (reg) => {
            Object.defineProperty(reg, 'pushManager', {
                configurable: true,
                value: {
                    async getSubscription() { return window.__pushSub; },
                    async subscribe() { window.__pushSub = fake; return fake; }
                }
            });
            return reg;
        };
        const ready = navigator.serviceWorker.ready.then(patch);
        Object.defineProperty(navigator.serviceWorker, 'ready', { configurable: true, get: () => ready });
        // The PushManager global is what pushSupported() checks.
        if (!('PushManager' in window)) window.PushManager = function PushManager() {};
        // Headless Chromium reports notifications as denied whatever the
        // context grants; the component would (correctly) show the blocked
        // hint, which is not the path under test.
        Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
        Notification.requestPermission = async () => 'granted';
    });
    await login(page);
    await page.goto('/app/settings/appearance');
    const install = page.locator('#install-app');
    await expect(install).toBeVisible();
    // Headless Chromium never fires beforeinstallprompt, so the card falls
    // back to the browser-menu instructions.
    await expect(install.locator('[data-testid^="install-"]')).toBeVisible();

    await page.goto('/app/settings/initiative');
    const field = page.locator('#browser-notifications');
    await expect(field).toBeVisible();
    await expect(field.getByTestId('push-settings')).toBeVisible();
    await expect(field.getByTestId('push-devices')).toContainText('No devices enrolled');

    await field.getByTestId('push-on').click();
    await expect(page.getByText(/Notifications are on for this device/)).toBeVisible();
    await expect(field.getByTestId('push-devices')).toContainText('On for this device');
    await expect(field.getByTestId('push-devices')).toContainText('1 device is enrolled');

    // The server knows this device; the endpoint never comes back in the payload.
    const status = await page.request.get(`/api/app/push?endpoint=${encodeURIComponent('https://push.example.test/e2e/device-1')}`);
    const json = await status.json();
    expect(json).toMatchObject({ enabled: true, devices: 1, thisDevice: true });
    expect(JSON.stringify(json)).not.toContain('push.example.test');

    await field.getByTestId('push-off').click();
    await expect(page.getByText('Notifications are off for this device.')).toBeVisible();
    await expect(field.getByTestId('push-devices')).toContainText('No devices enrolled');
    const after = await (await page.request.get('/api/app/push')).json();
    expect(after.devices).toBe(0);
});

// Replays what Chromium does when the page becomes installable: the
// captured event is what every install entry replays on click.
async function offerInstall(page, outcome = 'accepted') {
    await page.evaluate((choice) => {
        const event = new Event('beforeinstallprompt', { cancelable: true });
        event.prompt = async () => { window.__prompted = (window.__prompted || 0) + 1; };
        event.userChoice = Promise.resolve({ outcome: choice });
        window.dispatchEvent(event);
    }, outcome);
}

test('the install shortcut is one click from any room: nav entry, shell banner, and a snoozable nudge', async ({ page }) => {
    await login(page);
    await page.goto('/app/');

    // Without a prompt the nav entry is still there and leads to the
    // Settings card with the how-to; no banner nags about a menu dig.
    const entry = page.getByTestId('install-nav');
    await expect(entry).toBeVisible();
    await expect(entry).toHaveText(/Install app/);
    await expect(page.getByTestId('install-banner')).toHaveCount(0);
    await entry.click();
    await expect(page).toHaveURL(/\/app\/settings\/appearance#install-app$/);
    await expect(page.locator('#install-app')).toBeVisible();

    // Once the browser offers a prompt, the banner shows and a click on it
    // replays the prompt; an accepted install retires the whole nudge.
    await offerInstall(page, 'accepted');
    const banner = page.getByTestId('install-banner');
    await expect(banner).toBeVisible();
    await expect(page.locator('#install-app').getByTestId('install-button')).toBeVisible();
    await banner.getByTestId('install-banner-install').click();
    await expect(page.getByText('Goobster is installing.')).toBeVisible();
    expect(await page.evaluate(() => window.__prompted)).toBe(1);
    await expect(banner).toHaveCount(0);

    // A fresh page with a prompt nudges again; "Not now" snoozes it on this
    // device across reloads while the nav entry stays put.
    await page.goto('/app/');
    await offerInstall(page, 'dismissed');
    await expect(banner).toBeVisible();
    await banner.getByTestId('install-banner-dismiss').click();
    await expect(banner).toHaveCount(0);
    await page.reload();
    await offerInstall(page, 'dismissed');
    await expect(page.getByTestId('install-nav')).toBeVisible();
    await expect(page.getByTestId('install-banner')).toHaveCount(0);
    // The nav entry still installs on the spot when a prompt is in hand.
    await page.getByTestId('install-nav').click();
    expect(await page.evaluate(() => window.__prompted)).toBe(1);
});
