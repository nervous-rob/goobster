/**
 * Operator-approved sandbox requests: the two ways the model may ask for
 * something that mutates the HOST rather than a sandboxed run.
 *
 *   - package-install: "I need emcee" -> pip resolves a pinned, hash-locked
 *     set (dry run, wheels only, nothing executes), an approver sees exactly
 *     that set, and approval installs exactly that set into the overlay at
 *     data/sandbox/overlay (--require-hashes --no-deps). The curated venv is
 *     never touched; runs see the overlay via PYTHONPATH.
 *   - data-fetch: "download this catalog into the project" -> the URL is
 *     legalized by utils/safeFetch (https-only, DNS pinned, no redirects,
 *     byte-capped) and lands in the Observatory workspace's data/ directory.
 *     Hosts on sandbox.fetchAllowedHosts have standing consent and fetch
 *     immediately; anything else becomes a pending request.
 *
 * The trust boundary is the usual one - the model only ever proposes; THIS
 * service legalizes, and a human confirms anything without standing consent.
 * Approvers are the operator-configured sandbox.approverUserIds - these are
 * host-level mutations shared by every guild the bot serves, so Manage
 * Server is deliberately NOT sufficient, and with no approvers configured
 * the request features simply stay off.
 *
 * Requests live in SQLite (sandbox_requests) so a pending approval survives
 * a restart, and resolved rows double as the audit trail. Approvers get the
 * Confirm/Cancel buttons by DM (a request can originate in any guild, DM,
 * or the web portal - there is no shared channel to post to).
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const db = require('../db');
const logger = require('../utils/logger');
const { toGateway } = require('../gateway');
const sandboxConfig = require('../config/sandboxConfig');
const sandboxPackages = require('../config/sandboxPackages');
const store = require('./sandboxPackagesStore');
const safeFetch = require('../utils/safeFetch');

// Approvals go out by DM to humans who may be asleep; a 15-minute TTL would
// make the feature unusable. Half a day balances that against staleness.
const PENDING_TTL_MINUTES = 12 * 60;

const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_PACKAGES_PER_REQUEST = 8;

const PYPI_INDEX = 'https://pypi.org/simple';
const DRY_RUN_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

// One spec the model may propose: name, optional exact version pin,
// optional import name when it differs (emcee / pyyaml==6.0.3 / pyyaml:yaml).
const SPEC_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:==([0-9][A-Za-z0-9.+!-]{0,31}))?(?::([A-Za-z_][A-Za-z0-9_]{0,63}))?$/;

const FETCH_FILENAME_PATTERN = /[^A-Za-z0-9._-]+/g;

/** Machine-readable failure (the PanelError contract: status + code). */
class SandboxRequestError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'SandboxRequestError';
        this.status = status;
        this.code = code;
    }
}

class SandboxRequestService {
    /**
     * @param {object} [config] - sandboxConfig-shaped (tests inject their own)
     * @param {object} [deps] - injectable seams, all defaulted to the real thing:
     *   runPip(args, timeoutMs) -> {code, stdout, stderr},
     *   lookup (dns), transport (https), fetchToFile
     */
    constructor(config = sandboxConfig, deps = {}) {
        this.config = config;
        this._runPip = deps.runPip || ((args, timeoutMs) => this._spawnPip(args, timeoutMs));
        this._lookup = deps.lookup || undefined;
        this._transport = deps.transport || undefined;
        this._fetchToFile = deps.fetchToFile || safeFetch.fetchToFile;
        this._observatory = deps.observatory || null;
        /** @type {Map<string, number[]>} userId -> recent request timestamps */
        this._recent = new Map();
    }

    /** Lazy to avoid a require cycle (observatory -> sandbox -> here). */
    _getObservatory() {
        return this._observatory || require('./observatoryService');
    }

    /** Approvers for host-level mutations (operator-configured user ids). */
    get approvers() {
        return this.config.approverUserIds || [];
    }

    /** Sliding-window per-user rate limit shared by both request kinds. */
    _checkRateLimit(userId) {
        const max = this.config.maxFetchRequestsPerHour ?? 10;
        const now = Date.now();
        const stamps = (this._recent.get(userId) || []).filter(t => now - t < RATE_WINDOW_MS);
        if (stamps.length >= max) {
            throw new SandboxRequestError(429, 'RATE_LIMITED',
                `Too many sandbox requests - wait a while (max ${max} per hour).`);
        }
        stamps.push(now);
        this._recent.set(userId, stamps);
    }

