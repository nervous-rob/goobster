/**
 * The portal navigation contract (documentation/portal_navigation.md).
 * The registry's pure resolution is proven in tests/portalRooms.test.js;
 * these specs load the real router and assert that legacy URLs land on
 * their canonical destination with ids, query string and hash intact, that
 * the right sidebar entry lights up, and that the public share families,
 * the start-page preference and the settings return link keep working.
 */
const { test, expect } = require('@playwright/test');
const { login, openRoom } = require('./helpers');
const C = require('./constants');

const PRIMARY = ['Chat', 'Knowledge', 'Projects', 'Discussions', 'Activity', 'Tools'];

async function activeRoom(page) {
    return page.getByRole('navigation', { name: 'Rooms' }).locator('a[aria-current="page"]').getAttribute('data-room');
}

test.describe('legacy URLs keep their meaning', () => {
    test.beforeEach(async ({ page }) => {
        await login(page);
    });

    const matrix = [
        ['/app/study', '/app/chat', 'chat', null],
        ['/app/study/424242', '/app/chat/424242', 'chat', null],
        // Knowledge opens on Notes (E2): the alias lands on the room, the room lands on its first view.
        ['/app/spitball', '/app/knowledge/notes', 'knowledge', /^Knowledge/],
        ['/app/library', '/app/knowledge/notes', 'knowledge', /^Knowledge/],
        ['/app/spitball/map', '/app/knowledge/map', 'knowledge', /^Knowledge/],
        ['/app/observatory', '/app/projects', 'projects', /^Projects/],
        ['/app/observatory/graph', '/app/projects', 'projects', /^Projects/],
        ['/app/workshop', '/app/projects', 'projects', /^Projects/],
        ['/app/parlor', '/app/discussions', 'discussions', null],
        ['/app/parlor/424242', '/app/discussions/424242', 'discussions', null],
        ['/app/inbox', '/app/activity/inbox', 'activity', /^Inbox/],
        ['/app/noticed', '/app/activity/attention', 'activity', /^Attention/],
        ['/app/attention', '/app/activity/attention', 'activity', /^Attention/],
        ['/app/tasks', '/app/activity/scheduled', 'activity', /^Scheduled/]
    ];

    for (const [legacy, canonical, room, heading] of matrix) {
        test(`${legacy} → ${canonical} (query and hash preserved, ${room} active)`, async ({ page }) => {
            await page.goto(`${legacy}?tab=map&x=1#frag`);
            await expect(page).toHaveURL(new RegExp(`${canonical.replace(/\//g, '\\/')}\\?tab=map&x=1#frag$`));
            expect(await activeRoom(page)).toBe(room);
            if (heading) await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
        });
    }

    test('the pre-router #room/id hash resolves through the registry', async ({ page }) => {
        // A hash-only change is a same-document navigation; leave the app
        // first so each bookmark is a fresh load, as it would be from Discord.
        for (const [hash, target] of [['#study/515', /\/app\/chat\/515$/], ['#noticed', /\/app\/activity\/attention$/], ['#mtga', /\/app\/decks$/]]) {
            await page.goto('/health');
            await page.goto(`/app/${hash}`);
            await expect(page).toHaveURL(target);
        }
    });

    test('canonical URLs are not rewritten and light up their own entry', async ({ page }) => {
        for (const [path, room] of [
            ['/app/chat', 'chat'], ['/app/knowledge/notes', 'knowledge'], ['/app/knowledge/map', 'knowledge'], ['/app/projects', 'projects'],
            ['/app/discussions', 'discussions'], ['/app/activity/scheduled', 'activity'], ['/app/tools', 'tools'],
            ['/app/conservatory', 'tools'], ['/app/decks', 'tools'], ['/app/usage', 'usage']
        ]) {
            await page.goto(path);
            await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}\\/?$`));
            expect(await activeRoom(page)).toBe(room);
        }
    });
});

test.describe('sidebar', () => {
    test('shows the seven primary destinations, the account area, and hides Host from a member', async ({ page }) => {
        await login(page);
        const nav = page.getByRole('navigation', { name: 'Rooms' });
        for (const name of PRIMARY) {
            await expect(nav.getByRole('link', { name: new RegExp(`^${name}\\b`) })).toBeVisible();
        }
        await expect(page.getByRole('link', { name: /Goobster/ })).toBeVisible();
        await expect(nav.getByRole('link', { name: /Usage & limits/ })).toBeVisible();
        await expect(nav.getByRole('link', { name: /Host/ })).toHaveCount(0);
        await expect(page.getByRole('link', { name: /Settings/ })).toBeVisible();
        // The old room names stay visible as secondary names, never as entries.
        await expect(nav.getByText('Spitball')).toBeVisible();
        await expect(nav.getByText('the Parlor')).toBeVisible();
        await expect(nav.getByRole('link', { name: /^(Study|Noticed|Tasks|Inbox|Exchange|Decks|Conservatory)\b/ })).toHaveCount(0);
        expect(await nav.locator('a.nav-btn').count()).toBe(PRIMARY.length + 1);
    });

    test('Activity keeps Inbox, Attention and Scheduled as separate views under one entry', async ({ page }) => {
        await login(page);
        await openRoom(page, /Activity/);
        await expect(page).toHaveURL(/\/app\/activity\/inbox$/);
        const tabs = page.getByRole('navigation', { name: 'Activity views' });
        await expect(tabs.getByRole('link', { name: /Inbox/ })).toHaveAttribute('aria-current', 'page');
        await expect(page.getByRole('heading', { name: /^Inbox/ })).toBeVisible();

        await tabs.getByRole('link', { name: /Attention/ }).click();
        await expect(page).toHaveURL(/\/app\/activity\/attention$/);
        await expect(page.getByRole('heading', { name: /^Attention/ })).toBeVisible();
        // The seeded notice may already have been acted on by journeys.spec.js;
        // the Initiative control is Attention's own, order-independent proof.
        await expect(page.getByRole('button', { name: /Initiative/ })).toBeVisible();
        expect(await activeRoom(page)).toBe('activity');

        await tabs.getByRole('link', { name: /Scheduled/ }).click();
        await expect(page).toHaveURL(/\/app\/activity\/scheduled$/);
        await expect(page.getByRole('heading', { name: /^Scheduled/ })).toBeVisible();
        await expect(page.getByRole('button', { name: /New task/ })).toBeVisible();
        expect(await activeRoom(page)).toBe('activity');

        await page.goBack();
        await expect(page).toHaveURL(/\/app\/activity\/attention$/);
    });

    test('Tools lists the specialist rooms and explains an unavailable one locally', async ({ page }) => {
        await login(page);
        await openRoom(page, /Tools/);
        await expect(page.getByRole('heading', { name: 'Tools' })).toBeVisible();
        await expect(page.getByText('Music Lab', { exact: true })).toBeVisible();
        await expect(page.getByText('Card decks', { exact: true })).toBeVisible();
        // The e2e server has no Discord adapter: the trading game says so
        // instead of opening a room that would fail.
        const trading = page.locator('[data-tour="tool-trading"]');
        await expect(trading).toContainText('Trading game');
        await expect(trading).toContainText('not connected to Discord');
        await expect(trading).toHaveAttribute('aria-disabled', 'true');

        await page.locator('[data-tour="tool-music"]').click();
        await expect(page).toHaveURL(/\/app\/conservatory$/);
        expect(await activeRoom(page)).toBe('tools');
    });

    test('Home routes personal memory to Settings and offers the three creation choices', async ({ page }) => {
        await login(page);
        await expect(page.getByRole('button', { name: /New chat/ })).toBeVisible();
        await expect(page.getByRole('button', { name: /New note/ })).toBeVisible();
        await expect(page.getByRole('button', { name: /New project/ })).toBeVisible();
        await page.getByRole('button', { name: /Personal memory/ }).click();
        await expect(page).toHaveURL(/\/app\/settings\/memory$/);
        await expect(page.getByRole('link', { name: 'Open Knowledge →', exact: true })).toHaveAttribute('href', '/app/knowledge/notes');
    });
});

test.describe('deep links that carry state', () => {
    test('a settings shortcut from a legacy path returns to the canonical room by its new name', async ({ page }) => {
        await login(page);
        await page.goto('/app/noticed');
        await expect(page).toHaveURL(/\/app\/activity\/attention$/);
        await page.getByRole('button', { name: /Initiative/ }).click();
        await expect(page).toHaveURL(/\/app\/settings\/initiative/);
        const back = page.getByRole('link', { name: /Back to Activity · Attention/ });
        await expect(back).toBeVisible();
        await back.click();
        await expect(page).toHaveURL(/\/app\/activity\/attention$/);
    });

    test('a start page saved under an old room name still opens that room, and the select shows its new name', async ({ page }) => {
        await login(page);
        const settings = await page.request.get('/api/app/settings').then((r) => r.json());
        const revision = settings.sections.appearance.revision;
        const patch = await page.request.patch('/api/app/settings/appearance', {
            data: { changes: { startPage: 'study' }, expectedRevision: revision }
        });
        expect(patch.ok()).toBe(true);
        expect((await patch.json()).data.values.startPage).toBe('study');
        try {
            await page.evaluate(() => sessionStorage.removeItem('goobster-start-page-applied'));
            await page.goto('/app/');
            await expect(page).toHaveURL(/\/app\/chat$/);
            await page.goto('/app/settings/appearance');
            await expect(page.locator('#start-page-input')).toHaveValue('chat');
            await expect(page.locator('#start-page-input').locator('option')).toHaveText([
                'Home', 'Chat', 'Knowledge', 'Projects', 'Discussions', 'Activity', 'Tools'
            ]);
        } finally {
            const latest = await page.request.get('/api/app/settings').then((r) => r.json());
            await page.request.patch('/api/app/settings/appearance', {
                data: { changes: { startPage: 'home' }, expectedRevision: latest.sections.appearance.revision }
            });
        }
    });

    test('an Inbox item stored with a pre-rename link opens its canonical destination', async ({ page }) => {
        await login(page);
        await openRoom(page, /Activity/);
        const row = page.locator('.inbox-row').filter({ hasText: C.INBOX_LEGACY_LINK_TITLE });
        await row.getByRole('button', { name: new RegExp(C.INBOX_LEGACY_LINK_TITLE), expanded: false }).click();
        const open = row.getByRole('link', { name: 'Open →' });
        await expect(open).toHaveAttribute('href', '/app/tasks');
        await open.click();
        await expect(page).toHaveURL(/\/app\/activity\/scheduled$/);
        await expect(page.getByRole('heading', { name: /^Scheduled/ })).toBeVisible();
    });
});

test.describe('public shares stay public', () => {
    test('a conversation share renders in the shell without a session and offers Sign in', async ({ page }) => {
        await page.goto('/app/share/not-a-real-token');
        await expect(page.getByText(/does not exist|revoked/)).toBeVisible();
        await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
        await expect(page.getByText('Dev mode — mint a local identity')).toHaveCount(0);
        // Feature-gated rooms stay hidden from an anonymous viewer; the
        // public entries remain so the viewer can find the door.
        const nav = page.getByRole('navigation', { name: 'Rooms' });
        await expect(nav.getByRole('link', { name: /Projects/ })).toHaveCount(0);
        await expect(nav.getByRole('link', { name: /Chat/ })).toBeVisible();
    });

    test('a project dashboard share is answered by the server, never swallowed by the Projects route', async ({ page }) => {
        const response = await page.request.get('/app/observatory/share/not-a-real-token');
        expect(response.status()).toBe(404);
        const json = await response.json();
        expect(json.error?.code).toBeTruthy();
        expect(response.headers()['content-type']).toContain('application/json');
    });
});
