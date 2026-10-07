#!/usr/bin/env node
/**
 * A fake `docker` executable for the tests (no daemon exists in the test VM).
 * It keeps its world in the JSON file named by FAKE_DOCKER_STATE, appends one
 * JSON line per call (argv and the environment values of interest) to
 * `<state>.calls`, and answers the subset of the CLI the manager uses:
 * version, info, image inspect/pull, container/volume/network inspect/create/rm,
 * run, start, stop, rm, ps and logs. Anything else exits 1.
 *
 * `state.mode` selects the daemon: ok | unreachable | permission | desktop |
 * arm | unsupported-arch | windows | old | missing-cli (exit 127 is not
 * reproducible from a script that exists, so `missing-cli` is done by the
 * helper pointing PATH elsewhere).
 */

const fs = require('node:fs');

const statePath = process.env.FAKE_DOCKER_STATE;
const args = process.argv.slice(2);

function load() {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}
function save(state) {
    fs.writeFileSync(statePath, JSON.stringify(state));
}
function log(entry) {
    fs.appendFileSync(`${statePath}.calls`, `${JSON.stringify(entry)}\n`);
}
const out = (text) => process.stdout.write(`${text}\n`);
const fail = (text, code = 1) => {
    process.stderr.write(`${text}\n`);
    process.exit(code);
};

const state = load();
log({ args, env: process.env.POSTGRES_PASSWORD ? { POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD } : {} });

function flagValues(name) {
    const values = [];
    for (let i = 0; i < args.length; i++) if (args[i] === name) values.push(args[i + 1]);
    return values;
}
const flagValue = (name) => flagValues(name)[0];
const labelsOf = () => Object.fromEntries(flagValues('--label').map(item => [item.slice(0, item.indexOf('=')), item.slice(item.indexOf('=') + 1)]));

