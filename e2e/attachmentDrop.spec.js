/* global DataTransfer, DataTransferItem, DragEvent, window */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
const C = require('./constants');

// Real DataTransfer objects exercise the browser/React boundary, including
// file + URL duplicates and protected-mode dragover (no readable files).
async function dropOn(page, selector, { files = [], strings = {}, directory = false } = {}) {
    const dataTransfer = await page.evaluateHandle(({ files, strings, directory }) => {
        const data = new DataTransfer();
        for (const file of files) {
            const body = file.base64 ? Uint8Array.from(atob(file.base64), c => c.charCodeAt(0)) : file.text || '';
            data.items.add(new File([body], file.name, { type: file.type || 'text/plain' }));
        }
        for (const [type, value] of Object.entries(strings)) data.setData(type, value);
        if (directory) {
            window.originalEntry = DataTransferItem.prototype.webkitGetAsEntry;
            DataTransferItem.prototype.webkitGetAsEntry = () => ({ isDirectory: true });
        }
        return data;
    }, { files, strings, directory });
    await page.locator(selector).dispatchEvent('dragenter', { dataTransfer });
    await page.locator(selector).dispatchEvent('dragover', { dataTransfer });
    await page.locator(selector).dispatchEvent('drop', { dataTransfer });
    if (directory) await page.evaluate(() => { DataTransferItem.prototype.webkitGetAsEntry = window.originalEntry; });
    await dataTransfer.dispose();
    await expect(page.locator('.attachment-drop-indicator')).toHaveCount(0);
}
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=';
const image = name => ({ name, type: 'image/png', base64: PNG });

test.beforeEach(async ({ page }) => { await login(page); });
test.afterEach(async ({ page }) => {
    // The portal fixture server is shared across suites; leave its seeded counts intact.
    const scope = `dm:${C.OWNER}`;
    const data = await page.request.get(`/api/app/spitball/notes?scope=${encodeURIComponent(scope)}`).then(r => r.json());
    for (const note of data.notes || []) {
        if (!['Dropped private document', 'Retry attachments'].includes(note.label)) continue;
        for (const url of note.content.match(/\/api\/app\/note-attachments\/[^\s<>)]*/g) || []) await page.request.delete(url);
        await page.request.delete(`/api/app/spitball/notes/${note.id}?scope=${encodeURIComponent(scope)}`);
    }
    for (const file of ['drop-ok.txt', 'example.org-1.url', 'picker-file.txt']) {
        await page.request.delete(`/api/app/projects/${C.PROJECT_SLUG}/content/out/${file}?owner=${C.OWNER}`);
    }
});

test('Chat stages mixed files once and sends PDFs through document extraction', async ({ page }) => {
    await page.goto('/app/chat');
    let sent;
    await page.route('**/api/app/chat', route => {
        sent = route.request().postDataJSON();
        return route.fulfill({ contentType: 'text/event-stream', body: 'event: done\ndata: {}\n\n' });
    });
    await dropOn(page, '.study-main', { files: [image('photo.png'), { name: 'readme.md', text: '# My document' }, { name: 'paper.pdf', type: 'application/pdf', text: '%PDF-test' }], strings: { 'text/uri-list': 'https://example.org/duplicate.png' } });
    await expect(page.locator('.image-thumb')).toHaveCount(1);
    await expect(page.locator('.pending-file-chip')).toHaveCount(2);
    expect(sent).toBeUndefined();
    await expect(page.getByRole('textbox', { name: 'Message Goobster' })).toHaveValue('');
    await page.getByRole('textbox', { name: 'Message Goobster' }).fill('Read these');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => sent).toBeTruthy();
    expect(sent.images).toHaveLength(1);
    expect(sent.files).toEqual([{ name: 'readme.md', content: '# My document' }, { name: 'paper.pdf', contentBase64: Buffer.from('%PDF-test').toString('base64') }]);
});

