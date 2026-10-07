/**
 * The fake `docker` executable on a private PATH (tests/helpers/fakeDockerCli.js).
 * `create()` makes a temp directory holding a `docker` shim and a state file,
 * and `install()` puts the directory first on this process's PATH (and sets
 * FAKE_DOCKER_STATE) until `restore()`. Every call the manager makes is logged
 * with its argv and the secret environment values it carried, so a test can
 * prove what was and was not on the command line.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, 'fakeDockerCli.js');

function create({ mode = 'ok', imagePulled = true, healthAfter = 2, ...extra } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-'));
    const bin = path.join(dir, 'docker');
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
    const statePath = path.join(dir, 'state.json');
    const write = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
    write({ mode, imagePulled, healthAfter, containers: {}, volumes: {}, networks: {}, ...extra });
    const saved = { PATH: process.env.PATH, FAKE_DOCKER_STATE: process.env.FAKE_DOCKER_STATE, GOOBSTER_DOCKER_BIN: process.env.GOOBSTER_DOCKER_BIN };

    const api = {
        dir,
        bin,
        statePath,
        env() {
            return { PATH: `${dir}${path.delimiter}${process.env.PATH}`, FAKE_DOCKER_STATE: statePath };
        },
        install() {
            process.env.PATH = `${dir}${path.delimiter}${saved.PATH}`;
            process.env.FAKE_DOCKER_STATE = statePath;
            delete process.env.GOOBSTER_DOCKER_BIN;
            return api;
        },
        restore() {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            fs.rmSync(dir, { recursive: true, force: true });
        },
        state() {
            return JSON.parse(fs.readFileSync(statePath, 'utf8'));
        },
        set(patch) {
            write({ ...api.state(), ...patch });
            return api;
        },
        /** A container, volume or network somebody else created: no labels of ours. */
        seedForeign({ container, volume, network, port = 5432 } = {}) {
            const state = api.state();
            if (container) {
                state.containers[container] = {
                    labels: { 'com.example.owner': 'someone-else' },
                    image: 'postgres:16',
                    running: true,
                    status: 'running',
                    health: 'healthy',
                    bind: '0.0.0.0',
                    port,
                    restart: 'always',
                    healthcheck: false,
                    memory: 0,
                    mount: { Type: 'volume', Name: volume || 'foreign-data', Destination: '/var/lib/postgresql/data' },
                    network: network || 'foreign-net'
                };
            }
            if (volume) state.volumes[volume] = { labels: {} };
            if (network) state.networks[network] = { labels: {} };
            write(state);
            return api;
        },
        calls() {
            try {
                return fs.readFileSync(`${statePath}.calls`, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
            } catch {
                return [];
            }
        },
        clearCalls() {
            fs.rmSync(`${statePath}.calls`, { force: true });
        },
        /** Calls that change something (run, start, stop, rm, create, pull). */
        mutations() {
            const verbs = new Set(['run', 'start', 'stop', 'rm', 'pull']);
            return api.calls().filter(call => verbs.has(call.args[0]) || (['volume', 'network'].includes(call.args[0]) && ['create', 'rm'].includes(call.args[1])));
        },
        argvText() {
            return api.calls().map(call => call.args.join(' ')).join('\n');
        }
    };
    return api;
}

module.exports = { create, CLI };
