#!/usr/bin/env node
/**
 * One fake for every system program the native PostgreSQL code starts
 * (tests/helpers/fakeNative.js writes a one-line shim per program that runs
 * this file): apt-get, dpkg-query, apt-cache, dnf, rpm, pg_lsclusters,
 * pg_createcluster, pg_ctlcluster, pg_dropcluster, pg_controldata, pg_isready,
 * initdb, psql, runuser, systemctl, getent, getenforce, semanage, restorecon,
 * findmnt, df, ss, curl, gpg, cp, du.
 *
 * `node fakeNativeCli.js <program> <state file> [args...]`. The state file is
 * the only world: installed packages, clusters, units, mounts, flags. Every call is appended to
 * `<state>.calls` with its argv and stdin, so a test can prove what was run
 * and that no secret was on a command line. A real `cp` and `du` do the file
 * work (a relocation copies a real directory tree).
 */

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const [program, statePath, ...args] = process.argv.slice(2);

const read = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
let state = read();
const sysroot = state.sysroot || '';
const sys = (file) => path.join(sysroot, file);
const out = (text) => process.stdout.write(text);
const fail = (message, code = 1) => { process.stderr.write(`${message}\n`); process.exit(code); };

let stdin = '';
if (['psql'].includes(program)) {
    try { stdin = fs.readFileSync(0, 'utf8'); } catch { stdin = ''; }
}
fs.appendFileSync(`${statePath}.calls`, `${JSON.stringify({ program, args, stdin: stdin || undefined })}\n`);

const flag = (name) => Boolean(state.flags && state.flags[name]);
const MAJOR = 17;

function packageVersion(name) {
    return state.versions && state.versions[name] ? state.versions[name] : `${MAJOR}.4-1`;
}

function debianListeningPorts() {
    const ports = new Set(state.listening || []);
    for (const cluster of state.clusters) if (cluster.online) ports.add(cluster.port);
    for (const unit of Object.values(state.units || {})) if (unit.active && unit.port) ports.add(unit.port);
    return ports;
}

function findCluster(version, name) {
    return state.clusters.find(item => String(item.version) === String(version) && item.name === name);
}

function parseOptions(list, takesValue) {
    const options = {};
    const rest = [];
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (item === '--') { rest.push(...list.slice(i + 1)); break; }
        if (takesValue.includes(item)) { options[item] = list[++i]; continue; }
        const long = /^(--[a-z-]+)=(.*)$/.exec(item);
        if (long) { options[long[1]] = long[2]; continue; }
        rest.push(item);
    }
    return { options, rest };
}

function installPackages(names) {
    for (const name of names) {
        if (!state.installed.includes(name)) state.installed.push(name);
        if (name === `postgresql-${MAJOR}` && state.flags && state.flags.autoMainCluster && !findCluster(MAJOR, 'main')) {
            let port = 5432;
            const used = debianListeningPorts();
            while (used.has(port)) port++;
            state.clusters.push({ version: MAJOR, name: 'main', port, online: true, dataDirectory: `/var/lib/postgresql/${MAJOR}/main`, owner: 'postgres', synthetic: true });
        }
    }
}

