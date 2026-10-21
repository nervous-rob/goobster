/**
 * Project apps with project access (documentation/projects.md "Apps with
 * project access"): an app opened in its project's Apps tab lists, reads,
 * writes and deletes workspace files, saves notes and runs files through
 * window.goobster. Write / delete / run are declared in the app and approved
 * by the viewer; a refusal sticks for the session, Reset approvals asks
 * again, an undeclared capability and app assets are refused.
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


const APP = `<!doctype html><html><head>
<meta name="goobster-project-access" content="write delete run">
<title>Ledger</title></head><body>
<button id="save">Save</button><button id="del">Delete</button><button id="run">Run</button>
<button id="note">Note</button><button id="app">Overwrite app</button>
<pre id="out">idle</pre>
<script>
const out = (t) => { document.getElementById('out').textContent = t; };
const fail = (e) => out('ERR ' + (e.code || e.message));
const on = (id, fn) => { document.getElementById(id).onclick = () => fn().catch(fail); };
on('save', async () => {
    await goobster.write('data/ledger.json', { n: 3 });
    const back = await goobster.read('data/ledger.json', 'json');
    const names = (await goobster.list('data')).map((e) => e.name).join(',');
    out('saved ' + back.n + ' ' + names + ' in ' + goobster.context.project);
});
on('del', async () => { await goobster.remove('data/ledger.json'); out('deleted'); });
on('run', async () => { const r = await goobster.run('tools/sim.py', { args: ['--days', '3'] }); out('ran ' + r.result.stdout); });
on('note', async () => { const s = await goobster.assets.write('ledger-notes', '# Ledger notes'); out('note v' + s.version); });
on('app', async () => { await goobster.assets.write('ledger', 'x', { kind: 'app' }); out('overwrote'); });
</script></body></html>`;

const READER = `<!doctype html><html><head><title>Reader</title></head><body>
<button id="write">Write</button><pre id="out">idle</pre>
<script>
document.getElementById('write').onclick = () => goobster.write('x.txt', 'no')
    .then(() => { document.getElementById('out').textContent = 'wrote'; })
    .catch((e) => { document.getElementById('out').textContent = 'ERR ' + e.code; });
</script></body></html>`;

test.beforeEach(async ({ page }) => {
    await login(page);
});

test('an app reads, writes, deletes and runs project files with the viewer\'s approval', async ({ page }) => {
    const created = await page.request.post('/api/app/projects', { data: { name: `App access ${Date.now()}` } });
    expect(created.ok(), await created.text()).toBe(true);
    const { project: { slug } } = await created.json();
    trackProject(page, slug);
    for (const [asset, name, source] of [['ledger', 'Ledger', APP], ['reader', 'Reader', READER]]) {
        const saved = await page.request.post(`/api/app/projects/${slug}/assets`, {
            data: { slug: asset, name, kind: 'app', language: 'html', source }
        });
        expect(saved.ok(), await saved.text()).toBe(true);
    }
    const content = (file) => page.request.get(`/api/app/projects/${slug}/content/${file}?owner=${C.OWNER}`);

    await page.goto(`/app/projects/${C.OWNER}/${slug}/apps`);
    await page.getByRole('option', { name: /Ledger/ }).click();
    const access = page.getByTestId('app-access');
    await expect(access).toContainText('read this project');
    await expect(access).toContainText('write files & notes · asks first');
    const frame = page.frameLocator('.applet-frame');
    const out = frame.locator('#out');
    const dialog = page.getByRole('dialog');

    // Write: asks once, then writes, reads back and lists, as the viewer.
    await frame.locator('#save').click();
    await expect(dialog).toContainText('"Ledger" wants to create and change files and notes');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(out).toHaveText(`saved 3 ledger.json in ${slug}`);
    expect(JSON.parse(await (await content('data/ledger.json')).text())).toEqual({ n: 3 });
    await expect(access).toContainText('write files & notes ✓');

    // Delete refused: the file stays and the refusal sticks without asking again.
    await frame.locator('#del').click();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(out).toHaveText('ERR ACCESS_DENIED');
    expect((await content('data/ledger.json')).ok()).toBe(true);
    await frame.locator('#del').click();
    await expect(dialog).toHaveCount(0);
    await expect(out).toHaveText('ERR ACCESS_DENIED');
    await expect(access).toContainText('delete files & notes ✕');

    // Reset approvals: it asks again, and this time deletes.
    await access.getByRole('button', { name: 'Reset approvals' }).click();
    await frame.locator('#del').click();
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(out).toHaveText('deleted');
    expect((await content('data/ledger.json')).status()).toBe(404);

    // Run a workspace file (the e2e server has no executor, so the run is answered here).
    let runBody = null;
    await page.route('**/run-file*', async (route) => {
        runBody = route.request().postDataJSON();
        await route.fulfill({ json: { mode: 'foreground', jobId: 7, result: { ok: true, stdout: 'day 3' } } });
    });
    await frame.locator('#run').click();
    await expect(dialog).toContainText('run programs');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(out).toHaveText('ran day 3');
    expect(runBody).toMatchObject({ path: 'tools/sim.py', args: ['--days', '3'], startedBy: 'app' });

    // Notes and scripts are writable assets; apps are not.
    await frame.locator('#note').click();
    await expect(dialog).toContainText('create and change files');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(out).toHaveText('note v1');
    const notes = await (await page.request.get(`/api/app/projects/${slug}/assets?kind=note&owner=${C.OWNER}`)).json();
    expect(notes.assets.map((a) => a.slug)).toContain('ledger-notes');
    await frame.locator('#app').click();
    await expect(out).toHaveText('ERR APP_PROTECTED');

    const activity = page.getByTestId('app-activity');
    await activity.locator('summary').click();
    await expect(activity).toContainText('project.write');
    await expect(activity).toContainText('ACCESS_DENIED');

    // An app that declared nothing can read but never write.
    await page.getByRole('option', { name: /Reader/ }).click();
    await expect(page.getByTestId('app-access')).not.toContainText('write files');
    await page.frameLocator('.applet-frame').locator('#write').click();
    await expect(page.frameLocator('.applet-frame').locator('#out')).toHaveText('ERR UNDECLARED_CAPABILITY');
    await expect(dialog).toHaveCount(0);
    expect((await content('x.txt')).status()).toBe(404);
});

