/**
 * What is on this machine, read-only (documentation/native_postgres.md,
 * "Inspection"): the distribution, the packages, every PostgreSQL cluster
 * already here with its port and owner, whether pgvector and citext are
 * installed or obtainable, the host's backup client, and the file system and
 * free space of a candidate data directory.
 *
 * Every existing cluster is FOREIGN unless the manager's own record names it
 * (and, where a cluster can be asked, its data directory carries the
 * installation's marker). A foreign cluster is reported, its port is avoided,
 * and nothing in it is ever read beyond its entry in the cluster listing.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const detectDistro = require('./distro');
const packages = require('./packages');
const mounts = require('./mounts');
const names = require('./names');
const { createRunner } = require('./runner');
const image = require('../docker/image');
const { freeBytes, nearestExisting } = require('../docker/daemon');
const { probeListen } = require('../docker/containers');

const MIN_FREE_BYTES = 1024 * 1024 * 1024;
const PG_DUMP_TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------- parsers

/** `pg_lsclusters --no-header`: `17 main 5432 online postgres /var/lib/postgresql/17/main /var/log/postgresql/postgresql-17-main.log` */
function parseLsClusters(text) {
    const out = [];
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line || /^Ver\s+Cluster/i.test(line)) continue;
        const fields = line.split(/\s+/);
        if (fields.length < 6) continue;
        const [version, name, port, status, owner, dataDirectory] = fields;
        if (!/^\d{1,2}$/.test(version) || !/^\d{1,5}$/.test(port)) continue;
        out.push({ version: Number(version), name, port: Number(port), status, online: status.startsWith('online'), owner, dataDirectory, source: 'pg_lsclusters' });
    }
    return out;
}

/** `dpkg-query -W -f='${Package} ${Version} ${db:Status-Abbrev}\n'` */
function parseDpkg(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields.length >= 3 && /^ii/.test(fields[2])) out[fields[0]] = fields[1];
    }
    return out;
}

/** `rpm -q --qf '%{NAME} %{VERSION}-%{RELEASE}\n' ...` (a missing package prints "package X is not installed") */
function parseRpm(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
        if (/is not installed/.test(line)) continue;
        const fields = line.trim().split(/\s+/);
        if (fields.length === 2 && /^[A-Za-z0-9_.+-]+$/.test(fields[0])) out[fields[0]] = fields[1];
    }
    return out;
}

/** `apt-cache policy <pkg>`: the Candidate line. */
function parseAptCandidate(text) {
    const match = /^\s*Candidate:\s*(\S+)/m.exec(String(text || ''));
    return match && match[1] !== '(none)' ? match[1] : null;
}

/** `df -Pk <path>` -> available bytes */
function parseDf(text) {
    const lines = String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
    const fields = (lines[1] || '').split(/\s+/);
    const available = Number(fields[3]);
    return Number.isFinite(available) ? available * 1024 : null;
}

/** `/etc/passwd` -> the account named `name`. */
function passwdEntry(text, name) {
    for (const line of String(text || '').split('\n')) {
        const fields = line.split(':');
        if (fields[0] === name && fields.length >= 7) return { name, uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5], shell: fields[6] };
    }
    return null;
}

/** Whether `account` can search every directory above `target` (judged from owner, group and mode; groups beyond the primary are not consulted). */
function reachableBy(account, target, fs = nodeFs) {
    let dir = nodePath.dirname(target);
    for (;;) {
        let stat;
        try { stat = fs.statSync(dir); } catch { return { ok: true, blockedAt: null }; }
        const bit = stat.uid === account.uid ? 0o100 : (stat.gid === account.gid ? 0o010 : 0o001);
        if ((stat.mode & bit) === 0) return { ok: false, blockedAt: dir };
        const parent = nodePath.dirname(dir);
        if (parent === dir) return { ok: true, blockedAt: null };
        dir = parent;
    }
}

/** Debian-family package state of the four roles. */
function roleState(family, installed, candidates = {}) {
    const table = packages.table(family);
    const out = {};
    for (const role of ['server', 'client', 'pgvector', 'contrib']) {
        const wanted = table[role];
        if (wanted.length === 0) {
            out[role] = { names: [], installed: role === 'contrib' ? Boolean(out.server && out.server.installed) : false, version: null, availability: 'bundled', note: role === 'contrib' ? 'Debian ships the contrib extensions (citext) inside the server package.' : null };
            continue;
        }
        const present = wanted.filter(name => installed[name]);
        const all = present.length === wanted.length;
        const candidate = wanted.map(name => candidates[name]).find(Boolean) || null;
        out[role] = { names: [...wanted], installed: all, version: installed[wanted[0]] || null, availability: all ? 'installed' : (candidate ? 'available' : 'via-pgdg'), candidate };
    }
    return out;
}

