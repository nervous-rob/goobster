/** Durable, provider-free account export jobs. One worker, bounded private archives. */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const db = require('../db');
const { dataDir } = require('../runtimePaths');
const { snapshot } = require('./accountExportData');
const { buildArchive, safeOpen } = require('../utils/accountExportArchive');
const ROOT = path.join(dataDir, 'account-exports');
const DAY = 24 * 3600_000, LEASE = 90_000;
const utc = value => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
const MESSAGES = {
    EXPORT_LIMIT: 'The account exceeds the export size or record limit. Contact the host before retrying.',
    EXPORT_CHANGED: 'A file changed while being copied. Wait for active work to finish, then try again.',
    EXPORT_INTERRUPTED: 'Export interrupted. Create another export to retry.',
    EXPORT_FAILED: 'Export could not be completed. Contact the host or try again later.'
};
class ExportError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
class AccountExportService {
    constructor({ root = ROOT, now = Date.now, collect = snapshot, build = buildArchive,
        settings = userId => require('./userSettingsService').exportUserData({ userId }), autoKick = true, limits = {} } = {}) {
        Object.assign(this, { root, now, collect, build, settings, autoKick, limits });
        this.pending = null; this.timer = null; this.controller = null; this.stopped = false;
    }
    ownerDir(userId) { return path.join(this.root, createHash('sha256').update(String(userId)).digest('hex')); }
    directory(row) {
        if (!/^[a-f0-9-]{36}$/.test(row.id)) throw new ExportError(404, 'NOT_FOUND', 'Export not found.');
        return path.join(this.ownerDir(row.userId), row.id);
    }
    present(row) {
        const { id, status, createdAt, finishedAt, expiresAt, sizeBytes, fileCount, warningCount, errorCode } = row;
        return { id, status: expiresAt <= utc(this.now()) ? 'EXPIRED' : status, createdAt, finishedAt, expiresAt,
            sizeBytes, fileCount, warningCount, error: MESSAGES[errorCode] || null,
            downloadUrl: status === 'READY' && expiresAt > utc(this.now()) ? `/api/app/settings/exports/${id}/download` : null };
    }
    async list(userId) {
        return { exports: (await db.all('SELECT * FROM account_exports WHERE userId = @userId ORDER BY createdAt DESC, id DESC LIMIT 5', { userId })).map(r => this.present(r)) };
    }
    async request(userId) {
        if (!require('./identityService').isPrincipalId(userId)) throw new ExportError(400, 'BAD_USER', 'Invalid account.');
        const row = await db.transaction(async () => {
            const resource = `account_export:${userId}`;
            await db.run('INSERT INTO admission_locks (resource) VALUES (@resource) ON CONFLICT (resource) DO NOTHING', { resource });
            await db.run('UPDATE admission_locks SET resource = resource WHERE resource = @resource', { resource });
            const active = await db.get("SELECT * FROM account_exports WHERE userId = @userId AND status IN ('QUEUED', 'RUNNING')", { userId });
            if (active) return active;
            const recent = await db.get('SELECT id FROM account_exports WHERE userId = @userId AND createdAt > @cutoff', { userId, cutoff: utc(this.now() - 60_000) });
            if (recent) throw new ExportError(429, 'EXPORT_RATE_LIMIT', 'Wait one minute before requesting another export.');
            const available = await db.get("SELECT COUNT(*) AS n FROM account_exports WHERE userId = @userId AND status = 'READY' AND expiresAt > @now", { userId, now: utc(this.now()) });
            if (available.n >= 2) throw new ExportError(409, 'EXPORT_LIMIT', 'Delete an existing archive before creating another.');
            const id = randomUUID();
            await db.run('INSERT INTO account_exports (id, userId, createdAt, expiresAt) VALUES (@id, @userId, @now, @expires)', { id, userId, now: utc(this.now()), expires: utc(this.now() + DAY) });
            return db.get('SELECT * FROM account_exports WHERE id = @id', { id });
        });
        if (this.autoKick) this.kick();
        return this.present(row);
    }
    async remove(userId, id) {
        const row = await db.get('SELECT * FROM account_exports WHERE id = @id AND userId = @userId', { id, userId });
        if (!row) throw new ExportError(404, 'NOT_FOUND', 'Export not found.');
        await db.run('DELETE FROM account_exports WHERE id = @id AND userId = @userId', { id, userId });
        await fsp.rm(this.directory(row), { recursive: true, force: true });
        return { ok: true };
    }
    async forgetUser(userId) {
        const result = await db.run('DELETE FROM account_exports WHERE userId = @userId', { userId });
        await fsp.rm(this.ownerDir(userId), { recursive: true, force: true });
        await db.run('DELETE FROM admission_locks WHERE resource = @resource', { resource: `account_export:${userId}` });
        return result.changes;
    }
    async download(userId, id) {
        const row = await db.get("SELECT * FROM account_exports WHERE id = @id AND userId = @userId AND status = 'READY' AND expiresAt > @now", { id, userId, now: utc(this.now()) });
        if (!row) throw new ExportError(404, 'NOT_FOUND', 'Export is unavailable or expired.');
        try {
            const { handle, stat } = await safeOpen(this.root, path.join(this.directory(row), 'account.tar.gz'));
            return { handle, size: stat.size, name: `goobster-account-${row.createdAt.slice(0, 10)}.tar.gz` };
        } catch { throw new ExportError(410, 'EXPORT_MISSING', 'The archive file is unavailable. Create another export.'); }
    }
    async cleanup() {
        const expired = await db.all("SELECT * FROM account_exports WHERE (status != 'EXPIRED' AND expiresAt <= @now) OR (status = 'RUNNING' AND leaseUntil <= @now)", { now: utc(this.now()) });
        for (const row of expired) {
            const status = row.expiresAt <= utc(this.now()) ? 'EXPIRED' : 'FAILED';
            const changed = await db.run(`UPDATE account_exports SET status = @status, claimToken = NULL, leaseUntil = NULL,
                errorCode = 'EXPORT_INTERRUPTED' WHERE id = @id AND (expiresAt <= @now OR (status = 'RUNNING' AND leaseUntil <= @now))`, { id: row.id, status, now: utc(this.now()) });
            if (changed.changes) await fsp.rm(this.directory(row), { recursive: true, force: true });
        }
        await db.run("DELETE FROM account_exports WHERE status IN ('FAILED', 'EXPIRED') AND createdAt < @cutoff", { cutoff: utc(this.now() - 7 * DAY) });
        // Orphan folders can remain after a crash between file publication and DB commit.
        for (const owner of await fsp.readdir(this.root, { withFileTypes: true }).catch(() => [])) {
            if (!owner.isDirectory() || !/^[a-f0-9]{64}$/.test(owner.name)) continue;
            for (const entry of await fsp.readdir(path.join(this.root, owner.name), { withFileTypes: true })) {
                if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
                const exists = await db.get('SELECT id FROM account_exports WHERE id = @id', { id: entry.name });
                if (!exists) await fsp.rm(path.join(this.root, owner.name, entry.name), { recursive: true, force: true });
            }
        }
    }
    async run(row) {
        const token = randomUUID();
        const claimed = await db.run("UPDATE account_exports SET status = 'RUNNING', claimToken = @token, leaseUntil = @until WHERE id = @id AND status = 'QUEUED' AND expiresAt > @now", { id: row.id, token, now: utc(this.now()), until: utc(this.now() + LEASE) });
        if (!claimed.changes) return;
        const controller = new AbortController(); this.controller = controller;
        const directory = this.directory(row), temporary = path.join(directory, `${token}.part`), final = path.join(directory, 'account.tar.gz');
        const heartbeat = setInterval(() => {
            db.run("UPDATE account_exports SET leaseUntil = @until WHERE id = @id AND claimToken = @token AND status = 'RUNNING'", { id: row.id, token, until: utc(this.now() + LEASE) })
                .then(r => { if (!r.changes) controller.abort(); }).catch(() => controller.abort());
        }, 10000); heartbeat.unref?.();
        const deadline = setTimeout(() => controller.abort(), 15 * 60_000); deadline.unref?.();
        try {
            const data = await this.collect(row.userId, this.limits);
            const settings = await this.settings(row.userId);
            controller.signal.throwIfAborted();
            if (!await db.get('SELECT id FROM account_exports WHERE id = @id AND claimToken = @token', { id: row.id, token })) return;
            await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
            const result = await this.build({ userId: row.userId, data, settings, destination: temporary, signal: controller.signal, limits: this.limits });
            controller.signal.throwIfAborted();
            await fsp.rename(temporary, final);
            const stat = await fsp.stat(final);
            const published = await db.transaction(async () => {
                const changed = await db.run(`UPDATE account_exports SET status = 'READY', claimToken = NULL, leaseUntil = NULL,
                    finishedAt = @now, sizeBytes = @size, fileCount = @files, warningCount = @warnings
                    WHERE id = @id AND claimToken = @token AND status = 'RUNNING' AND expiresAt > @now`,
                { id: row.id, token, now: utc(this.now()), size: stat.size, files: result.fileCount, warnings: result.warningCount });
                if (!changed.changes) return false;
                await require('./inboxService').deliver({ userId: row.userId, kind: 'system', title: 'Your account export is ready',
                    body: `Download your private account archive from Settings → Memory & privacy. It expires at ${row.expiresAt} UTC.${result.warningCount ? ' Some files were unavailable; see the archive manifest.' : ''}`,
                    source: { type: 'account_export', id: row.id }, link: '/settings/memory', dedupeKey: `account_export:${row.id}` });
                return true;
            });
            if (!published) await fsp.rm(directory, { recursive: true, force: true });
        } catch (error) {
            const code = MESSAGES[error.code] ? error.code : controller.signal.aborted ? 'EXPORT_INTERRUPTED' : 'EXPORT_FAILED';
            await db.transaction(async () => {
                const changed = await db.run("UPDATE account_exports SET status = 'FAILED', errorCode = @code, claimToken = NULL, leaseUntil = NULL, finishedAt = @now WHERE id = @id AND claimToken = @token", { id: row.id, token, code, now: utc(this.now()) });
                if (changed.changes) await require('./inboxService').deliver({ userId: row.userId, kind: 'system', title: 'Account export could not finish',
                    body: MESSAGES[code], source: { type: 'account_export', id: row.id }, link: '/settings/memory', dedupeKey: `account_export:${row.id}` });
            });
            await fsp.rm(directory, { recursive: true, force: true });
        } finally { clearInterval(heartbeat); clearTimeout(deadline); this.controller = null; }
    }
    async sweep() {
        if (this.pending) return this.pending;
        this.pending = db.withSingletonLock('account_exports', async () => {
            await this.cleanup();
            const row = await db.get("SELECT * FROM account_exports WHERE status = 'QUEUED' ORDER BY createdAt, id LIMIT 1");
            if (row) await this.run(row);
        }).finally(() => { this.pending = null; });
        return this.pending;
    }
    kick() { setImmediate(() => { if (!this.stopped) this.sweep().catch(() => require('../utils/logger').warn('[account export] Worker could not complete its pass.')); }); }
    start() { if (this.timer) return; this.stopped = false; this.timer = setInterval(() => this.kick(), 10000); this.timer.unref?.(); this.kick(); }
    async stop() { this.stopped = true; clearInterval(this.timer); this.timer = null; this.controller?.abort(); await this.pending; }
}
module.exports = new AccountExportService();
module.exports.AccountExportService = AccountExportService;
module.exports.MESSAGES = MESSAGES;