switch (program) {
    case 'apt-get': {
        if (flag('aptFails')) fail('E: Unable to locate package', 100);
        if (args[0] === 'update') { state.aptUpdates = (state.aptUpdates || 0) + 1; save(state); break; }
        const names = args.slice(1).filter(item => !item.startsWith('-'));
        if (flag('pgvectorMissing') && names.some(name => /pgvector/.test(name))) fail('E: Unable to locate package postgresql-17-pgvector', 100);
        installPackages(names);
        save(state);
        break;
    }
    case 'dnf': {
        if (flag('dnfFails')) fail('Error: Unable to find a match', 1);
        const words = args.filter(item => !item.startsWith('-'));
        if (words[0] === 'install') {
            const names = words.slice(1);
            if (flag('pgvectorMissing') && names.some(name => /pgvector/.test(name))) fail('Error: Unable to find a match: pgvector_17', 1);
            installPackages(names);
            save(state);
        } else if (words[0] === 'list') {
            for (const name of words.slice(1)) if ((state.available || []).includes(name)) out(`${name}.x86_64 ${MAJOR}.4-1 pgdg17\n`);
        }
        break;
    }
    case 'dpkg-query': {
        for (const name of args.filter(item => !item.startsWith('-'))) {
            if (state.installed.includes(name)) out(`${name} ${packageVersion(name)} ii \n`);
        }
        break;
    }
    case 'apt-cache': {
        const name = args[1];
        out(`${name}:\n  Installed: ${state.installed.includes(name) ? packageVersion(name) : '(none)'}\n  Candidate: ${(state.available || []).includes(name) ? packageVersion(name) : '(none)'}\n`);
        break;
    }
    case 'rpm': {
        const format = args[args.indexOf('--qf') + 1] || '';
        const names = args.filter((item, index) => !item.startsWith('-') && args[index - 1] !== '--qf');
        for (const name of names) {
            if (!state.installed.includes(name)) out(`package ${name} is not installed\n`);
            else out(`${format.includes('%{VERSION}') ? `${name} ${packageVersion(name)}` : name}\n`);
        }
        break;
    }
    case 'pg_lsclusters': {
        for (const cluster of state.clusters) out(`${cluster.version} ${cluster.name} ${cluster.port} ${cluster.online ? 'online' : 'down'} ${cluster.owner || 'postgres'} ${cluster.dataDirectory} /var/log/postgresql/postgresql-${cluster.version}-${cluster.name}.log\n`);
        break;
    }
    case 'pg_createcluster': {
        const { options, rest } = parseOptions(args, ['-d', '-p', '--start-conf', '-e', '--locale']);
        const [version, name] = rest;
        if (flag('createFails')) fail('Error: could not create cluster', 1);
        if (findCluster(version, name)) fail(`Error: cluster ${version}/${name} already exists`, 1);
        const dir = options['-d'];
        if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) fail('Error: data directory is not empty', 1);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'PG_VERSION'), `${version}\n`);
        fs.writeFileSync(path.join(dir, 'PG_CONTROL'), `system-identifier-${Date.now()}-${Math.random().toString(16).slice(2)}\n`);
        fs.writeFileSync(path.join(dir, 'base.dat'), 'x'.repeat(4096));
        const config = sys(`/etc/postgresql/${version}/${name}`);
        fs.mkdirSync(path.join(config, 'conf.d'), { recursive: true });
        fs.writeFileSync(path.join(config, 'postgresql.conf'), `data_directory = '${dir}'\t\t# use data in another directory\nhba_file = '${config}/pg_hba.conf'\ninclude_dir = 'conf.d'\nport = ${options['-p']}\n`);
        fs.writeFileSync(path.join(config, 'pg_hba.conf'), 'local all postgres peer\nhost all all 127.0.0.1/32 trust\n');
        fs.writeFileSync(path.join(config, 'start.conf'), '# Automatic startup\nauto\n');
        state.clusters.push({ version: Number(version), name, port: Number(options['-p']), online: false, dataDirectory: dir, owner: 'postgres', startConf: options['--start-conf'] });
        state.createClusterCalls = (state.createClusterCalls || 0) + 1;
        save(state);
        break;
    }
    case 'pg_ctlcluster': {
        const [version, name, action] = args;
        const cluster = findCluster(version, name);
        if (!cluster) fail(`Error: specified cluster does not exist`, 2);
        if (action === 'start') {
            if (flag('startFails')) fail('pg_ctlcluster: server did not start', 1);
            const config = fs.readFileSync(sys(`/etc/postgresql/${version}/${name}/postgresql.conf`), 'utf8');
            const confd = path.join(sys(`/etc/postgresql/${version}/${name}/conf.d`), 'goobster.conf');
            const portText = (fs.existsSync(confd) ? fs.readFileSync(confd, 'utf8') : config).match(/^port\s*=\s*(\d+)/m);
            const dataDir = (config.match(/^data_directory\s*=\s*'([^']+)'/m) || [])[1] || cluster.dataDirectory;
            const port = portText ? Number(portText[1]) : cluster.port;
            const others = new Set(state.listening || []);
            for (const item of state.clusters) if (item !== cluster && item.online) others.add(item.port);
            if (others.has(port)) fail('pg_ctlcluster: could not bind IPv4 address: Address already in use', 1);
            if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) fail('pg_ctlcluster: data directory missing', 1);
            cluster.port = port;
            cluster.dataDirectory = dataDir;
            cluster.online = true;
        } else if (action === 'stop') {
            cluster.online = false;
            // With `stopChangesTree`, behave like a real shutdown: the postmaster drops its pid
            // file and the shutdown checkpoint flushes the statistics snapshot and WAL, by more
            // than the relocation's size tolerance.
            if (flag('stopChangesTree')) {
                try {
                    fs.rmSync(path.join(cluster.dataDirectory, 'postmaster.pid'), { force: true });
                    fs.mkdirSync(path.join(cluster.dataDirectory, 'pg_stat'), { recursive: true });
                    fs.writeFileSync(path.join(cluster.dataDirectory, 'pg_stat', 'pgstat.stat'), Buffer.alloc(96 * 1024, 1));
                } catch { }
            }
        } else if (action === 'restart') {
            cluster.online = true;
        }
        save(state);
        break;
    }
    case 'pg_dropcluster': {
        const [version, name] = args;
        const cluster = findCluster(version, name);
        if (!cluster) fail('Error: specified cluster does not exist', 2);
        fs.rmSync(cluster.dataDirectory, { recursive: true, force: true });
        fs.rmSync(sys(`/etc/postgresql/${version}/${name}`), { recursive: true, force: true });
        state.clusters = state.clusters.filter(item => item !== cluster);
        save(state);
        break;
    }
    case 'initdb': {
        const { options } = parseOptions(args, ['-D']);
        const dir = options['-D'];
        if (flag('createFails')) fail('initdb: error: could not create', 1);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) fail('initdb: error: directory exists but is not empty', 1);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'PG_VERSION'), `${MAJOR}\n`);
        fs.writeFileSync(path.join(dir, 'PG_CONTROL'), `system-identifier-${Date.now()}-${Math.random().toString(16).slice(2)}\n`);
        fs.writeFileSync(path.join(dir, 'base.dat'), 'x'.repeat(4096));
        fs.writeFileSync(path.join(dir, 'postgresql.conf'), '#listen_addresses = localhost\n');
        fs.writeFileSync(path.join(dir, 'pg_hba.conf'), 'local all all peer\n');
        state.initdbCalls = (state.initdbCalls || 0) + 1;
        save(state);
        break;
    }
    case 'pg_controldata': {
        const dir = args[args.length - 1];
        const file = path.join(dir, 'PG_CONTROL');
        if (!fs.existsSync(file)) fail('pg_controldata: could not open file', 1);
        const identifier = fs.readFileSync(file, 'utf8').trim();
        let running = false;
        for (const cluster of state.clusters) if (cluster.dataDirectory === dir && cluster.online) running = true;
        for (const unit of Object.values(state.units || {})) if (unit.active && unit.dataDirectory === dir) running = true;
        out(`pg_control version number:            1700\nDatabase system identifier:           ${identifier}\nDatabase cluster state:               ${running ? 'in production' : 'shut down'}\nLatest checkpoint location:           0/1A2B3C4\n`);
        break;
    }
    case 'pg_isready': {
        const { options } = parseOptions(args, ['-h', '-p']);
        const port = Number(options['-p']);
        if (flag('neverReady')) process.exit(2);
        process.exit(debianListeningPorts().has(port) ? 0 : 2);
        break;
    }
    case 'psql': {
        const { options } = parseOptions(args, ['-h', '-p', '-d', '-f', '-v']);
        if (flag('psqlFails')) {
            const line = (stdin.split('\n').find(item => /PASSWORD/.test(item)) || '').slice(0, 300);
            fail(`psql: error: syntax error at or near "PASSWORD"\nLINE 1: ${line}`, 3);
        }
        state.psql = state.psql || [];
        state.psql.push({ database: options['-d'], port: Number(options['-p']), lines: stdin.split('\n').filter(Boolean).length });
        if (/CREATE ROLE/.test(stdin)) {
            const role = /CREATE ROLE "([^"]+)"/.exec(stdin)[1];
            state.roles = state.roles || {};
            state.roles[role] = { superuser: /\bSUPERUSER\b/.test(stdin.replace(/NOSUPERUSER/g, '')), verifier: (/PASSWORD '([^']+)'/.exec(stdin) || [])[1] || null };
        }
        if (/CREATE DATABASE/.test(stdin)) {
            const database = /CREATE DATABASE "([^"]+)"/.exec(stdin)[1];
            state.databases = state.databases || [];
            if (!state.databases.includes(database)) state.databases.push(database);
        }
        if (/CREATE EXTENSION/.test(stdin)) {
            state.extensions = state.extensions || {};
            const key = options['-d'];
            state.extensions[key] = [...new Set([...(state.extensions[key] || []), ...[...stdin.matchAll(/CREATE EXTENSION IF NOT EXISTS (\w+)/g)].map(match => match[1])])];
        }
        save(state);
        break;
    }
    case 'runuser': {
        const index = args.indexOf('--');
        const command = args.slice(index + 1);
        const asUser = args[args.indexOf('-u') + 1];
        state.runuser = state.runuser || [];
        state.runuser.push({ user: asUser, program: path.basename(command[0]) });
        save(state);
        const result = childProcess.spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
        process.exit(result.status === null ? 1 : result.status);
        break;
    }
    case 'systemctl': {
        const words = args.filter(item => !item.startsWith('-'));
        const verb = words[0];
        const unitName = words[1];
        state.units = state.units || {};
        if (verb === 'is-system-running') { out(`${state.systemd === false ? 'offline' : 'running'}\n`); process.exit(state.systemd === false ? 1 : 0); }
        if (verb === 'daemon-reload') { state.reloads = (state.reloads || 0) + 1; save(state); break; }
        if (verb === 'list-unit-files') {
            if (fs.existsSync(sys('/etc/systemd/system'))) for (const entry of fs.readdirSync(sys('/etc/systemd/system'))) if (/^postgresql.*\.service$/.test(entry)) out(`${entry} enabled enabled\n`);
            break;
        }
        const unit = state.units[unitName] || (state.units[unitName] = { active: false, enabled: false, port: null, dataDirectory: null });
        const text = fs.existsSync(sys(`/etc/systemd/system/${unitName}`)) ? fs.readFileSync(sys(`/etc/systemd/system/${unitName}`), 'utf8') : null;
        if (verb === 'start' || verb === 'restart') {
            if (flag('startFails')) fail('Job for unit failed.', 1);
            if (text === null && /^postgresql\d/.test(unitName)) fail(`Unit ${unitName} not found.`, 5);
            const data = text ? (/^Environment=PGDATA=(\S+)$/m.exec(text) || [])[1] : null;
            const confd = data ? path.join(data, 'conf.d', 'goobster.conf') : null;
            const port = confd && fs.existsSync(confd) ? Number((/^port\s*=\s*(\d+)/m.exec(fs.readFileSync(confd, 'utf8')) || [])[1]) : null;
            const others = new Set(state.listening || []);
            for (const item of state.clusters) if (item.online) others.add(item.port);
            for (const [key, other] of Object.entries(state.units)) if (key !== unitName && other.active && other.port) others.add(other.port);
            if (port && others.has(port)) fail('Job for unit failed: address already in use.', 1);
            if (data && !fs.existsSync(path.join(data, 'PG_VERSION'))) fail('Job for unit failed: data directory missing.', 1);
            unit.active = true;
            unit.port = port;
            unit.dataDirectory = data;
        } else if (verb === 'stop') {
            unit.active = false;
        } else if (verb === 'enable') {
            unit.enabled = true;
            if (args.includes('--now')) unit.active = true;
        } else if (verb === 'disable') {
            unit.enabled = false;
            if (args.includes('--now')) unit.active = false;
        } else if (verb === 'is-active') {
            save(state);
            out(`${unit.active ? 'active' : 'inactive'}\n`);
            process.exit(unit.active ? 0 : 3);
        } else if (verb === 'is-enabled') {
            out(`${unit.enabled ? 'enabled' : 'disabled'}\n`);
            process.exit(unit.enabled ? 0 : 1);
        }
        save(state);
        break;
    }
    case 'getent': {
        const entry = (state.accounts || {})[args[1]];
        if (!entry) process.exit(2);
        out(`${args[1]}:x:${entry.uid}:${entry.gid}::${entry.home}:${entry.shell}\n`);
        break;
    }
    case 'getenforce': out(`${state.selinux || 'Disabled'}\n`); break;
    case 'semanage': case 'restorecon': break;
    case 'findmnt': {
        const target = args[args.indexOf('--target') + 1];
        const table = state.mounts || [{ target: '/', fstype: 'ext4', options: 'rw,relatime' }];
        const match = table.filter(item => target === item.target || target.startsWith(item.target === '/' ? '/' : `${item.target}/`)).sort((a, b) => b.target.length - a.target.length)[0];
        if (!match) process.exit(1);
        out(`${match.target} ${match.fstype} ${match.options}\n`);
        break;
    }
    case 'df': {
        out(`Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/fake 104857600 1 ${state.freeKb || 52428800} 1% /\n`);
        break;
    }
    case 'ss': {
        for (const port of debianListeningPorts()) out(`LISTEN 0 4096 127.0.0.1:${port} 0.0.0.0:*\n`);
        break;
    }
    case 'curl': {
        const url = args[args.length - 1];
        const file = args[args.indexOf('-o') + 1];
        if (flag('curlFails')) fail('curl: (22) The requested URL returned error: 404', 22);
        fs.writeFileSync(file, `-----BEGIN PGP PUBLIC KEY BLOCK-----\nfake-key-for:${url}\n-----END PGP PUBLIC KEY BLOCK-----\n`);
        break;
    }
    case 'gpg': {
        const text = fs.readFileSync(args[args.length - 1], 'utf8');
        const url = (/fake-key-for:(\S+)/.exec(text) || [])[1];
        const fingerprint = flag('wrongKey') ? 'DEADBEEF'.repeat(5) : ((state.keys || {})[url] || 'UNKNOWN');
        out(`pub:-:4096:1:${fingerprint.slice(-16)}:1318537154:::-:::scSC::::::23::0:\nfpr:::::::::${fingerprint}:\n`);
        break;
    }
    case 'cp': {
        if (flag('cpInterrupt')) {
            const dest = args[args.length - 1];
            fs.mkdirSync(dest, { recursive: true });
            fs.writeFileSync(path.join(dest, 'partial.dat'), 'half');
            fail('cp: error writing: No space left on device', 1);
        }
        const result = childProcess.spawnSync('/bin/cp', args, { stdio: 'inherit' });
        process.exit(result.status === null ? 1 : result.status);
        break;
    }
    case 'du': {
        const result = childProcess.spawnSync('/usr/bin/du', args, { stdio: 'inherit' });
        process.exit(result.status === null ? 1 : result.status);
        break;
    }
    case 'pg_dump':
        if (flag('noPgDump')) process.exit(127);
        out(`pg_dump (PostgreSQL) ${(state.pgDumpVersion || '17.4')}\n`);
        break;
    default:
        fail(`fake: unknown program ${program}`, 127);
}
