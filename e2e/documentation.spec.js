const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test('public getting started, article links, fragments, history, and missing pages', async ({ page }) => {
    await page.goto('/app/docs');
    await expect(page).toHaveURL(/\/app\/docs\/getting-started$/);
    const article = page.getByRole('article');
    await expect(article.getByRole('heading', { name: 'Getting started with Goobster' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    const sections = page.getByRole('navigation', { name: 'Documentation contents' });
    await expect(sections.locator('.docs-sections a[aria-current]')).toHaveCount(0);
    await sections.getByRole('link', { name: 'Find results in Activity', exact: true }).click();
    await expect(page).toHaveURL(/#find-results-in-activity$/);
    await expect(sections.locator('.docs-sections a[aria-current="page"]')).toHaveCount(1);
    await expect(article.locator('#find-results-in-activity')).toBeInViewport();
    await page.reload();
    await expect(article.locator('#find-results-in-activity')).toBeInViewport();
    await article.getByRole('link', { name: 'Knowledge and memory', exact: true }).click();
    await expect(page).toHaveURL(/\/app\/docs\/knowledge$/);
    await page.goBack();
    await expect(page).toHaveURL(/getting-started#find-results-in-activity$/);
    await page.goForward();
    await expect(page).toHaveURL(/\/app\/docs\/knowledge$/);
    await page.goto('/app/docs/not-a-page');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await page.getByRole('link', { name: 'Open Getting started' }).click();
    await expect(article.getByRole('heading', { name: 'Getting started with Goobster' })).toBeVisible();
    // `#projects` is a real heading in the rooms guide; it must not be
    // mistaken for the pre-router #room/id bookmark scheme on reload.
    await page.goto('/app/docs/rooms#projects');
    await expect(page).toHaveURL(/\/app\/docs\/rooms#projects$/);
    await expect(article.locator('#projects')).toBeInViewport();
});

test('search finds body text and opens its section, with a recoverable empty state', async ({ page }) => {
    await page.goto('/app/docs');
    const input = page.getByRole('searchbox', { name: 'Search documentation' });
    await input.fill('operatorDir');
    const results = page.getByRole('region', { name: 'Documentation search results' });
    await expect(results.getByRole('link').first()).toBeVisible();
    const target = await results.getByRole('link').first().getAttribute('href');
    await results.getByRole('link').first().click();
    await expect(page).toHaveURL(new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
    await expect(input).toHaveValue('');
    const hash = new URL(page.url()).hash.slice(1);
    await expect(page.getByRole('article').locator(`[id="${hash}"]`)).toBeInViewport();
    await input.fill('zzzz-no-documentation-match');
    await expect(results).toContainText('No matching sections');
    await results.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.getByRole('navigation', { name: 'Documentation contents' })).toBeVisible();
});

test('Documentation is reachable from sign-in and from the signed-in sidebar', async ({ page }) => {
    await page.goto('/app/');
    await page.getByRole('link', { name: 'Documentation', exact: true }).click();
    await expect(page).toHaveURL(/\/app\/docs\/getting-started$/);
    await login(page);
    await page.getByRole('link', { name: 'Documentation', exact: true }).click();
    await expect(page.getByRole('article').getByRole('heading', { name: 'Getting started with Goobster' })).toBeVisible();
});

test('narrow reader supports keyboard search and navigation without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/app/docs');
    const browse = page.getByRole('button', { name: 'Browse documentation', exact: true });
    await browse.focus();
    await page.keyboard.press('Enter');
    const input = page.getByRole('searchbox', { name: 'Search documentation' });
    await expect(input).toBeVisible();
    await input.focus();
    await input.fill('brief');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('region', { name: 'Documentation search results' }).getByRole('link').first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('article')).toBeVisible();
    await expect(browse).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
    await browse.click();
    await input.focus();
    await page.keyboard.press('Escape');
    await expect(browse).toBeFocused();
    await expect(browse).toHaveAttribute('aria-expanded', 'false');
});
