/**
 * `goobster-manager update <sub>` (documentation/manager_update.md).
 *
 *   update status                          what is installed, the policy, what is staged, any pending decision (read only)
 *   update check                           ask the configured source what it offers (writes only last-check.json)
 *   update stage                           download, verify and stage the offered release; the running one does not change
 *   update apply [--now|--window]          apply the staged release inside the maintenance barrier
 *   update policy [--mode off|check|download|apply] [--channel stable|prerelease]
 *                 [--source-dir <dir> | --github <owner/repo> | --source-url <base>]
 *                 [--window <days>/<start>-<end>/<tz> | --no-window]
 *   update recovery --decision restore|retry [--yes]
 *                                          the decision after a schema-changing update failed
 *
 * With a manager running on this machine (its loopback port answers) the command goes to it: a
 * recovery credential is minted from the store (this command runs on the machine, as
 * `--mint-recovery` does), exchanged for a local recovery session, and the request is made with
 * that session, so the running manager's own workers do the restart and the verification.
 * Without one the kind runs in this process with `via: 'local'` and the barrier, the flip and the
 * state files do the work; the next manager start finishes a handoff (it is the one that verifies).
 *
 * Nothing printed or reported names a path, an address, a token or a credential.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { ManagerError } = require('./errors');
const { resolveSettings } = require('./settings');
const { createManager } = require('./manager');

const SUBCOMMANDS = Object.freeze(['status', 'check', 'stage', 'apply', 'policy', 'recovery']);
const MODES = ['off', 'check', 'download', 'apply'];
const CHANNELS = ['stable', 'prerelease'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const quiet = { info() {}, warn() {}, error() {} };

/** Flags of `update`, validated; the sub-command is `flags.sub`. */
function checkArgs(flags, positional, CliError) {
    flags.sub = positional.shift() || '';
    if (!SUBCOMMANDS.includes(flags.sub)) throw new CliError('USAGE', `update needs a command: ${SUBCOMMANDS.join(', ')}.`);
    const own = { now: flags.now, window: flags.windowAt, mode: flags.mode, channel: flags.channel, sourceDir: flags.sourceDir, github: flags.github, sourceUrl: flags.sourceUrl, noWindow: flags.noWindow, decision: flags.decision };
    const allowed = {
        status: [], check: [], stage: [],
        apply: ['now', 'window'],
        policy: ['mode', 'channel', 'sourceDir', 'github', 'sourceUrl', 'window', 'noWindow'],
        recovery: ['decision']
    }[flags.sub];
    for (const [name, value] of Object.entries(own)) {
        if (value && !allowed.includes(name)) throw new CliError('USAGE', `--${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} does not apply to update ${flags.sub}.`);
    }
    if (flags.sub === 'apply' && flags.now && flags.windowAt) throw new CliError('USAGE', '--now and --window contradict each other.');
    if (flags.sub === 'recovery' && !flags.decision) throw new CliError('USAGE', 'update recovery needs --decision restore or --decision retry.');
    if (flags.sub === 'policy' && ![flags.mode, flags.channel, flags.sourceDir, flags.github, flags.sourceUrl, flags.windowAt, flags.noWindow].some(Boolean)) {
        throw new CliError('USAGE', 'update policy needs at least one of --mode, --channel, --source-dir, --github, --source-url, --window, --no-window.');
    }
    if ([flags.sourceDir, flags.github, flags.sourceUrl].filter(Boolean).length > 1) throw new CliError('USAGE', 'Name one source: --source-dir, --github or --source-url.');
    if (flags.noWindow && flags.windowAt) throw new CliError('USAGE', '--window and --no-window contradict each other.');
    if (flags.answers || flags.confirm || flags.dryRun) throw new CliError('USAGE', 'update takes no answers file, --confirm or --dry-run; "update apply" prints its plan and "update status" is the read-only view.');
}

