/**
 * Discovery: read-only detection of existing Goobster installations on this
 * host (documentation/manager_install.md, issue #329).
 *
 * Detects a source checkout with `data/goobster.sqlite` (manual), the
 * Raspberry Pi layout of `scripts/install-rpi.sh`, a PM2 app, a Docker
 * compose project and a payload install (`current/payload-manifest.json`).
 * It reads files and runs five read-only commands from a closed list
 * (`systemctl show`, `crontab -l`, `pm2 jlist`, `docker compose ls`, and a label-filtered `docker ps`); it
 * writes nothing, installs nothing and never adopts what it finds - an
 * operator names one candidate to `adopt`.
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const model = require('./model');
const { discordAdapterEnabled } = require('../lifecycle/layouts');
const serviceRecord = require('../platform/serviceRecord');
const rootsEnv = require('../platform/rootsEnv');

const MARKER_FILE = '.install-origin';
const EXEC_TIMEOUT_MS = 4000;
const SERVICE_UNIT = 'goobster.service';
const UPDATE_TIMER = 'goobster-update.timer';
const PM2_APP = 'goobster';

/** The only commands discovery may run: each one reads state. */
const READS = Object.freeze({
    'systemctl-service': ['systemctl', ['show', SERVICE_UNIT, '--property=LoadState,ActiveState,FragmentPath,WorkingDirectory,User']],
    'systemctl-timer': ['systemctl', ['show', UPDATE_TIMER, '--property=LoadState,ActiveState,UnitFileState']],
    crontab: ['crontab', ['-l']],
    'pm2-jlist': ['pm2', ['jlist']],
    'docker-compose-ls': ['docker', ['compose', 'ls', '--all', '--format', 'json']],
    'docker-owned-databases': ['docker', ['ps', '--all', '--filter', 'label=io.goobster.manager=1', '--filter', 'label=io.goobster.role=postgres', '--format', '{{json .}}']],
    'native-clusters': ['pg_lsclusters', ['--no-header']],
    'native-units': ['systemctl', ['list-unit-files', 'postgresql17-goobster*', '--no-legend', '--no-pager']]
});

/** @returns {(name: keyof typeof READS) => string|null} stdout, or null when the command is absent or fails */
function defaultExec(name) {
    const entry = READS[name];
    if (!entry) throw new Error(`discovery may not run "${name}"`);
    try {
        return childProcess.execFileSync(entry[0], entry[1], { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return null;
    }
}

function exists(fs, target) {
    try {
        fs.statSync(target);
        return true;
    } catch {
        return false;
    }
}

function readText(fs, file, max = 1 << 20) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        return text.length > max ? text.slice(0, max) : text;
    } catch {
        return null;
    }
}

function readJson(fs, file) {
    const text = readText(fs, file);
    if (text === null) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function parseProperties(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
        const at = line.indexOf('=');
        if (at > 0) out[line.slice(0, at)] = line.slice(at + 1).trim();
    }
    return out;
}

function candidateId(codeRoot) {
    return crypto.createHash('sha256').update(`goobster-candidate|${path.resolve(codeRoot)}`).digest('hex').slice(0, 12);
}

function looksLikeGoobster(fs, dir) {
    const pkg = readJson(fs, path.join(dir, 'package.json'));
    return Boolean(pkg && (pkg.name === 'goobster' || pkg.name === '@goobster/workspace' || (Array.isArray(pkg.workspaces) && exists(fs, path.join(dir, 'apps', 'manager')))));
}

function sqliteEngine(fs, roots) {
    return exists(fs, path.join(roots.data, 'goobster.sqlite')) ? 'sqlite' : null;
}

function layoutOf(fs, roots, services) {
    if (services.some(entry => entry.kind === 'docker')) return 'paired';
    const config = readJson(fs, roots.config) || {};
    return discordAdapterEnabled({ env: {}, config }) ? 'lite' : 'standalone';
}

/** Cron lines (user crontab) that run this installation's auto-update.sh. */
function cronUpdaters(exec, codeRoot) {
    const text = exec('crontab');
    if (!text) return [];
    const out = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('auto-update.sh')) continue;
        if (trimmed.includes(codeRoot)) out.push({ kind: 'auto-update.sh', mechanism: 'cron', unit: null });
    }
    return out;
}

