const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
const C = require('./constants');

function wav() {
    const data = Buffer.alloc(44 + 1600);
    data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
    data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
    data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
    data.write('data', 36); data.writeUInt32LE(1600, 40);
    return data;
}

test('Music Lab voices and IndexedDB samples follow the account; unowned legacy data stays separate', async ({ page }) => {
    await login(page);
    await page.evaluate(() => localStorage.setItem('goobster.conservatory.customVoices', JSON.stringify([{ id: 'legacy-private', name: 'Unowned private voice' }])));
    await page.goto('/app/conservatory/melody');
    await expect(page.getByRole('heading', { name: 'Voice Builder' })).toBeVisible();
    await page.getByRole('button', { name: 'Sample clip', exact: true }).click();
    await page.getByLabel('Voice name', { exact: true }).fill('Alice private clip');
    await page.locator('input[type=file].vb-file-input').setInputFiles({ name: 'private.wav', mimeType: 'audio/wav', buffer: wav() });
    await page.getByRole('button', { name: 'Save sample voice', exact: true }).click();
    await expect(page.locator('.vb-panel strong').filter({ hasText: 'Alice private clip' })).toBeVisible();
    await expect(page.getByText('Unowned private voice', { exact: true })).toHaveCount(0);
    const before = await page.evaluate(async () => (await globalThis.indexedDB.databases()).map(db => db.name));
    expect(before.some(name => name.includes(C.OWNER) && name.endsWith('conservatory.samples'))).toBe(true);

    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await login(page, { userId: C.NATIVE_MEMBER, name: C.NATIVE_MEMBER_NAME });
    await page.goto('/app/conservatory/melody');
    await expect(page.getByRole('heading', { name: 'Voice Builder' })).toBeVisible();
    await expect(page.getByText('Your voices (0)', { exact: true })).toBeVisible();
    await expect(page.locator('.vb-panel strong').filter({ hasText: 'Alice private clip' })).toHaveCount(0);
    await expect(page.getByText('Recover older Music Lab data on this device', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sample clip', exact: true }).click();
    await page.getByLabel('Voice name', { exact: true }).fill('Bob private clip');
    await page.locator('input[type=file].vb-file-input').setInputFiles({ name: 'bob.wav', mimeType: 'audio/wav', buffer: wav() });
    await page.getByRole('button', { name: 'Save sample voice', exact: true }).click();
    await expect(page.locator('.vb-panel strong').filter({ hasText: 'Bob private clip' })).toBeVisible();
    const after = await page.evaluate(async () => (await globalThis.indexedDB.databases()).map(db => db.name));
    expect(after.some(name => name.includes(C.NATIVE_MEMBER) && name.endsWith('conservatory.samples'))).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('goobster.conservatory.customVoices'))).toContain('Unowned private voice');

    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await login(page);
    await page.goto('/app/conservatory/melody');
    await expect(page.locator('.vb-panel strong').filter({ hasText: 'Alice private clip' })).toBeVisible();
    await expect(page.locator('.vb-panel strong').filter({ hasText: 'Bob private clip' })).toHaveCount(0);
});

test('another tab signs out immediately and a late previous-account response cannot repopulate it', async ({ page, context }) => {
    await login(page);
    const second = await context.newPage();
    await second.goto('/app/');
    await expect(second.getByRole('heading', { name: new RegExp(C.OWNER_NAME) })).toBeVisible();
    let captured;
    const arrived = new Promise(resolve => { captured = resolve; });
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    let first = true;
    await page.route('**/api/app/chat/conversations', async route => {
        if (!first || route.request().method() !== 'GET') { await route.continue(); return; }
        first = false;
        const response = await route.fetch();
        captured();
        await wait;
        try { await route.fulfill({ response }); } catch { /* the old account request was aborted */ }
    });
    await page.getByRole('navigation', { name: 'Rooms' }).getByRole('link', { name: /Chat/ }).click();
    await arrived;
    await second.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page.getByText('Dev mode — mint a local identity')).toBeVisible();
    await login(second, { userId: C.NATIVE_MEMBER, name: C.NATIVE_MEMBER_NAME });
    release();
    await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
    await expect(page.getByText(C.CHAT_TITLE, { exact: true })).toHaveCount(0);
    await expect(page.locator('.chat-msg')).toHaveCount(0);
    await second.close();
});

test('a note conflict keeps the local draft and shows the current saved note for comparison', async ({ page }) => {
    await login(page);
    const created = await page.request.post('/api/app/spitball/notes', { data: { scope: `dm:${C.OWNER}`, label: 'Concurrent note fixture', content: 'Before editing' } });
    expect(created.ok()).toBe(true);
    const { note } = await created.json();
    await page.goto('/app/knowledge/notes');
    const card = page.locator('.notes-row').filter({ hasText: 'Concurrent note fixture' }).first();
    await card.locator('.notes-row-main').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#note-content').fill('My unsaved draft');
    const changed = await page.request.patch(`/api/app/spitball/notes/${note.id}`, { data: {
        scope: `dm:${C.OWNER}`, expectedRevision: note.revision, content: 'Saved in another tab'
    } });
    expect(changed.ok()).toBe(true);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.locator('#note-content')).toHaveValue('My unsaved draft');
    await expect(dialog.getByText('Saved in another tab', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'I have compared and merged my changes' }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
});