/** `sun,mon/2-4/UTC` -> `{ days: [0, 1], startHour: 2, endHour: 4, tz: 'UTC' }`. */
function parseWindow(text, CliError) {
    const match = /^([a-z0-9,*]+)\/(\d{1,2})-(\d{1,2})\/([A-Za-z0-9_+\-/]+)$/.exec(String(text));
    if (!match) throw new CliError('USAGE', '--window is <days>/<startHour>-<endHour>/<timezone>, for example sun,sat/2-4/UTC (days: sun..sat, or * for every day).');
    const days = match[1] === '*' ? [0, 1, 2, 3, 4, 5, 6] : match[1].split(',').map((name) => {
        const at = DAYS.indexOf(name);
        if (at < 0) throw new CliError('USAGE', `"${name}" is not a weekday (sun, mon, tue, wed, thu, fri, sat).`);
        return at;
    });
    return { days, startHour: Number(match[2]), endHour: Number(match[3]), tz: match[4] };
}

function policyInput(flags, CliError) {
    const input = {};
    if (flags.mode) {
        if (!MODES.includes(flags.mode)) throw new CliError('USAGE', `--mode is one of ${MODES.join(', ')}.`);
        input.mode = flags.mode;
    }
    if (flags.channel) {
        if (!CHANNELS.includes(flags.channel)) throw new CliError('USAGE', `--channel is one of ${CHANNELS.join(', ')}.`);
        input.channel = flags.channel;
    }
    if (flags.sourceDir) input.source = { kind: 'directory', dir: flags.sourceDir };
    if (flags.github) {
        const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(flags.github);
        if (!match) throw new CliError('USAGE', '--github is <owner>/<repo>.');
        input.source = { kind: 'github-release', owner: match[1], repo: match[2] };
    }
    if (flags.sourceUrl) input.source = { kind: 'url', base: flags.sourceUrl };
    if (flags.windowAt) input.window = parseWindow(flags.windowAt, CliError);
    if (flags.noWindow) input.window = null;
    return input;
}

// ---------------------------------------------------------------- the daemon
function request({ port, method, path: requestPath, headers = {}, body }) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path: requestPath,
            agent: false,
            headers: {
                host: `127.0.0.1:${port}`,
                ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
                ...headers
            }
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { }
                resolve({ status: res.statusCode, body: json });
            });
        });
        req.on('error', reject);
        req.setTimeout(0);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

/** Is a manager answering on this machine's loopback port? Plain http only: a TLS (LAN) manager is not driven from here. */
async function daemonPort(settings) {
    if (!settings.port || settings.lan) return null;
    try {
        const probe = await Promise.race([
            request({ port: settings.port, method: 'GET', path: '/manager/api/status' }),
            new Promise((_resolve, reject) => { setTimeout(() => reject(new Error('timeout')), 1500).unref(); })
        ]);
        return probe.status === 200 && probe.body ? settings.port : null;
    } catch {
        return null;
    }
}

function asError(response) {
    const body = response.body || {};
    const error = body.error || {};
    const failure = new ManagerError(response.status || 502, error.code || 'MANAGER_ERROR', error.message || 'The manager refused the request.', error.details || undefined);
    if (body.operation) failure.operation = body.operation;
    return failure;
}

async function openSession(c, settings, port) {
    const manager = createManager({ settings, fs: c.fs, logger: quiet, extraKinds: require('./extensions').kinds });
    if (!manager.storeReady) throw new c.cli.CliError('STORE_UNUSABLE', 'The manager store cannot be read here.', c.cli.EXIT.REFUSED);
    if (manager.currentState().state !== 'claimed') return null;
    const minted = manager.credentials.recovery.mint();
    try { c.fs.rmSync(minted.file, { force: true }); } catch { }
    const unlocked = await request({ port, method: 'POST', path: '/manager/api/recovery/unlock', body: { credential: minted.credential } });
    c.secrets.push(minted.credential);
    if (unlocked.status !== 200 || !unlocked.body || !unlocked.body.session) throw asError(unlocked);
    c.secrets.push(unlocked.body.session.token);
    return unlocked.body.session.token;
}

async function viaDaemon(c, port, token, method, requestPath, body) {
    const response = await request({
        port,
        method,
        path: `/manager/api${requestPath}`,
        headers: { authorization: `Bearer ${token}`, ...(method === 'GET' ? {} : { 'x-goobster-nonce': crypto.randomBytes(12).toString('base64url') }) },
        body: method === 'GET' ? undefined : (body || {})
    });
    if (response.status < 200 || response.status >= 300) throw asError(response);
    return response.body;
}