function timerUpdaters(exec, fs, codeRoot, env) {
    const props = parseProperties(exec('systemctl-timer'));
    const conf = readText(fs, env.GOOBSTER_UPDATE_CONF || '/etc/goobster-update.conf');
    const targets = conf ? /^\s*(?:export\s+)?GOOBSTER_REPO_DIR=(.+)$/m.exec(conf) : null;
    const repo = targets ? targets[1].trim().replace(/^["']|["']$/g, '') : null;
    const active = props.LoadState === 'loaded' && (props.ActiveState === 'active' || props.UnitFileState === 'enabled');
    if (!active) return [];
    if (repo && path.resolve(repo) !== path.resolve(codeRoot)) return [];
    return [{ kind: 'auto-update.sh', mechanism: 'systemd-timer', unit: UPDATE_TIMER }];
}

/** A system cron file (/etc/cron.d) with a line that runs auto-update.sh for this code root. */
function systemCronUpdaters(fs, codeRoot, env) {
    const dir = env.GOOBSTER_CRON_DIR || '/etc/cron.d';
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const out = [];
    for (const name of names.sort()) {
        if (!/^[a-z][a-z0-9._-]{0,63}$/.test(name)) continue;
        const text = readText(fs, path.join(dir, name));
        if (!text) continue;
        const live = text.split('\n').some((line) => {
            const trimmed = line.trim();
            return trimmed && !trimmed.startsWith('#') && trimmed.includes('auto-update.sh') && trimmed.includes(codeRoot);
        });
        if (live) out.push({ kind: 'auto-update.sh', mechanism: 'cron-system', unit: name });
    }
    return out;
}

function systemdService(exec) {
    const props = parseProperties(exec('systemctl-service'));
    if (props.LoadState !== 'loaded') return null;
    return { name: SERVICE_UNIT, active: props.ActiveState === 'active', workingDirectory: props.WorkingDirectory || null, user: props.User || null };
}

function pm2Apps(exec) {
    const text = exec('pm2-jlist');
    if (!text) return [];
    let list;
    try {
        list = JSON.parse(text.slice(text.indexOf('[')));
    } catch {
        return [];
    }
    if (!Array.isArray(list)) return [];
    return list
        .filter(entry => entry && entry.name === PM2_APP && entry.pm2_env && typeof entry.pm2_env.pm_cwd === 'string')
        .map(entry => ({ name: entry.name, cwd: entry.pm2_env.pm_cwd, watch: Boolean(entry.pm2_env.watch), user: entry.pm2_env.username || null }));
}

function composeProjects(exec, fs) {
    const text = exec('docker-compose-ls');
    if (!text) return [];
    let list;
    try {
        list = JSON.parse(text);
    } catch {
        return [];
    }
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const entry of list) {
        const first = String(entry && entry.ConfigFiles || '').split(',')[0].trim();
        if (!first) continue;
        const dir = path.dirname(first);
        const code = path.basename(dir) === 'deploy' ? path.dirname(dir) : dir;
        if (!looksLikeGoobster(fs, code) && !/goobster/i.test(String(entry.Name || ''))) continue;
        out.push({ name: String(entry.Name || 'goobster'), code, status: String(entry.Status || '') });
    }
    return out;
}

/**
 * Docker Postgres containers this manager created (documentation/docker_postgres.md),
 * recognised by their labels alone: a report, not a candidate (a database is not an
 * installation, and the paired compose detection above is unchanged).
 */
function ownedDatabases(exec) {
    let text;
    try {
        text = exec('docker-owned-databases');
    } catch {
        return [];
    }
    if (!text) return [];
    const out = [];
    for (const line of String(text).split('\n')) {
        let row;
        try {
            row = line.trim() ? JSON.parse(line) : null;
        } catch {
            row = null;
        }
        if (!row || typeof row.Names !== 'string') continue;
        const labels = String(row.Labels || '');
        const match = /(?:^|,)io\.goobster\.installation=([0-9a-f-]{36})(?:,|$)/i.exec(labels);
        out.push({ container: row.Names.split(',')[0], installationId: match ? match[1].toLowerCase() : null, state: String(row.State || '') });
    }
    return out;
}

/**
 * Native PostgreSQL clusters this installer created (documentation/native_postgres.md),
 * recognised by the fixed names it gives them (`goobster`, `goobster-<id8>`): a report,
 * not a candidate. Debian family: `pg_lsclusters`; RPM family: the unit files. A cluster
 * that merely has such a name is only ever listed here; nothing acts on it from this list.
 */
function nativeDatabases(exec) {
    const out = [];
    const safe = (name) => {
        try { return exec(name); } catch { return null; }
    };
    for (const line of String(safe('native-clusters') || '').split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 6 || !/^\d{1,2}$/.test(fields[0]) || !/^goobster(-[0-9a-f]{8})?$/.test(fields[1])) continue;
        out.push({ cluster: fields[1], version: Number(fields[0]), port: Number(fields[2]) || null, state: fields[3].startsWith('online') ? 'online' : 'down', source: 'pg_lsclusters' });
    }
    for (const line of String(safe('native-units') || '').split('\n')) {
        const match = /^postgresql(\d{1,2})-(goobster(?:-[0-9a-f]{8})?)\.service\b/.exec(line.trim());
        if (match) out.push({ cluster: match[2], version: Number(match[1]), port: null, state: 'registered', source: 'systemd' });
    }
    return out;
}