test('approval is exact-source and asset-bound, including the old equal-length hash collision', async ({ page }) => {
    const created = await page.request.post('/api/app/projects', { data: { name: `Source identity ${Date.now()}` } });
    expect(created.ok(), await created.text()).toBe(true);
    const { project: { slug } } = await created.json();
    trackProject(page, slug);
    const original = APP.replace('<title>Ledger', '<!--Aa--><title>Ledger');
    const collision = original.replace('<!--Aa-->', '<!--B@-->');
    const save = async (asset, source) => {
        const response = await page.request.post(`/api/app/projects/${slug}/assets`, {
            data: { slug: asset, name: asset, kind: 'app', language: 'html', source }
        });
        expect(response.ok(), await response.text()).toBe(true);
    };
    await save('ledger', original);
    await save('twin', original);
    const open = async (asset) => {
        await page.goto(`/app/projects/${C.OWNER}/${slug}/apps?app=${asset}`);
        await expect(page.frameLocator('.applet-frame').locator('#out')).toHaveText('idle');
        await page.frameLocator('.applet-frame').locator('#save').evaluate(async (button) => {
            await globalThis.goobster.ready();
            if (typeof button.onclick !== 'function') throw new Error('App script is not ready');
        });
    };
    const clickSave = () => page.frameLocator('.applet-frame').locator('#save').click();
    const dialog = page.getByRole('dialog');
    await open('ledger');
    await clickSave();
    await expect(dialog).toContainText('create and change files');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.frameLocator('.applet-frame').locator('#out')).toContainText('saved 3');
    // Unchanged bytes on the same asset survive a reload without a prompt.
    await open('ledger');
    await clickSave();
    await expect(page.frameLocator('.applet-frame').locator('#out')).toContainText('saved 3');
    await expect(dialog).toHaveCount(0);
    // Identical code on another asset must ask, even within this project.
    await page.getByRole('option', { name: /twin/ }).click();
    await expect(page.frameLocator('.applet-frame').locator('#out')).toHaveText('idle');
    await page.frameLocator('.applet-frame').locator('#save').evaluate(() => globalThis.goobster.ready());
    await clickSave();
    await expect(dialog).toContainText('create and change files');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.frameLocator('.applet-frame').locator('#out')).toHaveText('ERR ACCESS_DENIED');
    // The old DJB2 collision used to inherit ledger's grant.
    await save('ledger', collision);
    await open('ledger');
    await clickSave();
    await expect(dialog).toContainText('create and change files');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.frameLocator('.applet-frame').locator('#out')).toHaveText('ERR ACCESS_DENIED');
});

test('unavailable cryptographic identity refuses capabilities without prompting or writing', async ({ page }) => {
    const created = await page.request.post('/api/app/projects', { data: { name: `Identity failure ${Date.now()}` } });
    expect(created.ok(), await created.text()).toBe(true);
    const { project: { slug } } = await created.json();
    trackProject(page, slug);
    const saved = await page.request.post(`/api/app/projects/${slug}/assets`, {
        data: { slug: 'ledger', name: 'Ledger', kind: 'app', language: 'html', source: APP }
    });
    expect(saved.ok()).toBe(true);
    await page.addInitScript(() => {
        crypto.subtle.digest = async () => { throw new Error('Synthetic identity failure'); };
    });
    let writes = 0;
    page.on('request', req => { if (req.method() === 'PUT' && req.url().includes('/content/')) writes++; });
    await page.goto(`/app/projects/${C.OWNER}/${slug}/apps`);
    const frame = page.frameLocator('.applet-frame');
    await frame.locator('#save').evaluate(() => globalThis.goobster.ready());
    await frame.locator('#save').click();
    await expect(frame.locator('#out')).toHaveText('ERR IDENTITY_UNAVAILABLE');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(writes).toBe(0);
    expect((await page.request.get(`/api/app/projects/${slug}/content/data/ledger.json`)).status()).toBe(404);
});
