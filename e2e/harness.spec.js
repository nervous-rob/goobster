/**
 * The shared e2e server itself. Every journey of a run talks to one
 * `e2e/server.js` process, so anything that ends that process fails the rest
 * of the run with refused connections. That happened on `main`: a journey
 * timed out, its retry seeded the same fixture again, the fixture route
 * threw, and 158 later journeys failed in about 130 ms each.
 */
const { test, expect } = require('@playwright/test');

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

test('a fixture route that throws answers with an error and the server keeps running', async ({ request }) => {
    const broken = await request.post('/e2e/fixtures/rejects');
    expect(broken.status()).toBe(500);
    expect((await request.get('/health')).ok()).toBe(true);
});
