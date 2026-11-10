/* global requestAnimationFrame */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
for (const narrow of [false, true]) {
    test(`follow a project source, inspect changes and prepare private research (${narrow ? 'narrow' : 'desktop'})`, async ({ page }) => {
        const userId = narrow ? '800000000000000032' : '800000000000000031';
        if (narrow) await page.setViewportSize({ width: 390, height: 844 });
        await login(page, { userId, name: 'Source reader' });
        const seeded = await page.request.post('/e2e/fixtures/followed-sources', { data: { userId } });
        expect(seeded.ok()).toBe(true);
        const { project } = await seeded.json();
        await page.goto(`/app/projects/${userId}/${project.slug}/knowledge`);
        await page.getByText('Follow sources for this project', { exact: true }).click();
        await expect(page.getByText(/Your follows and saved changes are private/)).toBeVisible();
        await page.getByLabel('Source URL', { exact: true }).fill('https://example.org/feed');
        await page.getByLabel('Label (optional)').fill('Fictional research feed');
        await page.getByRole('button', { name: 'Follow source', exact: true }).click();
        const source = page.getByRole('article', { name: 'Fictional research feed' });
        await expect(source).toContainText('Waiting for baseline');
        await source.getByRole('button', { name: 'Check now' }).click();
        await expect(source).toContainText('Following');
        await expect(source.getByText(/Recent changes/)).toHaveCount(0);
        await page.request.post('/e2e/fixtures/followed-sources', { data: { userId, advance: true } });
        await source.getByRole('button', { name: 'Check now' }).click();
        await source.getByText('Recent changes (1)').click();
        await expect(source.getByRole('link', { name: /Observed source change/ })).toBeVisible();
        await source.getByRole('button', { name: 'Keep change', exact: true }).click();
        await expect(source).toContainText('1 kept');
        await page.locator('.followed-sources').screenshot({ path: test.info().outputPath('followed-sources.png') });
        await source.getByRole('button', { name: 'Prepare private research' }).click();
        await expect(source.getByRole('link', { name: 'Review research draft' })).toBeVisible();
        const drafts = await (await page.request.get('/api/app/spitball/expeditions')).json();
        expect(drafts.expeditions).toEqual([expect.objectContaining({ status: 'DRAFT', projectId: null })]);
        await source.getByRole('button', { name: 'Pause source' }).click();
        await expect(source.getByRole('button', { name: 'Check now' })).toBeDisabled();
        await page.reload();
        await page.getByText('Follow sources for this project', { exact: true }).click();
        await expect(source.getByRole('button', { name: 'Resume source' })).toBeVisible();
        await source.getByRole('button', { name: 'Resume source' }).click();
        await source.getByRole('button', { name: 'Unfollow', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
        await expect(source).toHaveCount(0);
        // Same panel from a personal Knowledge topic, without changing its scope.
        await page.goto('/app/knowledge/notes');
        await page.getByRole('button', { name: 'Follow sources for Followed topic fixture' }).click();
        await expect(page.getByRole('dialog').getByRole('heading', { name: 'Followed sources' })).toBeVisible();
        await page.getByRole('dialog').getByLabel('Source URL', { exact: true }).fill('https://example.org/topic.xml');
        await page.getByRole('dialog').getByRole('button', { name: 'Follow source', exact: true }).click();
        await expect(page.getByRole('dialog').getByRole('article')).toHaveCount(1);
        await page.getByRole('button', { name: 'Close sources' }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
    });
}

// The map box takes its height from its content, and GraphView sizes the
// canvas to the box. With the canvas in flow above the empty-state line, both
// grew on every frame, which made the journey above several times slower as it
// went on, and on CI it once passed the test limit.
test('the map of a project with no notes keeps its height and shows its empty state', async ({ page }) => {
    const userId = '800000000000000033';
    await login(page, { userId, name: 'Source reader' });
    const seeded = await page.request.post('/e2e/fixtures/followed-sources', { data: { userId } });
    expect(seeded.ok()).toBe(true);
    const { project } = await seeded.json();
    await page.goto(`/app/projects/${userId}/${project.slug}/knowledge`);
    const map = page.locator('.graph-wrap');
    await expect(map.getByText(/No project knowledge yet/)).toBeInViewport();
    const size = () => map.evaluate((box) => ({ box: box.clientHeight, canvas: box.querySelector('canvas').height }));
    // GraphView sizes the canvas in an effect, a moment after the box is on the page.
    await expect.poll(async () => {
        const { box, canvas } = await size();
        return canvas - box;
    }).toBe(0);
    const first = await size();
    await page.evaluate(() => new Promise((resolve) => {
        let frames = 0;
        const next = () => (++frames < 30 ? requestAnimationFrame(next) : resolve());
        requestAnimationFrame(next);
    }));
    expect(await size()).toEqual(first);
    expect(first.box).toBeLessThan(page.viewportSize().height);
});