test('Chat applies count limits to whole batches and shares them with the picker', async ({ page }) => {
    await page.goto('/app/chat');
    await page.locator('input[type=file]').setInputFiles({ name: 'one.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
    await expect(page.locator('.image-thumb')).toHaveCount(1);
    await dropOn(page, '.study-main', { files: [image('two.png'), image('three.png'), image('four.png'), image('five.png')] });
    await expect(page.locator('.image-thumb')).toHaveCount(4);
    await expect(page.locator('#toast')).toContainText('At most 4 images');
    await dropOn(page, '.study-main', { files: [{ name: 'archive.zip', type: 'application/zip', text: 'PK\0' }, { name: 'ok.txt', text: 'keep me' }] });
    await expect(page.locator('.pending-file-chip')).toHaveCount(1);
    await expect(page.locator('.pending-file-chip')).toContainText('ok.txt');
});

test('web links and blocked browser images stay links without rendering dragged HTML', async ({ page }) => {
    await page.goto('/app/chat');
    await page.route('https://images.example.test/**', route => route.abort());
    await dropOn(page, '.study-main', { strings: { 'text/uri-list': 'https://example.org/page', 'text/html': '<img src="https://images.example.test/photo.png" onerror="window.injected=true">' } });
    await expect(page.getByRole('textbox', { name: 'Message Goobster' })).toHaveValue('https://images.example.test/photo.png');
    await expect(page.locator('#toast')).toContainText('source link was kept');
    expect(await page.evaluate(() => window.injected)).toBeUndefined();
    await dropOn(page, '.study-main', { strings: { 'text/uri-list': '# comment\nhttps://example.org/a\nhttps://example.org/a\njavascript:alert(1)' } });
    await expect(page.getByRole('textbox', { name: 'Message Goobster' })).toHaveValue('https://images.example.test/photo.png\nhttps://example.org/a');
});

test('a public browser image becomes an image attachment', async ({ page }) => {
    await page.goto('/app/chat');
    await page.route('https://images.example.test/**', route => route.fulfill({ contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: Buffer.from(PNG, 'base64') }));
    await dropOn(page, '.study-main', { strings: { 'text/uri-list': 'https://images.example.test/photo.png', 'text/html': '<img src="https://images.example.test/photo.png" alt="Photo">' } });
    await expect(page.locator('.image-thumb img')).toHaveAttribute('alt', 'photo.png');
    await expect(page.getByRole('textbox', { name: 'Message Goobster' })).toHaveValue('');
});

test('plain text drags stay native and an unsupported file drop cannot navigate away', async ({ page }) => {
    await page.goto('/app/chat');
    const prevented = await page.getByRole('textbox', { name: 'Message Goobster' }).evaluate(el => {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData('text/plain', 'selected text');
        dataTransfer.setData('text/html', '<b>selected text</b>');
        return !el.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
    });
    expect(prevented).toBe(false);
    await dropOn(page, 'body', { files: [{ name: 'notes.txt', text: 'keep the app open' }] });
    await expect(page).toHaveURL(/\/app\/chat$/);
    await expect(page.locator('#toast')).toContainText('Drop attachments into');
    await dropOn(page, '.study-main', { files: [{ name: 'folder', text: '' }], directory: true });
    await expect(page.locator('#toast')).toContainText('Folders cannot be attached');
    await expect(page.locator('.pending-file-chip')).toHaveCount(0);
});

test('Notes stage, remove, save and reopen private files; nested targets do not create another draft', async ({ page }) => {
    await page.goto('/app/knowledge/notes');
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    let uploads = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/note-attachments?')) uploads++; });
    await dropOn(page, '.note-editor-modal textarea', { files: [{ name: 'report.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', text: 'opaque document' }, { name: 'remove.txt', text: 'removed' }] });
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveCount(1);
    await expect(dialog.locator('.pending-file-chip')).toHaveCount(2);
    expect(uploads).toBe(0);
    await dialog.getByRole('button', { name: 'Remove remove.txt' }).click();
    await dialog.getByLabel('Title', { exact: true }).fill('Dropped private document');
    await dialog.getByRole('button', { name: 'Add note', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(uploads).toBe(1);
    await page.reload();
    await page.locator('.notes-row-main').filter({ hasText: 'Dropped private document' }).click();
    await dialog.getByText('Open saved attachments').click();
    const link = dialog.getByRole('link', { name: 'report.docx' });
    await expect(link).toBeVisible();
    const url = await link.getAttribute('href');
    const response = await page.request.get(url);
    expect(response.ok()).toBe(true);
    expect(await response.text()).toBe('opaque document');
    expect(response.headers()['content-disposition']).toContain('attachment');
    await dropOn(page, '.note-editor-modal textarea', { files: [image('diagram.png')] });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(uploads).toBe(2);
});

test('a map drop opens a reviewable new note and Cancel saves nothing', async ({ page }) => {
    await page.goto('/app/knowledge/map');
    await expect(page.locator('.graph-stage')).toBeVisible();
    await dropOn(page, '.graph-wrap', { files: [{ name: 'Map attachment.txt', text: 'Map draft' }] });
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Map attachment.txt');
    await expect(dialog.locator('.pending-file-chip')).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const notes = await page.request.get(`/api/app/spitball/notes?scope=dm:${C.OWNER}`).then(r => r.json());
    expect(notes.notes.some(note => note.label === 'Map attachment.txt')).toBe(false);
});

test('project drops upload to the selected owner and folder, retaining successful files after a partial failure', async ({ page }) => {
    await page.goto(`/app/projects/${C.OWNER}/${C.PROJECT_SLUG}/files`);
    await page.getByRole('button', { name: '📁 out', exact: true }).click();
    await page.route('**/content/out/fail.txt*', route => route.fulfill({ status: 413, json: { error: { message: 'Upload too large', code: 'FILE_TOO_LARGE' } } }));
    await dropOn(page, '.obs-explorer', { files: [{ name: 'fail.txt', text: 'fail' }, { name: 'drop-ok.txt', text: 'correct folder' }] });
    await expect(page.getByRole('button', { name: /drop-ok.txt/ })).toBeVisible();
    const response = await page.request.get(`/api/app/projects/${C.PROJECT_SLUG}/content/out/drop-ok.txt?owner=${C.OWNER}`);
    expect(response.ok()).toBe(true);
    expect(await response.text()).toBe('correct folder');
    await dropOn(page, '.obs-explorer', { strings: { 'text/uri-list': 'https://example.org/research' } });
    await expect(page.getByRole('button', { name: /example.org-1.url/ })).toBeVisible();
    const shortcut = await page.request.get(`/api/app/projects/${C.PROJECT_SLUG}/content/out/example.org-1.url?owner=${C.OWNER}`);
    expect(await shortcut.text()).toContain('URL=https://example.org/research');
    await page.locator('.obs-explorer input[type=file]').setInputFiles({ name: 'picker-file.txt', mimeType: 'text/plain', buffer: Buffer.from('picker still works') });
    await expect(page.getByRole('button', { name: /picker-file.txt/ })).toBeVisible();
});

test('direct browser PDF links become document attachments when copying is allowed', async ({ page }) => {
    await page.goto('/app/chat');
    await page.route('https://docs.example.test/report.pdf', route => route.fulfill({ contentType: 'application/pdf', headers: { 'Access-Control-Allow-Origin': '*' }, body: '%PDF-public-document' }));
    await dropOn(page, '.study-main', { strings: { 'text/uri-list': 'https://docs.example.test/report.pdf' } });
    await expect(page.locator('.pending-file-chip')).toContainText('report.pdf');
    await expect(page.getByRole('textbox', { name: 'Message Goobster' })).toHaveValue('');
});

test('a failed note upload keeps the draft and retry reuses files already uploaded', async ({ page }) => {
    await page.goto('/app/knowledge/notes');
    await dropOn(page, '.mtab-notes', { files: [{ name: 'first.txt', text: 'first' }, { name: 'second.txt', text: 'second' }] });
    const dialog = page.getByRole('dialog');
    const requests = [];
    let failed = false;
    await page.route('**/api/app/note-attachments?*', route => {
        const name = new URL(route.request().url()).searchParams.get('name');
        requests.push(name);
        if (name === 'second.txt' && !failed) {
            failed = true;
            return route.fulfill({ status: 413, json: { error: { code: 'FILE_TOO_LARGE', message: 'Try this file again' } } });
        }
        return route.continue();
    });
    await dialog.getByLabel('Title', { exact: true }).fill('Retry attachments');
    await dialog.getByRole('button', { name: 'Add note', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('Try this file again');
    await expect(dialog.locator('.pending-file-chip')).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Add note', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(requests).toEqual(['first.txt', 'second.txt', 'second.txt']);
});

test('leaving a chat during a remote drop does not attach into the next screen', async ({ page }) => {
    await page.goto('/app/chat');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('https://images.example.test/delayed.png', async route => {
        await gate;
        await route.fulfill({ contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: Buffer.from(PNG, 'base64') }).catch(() => {});
    });
    const dataTransfer = await page.evaluateHandle(() => {
        const data = new DataTransfer();
        data.setData('text/uri-list', 'https://images.example.test/delayed.png');
        return data;
    });
    await page.locator('.study-main').dispatchEvent('drop', { dataTransfer });
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await page.getByRole('navigation', { name: 'Rooms' }).getByRole('link', { name: /Knowledge/ }).click();
    release();
    await expect(page.locator('[data-tour="knowledge-notes"]')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Rooms' }).getByRole('link', { name: /Chat/ }).click();
    await expect(page.locator('.image-thumb')).toHaveCount(0);
    await dataTransfer.dispose();
});


test('a remote Notes drop cannot replace an editor opened while the file was loading', async ({ page }) => {
    await page.goto('/app/knowledge/notes');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('https://docs.example.test/delayed.pdf', async route => {
        await gate;
        await route.fulfill({ contentType: 'application/pdf', headers: { 'Access-Control-Allow-Origin': '*' }, body: '%PDF-delayed' });
    });
    const dataTransfer = await page.evaluateHandle(() => {
        const data = new DataTransfer();
        data.setData('text/uri-list', 'https://docs.example.test/delayed.pdf');
        return data;
    });
    await page.locator('.mtab-notes').dispatchEvent('drop', { dataTransfer });
    await expect(page.locator('.attachment-drop-indicator')).toBeVisible();
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Keep this draft');
    release();
    await expect(page.locator('#toast')).toContainText('destination changed');
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Keep this draft');
    await expect(page.locator('.pending-file-chip')).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dataTransfer.dispose();
});
