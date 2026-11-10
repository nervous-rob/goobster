/**
 * The shared e2e server itself. Every journey of a run talks to one
 * `e2e/server.js` process, so anything that ends that process fails the rest
 * of the run with refused connections. That happened on `main`: a journey
 * timed out, its retry seeded the same fixture again, the fixture route
 * threw, and 158 later journeys failed in about 130 ms each.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test('a retried journey can seed its project fixture again', async ({ request }) => {
    for (const route of ['/e2e/fixtures/followed-sources', '/e2e/fixtures/account-export']) {
        const userId = route.endsWith('sources') ? '800000000000000981' : '800000000000000982';
        const first = await request.post(route, { data: { userId } });
        expect(first.ok()).toBe(true);
        const second = await request.post(route, { data: { userId } });
        expect(second.ok()).toBe(true);
        expect((await second.json()).project.slug).toBe((await first.json()).project.slug);
    }
});

// The followed-sources journey asserts that its research draft is the only
// one. Its first attempt timed out after preparing that draft, and the retry
// then failed on the draft the first attempt had left.
test('seeding the followed-sources fixture again removes the research draft of the first attempt', async ({ page }) => {
    const userId = '800000000000000983';
    await login(page, { userId, name: 'Retried reader' });
    const seed = async () => (await (await page.request.post('/e2e/fixtures/followed-sources', { data: { userId } })).json()).project;
    const project = await seed();
    const followed = await page.request.post('/api/app/followed-sources', { data: { projectId: project.id, url: 'https://example.org/feed', kind: 'feed' } });
    expect(followed.ok()).toBe(true);
    const source = await followed.json();
    expect((await page.request.post(`/api/app/followed-sources/${source.id}/check`)).ok()).toBe(true);
    await page.request.post('/e2e/fixtures/followed-sources', { data: { userId, advance: true } });
    expect((await page.request.post(`/api/app/followed-sources/${source.id}/check`)).ok()).toBe(true);
    const listed = await (await page.request.get(`/api/app/followed-sources?projectId=${project.id}`)).json();
    const entry = listed.sources[0].entries[0];
    expect((await page.request.post(`/api/app/followed-sources/${source.id}/entries/${entry.id}/research`)).ok()).toBe(true);
    const drafts = async () => (await (await page.request.get('/api/app/spitball/expeditions')).json()).expeditions;
    expect(await drafts()).toHaveLength(1);

    expect((await seed()).slug).toBe(project.slug);
    expect(await drafts()).toEqual([]);
    expect((await (await page.request.get(`/api/app/followed-sources?projectId=${project.id}`)).json()).sources).toEqual([]);
});

test('a fixture route that throws answers with an error and the server keeps running', async ({ request }) => {
    const broken = await request.post('/e2e/fixtures/rejects');
    expect(broken.status()).toBe(500);
    expect((await request.get('/health')).ok()).toBe(true);
});
