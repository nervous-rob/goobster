/* global window */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
const C = require('./constants');

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('scrolling past the end of mobile Chat does not scroll the outer page', async ({ page }) => {
    await login(page);
    const { conversations } = await page.request.get('/api/app/chat/conversations').then(r => r.json());
    const chat = conversations.find(c => c.title === C.CHAT_TITLE);
    await page.goto(`/app/chat/${chat.id}`);
    await expect(page.getByText(C.CHAT_ANSWER_BODY)).toBeVisible();
    // Model an outer page with scrollable space (as can happen when the iOS
    // layout and visual viewports differ). Boundary gestures must stay in Chat.
    await page.evaluate(() => {
        const spacer = window.document.createElement('div');
        spacer.style.height = '300px';
        window.document.body.appendChild(spacer);
        const log = window.document.querySelector('.chat-scroll');
        log.scrollTop = log.scrollHeight;
    });
    const log = page.locator('.chat-scroll');
    await log.hover({ position: { x: 5, y: 5 } });
    await page.mouse.wheel(0, 500);
    // Wheel input is delivered asynchronously by the browser compositor.
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.getByRole('textbox', { name: 'Message Goobster' })).toBeInViewport();
});

test('mobile Chat still supports pinch zoom and restores its bounds after zooming out', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Page-scale emulation requires Chromium CDP');
    await login(page);
    await page.goto('/app/chat');
    const composer = page.getByRole('textbox', { name: 'Message Goobster' });
    await composer.fill('Keep my draft while zooming');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
    await expect.poll(() => page.evaluate(() => window.visualViewport.scale)).toBe(2);
    await composer.focus();
    await composer.press('End');
    await expect(composer).toHaveValue('Keep my draft while zooming');
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await expect.poll(() => page.evaluate(() => {
        const viewport = window.visualViewport;
        const rect = window.document.querySelector('.study-main').getBoundingClientRect();
        return {
            scale: viewport.scale,
            offset: viewport.offsetTop,
            scroll: window.scrollY,
            bottom: Math.round(rect.bottom),
            height: Math.round(viewport.height)
        };
    })).toEqual({ scale: 1, offset: 0, scroll: 0, bottom: 844, height: 844 });
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
    await cdp.detach();
});
