/**
 * The project workbench (documentation/projects.md): an app from a
 * template that runs a file and watches it live, pinned to the Overview
 * and opened full page; the Ctrl/Cmd+K palette; the chat dock's view
 * context chips; and a pull request reviewed in the repository editor
 * with its comments in the gutter. The e2e server has no code runner and
 * no GitHub, so those two are answered here; everything else is real.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
const C = require('./constants');

const createdProjects = new WeakMap();
test.afterEach(async ({ page }) => {
    for (const slug of createdProjects.get(page) || []) {
        const removed = await page.request.delete(`/api/app/observatory/projects/${slug}?owner=${C.OWNER}`);
        expect(removed.ok(), await removed.text()).toBe(true);
    }
});
function trackProject(page, slug) {
    createdProjects.set(page, [...(createdProjects.get(page) || []), slug]);
}


const SIM = 'import sys\nfor day in range(int(sys.argv[2])):\n    print("day", day + 1)\n';

async function freshProject(page, label) {
    const created = await page.request.post('/api/app/projects', { data: { name: `${label} ${Date.now()}` } });
    expect(created.ok(), await created.text()).toBe(true);
    const { project } = await created.json();
    trackProject(page, project.slug);
    const put = await page.request.put(`/api/app/projects/${project.slug}/content/tools/sim.py`, { data: { content: SIM } });
    expect(put.ok(), await put.text()).toBe(true);
    return { slug: project.slug, base: `/app/projects/${C.OWNER}/${project.slug}` };
}

test.beforeEach(async ({ page }) => {
    await login(page);
});

test('a run console from a template runs a file live, pins to the Overview and opens full page', async ({ page }) => {
    const { slug, base } = await freshProject(page, 'Workbench');
    let runBody = null;
    await page.route('**/run-file*', async (route) => {
        runBody = route.request().postDataJSON();
        await route.fulfill({ json: { mode: 'background', jobId: 77, status: 'RUNNING' } });
    });
    let polls = 0;
    await page.route(`**/api/app/projects/${slug}/jobs/77/live*`, async (route) => {
        expect(new URL(route.request().url()).searchParams.get('owner')).toBe(C.OWNER);
        polls += 1;
        await route.fulfill({
            json: polls < 2
                ? { jobId: 77, status: 'RUNNING', running: true, streaming: true, at: 't1', stdout: 'day 1\n', stderr: '' }
                : { jobId: 77, status: 'COMPLETED', running: false, streaming: false, at: 't2', stdout: 'day 1\nday 2\nday 3\n', stderr: '' }
        });
    });

    await page.goto(`${base}/apps`);
    await page.getByRole('button', { name: '+ New app from template' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('radio', { name: /Run console/ }).click();
    await dialog.getByLabel('Name').fill('Sim console');
    await dialog.getByLabel('Program to run').fill('tools/sim.py');
    await dialog.getByLabel('Default arguments').fill('--days 3');
    await dialog.getByRole('button', { name: 'Create app' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]app=sim-console/);

    const frame = page.frameLocator('.applet-frame');
    await expect(frame.locator('#title')).toHaveText('Sim console');
    await expect(frame.locator('#args')).toHaveValue('--days 3');
    await frame.locator('#run').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(frame.locator('#out')).toContainText('day 3');
    await expect(frame.locator('#state')).toHaveText('completed');
    expect(runBody).toMatchObject({ path: 'tools/sim.py', args: ['--days', '3'], background: true, startedBy: 'app' });
    await expect(frame.locator('#history')).toContainText('#77 --days 3 · completed');

    // Pin it; the Overview shows it live; ⤢ opens it alone at its own address.
    await page.getByRole('button', { name: '📌 Pin to Overview' }).click();
    await expect(page.getByRole('button', { name: '📌 Pinned' })).toBeVisible();
    await page.goto(`${base}/overview`);
    const card = page.getByTestId('pinned-app-sim-console');
    await expect(card).toContainText('Sim console');
    await expect(card.frameLocator('.applet-frame').locator('#title')).toHaveText('Sim console');
    await card.getByRole('button', { name: '⤢' }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/apps\\?app=sim-console&full=1`));
    await expect(page.locator('.obs-apps.is-full')).toBeVisible();
    await expect(page.locator('.obs-apps-history')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.obs-apps.is-full')).toBeVisible();
    await page.getByRole('button', { name: '⤡ Exit full page' }).click();
    await expect(page.locator('.obs-apps-history')).toBeVisible();

    const assets = await (await page.request.get(`/api/app/projects/${slug}/assets?kind=app&owner=${C.OWNER}`)).json();
    expect(assets.assets.find((a) => a.slug === 'sim-console')).toMatchObject({ pinned: true });
});

test('Ctrl+K jumps to views and files; the chat dock shows what is open and sends what is kept', async ({ page }) => {
    const { base } = await freshProject(page, 'Palette');
    await page.goto(`${base}/overview`);
    await expect(page.getByRole('heading', { name: /Palette/ })).toBeVisible();

    await page.keyboard.press('Control+K');
    const palette = page.getByRole('dialog', { name: 'Go to anything in this project' });
    await palette.getByRole('combobox').fill('automat');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${base}/automations$`));

    await page.keyboard.press('Control+K');
    await palette.getByRole('combobox').fill('sim.py');
    await expect(palette.getByRole('option', { name: /sim\.py.*tools\/sim\.py/ })).toBeVisible();
    await expect(palette.getByRole('option', { name: /Ask Goobster/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${base}/files\\?file=tools(%2F|/)sim\\.py`));
    await expect(page.locator('.cm-content')).toContainText('print("day", day + 1)');

    // Select two lines, then open the dock: it lists the open file and the selection.
    await page.locator('.cm-line').nth(1).click();
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.up('Shift');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    const context = page.getByTestId('view-context');
    await expect(context).toContainText('workspace/tools/sim.py');
    await expect(context).toContainText('lines 2–3');

    let sent = null;
    await page.route('**/api/app/parlor/chat', async (route) => {
        sent = route.request().postDataJSON();
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    });
    // Leave the file out; the selection goes.
    await context.getByRole('button', { name: 'Leave out workspace/tools/sim.py' }).click();
    await expect(context.locator('.view-context-chip.is-off')).toHaveCount(1);
    const composer = page.locator('.obs-chat-dock-composer textarea');
    await composer.fill('What does this loop do?');
    await page.keyboard.press('Enter');
    await expect.poll(() => sent?.message || '').toContain('What does this loop do?');
    expect(sent.message).toContain('Selected lines 2–3 of workspace/tools/sim.py');
    expect(sent.message).toMatch(/```python\n[\s\S]*print\(/);
    expect(sent.message.startsWith('Selected lines 2–3')).toBe(true);
    expect(sent.message).not.toContain('Open file: workspace/tools/sim.py');
});

test('a pull request opens for review in the repository editor, comments in the gutter, Ask Goobster to address', async ({ page }) => {
    const { base } = await freshProject(page, 'Review');
    const repo = {
        id: 1, name: 'chronicle', repo: 'acme/chronicle', path: 'repos/chronicle', url: 'https://github.com/acme/chronicle', clonedBranch: 'main',
        status: { branch: 'feature/ide', upstream: 'origin/feature/ide', ahead: 0, behind: 0, head: 'abc1234', changed: 0, changes: [], operation: null, conflicts: [] }
    };
    const file = 'def step(world):\n    for p in world.people:\n        p.age += 1\n    return world\n';
    await page.route('**/api/app/projects/*/repos', (r) => r.fulfill({ json: { enabled: true, maxRepos: 3, repos: [repo] } }));
    await page.route('**/api/app/projects/*/repos?*', (r) => r.fulfill({ json: { enabled: true, maxRepos: 3, repos: [repo] } }));
    await page.route('**/repos/chronicle/summary*', (r) => r.fulfill({ json: { ci: null, pr: null, remoteError: null } }));
    await page.route('**/repos/chronicle/watches*', (r) => r.fulfill({ json: { watches: [] } }));
    await page.route('**/repos/chronicle/changes*', (r) => r.fulfill({ json: { branch: 'feature/ide', upstream: 'origin/feature/ide', ahead: 0, behind: 0, operation: null, head: 'abc1234', truncated: false, files: [] } }));
    await page.route('**/repos/chronicle/file?*', (r) => r.fulfill({ json: { exists: true, binary: false, content: file } }));
    await page.route('**/repos/chronicle/pulls**', (r) => {
        if (/\/pulls\/12\/review/.test(r.request().url())) {
            return r.fulfill({ json: {
                name: 'chronicle', repo: 'acme/chronicle', number: 12, title: 'Age people daily', url: 'https://github.com/acme/chronicle/pull/12',
                state: 'open', draft: false, author: 'dana', body: '', head: 'feature/ide', base: 'main', fromFork: false,
                branch: 'feature/ide', onHead: true, patchesCut: false, filesTruncated: false,
                files: [{ path: 'src/sim.py', previousPath: null, status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,3 +1,4 @@\n def step(world):\n+    for p in world.people:' }],
                comments: [
                    { id: 5, path: 'src/sim.py', line: 3, originalLine: 3, outdated: false, body: 'Clamp age at 120?', author: 'rev', createdAt: null, url: 'https://github.com/acme/chronicle/pull/12#c5', inReplyTo: null },
                    { id: 6, path: 'src/sim.py', line: 3, originalLine: 3, outdated: false, body: 'Good idea.', author: 'dana', createdAt: null, url: null, inReplyTo: 5 }
                ],
                reviews: [{ id: 9, author: 'rev', state: 'CHANGES_REQUESTED', body: 'One thing.', url: null }]
            } });
        }
        return r.fulfill({ json: { pulls: [{ number: 12, title: 'Age people daily', head: 'feature/ide', base: 'main', author: 'dana', draft: false, ci: { state: 'success' } }] } });
    });
    await page.route('**/api/app/projects/*/files?*', (r) => {
        const dir = new URL(r.request().url()).searchParams.get('path');
        if (dir === 'repos/chronicle') return r.fulfill({ json: { entries: [{ path: 'repos/chronicle/src', name: 'src', kind: 'directory', size: 0 }] } });
        if (dir === 'repos/chronicle/src') return r.fulfill({ json: { entries: [{ path: 'repos/chronicle/src/sim.py', name: 'sim.py', kind: 'file', size: 90 }] } });
        return r.continue();
    });
    await page.route('**/content/repos/chronicle/src/sim.py*', (r) => r.fulfill({ body: file, contentType: 'text/plain' }));

    await page.goto(`${base}/code`);
    await page.getByRole('button', { name: 'Open editor' }).click();
    await page.getByRole('tab', { name: 'Review' }).click();
    await page.getByTestId('repo-ide-pulls').getByRole('button', { name: /#12 Age people daily/ }).click();
    const reviewPane = page.getByTestId('repo-ide-review');
    await expect(reviewPane).toContainText('rev ✋ changes requested');
    await expect(reviewPane).not.toContainText('Switch to');
    await reviewPane.getByRole('button', { name: /src\/sim\.py/ }).click();

    await expect(page.locator('.cm-content')).toContainText('p.age += 1');
    await expect(page.locator('.cm-comment-mark')).toHaveCount(1);
    await expect(page.locator('.cm-comment-mark')).toHaveAttribute('title', /rev: Clamp age at 120\?/);
    const threads = page.getByTestId('repo-ide-threads');
    await expect(threads).toContainText('line 3');
    await expect(threads).toContainText('Good idea.');
    await threads.getByRole('button', { name: 'Ask Goobster to address this' }).click();
    const composer = page.locator('.obs-chat-dock-composer textarea');
    await expect(composer).toHaveValue(/On pull request #12 "Age people daily" \(feature\/ide → main\), a review comment on repos\/chronicle\/src\/sim\.py line 3/);
    await expect(composer).toHaveValue(/> Clamp age at 120\?/);
});