function daemon() {
    const mode = state.mode || 'ok';
    if (mode === 'unreachable') fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
    if (mode === 'permission') fail('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info": dial unix /var/run/docker.sock: connect: permission denied');
    const base = { ServerVersion: '27.3.1', OperatingSystem: 'Ubuntu 24.04 LTS', OSType: 'linux', Architecture: 'x86_64', Name: 'host', SecurityOptions: ['name=apparmor', 'name=seccomp,profile=builtin'], DockerRootDir: '/var/lib/docker' };
    if (mode === 'desktop') return { ...base, OperatingSystem: 'Docker Desktop', Name: 'docker-desktop' };
    if (mode === 'arm') return { ...base, Architecture: 'aarch64' };
    if (mode === 'unsupported-arch') return { ...base, Architecture: 'armv7l' };
    if (mode === 'windows') return { ...base, OSType: 'windows' };
    if (mode === 'old') return { ...base, ServerVersion: '19.03.5' };
    if (mode === 'rootless') return { ...base, SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless'] };
    return base;
}

function containerView(name, c) {
    return {
        Name: `/${name}`,
        Config: { Image: c.image, Labels: c.labels, ...(c.healthcheck === false ? {} : { Healthcheck: { Test: ['CMD-SHELL', 'pg_isready'] } }) },
        State: { Running: c.running, Status: c.status, StartedAt: '2026-10-07T10:00:00Z', ...(c.health ? { Health: { Status: c.health } } : {}) },
        HostConfig: { RestartPolicy: { Name: c.restart || 'no' }, Memory: c.memory || 0 },
        NetworkSettings: { Ports: c.port ? { '5432/tcp': [{ HostIp: c.bind, HostPort: String(c.port) }] } : {} },
        Mounts: [c.mount]
    };
}

const noSuch = (kind, name) => { out('[]'); fail(`Error: No such ${kind}: ${name}`); };

const [verb, sub] = args;

if (verb === 'version') {
    out(JSON.stringify({ Version: '27.3.1' }));
} else if (verb === 'info') {
    out(JSON.stringify(daemon()));
} else {
    daemon();
    if (verb === 'image' && sub === 'inspect') {
        if (!state.imagePulled) fail(`Error: No such image: ${args[args.length - 1]}`);
        out('sha256:feedface');
    } else if (verb === 'pull') {
        state.imagePulled = true;
        save(state);
        out('pulled');
    } else if (verb === 'container' && sub === 'inspect') {
        const name = args[2];
        const c = state.containers[name];
        if (!c) noSuch('container', name);
        if (c.health === 'starting' && c.running) {
            c.countdown = (c.countdown === undefined ? state.healthAfter : c.countdown) - 1;
            if (c.countdown <= 0) c.health = state.neverHealthy ? 'unhealthy' : 'healthy';
            save(state);
        }
        out(JSON.stringify([containerView(name, c)]));
    } else if (verb === 'volume' && sub === 'inspect') {
        const v = state.volumes[args[2]];
        if (!v) noSuch('volume', args[2]);
        out(JSON.stringify([{ Name: args[2], Labels: v.labels }]));
    } else if (verb === 'network' && sub === 'inspect') {
        const n = state.networks[args[2]];
        if (!n) noSuch('network', args[2]);
        out(JSON.stringify([{ Name: args[2], Labels: n.labels }]));
    } else if (verb === 'volume' && sub === 'create') {
        state.volumes[args[args.length - 1]] = { labels: labelsOf() };
        save(state);
        out(args[args.length - 1]);
    } else if (verb === 'network' && sub === 'create') {
        state.networks[args[args.length - 1]] = { labels: labelsOf() };
        save(state);
        out('networkid');
    } else if (verb === 'volume' && sub === 'rm') {
        if (!state.volumes[args[2]]) fail(`Error: No such volume: ${args[2]}`);
        delete state.volumes[args[2]];
        save(state);
        out(args[2]);
    } else if (verb === 'network' && sub === 'rm') {
        if (!state.networks[args[2]]) fail(`Error: No such network: ${args[2]}`);
        delete state.networks[args[2]];
        save(state);
        out(args[2]);
    } else if (verb === 'run') {
        const name = flagValue('--name');
        if (state.containers[name]) fail(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use.`, 125);
        if (state.failRun) fail('docker: Error response from daemon: could not create the container.', 125);
        const publish = flagValue('-p').split(':');
        const mountSpec = flagValue('-v');
        const separator = mountSpec.lastIndexOf(':');
        const source = mountSpec.slice(0, separator);
        const memory = flagValue('--memory');
        state.containers[name] = {
            labels: labelsOf(),
            image: args[args.length - 1],
            running: !state.exitOnStart,
            status: state.exitOnStart ? 'exited' : 'running',
            health: state.exitOnStart ? 'none' : 'starting',
            bind: publish[0],
            port: Number(publish[1]),
            restart: flagValue('--restart'),
            memory: memory ? Number(memory.replace(/m$/, '')) * 1024 * 1024 : 0,
            mount: source.startsWith('/') ? { Type: 'bind', Source: source, Destination: '/var/lib/postgresql/data' } : { Type: 'volume', Name: source, Destination: '/var/lib/postgresql/data' },
            network: flagValue('--network'),
            hadPassword: Boolean(process.env.POSTGRES_PASSWORD)
        };
        if (state.interruptAfterRun) {
            save(state);
            process.stderr.write('docker: the client was interrupted after the container was created\n');
            process.exit(130);
        }
        save(state);
        out('0123456789abcdef0123456789abcdef');
    } else if (verb === 'start') {
        const c = state.containers[args[1]];
        if (!c) fail(`Error response from daemon: No such container: ${args[1]}`);
        c.running = true;
        c.status = 'running';
        c.health = 'starting';
        c.countdown = undefined;
        save(state);
        out(args[1]);
    } else if (verb === 'stop') {
        const name = args[args.length - 1];
        const c = state.containers[name];
        if (!c) fail(`Error response from daemon: No such container: ${name}`);
        c.running = false;
        c.status = 'exited';
        c.health = 'none';
        save(state);
        out(name);
    } else if (verb === 'rm') {
        const name = args[args.length - 1];
        if (!state.containers[name]) fail(`Error response from daemon: No such container: ${name}`);
        delete state.containers[name];
        save(state);
        out(name);
    } else if (verb === 'ps') {
        const wanted = flagValues('--filter').filter(item => item.startsWith('label=')).map(item => item.slice(6));
        const everything = args.includes('--all') || args.includes('-a');
        for (const [name, c] of Object.entries(state.containers)) {
            if (!everything && !c.running) continue;
            const labels = Object.entries(c.labels).map(([k, v]) => `${k}=${v}`);
            if (!wanted.every(item => labels.includes(item))) continue;
            out(JSON.stringify({ Names: name, Ports: c.port ? `${c.bind}:${c.port}->5432/tcp` : '', State: c.running ? 'running' : 'exited', Labels: labels.join(',') }));
        }
    } else if (verb === 'logs') {
        out('LOG: database system is ready to accept connections');
    } else {
        fail(`fake docker: unsupported command "${args.join(' ')}"`);
    }
}