// ---------------------------------------------------------------- inspection

/**
 * @param {Object} params
 * @param {Object} [params.fs]
 * @param {{ run: Function }} [params.runner]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {Object} [params.distro]            pre-detected (tests)
 * @param {Object|null} [params.record]       the manager's record of OUR cluster (native-postgres.json), or null
 * @param {string|null} [params.candidatePath] a data directory to evaluate
 * @param {number} [params.requiredBytes]
 * @param {Function} [params.probePort]       `(port, bind) => Promise<boolean>` is it free
 * @param {string} [params.platform]
 * @param {string} [params.arch]
 */
async function inspectHost({ fs = nodeFs, runner = null, env = process.env, distro = null, record = null, candidatePath = null, requiredBytes = MIN_FREE_BYTES, probePort = probeListen, platform = process.platform, arch } = {}) {
    const run = (runner || createRunner({ env })).run;
    const facts = distro || detectDistro.detect({ fs, platform, ...(arch ? { arch } : {}) });
    const report = {
        distro: facts,
        supported: facts.supported,
        reason: facts.reason,
        remedy: facts.remedy || null,
        packageManager: facts.family ? packages.table(facts.family).manager : null,
        major: packages.MAJOR,
        packages: null,
        backupTools: null,
        clusters: [],
        ports: { inUse: [] },
        systemd: { available: false },
        selinux: null,
        storage: null,
        postgresAccount: null,
        findings: []
    };
    if (!facts.supported) return report;

    const layout = packages.layoutFor(facts.family);
    const clusterRecord = record && record.cluster ? record.cluster : null;

    // packages
    let installed;
    const candidates = {};
    if (facts.family === 'debian') {
        const wanted = packages.allNames('debian');
        const dpkg = await run('dpkg-query', ['-W', '-f=${Package} ${Version} ${db:Status-Abbrev}\\n', ...wanted]);
        installed = parseDpkg(dpkg.stdout);
        for (const name of [...packages.table('debian').server, ...packages.table('debian').client, ...packages.table('debian').pgvector]) {
            if (installed[name]) continue;
            const policy = await run('apt-cache', ['policy', name]);
            const candidate = policy.code === 0 ? parseAptCandidate(policy.stdout) : null;
            if (candidate) candidates[name] = candidate;
        }
    } else {
        const wanted = packages.allNames('rhel');
        const rpm = await run('rpm', ['-q', '--qf', '%{NAME} %{VERSION}-%{RELEASE}\\n', ...wanted]);
        installed = parseRpm(rpm.stdout);
    }
    report.packages = roleState(facts.family, installed, candidates);

    // clusters
    if (facts.family === 'debian') {
        const listing = await run('pg_lsclusters', ['--no-header']);
        report.clusters = listing.missing ? [] : parseLsClusters(listing.stdout);
    } else {
        report.clusters = await rhelClusters({ fs, run, layout });
    }
    for (const cluster of report.clusters) {
        const ours = Boolean(clusterRecord) && cluster.name === clusterRecord.name && Number(cluster.version) === packages.MAJOR;
        cluster.owned = ours;
        cluster.ownerKind = ours ? 'goobster' : 'foreign';
    }
    report.ports.inUse = [...new Set(report.clusters.map(cluster => cluster.port).filter(Number.isInteger))].sort((a, b) => a - b);

    // systemd and SELinux
    const systemctl = await run('systemctl', ['is-system-running']);
    const state = systemctl.stdout.trim();
    report.systemd = { available: ['running', 'degraded', 'starting', 'initializing'].includes(state), state: state || null };
    const getenforce = await run('getenforce', []);
    report.selinux = getenforce.missing ? { present: false, mode: null } : { present: true, mode: getenforce.stdout.trim() || null };

    // the postgres account
    let passwd = '';
    try { passwd = fs.readFileSync('/etc/passwd', 'utf8'); } catch { /* unreadable */ }
    report.postgresAccount = passwdEntry(passwd, 'postgres');

    // backup client
    const pgDump = await runPgDump({ run, env });
    const clientMajor = pgDump.present ? image.parseClientMajor(pgDump.text) : null;
    const compat = image.backupCompatibility(clientMajor);
    report.backupTools = { ...compat, version: pgDump.present ? pgDump.text.trim().split('\n')[0].slice(0, 120) : null, installedPackage: report.packages.client.installed };

    // storage
    const target = candidatePath || (clusterRecord ? clusterRecord.dataDirectory : `${layout.defaultDataParent}/goobster`);
    report.storage = await storageFacts({ fs, run, target, requiredBytes, account: report.postgresAccount });
    report.storage.candidate = Boolean(candidatePath);
    report.layout = layout;
    return report;
}

