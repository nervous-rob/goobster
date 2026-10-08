'use strict';

/**
 * One cell of the acceptance matrix on this host: the infrastructure the steps share (the work
 * directory, the roots of the installation, the ports, the manager's command line and process, the
 * portal) and the lifecycle steps themselves. The injections live in injections.js and use the same
 * handle. Every door is the operator's: the manager CLI, the manager process, and loopback HTTP.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { check, notApplicable, deferred } = require('./evidence');
const op = require('./operator');
const { startFakeOllama, REPLY } = require('./fakeOllama');
const { ReleaseWorkshop } = require('./release');

const OWNER_LOGIN = 'acceptance-owner';
const OFFSET = { manager: 0, api: 1, bot: 2, ollama: 3, scratchManager: 4, scratchApi: 5, scratchBot: 6, busy: 7, docker: 8 };
const FEATURE_ROUTE = '/api/app/exchange/overview?guildId=1';
const FEATURE_ID = 'exchange';

function parseSse(text) {
    const events = [];
    for (const block of String(text).split(/\r?\n\r?\n/)) {
        let name = 'message';
        const data = [];
        for (const line of block.split(/\r?\n/)) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (data.length || block.includes('event:')) {
            let parsed = null;
            try { parsed = JSON.parse(data.join('\n')); } catch { /* not JSON */ }
            events.push({ name, data: parsed });
        }
    }
    return events;
}

class Cell {
    /**
     * @param {Object} options  the parsed command line (run.js)
     * @param {import('./evidence').Recorder} recorder
     * @param {import('./evidence').Redactor} redactor
     */
    constructor(options, recorder, redactor) {
        this.o = options;
        this.rec = recorder;
        this.redactor = redactor;
        this.work = path.resolve(options.work);
        const inst = path.join(this.work, 'inst');
        this.roots = {
            code: path.join(inst, 'opt goobster', 'code'),
            data: path.join(inst, 'var lib goobster'),
            config: path.join(inst, 'etc goobster', 'config.json'),
            cache: path.join(inst, 'var cache goobster'),
            logs: path.join(inst, 'var log goobster'),
            managerStore: path.join(inst, 'var lib goobster', 'manager')
        };
        this.dirs = {
            home: path.join(this.work, 'home'),
            answers: path.join(this.work, 'answers'),
            backups: path.join(this.work, 'backups'),
            logs: path.join(this.work, 'logs'),
            scratch: path.join(this.work, 'scratch'),
            releases: path.join(this.work, 'releases')
        };
        this.ports = Object.fromEntries(Object.entries(OFFSET).map(([name, offset]) => [name, options.portBase + offset]));
        this.password = `${crypto.randomBytes(9).toString('hex')}-walnut-ladder-kettle`;
        this.secretKey = `acceptance-${crypto.randomBytes(10).toString('hex')}`;
        this.redactor.secret(this.password);
        this.redactor.secret(this.secretKey);
        this.daemon = null;
        this.api = null;
        this.cookie = null;
        this.installationId = null;
        this.installed = false;
        this.passphrase = null;
        this.engine = 'sqlite';
        this.markerConversation = null;
        this.fake = null;
        this.workshop = null;
        this.base = null;
        this.releaseKey = null;
        this.published = new Map();
        this.state = {};
    }

    // ------------------------------------------------------------------ setup
    async setup() {
        for (const dir of Object.values(this.dirs)) fs.mkdirSync(dir, { recursive: true });
        fs.mkdirSync(path.dirname(this.roots.config), { recursive: true });
        this.redactor.path(this.work, '<work>');
        this.redactor.path(this.o.payload, '<payload>');
        this.redactor.path(this.o.out, '<out>');
        this.fake = await startFakeOllama({ port: this.ports.ollama });
        this.workshop = new ReleaseWorkshop({ payload: this.o.payload, dir: this.dirs.releases });
        this.base = this.workshop.prepareBase();
        this.releaseKey = this.base.publicKeyPath;
        this.api = new op.ManagerApi({ port: this.ports.manager, mint: () => this.mintRecovery(), redactor: this.redactor });
    }

