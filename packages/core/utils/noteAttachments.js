/** Durable, owner-only note files. Covered by upload backup and account erasure. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { userUploadDir } = require('./webUploads');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

function fail(status, code, message) { return Object.assign(new Error(message), { status, code }); }
function directory(userId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(userId))) throw fail(400, 'BAD_USER', 'Invalid account.');
    return path.join(userUploadDir(userId), 'note-attachments');
}
function cleanName(name) {
    let clean = String(name || 'attachment').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '_').slice(0, 100) || 'attachment';
    while (Buffer.byteLength(clean) > 160) clean = clean.slice(0, -1);
    return clean;
}
function save(userId, name, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw fail(413, 'FILE_TOO_LARGE', 'Attachments must be 8 MB or smaller.');
    const dir = directory(userId);
    fs.mkdirSync(dir, { recursive: true });
    const entries = fs.readdirSync(dir);
    const size = entries.reduce((total, file) => total + fs.statSync(path.join(dir, file)).size, 0);
    if (entries.length >= 1000 || size + bytes.length > MAX_TOTAL_BYTES) throw fail(413, 'ATTACHMENT_QUOTA', 'Your note attachment storage is full (256 MB or 1,000 files).');
    const filename = `${crypto.randomBytes(16).toString('hex')}-${cleanName(name)}`;
    fs.writeFileSync(path.join(dir, filename), bytes, { flag: 'wx' });
    return { url: `/api/app/note-attachments/${encodeURIComponent(filename)}`, name: cleanName(name) };
}
function locate(userId, filename) {
    if (!/^[0-9a-f]{32}-[^/\\]+$/.test(String(filename)) || path.basename(filename) !== filename) return null;
    const file = path.join(directory(userId), filename);
    return fs.existsSync(file) ? file : null;
}
function remove(userId, filename) {
    const file = locate(userId, filename);
    if (file) fs.rmSync(file, { force: true });
}
function references(content) {
    const urls = String(content || '').match(/\/api\/app\/note-attachments\/[0-9a-f]{32}-[^\s<>)]*/g) || [];
    return [...new Set(urls)].flatMap(url => {
        try { return [{ url, filename: decodeURIComponent(url.split('/').pop()) }]; }
        catch { return []; }
    });
}
module.exports = { MAX_BYTES, save, locate, remove, references };