function addEvidence(candidate, ...codes) {
    for (const code of codes) if (!candidate.evidence.includes(code)) candidate.evidence.push(code);
}

/**
 * @param {Object} [options]
 * @param {Object} [options.fs]
 * @param {string} [options.home]
 * @param {Object} [options.env]
 * @param {string[]} [options.searchRoots] directories to look in besides the defaults
 * @param {(name: string) => string|null} [options.exec] read-only command runner (tests)
 * @returns {{ candidates: Array<Object>, searched: number, dockerDatabases: Array<{ container: string, installationId: string|null, state: string }>, nativeDatabases: Array<{ cluster: string, version: number, port: number|null, state: string, source: string }> }}
 */
function discover({ fs = nodeFs, home = os.homedir(), env = process.env, searchRoots = [], exec = defaultExec } = {}) {
    const byRoot = new Map();
    const touch = (code, kind) => {
        const root = path.resolve(code);
        if (!byRoot.has(root)) {
            byRoot.set(root, { id: candidateId(root), kind, root, services: [], updaters: [], evidence: [], extraKinds: [] });
        }
        return byRoot.get(root);
    };

    const places = [...searchRoots, env.GOOBSTER_WORKSPACE_ROOT, path.join(home, 'goobster'), path.join(home, 'Goobster'), '/opt/goobster', '/srv/goobster']
        .filter(Boolean).map(dir => path.resolve(dir));
    const seen = new Set();
    for (const dir of places) {
        if (seen.has(dir)) continue;
        seen.add(dir);
        if (!exists(fs, dir)) continue;
        const roots = model.defaultRoots(dir);
        const payload = exists(fs, path.join(dir, 'current', 'payload-manifest.json'));
        const source = looksLikeGoobster(fs, dir);
        const sqlite = Boolean(sqliteEngine(fs, roots));
        const marker = readJson(fs, path.join(roots.data, MARKER_FILE));
        if (payload) {
            const candidate = touch(dir, 'payload');
            addEvidence(candidate, 'PAYLOAD_CURRENT');
        } else if (source && (sqlite || marker)) {
            const candidate = touch(dir, marker && marker.kind === 'rpi-script' ? 'rpi' : 'manual');
            addEvidence(candidate, 'SOURCE_CHECKOUT');
        } else if (sqlite && exists(fs, roots.config)) {
            const candidate = touch(dir, 'manual');
            addEvidence(candidate, 'DATA_AND_CONFIG');
        }
        const candidate = byRoot.get(dir);
        if (candidate) {
            if (sqlite) addEvidence(candidate, 'SQLITE_PRESENT');
            if (marker && marker.kind === 'rpi-script') {
                candidate.kind = 'rpi';
                addEvidence(candidate, 'RPI_MARKER');
            }
            if (exists(fs, path.join(home, '.local', 'goobster-venv'))) addEvidence(candidate, 'MUSIC_VENV');
            if (exists(fs, path.join(dir, 'ecosystem.config.js'))) addEvidence(candidate, 'ECOSYSTEM_CONFIG');
        }
    }

    const service = systemdService(exec);
    if (service && service.workingDirectory) {
        const root = path.resolve(service.workingDirectory);
        const candidate = byRoot.get(root) || (exists(fs, root) && looksLikeGoobster(fs, root) ? touch(root, 'rpi') : null);
        if (candidate) {
            candidate.services.push({ kind: 'systemd', name: service.name, registeredBy: 'system' });
            addEvidence(candidate, 'SYSTEMD_UNIT');
            if (candidate.kind === 'manual') candidate.kind = 'rpi';
        }
    }

    for (const app of pm2Apps(exec)) {
        const root = path.resolve(app.cwd);
        const candidate = byRoot.get(root) || (exists(fs, root) ? touch(root, 'pm2') : null);
        if (!candidate) continue;
        candidate.services.push({ kind: 'pm2', name: app.name, registeredBy: 'system' });
        addEvidence(candidate, 'PM2_APP');
        if (candidate.kind === 'manual') candidate.kind = 'pm2';
        if (app.watch) {
            candidate.updaters.push({ kind: 'pm2', mechanism: 'pm2-watch', unit: app.name });
            addEvidence(candidate, 'PM2_WATCH');
        }
    }

    for (const project of composeProjects(exec, fs)) {
        const root = path.resolve(project.code);
        const candidate = byRoot.get(root) || touch(root, 'docker');
        candidate.services.push({ kind: 'docker', name: project.name, registeredBy: 'system' });
        addEvidence(candidate, 'COMPOSE_PROJECT');
        if (!candidate.evidence.some(code => ['SOURCE_CHECKOUT', 'PAYLOAD_CURRENT', 'DATA_AND_CONFIG'].includes(code))) candidate.kind = 'docker';
    }

    const candidates = [];
    for (const candidate of byRoot.values()) {
        for (const entry of cronUpdaters(exec, candidate.root)) {
            candidate.updaters.push(entry);
            addEvidence(candidate, 'CRON_AUTO_UPDATE');
        }
        for (const entry of timerUpdaters(exec, fs, candidate.root, env)) {
            candidate.updaters.push(entry);
            addEvidence(candidate, 'AUTO_UPDATE_TIMER');
        }
        for (const entry of systemCronUpdaters(fs, candidate.root, env)) {
            candidate.updaters.push(entry);
            addEvidence(candidate, 'CRON_SYSTEM_AUTO_UPDATE');
        }
        const roots = model.defaultRoots(candidate.root);
        const stated = rootsEnv.readRootsEnv(candidate.root, fs);
        const registered = serviceRecord.readRecord(stated.GOOBSTER_MANAGER_STATE_DIR || roots.managerStore, fs);
        for (const entry of registered.services) {
            const seenUnit = candidate.services.find(item => item.name === `${entry.name}.service` || item.name === entry.name);
            if (seenUnit) seenUnit.registeredBy = 'installer';
            else candidate.services.push({ kind: entry.kind, name: entry.name, registeredBy: 'installer' });
            addEvidence(candidate, 'INSTALLER_SERVICE_RECORD');
        }
        const updater = candidate.updaters.length ? { kind: candidate.updaters[0].kind, ...(candidate.updaters[0].unit ? { unit: candidate.updaters[0].unit } : {}) } : { kind: 'none' };
        candidates.push({
            id: candidate.id,
            kind: candidate.kind,
            roots,
            layout: layoutOf(fs, roots, candidate.services),
            services: candidate.services.length ? candidate.services : [{ kind: 'none', name: 'none', registeredBy: 'unknown' }],
            updater,
            updaters: candidate.updaters.map(entry => ({ kind: entry.kind, mechanism: entry.mechanism, unit: entry.unit || null })),
            dbEngine: candidate.kind === 'docker' ? 'postgres' : (sqliteEngine(fs, roots) || 'unknown'),
            evidence: candidate.evidence.sort()
        });
    }
    candidates.sort((a, b) => (a.roots.code < b.roots.code ? -1 : 1));
    return { candidates, searched: seen.size, dockerDatabases: ownedDatabases(exec), nativeDatabases: nativeDatabases(exec) };
}

module.exports = { discover, candidateId, defaultExec, READS, MARKER_FILE, SERVICE_UNIT, UPDATE_TIMER };