// ------------------------------------------------------------------ output
function describeStatus(view) {
    if (!view.available) return [`update      not available (${view.code})`];
    const lines = [];
    lines.push(`installed   ${view.installed.version} (${view.installed.target}; ${view.installed.features.join(', ')}), updater ${view.updater || 'none'}`);
    const source = view.policy.source.kind === 'github-release' ? `github ${view.policy.source.owner}/${view.policy.source.repo}` : view.policy.source.kind;
    lines.push(`policy      ${view.policy.mode}${view.policy.effectiveMode !== view.policy.mode ? ` (acts as ${view.policy.effectiveMode}: ${view.policy.capped})` : ''}, channel ${view.policy.channel}, source ${source}${view.policy.window ? `, window ${view.policy.window.startHour}-${view.policy.window.endHour} ${view.policy.window.tz}` : ''}`);
    if (view.lastCheck) lines.push(`last check  ${view.lastCheck.at}: ${view.lastCheck.outcome}${view.lastCheck.code ? ` (${view.lastCheck.code})` : ''}${view.lastCheck.latest ? `, offers ${view.lastCheck.latest.version}` : ''}`);
    else lines.push('last check  never');
    lines.push(`staged      ${view.staged ? `${view.staged.version}${view.staged.schemaChanging ? ' (changes the database schema)' : ''}${view.staged.stale ? ' (STALE: stage again)' : ''}` : 'nothing'}`);
    if (view.scheduled) lines.push(`scheduled   applies when the window opens (${view.scheduled.opensAt})`);
    if (view.handoff) lines.push(`handoff     ${view.handoff.phase}: ${view.handoff.from} -> ${view.handoff.to}${view.watchdog ? `, watchdog ${view.watchdog.expired ? 'EXPIRED' : `until ${view.watchdog.deadline}`}` : ''}`);
    if (view.recovery) {
        lines.push(`DECISION    the update to ${view.recovery.to.version} failed (${view.recovery.code}); the maintenance barrier is held`);
        lines.push(`            ${view.recovery.warning}`);
        lines.push('            decide with: update recovery --decision restore   or   update recovery --decision retry');
    }
    if (view.lastApply) lines.push(`last apply  ${view.lastApply.outcome}${view.lastApply.code ? ` (${view.lastApply.code})` : ''}: ${view.lastApply.from.version} -> ${view.lastApply.to.version}${view.lastApply.downtimeMs !== undefined ? `, downtime ${view.lastApply.downtimeMs} ms` : ''}`);
    if (view.handoffAvailability) lines.push(`handoff     ${view.handoffAvailability.mode}${view.handoffAvailability.mode === 'exit' ? ` (the manager leaves with exit code ${view.handoffAvailability.exitCode})` : ''}`);
    return lines;
}

function describeResult(sub, result) {
    if (!result) return [];
    if (sub === 'check') {
        if (result.outcome === 'available') return [`available   ${result.latest.version} (${result.latest.channel}, ${result.latest.signed ? 'signed' : 'UNSIGNED'}${result.size ? `, ${result.size} bytes` : ''})`];
        if (result.outcome === 'up-to-date') return [`up to date  the source offers ${result.latest.version}`];
        return [`blocked     ${result.code}`];
    }
    if (sub === 'stage') {
        return result.staged ? [`staged      ${result.version}${result.schemaChanging ? ' (changes the database schema: a failure after the database was used needs your decision)' : ' (no schema change: a failure rolls back automatically)'}`] : ['nothing staged'];
    }
    if (sub === 'apply') {
        if (result.outcome === 'scheduled') return ['scheduled   outside the window; it applies when the window opens'];
        if (result.outcome === 'applied') return [`applied     ${result.from} -> ${result.to}, downtime ${result.downtimeMs} ms${result.backup ? ', verified backup taken first' : ''}`, ...(result.service ? [`service     registration ${result.service.template}${result.service.code ? ` (${result.service.code})` : ''}`] : [])];
        return [`handed over ${result.from} -> ${result.to}`, `            ${result.handoff}`];
    }
    if (sub === 'policy') return [`policy      ${result.policy.mode}, channel ${result.policy.channel}, source ${result.policy.source ? result.policy.source.kind : 'default'}${result.policy.window ? ', window set' : ''}`];
    if (sub === 'recovery') {
        if (result.outcome === 'applied') return [`applied     the new release verified; downtime ${result.downtimeMs} ms`];
        if (result.outcome === 'rolled_back') return [`rolled back the previous release is running again${result.downtimeMs !== null && result.downtimeMs !== undefined ? `; downtime ${result.downtimeMs} ms` : ''}`];
        return [`handed over ${result.outcome}: the manager restarts once more to finish`];
    }
    return [];
}

