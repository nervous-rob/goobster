'use strict';

/**
 * Failure injection and negative authorization (documentation/release_acceptance.md). Each check is
 * `(cell, step) => result` like a step. The ones that would damage the cell's own installation use a
 * scratch installation under <work>/scratch with its own roots and ports (3705-3707 above the port
 * base), installed from the same payload; the ones that interrupt a long operation (update, restore)
 * run against the cell's installation at the point the brief names.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { check, notApplicable } = require('./evidence');
const op = require('./operator');
const { FEATURE_ROUTE, FEATURE_ID } = require('./cell');
const steps = require('./steps');
const dataSteps = require('./dataSteps');

class Scratch {
    constructor(cell, name) {
        this.cell = cell;
        this.name = name;
        this.dir = path.join(cell.dirs.scratch, name);
        const root = path.join(this.dir, 'inst');
        this.roots = {
            code: path.join(root, 'code'),
            data: path.join(root, 'data'),
            config: path.join(root, 'etc', 'config.json'),
            cache: path.join(root, 'cache'),
            logs: path.join(root, 'logs'),
            managerStore: path.join(root, 'data', 'manager')
        };
        this.daemon = null;
        fs.mkdirSync(path.join(this.dir, 'home'), { recursive: true });
    }

    env(extra = {}) {
        return this.cell.env({
            HOME: path.join(this.dir, 'home'),
            USERPROFILE: path.join(this.dir, 'home'),
            GOOBSTER_MANAGER_PORT: String(this.cell.ports.scratchManager),
            GOOBSTER_API_PORT: String(this.cell.ports.scratchApi),
            PORT: String(this.cell.ports.scratchBot),
            ...extra
        });
    }

    /** The environment of the payload's launcher before anything is installed (an unclaimed manager). */
    bareEnv() {
        return this.env({
            GOOBSTER_RUNTIME_MODE: 'standalone',
            GOOBSTER_DATA_DIR: this.roots.data,
            GOOBSTER_CONFIG_PATH: this.roots.config,
            GOOBSTER_CACHE_DIR: this.roots.cache,
            GOOBSTER_LOG_DIR: this.roots.logs,
            GOOBSTER_MANAGER_STATE_DIR: this.roots.managerStore
        });
    }

    installAnswers() {
        return { command: 'install', source: this.cell.base.dir, ownerLabel: 'scratch', layout: 'standalone', roots: this.roots, release: { publicKeyFiles: [this.cell.base.publicKeyPath] }, registerService: false, update: { mode: 'off' } };
    }

    launcher() {
        return path.join(this.roots.code, 'current', 'bin', op.IS_WINDOWS ? 'goobster-manager.cmd' : 'goobster-manager');
    }

    install(step, { env = {} } = {}) {
        const answers = this.cell.answersFile(`scratch-${this.name}-install`, this.installAnswers());
        return this.cell.cli(step, ['install', '--answers', answers, '--yes', '--json'], { launcher: this.cell.payloadLauncher(), env: this.env(env) });
    }

    start({ launcher = this.launcher(), env = this.env() } = {}) {
        this.daemon = new op.Daemon({ launcher, env, logFile: path.join(this.cell.dirs.logs, `scratch-${this.name}.log`), args: [], restartOnHandoff: false });
        this.daemon.start();
        return this.daemon;
    }

    async stop() {
        if (this.daemon && this.daemon.running()) await this.daemon.stop();
        await op.waitFor(async () => !(await op.portInUse(this.cell.ports.scratchManager)), { timeoutMs: 20_000, what: 'the scratch manager port to be free' });
    }

    async status() {
        const response = await fetch(`http://127.0.0.1:${this.cell.ports.scratchManager}/manager/api/status`, { signal: AbortSignal.timeout(5000) });
        return { status: response.status, json: await response.json().catch(() => null) };
    }

    async waitStatus() {
        return op.waitFor(async () => {
            try {
                const answer = await this.status();
                return answer.status === 200 ? answer.json : null;
            } catch { return null; }
        }, { timeoutMs: 40_000, what: 'the scratch manager to answer' });
    }

    async post(route, body, headers = {}) {
        const response = await fetch(`http://127.0.0.1:${this.cell.ports.scratchManager}/manager/api${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goobster-nonce': crypto.randomBytes(18).toString('base64url'), ...headers },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20_000)
        });
        return { status: response.status, json: await response.json().catch(() => null) };
    }

    async end() {
        try { await this.stop(); } catch { /* already down */ }
    }
}

const errorCode = (answer) => (answer.json && answer.json.error ? answer.json.error.code : null);
const refused = (answer) => answer.status >= 400 && answer.status < 600;

async function mintBootstrap(cell, scratch, step) {
    const result = await cell.cli(step, ['--mint-bootstrap'], { launcher: cell.payloadLauncher(), env: scratch.bareEnv(), show: ['--mint-bootstrap'] });
    const match = /Setup credential: (\S+)/.exec(result.stdout);
    check(result.code === 0 && match, `--mint-bootstrap did not print a credential (exit ${result.code})`);
    cell.redactor.secret(match[1]);
    return match[1];
}

async function staleSetupToken(cell, step) {
    const scratch = new Scratch(cell, 'token');
    fs.mkdirSync(scratch.roots.data, { recursive: true });
    try {
        const first = await mintBootstrap(cell, scratch, step);
        const second = await mintBootstrap(cell, scratch, step);
        scratch.start({ launcher: cell.payloadLauncher(), env: scratch.bareEnv() });
        const state = await scratch.waitStatus();
        check(state.state === 'unclaimed', `the scratch manager is ${state.state}, not unclaimed`);
        const replaced = await scratch.post('/claim', { credential: first, label: 'scratch' });
        check(refused(replaced), `a replaced setup credential was accepted (${replaced.status})`);
        const file = path.join(scratch.roots.managerStore, 'bootstrap.json');
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        record.expiresAt = new Date(Date.now() - 60_000).toISOString();
        fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
        const expired = await scratch.post('/claim', { credential: second, label: 'scratch' });
        check(refused(expired), `an expired setup credential was accepted (${expired.status})`);
        const third = await mintBootstrap(cell, scratch, step);
        const good = await scratch.post('/claim', { credential: third, label: 'scratch' });
        check(good.status === 200, `a fresh setup credential was refused (${good.status} ${errorCode(good) || ''})`);
        const reused = await scratch.post('/claim', { credential: third, label: 'scratch' });
        check(refused(reused), `a reused setup credential was accepted (${reused.status})`);
        step.command({ command: 'POST /manager/api/claim (replaced, expired, fresh, reused credentials)', exitCode: 200, durationMs: 0 });
        return { result: `replaced credential refused (${replaced.status} ${errorCode(replaced)}), expired refused (${expired.status} ${errorCode(expired)}), a fresh one claimed once (200), its reuse refused (${reused.status} ${errorCode(reused)})` };
    } finally {
        await scratch.end();
    }
}

async function lostManagerStore(cell, step) {
    const scratch = new Scratch(cell, 'store');
    try {
        const installed = await scratch.install(step);
        check(installed.code === 0, `the scratch install exited ${installed.code}: ${cell.why(installed)}`);
        scratch.start();
        const claimed = await scratch.waitStatus();
        check(claimed.state === 'claimed', `the scratch installation is ${claimed.state}`);
        await scratch.stop();
        const store = scratch.roots.managerStore;
        for (const name of fs.readdirSync(store)) {
            if (name.endsWith('.json') || name === 'installation.seal' || name === 'bridge-key') fs.rmSync(path.join(store, name), { force: true });
        }
        scratch.start();
        const lost = await scratch.waitStatus();
        check(lost.state === 'recovery' && lost.reason === 'MANAGER_STORE_MISSING', `a lost store gave ${lost.state} (${lost.reason}), not the recovery state MANAGER_STORE_MISSING`);
        await scratch.stop();
        const answers = cell.answersFile('scratch-store-adopt', { command: 'adopt', label: 'scratch', roots: scratch.roots, layout: 'standalone' });
        const adopted = await cell.cli(step, ['adopt', '--answers', answers, '--yes', '--json'], { launcher: scratch.launcher(), env: scratch.env() });
        check(adopted.code === 0, `adopt exited ${adopted.code}: ${cell.why(adopted)}`);
        scratch.start();
        const back = await scratch.waitStatus();
        check(back.state === 'claimed', `after adopt the manager is ${back.state}`);
        await scratch.stop();
        fs.writeFileSync(path.join(store, 'installation.json'), '{ this is not json');
        scratch.start();
        const damaged = await scratch.waitStatus();
        check(damaged.state === 'recovery', `a corrupted installation record gave ${damaged.state}, not recovery`);
        const refusedMutation = await scratch.post('/operations', { kind: 'features.set', input: { changes: { music: false } } });
        check(refused(refusedMutation), `the manager accepted a mutation (${refusedMutation.status}) with a corrupted record and no session`);
        return { result: `lost store -> recovery ${lost.reason}, adopt took the installation back (claimed); corrupted installation.json -> recovery ${damaged.reason || 'recovery'}, no session and no mutation, the process stayed up` };
    } finally {
        await scratch.end();
    }
}

function writtenBeyondJournal(scratch) {
    const found = [];
    const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else found.push(path.relative(scratch.dir, full).split(path.sep).join('/'));
        }
    };
    walk(path.join(scratch.dir, 'inst'));
    return found.filter((file) => !/^inst\/data\/manager\/operations\/[^/]+\.json$/.test(file));
}

async function portInUse(cell, step) {
    const scratch = new Scratch(cell, 'port');
    const held = await op.occupyPort(cell.ports.busy);
    try {
        const installed = await scratch.install(step, { env: { GOOBSTER_API_PORT: String(cell.ports.busy) } });
        check(installed.code === 2, `install with a busy port exited ${installed.code}, not 2 (invalid input or preflight block): ${cell.why(installed)}`);
        const text = JSON.stringify(installed.json || {});
        check(/PORT_IN_USE/.test(text), 'the refusal does not name PORT_IN_USE');
        const extra = writtenBeyondJournal(scratch);
        check(extra.length === 0, `the refused install wrote more than its operation record: ${extra.slice(0, 5).join(', ')}`);
        return { result: 'install exit 2 with PORT_IN_USE (api port held by another listener); nothing written but the refused operation\'s own journal entry' };
    } finally {
        await held.close();
    }
}

async function storageRefusal(cell, step) {
    if (process.platform === 'win32') return notApplicable('POSIX directory modes do not exist on Windows; the read-only half cannot be built the same way, and a full disk needs a size-limited volume');
    if (typeof process.getuid === 'function' && process.getuid() === 0) return notApplicable('running as root: directory modes do not stop root, and a full disk needs a privileged size-limited mount');
    const outcomes = [];

    const codeCase = new Scratch(cell, 'storage-code');
    const codeLocked = path.join(codeCase.dir, 'locked');
    fs.mkdirSync(codeLocked, { recursive: true });
    fs.chmodSync(codeLocked, 0o555);
    try {
        codeCase.roots.code = path.join(codeLocked, 'code');
        const installed = await codeCase.install(step);
        check(installed.code === 2, `install with a read-only code root exited ${installed.code}, not 2: ${cell.why(installed)}`);
        check(/ROOT_NOT_WRITABLE/.test(JSON.stringify(installed.json || {})), 'the refusal for a read-only code root does not name ROOT_NOT_WRITABLE');
        check(fs.readdirSync(codeLocked).length === 0, 'the refused install wrote into the read-only code root');
        const extra = writtenBeyondJournal(codeCase);
        check(extra.length === 0, `the refused install wrote more than its operation record: ${extra.slice(0, 5).join(', ')}`);
        outcomes.push('read-only code root: exit 2, ROOT_NOT_WRITABLE, nothing written');
    } finally {
        fs.chmodSync(codeLocked, 0o755);
    }

    const dataCase = new Scratch(cell, 'storage-data');
    const dataLocked = path.join(dataCase.dir, 'locked');
    fs.mkdirSync(dataLocked, { recursive: true });
    fs.chmodSync(dataLocked, 0o555);
    try {
        dataCase.roots.data = path.join(dataLocked, 'data');
        dataCase.roots.managerStore = path.join(dataLocked, 'data', 'manager');
        const installed = await dataCase.install(step);
        check(installed.code !== 0, 'install into a read-only data root succeeded');
        check(/ROOT_NOT_WRITABLE|STORE_UNUSABLE/.test(JSON.stringify(installed.json || {})), `the refusal for a read-only data root names neither ROOT_NOT_WRITABLE nor STORE_UNUSABLE: ${cell.why(installed)}`);
        check(fs.readdirSync(dataLocked).length === 0 && !fs.existsSync(dataCase.roots.code), 'the refused install wrote something');
        const named = /STORE_UNUSABLE/.test(JSON.stringify(installed.json || {})) ? 'STORE_UNUSABLE' : 'ROOT_NOT_WRITABLE';
        outcomes.push(`read-only data root: exit ${installed.code}, ${named} (the manager cannot keep its own store there), nothing written`);
    } finally {
        fs.chmodSync(dataLocked, 0o755);
    }
    return { result: `${outcomes.join('; ')}. A full disk (DISK_SPACE) needs a size-limited mount and was not exercised` };
}

async function unauthenticatedManager(cell, step) {
    const base = await cell.api.call('GET', '/config');
    check(base.status === 200, `GET /config with a session answered ${base.status}`);
    const revision = base.json.revision;
    const outcomes = [];
    const none = await cell.api.raw('POST', '/operations', { body: { kind: 'features.set', input: { changes: { music: false } } }, auth: false });
    check(refused(none), `a mutation with no session answered ${none.status}`);
    outcomes.push(`no session ${none.status} ${errorCode(none) || ''}`.trim());
    const fake = crypto.randomBytes(32).toString('base64url');
    const bogus = await cell.api.raw('POST', '/operations', { body: { kind: 'features.set', input: { changes: { music: false } } }, auth: false, headers: { authorization: `Bearer ${fake}` } });
    check(refused(bogus), `a mutation with a made-up bearer token answered ${bogus.status}`);
    outcomes.push(`made-up token ${bogus.status} ${errorCode(bogus) || ''}`.trim());
    const read = await cell.api.raw('GET', '/config', { auth: false });
    check(refused(read), `GET /config without a session answered ${read.status}`);
    outcomes.push(`config read ${read.status}`);
    await cell.api.call('GET', '/status');
    const noNonce = await cell.api.raw('POST', '/operations', { body: { kind: 'features.set', input: { changes: { music: false } } }, nonce: false });
    check(refused(noNonce), `a session mutation with no nonce answered ${noNonce.status}`);
    outcomes.push(`no nonce ${noNonce.status} ${errorCode(noNonce) || ''}`.trim());
    const foreign = await cell.api.raw('POST', '/operations', { body: { kind: 'features.set', input: { changes: { music: false } } }, headers: { origin: 'https://evil.example' } });
    check(refused(foreign), `a mutation from a foreign origin answered ${foreign.status}`);
    outcomes.push(`foreign origin ${foreign.status} ${errorCode(foreign) || ''}`.trim());
    const after = await cell.api.call('GET', '/config');
    check(after.json.revision === revision, 'the configuration changed while the refused requests were made');
    step.command({ command: 'POST /manager/api/operations (no session, made-up token, no nonce, foreign origin)', exitCode: none.status, durationMs: 0 });
    return { result: `every mutation refused and nothing changed: ${outcomes.join('; ')}` };
}

function rawHttp({ port, method, route, headers, body }) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, method, path: route, headers }, (response) => {
            let text = '';
            response.on('data', (chunk) => { text += chunk; });
            response.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: response.statusCode, json });
            });
        });
        request.setTimeout(20_000, () => request.destroy(new Error('timeout')));
        request.on('error', reject);
        request.end(body);
    });
}

async function recoveryNotRemote(cell, step) {
    const credential = await cell.mintRecovery();
    cell.redactor.secret(credential);
    const body = JSON.stringify({ credential });
    const nonce = () => crypto.randomBytes(18).toString('base64url');
    const through = async (extra) => rawHttp({
        port: cell.ports.manager, method: 'POST', route: '/manager/api/recovery/unlock', body,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-goobster-nonce': nonce(), host: `127.0.0.1:${cell.ports.manager}`, ...extra }
    });
    const proxied = await through({ 'x-forwarded-for': '203.0.113.9' });
    check(refused(proxied), `recovery unlock through a forwarding header answered ${proxied.status}`);
    const named = await through({ host: 'goobster.example.com' });
    check(refused(named), `recovery unlock addressed to a non-loopback name answered ${named.status}`);
    const direct = await through({});
    check(direct.status === 200 && direct.json && direct.json.session, `the same credential, used directly on this machine, answered ${direct.status}: the refused attempts must not burn it`);
    cell.redactor.secret(direct.json.session.token);
    step.command({ command: 'POST /manager/api/recovery/unlock (forwarded, non-loopback host, direct)', exitCode: direct.status, durationMs: 0 });
    return { result: `through a forwarding header: ${proxied.status} ${errorCode(proxied) || ''}; to a non-loopback host name: ${named.status} ${errorCode(named) || ''}; the same credential then worked directly (200)`.replace(/\s+/g, ' ') };
}

async function disabledFeatureRoute(cell, step) {
    await cell.portalLogin();
    const unsigned = await cell.portalGet(FEATURE_ROUTE, { signedIn: false });
    check(unsigned.status === 404 && unsigned.json && unsigned.json.error && unsigned.json.error.code === 'NOT_FOUND', `a signed-out request to the disabled ${FEATURE_ID} route answered ${steps.describe(unsigned)}, not the plain missing-route 404`);
    const gated = await steps.signedInGet(cell, FEATURE_ROUTE);
    check(steps.gatedBody(gated) && gated.json.feature, `a signed-in request to the disabled ${FEATURE_ID} route answered ${steps.describe(gated)}, not the gated response`);
    const write = await fetch(cell.portal('/api/app/exchange/trade'), { method: 'POST', headers: { 'content-type': 'application/json', cookie: cell.cookie }, body: JSON.stringify({ guildId: '1', symbol: 'GOOB', side: 'buy', quantity: 1 }), signal: AbortSignal.timeout(20_000) });
    check(write.status === 404, `a signed-in write to the disabled feature answered ${write.status}`);
    step.command({ command: `GET ${FEATURE_ROUTE} (signed out, signed in) and POST /api/app/exchange/trade`, exitCode: gated.status, durationMs: 0 });
    return { result: `${FEATURE_ID} not active (${cell.o.features === 'minimal' ? 'not in the payload' : 'removed by features.set'}): signed out -> plain 404 NOT_FOUND, signed in -> 404 FEATURE_UNAVAILABLE naming the feature, a write -> 404; nothing reached the feature` };
}

async function updateInterrupted(cell, step) {
    const target = '1.2.0';
    const from = cell.state.release.version;
    await steps.offerAndStage(cell, step, target);
    const handoff = path.join(cell.roots.managerStore, 'update', 'handoff.json');
    cell.daemon.restartOnHandoff = false;
    const pid = cell.daemon.pid;
    const applied = await cell.cli(step, ['update', 'apply', '--now', '--json']);
    check(applied.code === 0, `update apply exited ${applied.code}: ${cell.why(applied)}`);
    let phase = null;
    await op.waitFor(async () => {
        try { phase = JSON.parse(fs.readFileSync(handoff, 'utf8')).phase; } catch { return null; }
        return phase === 'pending' || phase === 'verified' ? true : null;
    }, { timeoutMs: 120_000, intervalMs: 20, what: 'the handoff to reach pending' });
    const alreadyGone = !op.alive(pid);
    if (!alreadyGone) {
        await cell.daemon.kill();
        step.command({ command: `kill -9 <manager pid ${pid}> (handoff phase ${phase})`, exitCode: null, durationMs: 0 });
    }
    check(!op.alive(pid), 'the manager survived SIGKILL');
    cell.daemon.restartOnHandoff = true;
    await op.sleep(1500);
    cell.api.token = null;
    cell.startDaemon();
    await cell.waitManager();
    const view = await op.waitFor(async () => {
        let current;
        try { current = await steps.updateView(cell, step); } catch { return null; }
        return !current.handoff && current.lastApply && current.lastApply.outcome ? current : null;
    }, { timeoutMs: 240_000, intervalMs: 1500, what: 'the interrupted update to settle' });
    await cell.waitHealthy();
    const outcome = view.lastApply.outcome;
    check(['applied', 'rolled_back', 'abandoned'].includes(outcome), `the interrupted update ended ${outcome}${view.lastApply.code ? ` (${view.lastApply.code})` : ''}, not a state the crash matrix allows`);
    const wanted = outcome === 'applied' ? target : from;
    check(view.installed.version === wanted, `the update ended ${outcome} but the installed release is ${view.installed.version}, not ${wanted}`);
    const maintenance = await cell.api.call('GET', '/maintenance');
    check(!(maintenance.json && maintenance.json.active), 'the maintenance barrier is still up after the interrupted update');
    cell.state.release = { ...cell.state.release, version: view.installed.version };
    await cell.portalLogin();
    check((await cell.conversations()).length >= cell.state.conversationCount, 'a conversation was lost by the interrupted update');
    return { result: `manager ${alreadyGone ? 'had already left with 76' : 'SIGKILLed by pid'} with the handoff at ${phase}; the next start ${outcome === 'applied' ? 'verified and finished the update to' : 'rolled back to'} ${view.installed.version} (${outcome}), barrier released, workers healthy, data intact` };
}

function operationJournals(cell) {
    const dir = path.join(cell.roots.managerStore, 'operations');
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
            const doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
            if (doc.kind === 'backup.restore') out.push(doc);
        } catch { /* being written */ }
    }
    return out;
}

function filesNamed(root, prefix, found = []) {
    for (const entry of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
        const full = path.join(root, entry.name);
        if (entry.name.includes(prefix)) found.push(full);
        if (entry.isDirectory() && !entry.name.startsWith('goobster-backup-')) filesNamed(full, prefix, found);
    }
    return found;
}

async function restoreInterrupted(cell, step) {
    const archive = await dataSteps.backup(cell, step, path.join(cell.dirs.backups, 'interrupt'));
    const before = (await cell.conversations()).length;
    const turn = await cell.portalChatInNewConversation('A conversation the interrupted restore must not lose.');
    check(turn.ok, 'a chat turn before the restore failed');
    check((await cell.conversations()).length === before + 1, 'the extra conversation was not kept');
    await cell.stopDaemon();
    const sqlite = cell.sqliteFile();
    const hashBefore = cell.sha256File(sqlite);
    const knownOps = new Set(operationJournals(cell).map((doc) => doc.id));
    const run = op.startLauncher(cell.installedLauncher(), ['restore', archive, '--confirm', cell.installationId, '--without-config', '--json'], { env: cell.env() });
    let killed = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        const journal = operationJournals(cell).find((doc) => !knownOps.has(doc.id));
        if (journal && (journal.steps || []).some((entry) => entry.name === 'mutate' && entry.status === 'started')) {
            try { process.kill(run.pid, 'SIGKILL'); killed = true; } catch { /* already finished */ }
            break;
        }
        if (!op.alive(run.pid)) break;
        await op.sleep(5);
    }
    const ended = await run.done;
    step.command({ command: `kill -9 <restore pid ${run.pid}> (journal at mutate)`, exitCode: ended.code, durationMs: ended.durationMs });
    if (!killed) return notApplicable(`the restore finished (exit ${ended.code}) before the kill landed: the window is shorter than the 5 ms poll on this host`);
    const hashAfterKill = fs.existsSync(sqlite) ? cell.sha256File(sqlite) : null;
    let previous;
    if (hashAfterKill === hashBefore) {
        previous = 'the live database was still the pre-restore file';
    } else {
        const aside = filesNamed(cell.roots.data, '.pre-restore');
        const kept = aside.some((entry) => fs.statSync(entry).isFile() && cell.sha256File(entry) === hashBefore);
        check(kept, 'the database was replaced and the previous file is nowhere among the .pre-restore items');
        previous = 'the previous database was set aside intact (.pre-restore)';
    }
    const again = await cell.cli(step, ['restore', archive, '--confirm', cell.installationId, '--without-config', '--release', '--json'], { show: ['restore', '<archive>', '--confirm', '<installationId>', '--without-config', '--release', '--json'] });
    check(again.code === 0, `restore after the interruption exited ${again.code}: ${cell.why(again)}`);
    await dataSteps.comeBack(cell, before);
    const resumed = again.json && again.json.result && again.json.result.resumed ? 'resumed the interrupted restore' : 'restored from scratch';
    return { result: `restore SIGKILLed by pid once its journal reached mutate; ${previous}; the next run ${resumed}, data equals the archive (${before} conversation(s), the later one gone), workers healthy` };
}

module.exports = { Scratch, staleSetupToken, lostManagerStore, portInUse, storageRefusal, unauthenticatedManager, recoveryNotRemote, disabledFeatureRoute, updateInterrupted, restoreInterrupted };
