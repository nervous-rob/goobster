/** Synthetic repository files and intercepted chat: no GitHub or model requests. */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
const C = require('./constants');

test('excluded unsaved selections cannot move between already-loaded repository tabs', async ({ page }) => {
    await login(page);
    const created = await page.request.post('/api/app/projects', { data: { name: `Selection privacy ${Date.now()}` } });
    expect(created.ok()).toBe(true);
    const { project } = await created.json();
    const repo = {
        id: 1, name: 'privacy', repo: 'synthetic/privacy', path: 'repos/privacy',
        status: { branch: 'main', upstream: null, ahead: 0, behind: 0, changed: 0, changes: [], operation: null, conflicts: [] }
    };
    const contents = { 'a.txt': 'Saved A text', 'b.txt': 'Synthetic B text' };
    const reads = { 'a.txt': 0, 'b.txt': 0 };
    await page.route('**/api/app/projects/*/repos{,?*}', (r) => r.fulfill({ json: { enabled: true, maxRepos: 3, repos: [repo] } }));
    await page.route('**/repos/privacy/summary*', (r) => r.fulfill({ json: { ci: null, pr: null, remoteError: null } }));
    await page.route('**/repos/privacy/watches*', (r) => r.fulfill({ json: { watches: [] } }));
    await page.route('**/repos/privacy/changes*', (r) => r.fulfill({ json: { branch: 'main', files: [] } }));
    await page.route('**/repos/privacy/file?*', (r) => {
        const path = new URL(r.request().url()).searchParams.get('path');
        return r.fulfill({ json: { exists: true, content: contents[path], binary: false } });
    });
    await page.route('**/api/app/projects/*/files?*', (r) => {
        if (new URL(r.request().url()).searchParams.get('path') !== 'repos/privacy') return r.continue();
        return r.fulfill({ json: { entries: Object.keys(contents).map((name) => ({ path: `repos/privacy/${name}`, name, kind: 'file', size: 30 })) } });
    });
    await page.route('**/content/repos/privacy/*', (r) => {
        const name = new URL(r.request().url()).pathname.split('/').pop();
        reads[name] += 1;
        return r.fulfill({ body: contents[name], contentType: 'text/plain' });
    });
    const sent = [];
    await page.route('**/api/app/parlor/chat', async (r) => {
        sent.push(r.request().postDataJSON().message);
        await r.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    });

    await page.goto(`/app/projects/${C.OWNER}/${project.slug}/code`);
    await page.getByRole('button', { name: 'Open editor' }).click();
    const editor = page.locator('.cm-content');
    await page.getByRole('treeitem', { name: 'a.txt', exact: true }).click();
    await expect(editor).toHaveText(contents['a.txt']);
    await page.getByRole('treeitem', { name: 'b.txt', exact: true }).click();
    await expect(editor).toHaveText(contents['b.txt']);
    const tab = (name) => page.locator('.repo-ide-tab-name').filter({ hasText: name });
    await tab('a.txt').click();
    await editor.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText('UNSAVED_SYNTHETIC_A_PRIVATE');
    await page.keyboard.press('Control+a');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    const context = page.getByTestId('view-context');
    await expect(context).toContainText('line 1');
    await context.getByRole('button', { name: 'Leave out line 1', exact: true }).click();
    await expect(context.locator('.view-context-chip.is-off')).toHaveCount(1);

    await tab('b.txt').click();
    await expect(editor).toHaveText(contents['b.txt']);
    await expect(context).toContainText('repos/privacy/b.txt');
    const composer = page.locator('.obs-chat-dock-composer textarea');
    await composer.fill('Discuss B');
    await composer.press('Enter');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toContain('Open file: repos/privacy/b.txt');
    expect(sent[0]).not.toContain('UNSAVED_SYNTHETIC_A_PRIVATE');
    expect(sent[0]).not.toContain('Selected');
    await expect(context).not.toContainText('line 1');
    await expect(page.getByRole('button', { name: 'Ask Goobster about line 1', exact: true })).toHaveCount(0);

    // Switching back must not revive the excluded unsaved selection either.
    await tab('a.txt').click();
    await expect(editor).toHaveText('UNSAVED_SYNTHETIC_A_PRIVATE');
    await expect(context).not.toContainText('line 1');
    await composer.fill('Discuss A without its selected text');
    await composer.press('Enter');
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]).toContain('Open file: repos/privacy/a.txt on branch main (unsaved edit)');
    expect(sent[1]).not.toContain('UNSAVED_SYNTHETIC_A_PRIVATE');

    // A fresh selection of B is correctly attributed and included.
    await tab('b.txt').click();
    await editor.click();
    await page.keyboard.press('Control+a');
    await expect(context).toContainText('line 1');
    await composer.fill('Discuss the selected B text');
    await composer.press('Enter');
    await expect.poll(() => sent.length).toBe(3);
    expect(sent[2]).toContain('Selected line 1 of repos/privacy/b.txt on branch main');
    expect(sent[2]).toContain('Synthetic B text');
    expect(sent[2]).not.toContain('UNSAVED_SYNTHETIC_A_PRIVATE');
    expect(reads).toEqual({ 'a.txt': 1, 'b.txt': 1 });
});