async function runPgDump({ run, env }) {
    const bin = env.GOOBSTER_PG_BIN ? nodePath.join(env.GOOBSTER_PG_BIN, 'pg_dump') : 'pg_dump';
    const out = await run(bin, ['--version'], { timeoutMs: PG_DUMP_TIMEOUT_MS });
    return out.code === 0 ? { present: true, text: out.stdout } : { present: false, text: '' };
}

/** RPM family: clusters are systemd units and `/var/lib/pgsql/<major>/<dir>` directories; ports cannot be read without being `postgres`. */
async function rhelClusters({ fs, run, layout }) {
    const out = [];
    const seen = new Set();
    const units = await run('systemctl', ['list-unit-files', 'postgresql*', '--no-legend', '--no-pager']);
    for (const line of units.stdout.split('\n')) {
        const unit = line.trim().split(/\s+/)[0];
        const match = /^postgresql-?(\d{1,2})(?:-([a-z0-9-]+))?\.service$/.exec(unit || '');
        if (!match) continue;
        const name = match[2] || 'main';
        const active = await run('systemctl', ['is-active', unit]);
        const status = active.stdout.trim() || 'inactive';
        out.push({ version: Number(match[1]), name, port: null, status: status === 'active' ? 'online' : 'down', online: status === 'active', owner: 'postgres', dataDirectory: null, unit, source: 'systemd' });
        seen.add(`${match[1]}/${name}`);
    }
    const root = nodePath.dirname(layout.defaultDataParent);
    let majors = [];
    try { majors = fs.readdirSync(root); } catch { /* none */ }
    for (const entry of majors) {
        if (!/^\d{1,2}$/.test(entry)) continue;
        let dirs;
        try { dirs = fs.readdirSync(nodePath.join(root, entry)); } catch { continue; }
        for (const dir of dirs) {
            const dataDirectory = nodePath.join(root, entry, dir);
            let hasVersion = false;
            try { hasVersion = fs.existsSync(nodePath.join(dataDirectory, 'PG_VERSION')); } catch { /* unreadable to this account */ }
            const name = dir === 'data' ? 'main' : dir;
            const existing = out.find(item => item.version === Number(entry) && item.name === name);
            if (existing) existing.dataDirectory = existing.dataDirectory || dataDirectory;
            else if (hasVersion && !seen.has(`${entry}/${name}`)) out.push({ version: Number(entry), name, port: null, status: 'unknown', online: false, owner: 'postgres', dataDirectory, unit: null, source: 'directory' });
        }
    }
    return out;
}

async function storageFacts({ fs, run, target, requiredBytes, account }) {
    const out = { path: target, exists: false, isDirectory: false, empty: null, freeBytes: null, requiredBytes, mount: null, mountIssues: [], reachableByPostgres: null, blockedAt: null, nearest: null };
    let stat = null;
    try { stat = fs.statSync(target); } catch { /* may be created */ }
    out.exists = Boolean(stat);
    out.isDirectory = Boolean(stat && stat.isDirectory());
    if (out.isDirectory) {
        try { out.empty = fs.readdirSync(target).length === 0; } catch { out.empty = null; }
    }
    const nearest = nearestExisting(fs, target);
    out.nearest = nearest;
    if (nearest) {
        out.freeBytes = freeBytes(fs, nearest);
        if (out.freeBytes === null) {
            const df = await run('df', ['-Pk', nearest]);
            if (df.code === 0) out.freeBytes = parseDf(df.stdout);
        }
        const found = await run('findmnt', ['-n', '-o', 'TARGET,FSTYPE,OPTIONS', '--target', nearest]);
        const mount = found.code === 0 ? mounts.parseFindmnt(found.stdout) : null;
        out.mount = mount;
        let fstab = null;
        try { fstab = mounts.fstabTargets(fs.readFileSync('/etc/fstab', 'utf8')); } catch { /* no fstab */ }
        out.mountIssues = mounts.classify(mount, { fstabTargets: fstab }).issues;
    }
    if (account && nearest) {
        const reach = reachableBy(account, nodePath.join(nearest, 'x'), fs);
        out.reachableByPostgres = reach.ok;
        out.blockedAt = reach.blockedAt;
    }
    return out;
}

module.exports = {
    MIN_FREE_BYTES, parseLsClusters, parseDpkg, parseRpm, parseAptCandidate, parseDf, passwdEntry, reachableBy, roleState,
    inspectHost, storageFacts, names
};
