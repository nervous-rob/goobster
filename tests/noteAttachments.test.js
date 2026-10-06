const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-note-files-'));
process.env.GOOBSTER_UPLOADS_DIR = ROOT;
process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'test.sqlite');
const files = require('@goobster/core/utils/noteAttachments');
const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');
const U = '800000000000000081', V = '800000000000000082';
let server, base, cookie, other;
async function login(userId) {
    const res = await fetch(`${base}/api/app/auth/dev-session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, name: 'Files tester' }) });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie').split(';')[0];
}
async function upload(name, body, headers = {}) {
    return fetch(`${base}/api/app/note-attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', ...headers }, body });
}
beforeAll(async () => {
    const app = express();
    app.use(createWebAppApp(createWebAppContext({ config: { webapp: { enabled: true, devMode: true } }, logger: { error() {}, warn() {}, info() {} } })));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    cookie = await login(U); other = await login(V);
});
afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await require('@goobster/core/db').closeConnection();
    fs.rmSync(ROOT, { recursive: true, force: true });
});
test('upload, read and delete are owner-bound; query owner cannot grant access', async () => {
    const res = await upload('file.pdf', Buffer.from('%PDF-file'));
    expect(res.status).toBe(200);
    const { url } = await res.json();
    const own = await fetch(base + url, { headers: { Cookie: cookie } });
    expect(own.status).toBe(200); expect(await own.text()).toBe('%PDF-file');
    expect(own.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''file.pdf");
    expect(own.headers.get('cache-control')).toBe('private, no-store');
    expect((await fetch(base + url)).status).toBe(401);
    expect((await fetch(`${base}${url}?owner=${U}`, { headers: { Cookie: other } })).status).toBe(404);
    await fetch(base + url, { method: 'DELETE', headers: { Cookie: other } });
    expect((await fetch(base + url, { headers: { Cookie: cookie } })).status).toBe(200);
    await fetch(base + url, { method: 'DELETE', headers: { Cookie: cookie } });
    expect((await fetch(base + url, { headers: { Cookie: cookie } })).status).toBe(404);
});
test('authentication, account binding, CSRF, body type and size are enforced before storage', async () => {
    expect((await upload('a', 'a', { Cookie: '' })).status).toBe(401);
    expect((await upload('a', 'a', { 'X-Goobster-Account': V })).status).toBe(409);
    expect((await upload('a', 'a', { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await upload('a', '{}', { 'Content-Type': 'application/json' })).status).toBe(400);
    expect((await upload('big.bin', Buffer.alloc(files.MAX_BYTES + 1))).status).toBe(413);
});
test('filenames cannot traverse; active content downloads without execution', async () => {
    for (const name of ['../../payload.html', 'evil.svg']) {
        const res = await upload(name, '<script>alert(1)</script>');
        const data = await res.json();
        expect(data.name).not.toMatch(/[\\/]/);
        const read = await fetch(base + data.url, { headers: { Cookie: cookie } });
        expect(read.headers.get('content-disposition')).toContain('attachment');
        expect(read.headers.get('content-type')).toContain('text/plain');
        expect(read.headers.get('x-content-type-options')).toBe('nosniff');
        expect(read.headers.get('content-security-policy')).toContain('sandbox');
    }
    expect(files.locate(U, '../test.sqlite')).toBeNull();
    expect(() => files.save('../escape', 'a', Buffer.from('x'))).toThrow('Invalid account');
});
test('files are durable beyond chat registry expiry and account erasure removes them', async () => {
    const saved = files.save(U, 'retained.txt', Buffer.from('retained'));
    files.save(U, 'second.txt', Buffer.from('another retained file'));
    const filename = decodeURIComponent(saved.url.split('/').pop());
    const file = files.locate(U, filename);
    fs.utimesSync(file, new Date(0), new Date(0));
    expect((await fetch(base + saved.url, { headers: { Cookie: cookie } })).status).toBe(200);
    const uploads = require('@goobster/core/utils/webUploads');
    const count = uploads.countUserUploads(U);
    expect(count).toBeGreaterThan(1);
    expect(uploads.deleteUserUploads(U)).toBe(count);
    expect(uploads.countUserUploads(U)).toBe(0);
    expect(files.locate(U, filename)).toBeNull();
});