// --------------------------------------------------------------------- run
const KIND_FOR = { check: 'update.check', stage: 'update.stage', apply: 'update.apply', policy: 'update.policy' };
const ROUTE_FOR = { check: '/update/check', stage: '/update/stage', apply: '/update/apply', policy: '/update/policy', recovery: '/update/recovery' };

async function run(c) {
    const { flags, fs, json } = c;
    const { CliError, EXIT } = c.cli;
    const settings = resolveSettings(c.baseEnv, { fs });
    const sub = flags.sub;

    const body = sub === 'apply' ? { when: flags.windowAt ? 'window' : 'now' } : (sub === 'policy' ? policyInput(flags, CliError) : (sub === 'recovery' ? { decision: flags.decision } : {}));
    if (sub === 'recovery' && !['restore', 'retry'].includes(flags.decision)) throw new CliError('USAGE', '--decision is restore or retry.');

    const port = await daemonPort(settings);
    let token = null;
    if (port) {
        token = await openSession(c, settings, port);
        if (!token) throw new CliError('NOT_INSTALLED', 'There is no claimed installation to update.', EXIT.REFUSED);
    }

    if (sub === 'status') {
        let view;
        if (port) {
            view = await viaDaemon(c, port, token, 'GET', '/update/status');
        } else {
            const manager = createManager({ settings, fs, logger: quiet, extraKinds: require('./extensions').kinds });
            if (!manager.storeReady) throw new CliError('STORE_UNUSABLE', 'The manager store cannot be read here.', EXIT.REFUSED);
            view = require('./update/status').buildStatus({ manager, settings, fs, now: manager.now });
        }
        if (!json) for (const line of describeStatus(view)) c.out(line);
        return c.finish(EXIT.OK, { update: view });
    }

    if (sub === 'recovery' && flags.decision === 'restore' && !flags.yes) {
        throw new CliError('CONFIRMATION_REQUIRED', 'Restoring returns the data to the backup taken before the update; every write since then is lost. Read "update status" for the time, then run this again with --yes.', EXIT.INVALID);
    }

    let outcome;
    if (port) {
        if (!json) c.progress(`update ${sub} -> the running manager`);
        outcome = await viaDaemon(c, port, token, 'POST', ROUTE_FOR[sub], body);
    } else {
        const manager = createManager({
            settings,
            fs,
            logger: quiet,
            extraKinds: require('./extensions').kinds,
            ...(c.io.now ? { now: c.io.now } : {}),
            hooks: { beforeStep: ({ kind, step }) => { if (!json) c.progress(`[${kind}] ${step} ...`); } }
        });
        if (!manager.storeReady) throw new CliError('STORE_UNUSABLE', 'The manager store cannot be created or written here.', EXIT.REFUSED);
        await manager.engine.recoverInterrupted();
        if (sub === 'recovery') {
            const decide = require('./update/wiring').decider(settings.storeDir);
            if (!decide) throw new CliError('NOT_AVAILABLE', 'This manager has no update machinery.', EXIT.REFUSED);
            outcome = await decide({ decision: flags.decision, auth: c.cli.LOCAL_AUTH });
        } else {
            outcome = await manager.engine.run(KIND_FOR[sub], body, c.cli.LOCAL_AUTH);
        }
    }

    const result = outcome.result === undefined ? null : outcome.result;
    if (!json) {
        c.out(`update ${sub}: ${outcome.operation ? outcome.operation.status : 'ok'}`);
        for (const line of describeResult(sub, result)) c.out(`  ${line}`);
    }
    return c.finish(EXIT.OK, {
        operation: outcome.operation ? { id: outcome.operation.id, kind: outcome.operation.kind, status: outcome.operation.status } : null,
        result
    });
}

module.exports = { run, checkArgs, parseWindow, describeStatus, describeResult, SUBCOMMANDS };