    async _checkPendingCap(userId) {
        const max = this.config.maxPendingRequestsPerUser ?? 5;
        const pending = await db.get(
            `SELECT COUNT(*) AS c FROM sandbox_requests
             WHERE userId = @userId AND status = 'PENDING'
               AND createdAt > datetime('now', '-${PENDING_TTL_MINUTES} minutes')`,
            { userId }
        );
        if ((pending?.c || 0) >= max) {
            throw new SandboxRequestError(429, 'TOO_MANY_PENDING',
                `Too many requests are already waiting for approval - let those resolve first (max ${max}).`);
        }
    }

    // --- Package installs -----------------------------------------------------

    /**
     * Propose a package install. Resolves the full pinned set via a pip dry
     * run (nothing downloads or executes), stores it, and asks the approvers.
     * @param {{userId:string, packages:string[], reason?:string, client?:object}} params
     * @returns {Promise<string>} a model-readable outcome line
     */
    async requestPackages({ userId, packages, reason = '', client = null }) {
        if (this.approvers.length === 0) {
            return '❌ Package requests are not enabled on this server - the operator has not '
                + 'configured any sandbox.approverUserIds. They can also install packages directly '
                + 'with `npm run sandbox-python` (see sandbox.extraPythonPackages).';
        }
        await this._checkPendingCap(userId);
        this._checkRateLimit(userId);

        const specs = this._parseSpecs(packages);
        const catalogPackages = sandboxPackages.packagesFor(sandboxPackages.bundleNames());
        const already = [];
        for (const spec of specs) {
            if ((await store.has(spec.pip)) || catalogPackages.some(pkg => pkg.pip === spec.pip)) {
                already.push(spec);
            }
        }
        if (already.length === specs.length) {
            return `✅ Nothing to request - already available: ${already.map(s => s.pip).join(', ')}. `
                + 'If an import still fails, the import name may differ from the pip name.';
        }
        const wanted = specs.filter(spec => !already.includes(spec));

        const resolved = await this._dryRunResolve(wanted);
        await this._attachWheelSizes(resolved);
        const totalBytes = resolved.reduce((sum, pkg) => sum + (pkg.sizeBytes || 0), 0);
        const sizesKnown = resolved.every(pkg => Number.isFinite(pkg.sizeBytes));

        const overlayMb = this._overlaySizeMb();
        const projectedMb = overlayMb + totalBytes / (1024 * 1024);
        if (projectedMb > this.config.maxOverlayMb) {
            return `❌ That install would put the package overlay over its ${this.config.maxOverlayMb} MB `
                + `budget (currently ${overlayMb.toFixed(1)} MB, this set adds ~${(totalBytes / (1024 * 1024)).toFixed(1)} MB). `
                + 'Ask for less, or ask the operator to raise sandbox.maxOverlayMb.';
        }

        const payload = { specs: wanted, reason: String(reason || '').slice(0, 500), resolved, totalBytes };
        const id = await this._createRequest({ type: 'package-install', userId, payload });
        const delivered = await this._dmApprovers(client, id, this._packageEmbed(id, userId, payload));

        const setLine = resolved.map(pkg => `${pkg.name}==${pkg.version}`).join(', ');
        const lines = [
            `🟡 Proposed package install #${id}: ${setLine} `
            + `(${resolved.length} distribution(s), ${sizesKnown ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB` : 'size partly unknown'}, `
            + 'wheels only, hash-pinned).'
        ];
        if (already.length > 0) lines.push(`Already available, not re-requested: ${already.map(s => s.pip).join(', ')}.`);
        lines.push(delivered > 0
            ? `An approver has been asked by DM (${delivered} reached) - I'll be able to import it once they confirm. `
            + 'Tell the user it is waiting for approval.'
            : '⚠️ No approver could be reached by DM right now - the request stays pending '
            + `(${PENDING_TTL_MINUTES / 60}h) in case they check in.`);
        return lines.join('\n');
    }

    /** Legalize the model-proposed spec strings. Throws on anything dubious. */
    _parseSpecs(packages) {
        const raw = Array.isArray(packages) ? packages : [packages];
        const seen = new Set();
        const specs = [];
        for (const entry of raw.map(v => String(v ?? '').trim()).filter(Boolean)) {
            const match = SPEC_PATTERN.exec(entry);
            if (!match) {
                throw new SandboxRequestError(400, 'BAD_SPEC',
                    `"${entry}" is not a plain package spec - use name, name==1.2.3, or name:import_name.`);
            }
            const pip = match[1].toLowerCase();
            if (seen.has(pip)) continue;
            seen.add(pip);
            specs.push({
                pip,
                version: match[2] || null,
                module: (match[3] || pip).replace(/-/g, '_')
            });
        }
        if (specs.length === 0) {
            throw new SandboxRequestError(400, 'NO_PACKAGES', 'Name at least one package.');
        }
        if (specs.length > MAX_PACKAGES_PER_REQUEST) {
            throw new SandboxRequestError(400, 'TOO_MANY_PACKAGES',
                `At most ${MAX_PACKAGES_PER_REQUEST} packages per request.`);
        }
        return specs;
    }

    /**
     * Resolve the full transitive set without downloading or executing
     * anything: pip --dry-run --only-binary=:all: --report. The report is
     * the contract - approval installs exactly what it names.
     * @returns {Promise<Array<{name:string, version:string, url:string, sha256:string, requested:boolean, module:string|null}>>}
     */
    async _dryRunResolve(specs) {
        const reportPath = path.join(os.tmpdir(), `goobster-pip-report-${crypto.randomBytes(6).toString('hex')}.json`);
        const args = [
            'install', '--dry-run', '--only-binary=:all:', '--isolated', '--no-input',
            '--disable-pip-version-check', '--quiet', '--index-url', PYPI_INDEX,
            '--report', reportPath,
            ...specs.map(spec => spec.version ? `${spec.pip}==${spec.version}` : spec.pip)
        ];
        try {
            const result = await this._runPip(args, DRY_RUN_TIMEOUT_MS);
            if (result.code !== 0) {
                const tail = String(result.stderr || result.stdout || '').trim().split('\n').slice(-4).join(' ');
                throw new SandboxRequestError(422, 'RESOLVE_FAILED',
                    `pip could not resolve that set (wheels-only, PyPI): ${tail.slice(0, 400)}`);
            }
            let report;
            try {
                report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
            } catch {
                throw new SandboxRequestError(500, 'REPORT_UNREADABLE', 'pip produced no readable resolution report.');
            }
            const byName = new Map(specs.map(spec => [spec.pip.replace(/[-_.]+/g, '-'), spec]));
            const resolved = [];
            for (const item of report.install || []) {
                const name = String(item?.metadata?.name || '').toLowerCase();
                const version = String(item?.metadata?.version || '');
                const url = String(item?.download_info?.url || '');
                const archive = item?.download_info?.archive_info || {};
                const sha256 = archive?.hashes?.sha256
                    || (String(archive?.hash || '').startsWith('sha256=') ? String(archive.hash).slice(7) : null);
                if (!name || !version || !sha256) {
                    throw new SandboxRequestError(500, 'REPORT_INCOMPLETE',
                        `The resolution report lacks a pinned hash for ${name || 'a package'} - refusing.`);
                }
                const spec = byName.get(name.replace(/[-_.]+/g, '-'));
                resolved.push({ name, version, url, sha256, requested: Boolean(spec), module: spec?.module || null });
            }
            if (resolved.length === 0) {
                throw new SandboxRequestError(422, 'NOTHING_TO_INSTALL',
                    'Everything in that set is already installed in the sandbox toolkit.');
            }
            return resolved;
        } finally {
            try { fs.rmSync(reportPath, { force: true }); } catch { /* best effort */ }
        }
    }

    /** Best-effort wheel sizes via HEAD to the (fixed, trusted) PyPI file host. */
    async _attachWheelSizes(resolved) {
        await Promise.all(resolved.map(async (pkg) => {
            try {
                const assessed = safeFetch.assessUrl(pkg.url);
                const pinned = await safeFetch.resolvePinned(assessed.host, { lookup: this._lookup });
                pkg.sizeBytes = await this._headContentLength(assessed.url, pinned.address);
            } catch {
                pkg.sizeBytes = null; // unknown is fine - shown as such
            }
        }));
    }

    _headContentLength(url, address) {
        const https = this._transport || require('node:https');
        return new Promise((resolve) => {
            const request = https.request({
                host: address,
                servername: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method: 'HEAD',
                headers: { Host: url.hostname },
                timeout: 10_000
            }, (response) => {
                response.resume();
                const length = Number(response.headers['content-length']);
                resolve(Number.isFinite(length) && length > 0 ? length : null);
            });
            request.on('error', () => resolve(null));
            request.on('timeout', () => { request.destroy(); resolve(null); });
            request.end();
        });
    }

    _overlaySizeMb() {
        let bytes = 0;
        const walk = (dir) => {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.isFile()) {
                    try { bytes += fs.statSync(full).size; } catch { /* raced away */ }
                }
            }
        };
        walk(this.config.overlayDir);
        return bytes / (1024 * 1024);
    }

    /**
     * The approved install: exactly the stored resolution, nothing else.
     * --require-hashes + --no-deps means pip may not resolve, substitute, or
     * add anything beyond what the approver saw.
     */
    async _executeInstall(pending, approvedBy) {
        const { resolved } = pending.payload;
        const requirements = resolved
            .map(pkg => `${pkg.name}==${pkg.version} --hash=sha256:${pkg.sha256}`)
            .join('\n') + '\n';
        const reqPath = path.join(os.tmpdir(), `goobster-pip-req-${crypto.randomBytes(6).toString('hex')}.txt`);
        fs.writeFileSync(reqPath, requirements, { mode: 0o600 });
        try {
            fs.mkdirSync(this.config.overlayDir, { recursive: true });
            const result = await this._runPip([
                'install', '--require-hashes', '--no-deps', '--only-binary=:all:', '--isolated',
                '--no-input', '--disable-pip-version-check', '--index-url', PYPI_INDEX,
                '--upgrade', '--target', this.config.overlayDir, '-r', reqPath
            ], INSTALL_TIMEOUT_MS);
            if (result.code !== 0) {
                const tail = String(result.stderr || result.stdout || '').trim().split('\n').slice(-4).join(' ');
                throw new SandboxRequestError(500, 'INSTALL_FAILED', `pip install failed: ${tail.slice(0, 400)}`);
            }
        } finally {
            try { fs.rmSync(reqPath, { force: true }); } catch { /* best effort */ }
        }
        for (const pkg of resolved) {
            await store.record({
                pip: pkg.name,
                module: pkg.module,
                version: pkg.version,
                requirement: `${pkg.name}==${pkg.version} --hash=sha256:${pkg.sha256}`,
                requestedBy: pending.userId,
                approvedBy
            });
        }
        // The tool descriptions advertise importability; make them true now,
        // not after the next restart.
        await require('./sandboxService').refreshPythonModules();
        return resolved.filter(pkg => pkg.requested).map(pkg => `${pkg.name}==${pkg.version}`);
    }

    _spawnPip(args, timeoutMs) {
        return new Promise((resolve) => {
            const child = spawn(this.config.pythonCommand, ['-m', 'pip', ...args], {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, PIP_NO_INPUT: '1' }
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk) => { stdout += chunk; });
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            const killer = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch { /* already gone */ }
            }, timeoutMs);
            child.on('error', (error) => {
                clearTimeout(killer);
                resolve({ code: 127, stdout: '', stderr: error.message });
            });
            child.on('close', (code) => {
                clearTimeout(killer);
                resolve({ code, stdout, stderr });
            });
        });
    }

    // --- Data fetches -----------------------------------------------------------

    /**
     * Fetch (or propose fetching) a URL into an Observatory project's
     * workspace under data/. Allowlisted hosts run immediately; anything
     * else needs an approver.
     * @param {{userId:string, project:string, url:string, saveAs?:string,
     *          reason?:string, client?:object}} params
     * @returns {Promise<string>} a model-readable outcome line
     */
    async requestFetch({ userId, project, url, saveAs = '', reason = '', client = null }) {
        const observatoryService = this._getObservatory();
        // resolveProject is async (DB lookup) — awaiting is load-bearing.
        // A forgotten await yields a Promise whose .dir/.slug are undefined
        // and path.join then throws a raw TypeError.
        const row = this._requireWorkspace(
            await observatoryService.resolveProject({ userId, project }),
            project
        );

        const assessed = safeFetch.assessUrl(url, this.config.fetchAllowedHosts);
        const fileName = this._sanitizeFetchName(saveAs || assessed.url.pathname.split('/').pop());
        const payload = {
            url: assessed.url.href,
            host: assessed.host,
            project: row.slug,
            fileName,
            reason: String(reason || '').slice(0, 500)
        };

        if (assessed.allowlisted) {
            this._checkRateLimit(userId);
            const outcome = await this._executeFetch({ userId, payload });
            await this._createRequest({
                type: 'data-fetch', userId, payload: { ...payload, ...outcome },
                status: 'COMPLETED', resolvedBy: 'allowlist'
            });
            return `✅ Fetched ${assessed.host} → ${outcome.relPath} `
                + `(${(outcome.bytes / (1024 * 1024)).toFixed(2)} MB${outcome.contentType ? `, ${outcome.contentType}` : ''}) `
                + `in project "${row.slug}". Runs can read it at $GOOBSTER_PROJECT_DIR/${outcome.relPath}.`;
        }

        if (this.approvers.length === 0) {
            return `❌ ${assessed.host} is not on the fetch allowlist and no sandbox approvers are `
                + 'configured, so off-list fetches are disabled. The operator can add the host to '
                + 'sandbox.fetchAllowedHosts, or drop the file into the project workspace directly.';
        }
        await this._checkPendingCap(userId);
        this._checkRateLimit(userId);
        const id = await this._createRequest({ type: 'data-fetch', userId, payload });
        const delivered = await this._dmApprovers(client, id, this._fetchEmbed(id, userId, payload));
        return `🟡 Proposed fetch #${id}: ${assessed.url.href} → ${row.slug}/data/${fileName} `
            + `(cap ${this.config.maxFetchMb} MB). ${assessed.host} is not on the standing allowlist, so `
            + (delivered > 0
                ? `an approver has been asked by DM (${delivered} reached). Tell the user it is waiting for approval.`
                : `⚠️ no approver could be reached by DM right now - the request stays pending (${PENDING_TTL_MINUTES / 60}h).`);
    }

    _sanitizeFetchName(candidate) {
        const cleaned = String(candidate ?? '')
            .split(/[\\/]/).pop()
            .replace(FETCH_FILENAME_PATTERN, '_')
            .replace(/^[._]+/, '')
            .slice(0, 80);
        return cleaned || `download-${Date.now()}.dat`;
    }

    /**
     * A resolved Observatory project must carry a concrete workspace path.
     * Without this, a missed await (or a stub that omitted `dir`) reaches
     * path.join/fs as undefined and surfaces a raw Node TypeError.
     */
    _requireWorkspace(row, projectRef) {
        const dir = row && typeof row === 'object' && typeof row.dir === 'string' ? row.dir.trim() : '';
        if (!dir) {
            const label = String(projectRef || '').trim();
            throw new SandboxRequestError(404, 'NO_WORKSPACE',
                label
                    ? `Project workspace not found for "${label}" - create the project first.`
                    : 'Project workspace not found - create the project first.');
        }
        return row;
    }

    /** The actual transfer, shared by the allowlist path and button approval. */
    async _executeFetch({ userId, payload }) {
        const observatoryService = this._getObservatory();
        const row = this._requireWorkspace(
            await observatoryService.resolveProject({ userId, project: payload.project }),
            payload.project
        );

        const dataDir = path.join(row.dir, 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        const destPath = path.join(dataDir, payload.fileName);
        if (fs.existsSync(destPath)) {
            throw new SandboxRequestError(409, 'FILE_EXISTS',
                `data/${payload.fileName} already exists in that project - pick another name.`);
        }

        // Quota: the fetch may not push the workspace past its cap.
        const quotaMb = observatoryService.config.maxProjectMb;
        const usedMb = observatoryService.workspaceSizeMb(row);
        const remainingMb = quotaMb - usedMb;
        if (remainingMb <= 0.1) {
            throw new SandboxRequestError(413, 'QUOTA_EXCEEDED',
                `The project workspace is at its ${quotaMb} MB quota - delete files first.`);
        }
        const maxBytes = Math.floor(Math.min(this.config.maxFetchMb, remainingMb) * 1024 * 1024);

        // Fresh DNS pin at execution time - approval may be hours after the
        // proposal, and the policy must hold for the address we USE.
        const assessed = safeFetch.assessUrl(payload.url, this.config.fetchAllowedHosts);
        const pinned = await safeFetch.resolvePinned(assessed.host, { lookup: this._lookup });
        const result = await this._fetchToFile({
            url: assessed.url,
            address: pinned.address,
            destPath,
            maxBytes,
            timeoutMs: 120_000,
            ...(this._transport ? { transport: this._transport } : {})
        });
        return { relPath: `data/${payload.fileName}`, bytes: result.bytes, contentType: result.contentType };
    }

    // --- Request lifecycle --------------------------------------------------------

    async _createRequest({ type, userId, payload, status = 'PENDING', resolvedBy = null }) {
        return db.insert(
            `INSERT INTO sandbox_requests (type, userId, payload, status, resolvedBy, resolvedAt)
             VALUES (@type, @userId, @payload, @status, @resolvedBy,
                     CASE WHEN @status = 'PENDING' THEN NULL ELSE CURRENT_TIMESTAMP END)`,
            { type, userId, payload: JSON.stringify(payload), status, resolvedBy }
        );
    }

    /** The pending row, or null when missing/resolved/expired (expiry persisted). */
    async getPending(id) {
        const row = await db.get('SELECT * FROM sandbox_requests WHERE id = @id', { id });
        if (!row || row.status !== 'PENDING') return null;
        const expired = await db.get(
            `SELECT 1 AS stale FROM sandbox_requests
             WHERE id = @id AND createdAt <= datetime('now', '-${PENDING_TTL_MINUTES} minutes')`,
            { id }
        );
        if (expired) {
            await this._resolve(id, 'EXPIRED', null);
            return null;
        }
        return { ...row, payload: JSON.parse(row.payload) };
    }

    async _resolve(id, status, resolvedBy, error = null) {
        await db.run(
            `UPDATE sandbox_requests
             SET status = @status, resolvedAt = CURRENT_TIMESTAMP, resolvedBy = @resolvedBy, error = @error
             WHERE id = @id AND status = 'PENDING'`,
            { id, status, resolvedBy, error }
        );
    }

    // --- Approver interaction -------------------------------------------------------

    _buttons(id) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`approve_sbxreq_${id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`deny_sbxreq_${id}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
        );
    }

    _packageEmbed(id, userId, payload) {
        const lines = payload.resolved.map(pkg =>
            `${pkg.requested ? '**' : ''}${pkg.name}==${pkg.version}${pkg.requested ? '**' : ' (dependency)'}`
            + `${Number.isFinite(pkg.sizeBytes) ? ` · ${(pkg.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : ''}`);
        return new EmbedBuilder()
            .setColor(0xf0b429)
            .setTitle('📦 Install Python packages into the sandbox overlay?')
            .setDescription(
                `Requested by <@${userId}>${payload.reason ? ` — ${payload.reason}` : ''}\n\n`
                + lines.join('\n').slice(0, 3500)
                + `\n\nWheels only, hash-pinned to exactly this set (pip may not substitute anything). `
                + `~${(payload.totalBytes / (1024 * 1024)).toFixed(1)} MB into data/sandbox/overlay.`)
            .setFooter({ text: `Sandbox request #${id} • host-level change • expires in ${PENDING_TTL_MINUTES / 60}h` });
    }

    _fetchEmbed(id, userId, payload) {
        return new EmbedBuilder()
            .setColor(0xf0b429)
            .setTitle('🌐 Fetch a file into an Observatory workspace?')
            .setDescription(
                `Requested by <@${userId}>${payload.reason ? ` — ${payload.reason}` : ''}\n\n`
                + `**URL:** ${payload.url.slice(0, 500)}\n`
                + `**Host:** ${payload.host} (not on the standing allowlist)\n`
                + `**Destination:** project \`${payload.project}\` → \`data/${payload.fileName}\`\n`
                + `**Cap:** ${this.config.maxFetchMb} MB, https only, no redirects, DNS-pinned`)
            .setFooter({ text: `Sandbox request #${id} • expires in ${PENDING_TTL_MINUTES / 60}h` });
    }

    /** DM every configured approver; returns how many were reachable. */
    async _dmApprovers(clientOrGateway, id, embed) {
        const gateway = toGateway(clientOrGateway);
        if (!gateway) return 0;
        let delivered = 0;
        for (const approverId of this.approvers) {
            const result = await gateway.sendDm(approverId,
                { embeds: [embed], components: [this._buttons(id)] });
            if (result.ok) {
                delivered += 1;
            } else {
                logger.warn?.(`[sandbox-requests] Could not DM approver ${approverId}: ${result.error}`);
            }
        }
        return delivered;
    }

    async _notifyRequester(clientOrGateway, userId, text) {
        const gateway = toGateway(clientOrGateway);
        if (!gateway) return;
        // Fire-and-report: DMs closed - the request row still holds the outcome
        await gateway.sendDm(userId, text);
    }

    /**
     * Handle an Approve/Deny button press (routed from interactionCreate).
     * Only configured approvers may resolve; execution happens here, and the
     * requester is told the outcome by DM.
     * @returns {Promise<{content?:string, embeds?:object[], components:[]}|null>}
     */
    async handleButton(action, id, interaction) {
        const pending = await this.getPending(id);
        if (!pending) {
            return { content: '⌛ This request is no longer pending (already handled or expired).', embeds: [], components: [] };
        }
        if (!this.approvers.includes(interaction.user.id)) {
            await interaction.followUp({
                content: '❌ Only a configured sandbox approver can resolve this.', ephemeral: true
            }).catch(() => {});
            return null; // leave the buttons for someone who can
        }

        const label = pending.type === 'package-install'
            ? (pending.payload.resolved || []).filter(p => p.requested).map(p => p.name).join(', ')
            : `${pending.payload.url} → ${pending.payload.project}/data/${pending.payload.fileName}`;

        if (action === 'deny') {
            await this._resolve(id, 'DENIED', interaction.user.id);
            await this._notifyRequester(interaction.client, pending.userId,
                `🚫 Your sandbox request #${id} (${label}) was denied by the approver.`);
            return { content: `🚫 Denied by <@${interaction.user.id}>.`, embeds: [], components: [] };
        }

        try {
            if (pending.type === 'package-install') {
                const installed = await this._executeInstall(pending, interaction.user.id);
                await this._resolve(id, 'COMPLETED', interaction.user.id);
                await this._notifyRequester(interaction.client, pending.userId,
                    `✅ Approved: ${installed.join(', ')} installed into the sandbox overlay - `
                    + 'Python runs can import it now.');
                return {
                    content: `✅ Approved by <@${interaction.user.id}> — installed ${installed.join(', ')} `
                        + `(overlay now ${this._overlaySizeMb().toFixed(1)} MB / ${this.config.maxOverlayMb} MB).`,
                    embeds: [], components: []
                };
            }
            const outcome = await this._executeFetch({ userId: pending.userId, payload: pending.payload });
            await this._resolve(id, 'COMPLETED', interaction.user.id);
            await this._notifyRequester(interaction.client, pending.userId,
                `✅ Approved: ${pending.payload.url} fetched into project "${pending.payload.project}" `
                + `as ${outcome.relPath} (${(outcome.bytes / (1024 * 1024)).toFixed(2)} MB).`);
            return {
                content: `✅ Approved by <@${interaction.user.id}> — fetched ${outcome.relPath} `
                    + `(${(outcome.bytes / (1024 * 1024)).toFixed(2)} MB).`,
                embeds: [], components: []
            };
        } catch (error) {
            logger.error?.(`[sandbox-requests] Request #${id} failed on approval: ${error.message}`);
            // A fixable failure (transient network, quota freed later) can be
            // retried - keep the request pending, tell the approver privately.
            await interaction.followUp({
                content: `❌ ${error.message || 'The request failed.'} (Still pending — press Approve again to retry.)`,
                ephemeral: true
            }).catch(() => {});
            return null;
        }
    }

    // --- Privacy -------------------------------------------------------------------

    /** /forget-me: the user's request rows go; package attribution is nulled. */
    async forgetUser(userId) {
        const requests = (await db.run('DELETE FROM sandbox_requests WHERE userId = @userId', { userId })).changes;
        const packagesAnonymized = await store.anonymizeUser(userId);
        return { requests, packagesAnonymized };
    }
}

module.exports = new SandboxRequestService();
module.exports.SandboxRequestService = SandboxRequestService;
module.exports.SandboxRequestError = SandboxRequestError;
module.exports.PENDING_TTL_MINUTES = PENDING_TTL_MINUTES;