    async teardown() {
        if (this.daemon && this.daemon.running()) await this.daemon.stop().catch(() => {});
        if (this.fake) await this.fake.close().catch(() => {});
        if (this.workshop) this.workshop.discardPrivateKey();
    }

    // ---------------------------------------------------------------- doors
    payloadLauncher() {
        return path.join(this.base.dir, 'bin', op.IS_WINDOWS ? 'goobster-manager.cmd' : 'goobster-manager');
    }

    installedLauncher() {
        return path.join(this.roots.code, 'current', 'bin', op.IS_WINDOWS ? 'goobster-manager.cmd' : 'goobster-manager');
    }

    launcher() {
        return this.installed ? this.installedLauncher() : this.payloadLauncher();
    }

    env(extra = {}) {
        return op.baseEnv({
            HOME: this.dirs.home,
            USERPROFILE: this.dirs.home,
            GOOBSTER_RELEASE_PUBLIC_KEY_FILE: this.releaseKey,
            GOOBSTER_MANAGER_HOST: '127.0.0.1',
            GOOBSTER_MANAGER_PORT: String(this.ports.manager),
            GOOBSTER_API_PORT: String(this.ports.api),
            PORT: String(this.ports.bot),
            GOOBSTER_MANAGER_OS_SUPERVISED: '1',
            GOOBSTER_LIFECYCLE_DRAIN_SECONDS: '3',
            GOOBSTER_UPDATE_SETTLE_MS: '3000',
            ...extra
        });
    }

    /** The roots the installed launcher would read from goobster.env, for commands run from the payload's launcher. */
    rootEnv(extra = {}) {
        return this.env({
            GOOBSTER_RUNTIME_MODE: 'standalone',
            GOOBSTER_DATA_DIR: this.roots.data,
            GOOBSTER_CONFIG_PATH: this.roots.config,
            GOOBSTER_CACHE_DIR: this.roots.cache,
            GOOBSTER_LOG_DIR: this.roots.logs,
            GOOBSTER_MANAGER_STATE_DIR: this.roots.managerStore,
            ...extra
        });
    }

    sqliteFile() {
        return path.join(this.roots.data, 'goobster.sqlite');
    }

    sha256File(file) {
        return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }

    /** The one archive directory `backup --out <dir>` wrote inside `dir`. */
    archiveIn(dir) {
        const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith('goobster-backup-')).sort() : [];
        check(names.length > 0, 'the backup wrote no archive directory');
        return path.join(dir, names[names.length - 1]);
    }

    ensurePassphrase() {
        if (!this.passphrase) {
            this.passphrase = `${crypto.randomBytes(9).toString('hex')}-copper-lantern-tide`;
            this.redactor.secret(this.passphrase);
        }
        return this.passphrase;
    }

    /** A 0600 file holding a passphrase (the first line), registered as a secret. */
    passphraseFile(name = 'passphrase') {
        this.ensurePassphrase();
        const file = path.join(this.dirs.answers, `${name}.txt`);
        fs.writeFileSync(file, `${this.passphrase}\n`, { mode: 0o600 });
        try { fs.chmodSync(file, 0o600); } catch { /* not POSIX */ }
        return file;
    }

    /** Write a 0600 answers file (it may hold a secret) and return its path. */
    answersFile(name, document) {
        const file = path.join(this.dirs.answers, `${name}.json`);
        fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
        try { fs.chmodSync(file, 0o600); } catch { /* not POSIX */ }
        return file;
    }

    /**
     * Run the manager's command line as an operator would and record it on `step`.
     * @returns {Promise<{code:number|null, stdout:string, stderr:string, json:Object|null, durationMs:number}>}
     */
    async cli(step, args, { env = null, launcher = null, input = '', timeoutMs = 600_000, show = null } = {}) {
        const result = await op.runLauncher(launcher || this.launcher(), args, { env: env || this.env(), input, timeoutMs });
        const json = args.includes('--json') ? op.extractJson(result.stdout) : null;
        step.command({ command: `goobster-manager ${(show || args).join(' ')}`, exitCode: result.timedOut ? 'timeout' : result.code, durationMs: result.durationMs });
        return { ...result, json };
    }

    /** The database URL the manager keeps in its environment overlay (mode 0600): what an operator's service environment would hold. */
    databaseUrl() {
        const file = path.join(this.roots.managerStore, 'environment.json');
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        const url = doc && doc.values && doc.values.GOOBSTER_DB_URL;
        check(typeof url === 'string' && url.length > 0, 'the manager keeps no database URL after the migration');
        this.redactor.secret(url);
        try {
            const parsed = new URL(url);
            if (parsed.password) this.redactor.secret(decodeURIComponent(parsed.password));
        } catch { /* not a URL we can take a password from */ }
        return url;
    }

    /** The one-line reason a command failed: its error code from the JSON, else the last thing it said. */
    why(result) {
        const blocks = result.json && (Array.isArray(result.json.blocks) ? result.json.blocks : (result.json.preflight && result.json.preflight.blocks));
        if (Array.isArray(blocks) && blocks.length) {
            return blocks.map((item) => `${item.code}${typeof item.detail === 'string' && item.detail ? `: ${item.detail}` : ''}`).join('; ');
        }
        if (result.json && result.json.error) return `${result.json.error.code}${result.json.error.reason ? ` (${result.json.error.reason})` : ''}${result.json.error.message ? `: ${result.json.error.message}` : ''}`;
        const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const said = lines.filter((line) => !/^\[[\w.-]+\] [\w.-]+ \.\.\.$/.test(line));
        if (said.length) return said[said.length - 1];
        return lines.length ? `${lines[lines.length - 1]} (then nothing: exit ${result.code})` : `exit ${result.code}`;
    }

    async mintRecovery() {
        const out = await op.runLauncher(this.launcher(), ['--mint-recovery'], { env: this.env() });
        const match = /Recovery credential: (\S+)/.exec(out.stdout);
        if (match) return match[1];
        const file = path.join(this.roots.managerStore, 'recovery-credential');
        check(fs.existsSync(file), 'the manager printed no recovery credential and wrote no file');
        return fs.readFileSync(file, 'utf8').trim();
    }

    startDaemon() {
        this.daemon = new op.Daemon({
            launcher: this.installedLauncher(),
            env: this.env(),
            logFile: path.join(this.dirs.logs, 'manager.log'),
            onEvent: () => {}
        });
        this.daemon.start();
        this.api.token = null;
        return this.daemon;
    }

    /** After a step that failed half way: bring the manager and its workers back so the next step starts from a running installation. */
    async ensureRunning() {
        if (!this.installed || (this.daemon && this.daemon.running())) return;
        this.startDaemon();
        await this.waitManager();
        await this.waitHealthy();
    }

    /**
     * Stop the installation as its service host would. On POSIX that is SIGTERM to the manager, which
     * drains and stops its workers before it exits. On Windows the host sends Ctrl+C, which a Node
     * parent cannot; the manager's own `lifecycle.stop` operation is what that Ctrl+C runs inside it
     * (workers drained and closed through the control file), so it is asked for first and the process
     * tree is ended afterwards. Ending the tree without it kills the workers mid-write: SQLite is left
     * with an un-checkpointed WAL, and the next thing to open the database (a restore) folds the WAL
     * into the main file, so the file the restore sets aside is not the one that was there before.
     */
    async stopDaemon() {
        if (this.daemon && this.daemon.running()) {
            if (op.IS_WINDOWS) await this.drainWorkers();
            await this.daemon.stop();
        }
        await this.waitPortFree(this.ports.api, 40_000).catch(() => {});
        this.api.token = null;
    }

    /** `lifecycle.stop` through the manager's API, bounded; a manager that cannot (not supervising, already leaving) is left to the tree kill. */
    async drainWorkers() {
        const stop = this.api.operation('lifecycle.stop', {}).then(() => true, () => false);
        const outcome = await Promise.race([stop, op.sleep(90_000).then(() => false)]);
        if (outcome) await this.waitPortFree(this.ports.api, 30_000).catch(() => {});
        return outcome;
    }

    async waitPortFree(port, timeoutMs = 30_000) {
        await op.waitFor(async () => !(await op.portInUse(port)), { timeoutMs, what: `port ${port} to be free` });
    }

    async managerStatus() {
        const response = await fetch(`http://127.0.0.1:${this.ports.manager}/manager/api/status`, { signal: AbortSignal.timeout(5000) });
        return { status: response.status, json: await response.json().catch(() => null) };
    }

    async waitManager(timeoutMs = 60_000) {
        return op.waitFor(async () => {
            const answer = await this.managerStatus();
            return answer.status === 200 ? answer.json : null;
        }, { timeoutMs, what: 'the manager to answer' });
    }

    /** Every supervised worker answers /health and has acknowledged the current revision. */
    async waitHealthy(timeoutMs = 120_000) {
        return op.waitFor(async () => {
            const lifecycle = await this.api.call('GET', '/lifecycle');
            if (lifecycle.status !== 200 || !lifecycle.json) return null;
            const workers = lifecycle.json.workers || [];
            if (!workers.length || !workers.every((worker) => worker.healthy === true)) return null;
            const health = await fetch(`http://127.0.0.1:${this.ports.api}/health`, { signal: AbortSignal.timeout(5000) });
            return health.status === 200 ? lifecycle.json : null;
        }, { timeoutMs, intervalMs: 500, what: 'the workers to answer /health' });
    }

    async cliStatus(step) {
        const result = await this.cli(step, ['status', '--json']);
        check(result.code === 0 && result.json && result.json.status, `status failed: ${this.why(result)}`);
        return result.json.status;
    }

    // --------------------------------------------------------------- portal
    portal(route) {
        return `http://127.0.0.1:${this.ports.api}${route}`;
    }

    async portalLogin() {
        const response = await fetch(this.portal('/api/app/auth/native-login'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ loginName: OWNER_LOGIN, password: this.password }),
            signal: AbortSignal.timeout(30_000)
        });
        check(response.status === 200, `portal sign-in answered ${response.status}`);
        const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
        check(cookie.includes('='), 'the portal set no session cookie');
        this.redactor.secret(cookie.split('=').slice(1).join('='));
        this.cookie = cookie;
        return cookie;
    }

    async portalGet(route, { signedIn = true } = {}) {
        const response = await fetch(this.portal(route), { headers: signedIn && this.cookie ? { cookie: this.cookie } : {}, signal: AbortSignal.timeout(30_000) });
        let json = null;
        try { json = await response.json(); } catch { /* not JSON */ }
        return { status: response.status, json };
    }

    /** A chat turn; without a conversation id the portal continues the latest conversation. */
    async portalChat(message, conversationId = null) {
        const response = await fetch(this.portal('/api/app/chat'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: this.cookie },
            body: JSON.stringify(conversationId === null ? { message } : { message, conversationId }),
            signal: AbortSignal.timeout(120_000)
        });
        const text = await response.text();
        const events = parseSse(text);
        const reply = events.find((event) => event.name === 'message' && event.data);
        const done = events.find((event) => event.name === 'done' && event.data);
        return { status: response.status, reply: reply ? reply.data.content : null, ok: Boolean(done && done.data.ok), conversationId: done && done.data ? done.data.conversationId : null };
    }

    /** A chat turn in a conversation of its own, so a later count of conversations moves by exactly one. */
    async portalChatInNewConversation(message) {
        const made = await fetch(this.portal('/api/app/chat/conversations'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: this.cookie },
            body: '{}',
            signal: AbortSignal.timeout(30_000)
        });
        const body = await made.json().catch(() => null);
        check(made.status === 200 && body && body.id, `creating a conversation answered ${made.status}`);
        return this.portalChat(message, body.id);
    }

    async conversations() {
        const answer = await this.portalGet('/api/app/chat/conversations');
        check(answer.status === 200 && answer.json, `conversation list answered ${answer.status}`);
        return answer.json.conversations || [];
    }

    // ------------------------------------------------------- shared checks
    /** Plan, apply and wait out a restart the way the portal does: lifecycle.apply, then restart-now. */
    async applyRestart(changeRef) {
        const before = await this.api.call('GET', '/lifecycle');
        const revision = before.json ? before.json.current : null;
        const applied = await this.api.operation('lifecycle.apply', { changeRef, graceSeconds: 10, onExpired: 'apply' });
        const now = await this.api.call('POST', '/lifecycle/restart-now');
        check(now.status === 200, `restart-now answered ${now.status}${now.json && now.json.error ? ` ${now.json.error.code}` : ''}`);
        const done = await op.waitFor(async () => {
            const lifecycle = await this.api.call('GET', '/lifecycle');
            const body = lifecycle.json;
            if (!body || body.pending) return null;
            if (body.lastOutcome && body.lastOutcome.outcome && body.current !== revision) return body;
            return null;
        }, { timeoutMs: 180_000, intervalMs: 700, what: 'the restart to be promoted' });
        check(done.lastOutcome.outcome === 'applied', `the restart ended ${done.lastOutcome.outcome}${done.lastOutcome.code ? ` (${done.lastOutcome.code})` : ''}`);
        await this.waitHealthy();
        return { applied, lifecycle: done };
    }

    /** Restart the workers at the current revision, the portal's "Restart" button. */
    async restartWorkers() {
        const before = await this.api.call('GET', '/lifecycle');
        const pids = new Set(((before.json && before.json.workers) || []).map((worker) => worker.pid));
        const now = await this.api.call('POST', '/lifecycle/restart');
        check(now.status === 200, `restart answered ${now.status}${now.json && now.json.error ? ` ${now.json.error.code}` : ''}`);
        await op.waitFor(async () => {
            const lifecycle = await this.api.call('GET', '/lifecycle');
            const workers = (lifecycle.json && lifecycle.json.workers) || [];
            return workers.length && workers.every((worker) => worker.pid && !pids.has(worker.pid) && worker.healthy === true) ? lifecycle.json : null;
        }, { timeoutMs: 180_000, intervalMs: 700, what: 'the workers to come back with new processes' });
        await this.waitHealthy();
    }

    // ------------------------------------------------------------ steps
    installAnswers() {
        const config = [
            { id: 'webapp.enabled', value: true },
            { id: 'identity.nativeLogin', value: true },
            { id: 'ollama.host', value: this.fake.url },
            { id: 'ollama.model', value: 'llama3.2:3b' }
        ];
        return {
            command: 'install',
            source: this.base.dir,
            ownerLabel: 'acceptance',
            layout: 'standalone',
            roots: this.roots,
            release: { publicKeyFiles: [this.base.publicKeyPath] },
            config,
            registerService: false,
            update: { mode: 'off' }
        };
    }

    async stepInstall(step) {
        step.setEngine('sqlite');
        const answers = this.answersFile('install', this.installAnswers());
        const result = await this.cli(step, ['install', '--answers', answers, '--yes', '--json']);
        check(result.code === 0, `install exited ${result.code}: ${this.why(result)}`);
        this.installed = true;
        const status = await this.cliStatus(step);
        check(status.state === 'claimed' && status.installation, `the installation is ${status.state}, not claimed`);
        this.installationId = status.installation.installationId;
        this.state.release = status.installation.release;
        check(status.installation.release && status.installation.release.version === this.base.version, 'the installed release is not the payload built');
        this.startDaemon();
        await this.waitManager();
        const lifecycle = await this.waitHealthy();
        let note = `installed ${status.installation.release.version} (${status.installation.release.features.join(', ')}); ${lifecycle.workers.length} worker healthy`;
        if (this.o.install === 'adopt') note += `; ${await this.loseAndAdopt(step)}`;
        return { result: note };
    }

    /**
     * Lose the manager store next to a running installation, see the manager refuse to guess, then take
     * the installation back through `adopt` with the roots an operator would name. The same sequence is
     * the adopted-install path and the lost-store injection.
     */
    async loseAndAdopt(step) {
        await this.stopDaemon();
        const store = this.roots.managerStore;
        const removed = [];
        for (const name of fs.readdirSync(store)) {
            if (name.endsWith('.json') || name === 'installation.seal' || name === 'bridge-key') {
                fs.rmSync(path.join(store, name), { force: true });
                removed.push(name);
            }
        }
        check(removed.includes('installation.json'), 'the store had no installation.json to lose');
        this.startDaemon();
        const lost = await this.waitManager();
        check(lost.state === 'recovery' && lost.reason === 'MANAGER_STORE_MISSING', `a lost store gave state ${lost.state} (${lost.reason}), not recovery MANAGER_STORE_MISSING`);
        this.state.lostStoreStatus = lost.state;
        await this.stopDaemon();
        const answers = this.answersFile('adopt', { command: 'adopt', label: 'acceptance', roots: this.roots, layout: 'standalone' });
        const result = await this.cli(step, ['adopt', '--answers', answers, '--yes', '--json']);
        check(result.code === 0, `adopt exited ${result.code}: ${this.why(result)}`);
        const status = await this.cliStatus(step);
        check(status.state === 'claimed' && status.installation, `after adopt the installation is ${status.state}`);
        this.installationId = status.installation.installationId;
        check(status.installation.release && status.installation.release.version, 'the adopted installation records no release');
        this.startDaemon();
        await this.waitManager();
        await this.waitHealthy();
        return `store lost -> recovery MANAGER_STORE_MISSING -> adopted (origin ${status.installation.origin}, ${removed.length} store files removed)`;
    }

    async stepOwner(step) {
        const run = await this.api.operation('owner.create', { loginName: OWNER_LOGIN, password: this.password });
        check(run.operation.status === 'applied', `owner.create ended ${run.operation.status}`);
        check(run.result && run.result.created === true, 'owner.create reported no account created');
        const second = await this.api.call('POST', '/operations', { kind: 'owner.create', input: { loginName: 'second-owner', password: `${this.password}-two` } });
        let again;
        if (second.status === 200) {
            const id = second.json.operation.id;
            const validated = await this.api.call('POST', `/operations/${id}/validate`, {});
            const applied = validated.status === 200 ? await this.api.call('POST', `/operations/${id}/apply`, { revision: validated.json.operation.revision }) : validated;
            again = applied.status === 200 ? 'accepted' : `refused ${applied.json && applied.json.error ? applied.json.error.code : applied.status}`;
        } else {
            again = `refused ${second.json && second.json.error ? second.json.error.code : second.status}`;
        }
        check(again !== 'accepted', 'a second owner.create was accepted: this is the first-operator path only');
        step.command({ command: 'POST /manager/api/operations owner.create (recovery session)', exitCode: 200, durationMs: 0 });
        return { result: `first operator created through a recovery session; a second owner.create ${again}` };
    }

    async stepChat(step) {
        await this.portalLogin();
        const before = this.fake.chatRequests();
        const turn = await this.portalChat('Say hello to the new installation.');
        check(turn.status === 200, `the chat turn answered ${turn.status}`);
        check(turn.ok, 'the chat stream did not finish');
        check(turn.reply === REPLY, 'the reply is not the fake model\'s sentence');
        check(this.fake.chatRequests() > before, 'the fake model was never asked');
        const conversations = await this.conversations();
        check(conversations.length >= 1, 'the turn left no conversation');
        this.markerConversation = turn.conversationId;
        this.state.conversationCount = conversations.length;
        step.command({ command: 'POST /api/app/chat (signed in)', exitCode: 200, durationMs: 0 });
        return { result: `signed in, one turn answered by the fake provider, ${conversations.length} conversation kept` };
    }
}

module.exports = { Cell, OWNER_LOGIN, FEATURE_ROUTE, FEATURE_ID, parseSse, notApplicable, deferred };
