/**
 * Container, volume and network management over the plain `docker` CLI
 * (no compose). Everything here acts on resources of ONE installation,
 * named exactly (`names.resourcesFor`), and re-checks their labels before it
 * changes them: a resource without this installation's labels is somebody
 * else's and the call fails with `RESOURCE_FOREIGN` (documentation/docker_postgres.md).
 *
 * Secrets: the superuser password is handed to `docker run` through the child
 * environment (`-e POSTGRES_PASSWORD`, no value), never through argv.
 */

const net = require('node:net');
const { DockerError } = require('./errors');
const image = require('./image');
const names = require('./names');

const CONTAINER_PORT = 5432;
const HEALTH_INTERVAL_S = 5;
const HEALTH_RETRIES = 12;
const WAIT_HEALTHY_MS = 180_000;
const POLL_MS = 1500;
const PORT_SEARCH = 50;
const PGDATA_SUBDIR = 'pgdata';

const defaultSleep = (ms) => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

function parseJson(text) {
    try {
        return JSON.parse(String(text).trim());
    } catch {
        return null;
    }
}

/** Docker's own words for a failure, reduced to a code: never the stderr text itself, which can echo an argument. */
function failure(code, message, result, details = {}) {
    return new DockerError(code, message, { ...details, exit: result && typeof result.code === 'number' ? result.code : null });
}

/** Published host ports from `docker ps` (`0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp`). */
function parsePublished(text) {
    const out = [];
    for (const part of String(text || '').split(',')) {
        const match = /^\s*(?:\[?([0-9a-f.:]*)\]?):(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/(tcp|udp)\s*$/i.exec(part);
        if (!match) continue;
        const from = Number(match[2]);
        const to = match[3] ? Number(match[3]) : from;
        for (let port = from; port <= Math.min(to, from + 64); port++) out.push({ bind: match[1] || '0.0.0.0', port, protocol: match[4].toLowerCase() });
    }
    return out;
}

/** Can this process bind `port` on `bind` right now? */
function probeListen(port, bind) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => server.close(() => resolve(true)));
        server.listen({ port, host: bind, exclusive: true });
    });
}

/**
 * @param {Object} params
 * @param {{ run: Function }} params.docker
 * @param {string} params.installationId
 * @param {Object} [params.deps] test seams: `sleep`, `probeListen`
 */
function createContainers({ docker, installationId, deps = {} }) {
    const resources = names.resourcesFor(installationId);
    const sleep = deps.sleep || defaultSleep;
    const listenProbe = deps.probeListen || probeListen;

    async function inspectRaw(kind, name) {
        const verb = kind === 'container' ? ['container', 'inspect'] : [kind, 'inspect'];
        const result = await docker.run([...verb, name], { timeoutMs: 15_000 });
        if (result.missing) throw new DockerError('DOCKER_CLI_MISSING', 'The docker command is not installed or not on PATH.');
        if (result.code !== 0) {
            if (/no such|not found|no container|no volume|no network/i.test(`${result.stderr}${result.stdout}`)) return null;
            throw failure('DOCKER_INSPECT_FAILED', `Docker could not inspect the ${kind} "${name}".`, result, { kind, name });
        }
        const parsed = parseJson(result.stdout);
        const entry = Array.isArray(parsed) ? parsed[0] : null;
        if (!entry) return null;
        const reported = String(entry.Name || '').replace(/^\//, '');
        if (reported !== name) return null;
        return entry;
    }

    /** The exact-name resource, or null when there is none. Throws `RESOURCE_FOREIGN` when it exists without our labels. */
    async function inspectOwned(resource) {
        const entry = await inspectRaw(resource.kind, resource.name);
        if (!entry) return null;
        const labels = resource.kind === 'container' ? (entry.Config && entry.Config.Labels) : entry.Labels;
        names.assertOwned(resource, labels, { installationId });
        return entry;
    }

    function summarizeContainer(entry) {
        if (!entry) return { exists: false, status: 'missing', health: 'none', running: false };
        const state = entry.State || {};
        const health = state.Health && state.Health.Status ? String(state.Health.Status) : 'none';
        const ports = (entry.NetworkSettings && entry.NetworkSettings.Ports) || {};
        const binding = Array.isArray(ports[`${CONTAINER_PORT}/tcp`]) ? ports[`${CONTAINER_PORT}/tcp`][0] : null;
        const mounts = Array.isArray(entry.Mounts) ? entry.Mounts : [];
        const data = mounts.find(item => item.Destination === image.DATA_DIRECTORY) || null;
        const reference = entry.Config && entry.Config.Image ? String(entry.Config.Image) : null;
        return {
            exists: true,
            running: state.Running === true,
            status: String(state.Status || 'unknown'),
            health,
            restartPolicy: entry.HostConfig && entry.HostConfig.RestartPolicy ? entry.HostConfig.RestartPolicy.Name : null,
            port: binding ? Number(binding.HostPort) : null,
            bind: binding ? String(binding.HostIp || '') : null,
            image: reference,
            imagePinned: reference === image.REFERENCE,
            data: data ? { kind: data.Type === 'volume' ? 'volume' : 'path', name: data.Type === 'volume' ? data.Name : null, source: data.Type === 'volume' ? null : data.Source } : null,
            memoryBytes: entry.HostConfig && entry.HostConfig.Memory ? Number(entry.HostConfig.Memory) : 0,
            startedAt: state.StartedAt || null
        };
    }

    async function container() {
        return summarizeContainer(await inspectOwned(resources.container));
    }

    async function ensureNetwork() {
        if (await inspectOwned(resources.network)) return { created: false };
        const result = await docker.run(['network', 'create', ...names.labelArgs(resources.network), resources.network.name]);
        if (result.code !== 0) throw failure('NETWORK_CREATE_FAILED', 'Docker could not create the network.', result, { name: resources.network.name });
        return { created: true };
    }

    async function ensureVolume() {
        if (await inspectOwned(resources.volume)) return { created: false };
        const result = await docker.run(['volume', 'create', ...names.labelArgs(resources.volume), resources.volume.name]);
        if (result.code !== 0) throw failure('VOLUME_CREATE_FAILED', 'Docker could not create the volume.', result, { name: resources.volume.name });
        return { created: true };
    }

    async function imagePulled() {
        const result = await docker.run(['image', 'inspect', '--format', '{{.Id}}', image.REFERENCE], { timeoutMs: 15_000 });
        return result.code === 0;
    }

    /** Pulls the pinned image by digest. Called only by the provisioning step the operator approved. */
    async function pull() {
        const result = await docker.run(['pull', image.REFERENCE], { timeoutMs: 20 * 60_000 });
        if (result.code !== 0) throw failure('IMAGE_PULL_FAILED', 'Docker could not pull the pinned image. Check the network and that the registry is reachable.', result);
        return { pulled: true };
    }

    /**
     * `docker run -d` for the instance. `superuserPassword` goes in the child's
     * environment only; `storage` is `{ kind: 'volume' }` or `{ kind: 'path', path }`.
     */
    async function createContainer({ port, bind, storage, memoryMb = null, superuserPassword }) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DockerError('INVALID_PORT', 'The port must be a whole number from 1 to 65535.');
        if (typeof superuserPassword !== 'string' || superuserPassword.length < 16) throw new DockerError('INVALID_PASSWORD', 'The superuser password was not generated.');
        const mount = storage.kind === 'path' ? `${storage.path}:${image.DATA_DIRECTORY}` : `${resources.volume.name}:${image.DATA_DIRECTORY}`;
        const args = [
            'run', '-d',
            '--name', resources.container.name,
            ...names.labelArgs(resources.container),
            '--restart', 'unless-stopped',
            '--network', resources.network.name,
            '-p', `${bind}:${port}:${CONTAINER_PORT}`,
            '-v', mount,
            '-e', 'POSTGRES_PASSWORD',
            '-e', `PGDATA=${image.DATA_DIRECTORY}/${PGDATA_SUBDIR}`,
            '--health-cmd', 'pg_isready -h 127.0.0.1 -U postgres',
            '--health-interval', `${HEALTH_INTERVAL_S}s`,
            '--health-timeout', '5s',
            '--health-retries', String(HEALTH_RETRIES),
            '--health-start-period', '10s',
            ...(memoryMb ? ['--memory', `${memoryMb}m`] : []),
            image.REFERENCE
        ];
        const result = await docker.run(args, { env: { POSTGRES_PASSWORD: superuserPassword }, timeoutMs: 60_000 });
        if (result.code !== 0) throw failure('CONTAINER_CREATE_FAILED', 'Docker could not create the container.', result, { name: resources.container.name });
        return { created: true };
    }

    async function start() {
        const entry = await inspectOwned(resources.container);
        if (!entry) throw new DockerError('CONTAINER_MISSING', 'The database container does not exist; repair it.', { name: resources.container.name });
        const result = await docker.run(['start', resources.container.name]);
        if (result.code !== 0) throw failure('CONTAINER_START_FAILED', 'Docker could not start the container.', result, { name: resources.container.name });
        return { started: true };
    }

    async function stop({ timeoutSeconds = 30 } = {}) {
        const entry = await inspectOwned(resources.container);
        if (!entry) return { stopped: false, missing: true };
        const result = await docker.run(['stop', '--time', String(timeoutSeconds), resources.container.name], { timeoutMs: (timeoutSeconds + 30) * 1000 });
        if (result.code !== 0) throw failure('CONTAINER_STOP_FAILED', 'Docker could not stop the container.', result, { name: resources.container.name });
        return { stopped: true, missing: false };
    }

    async function removeContainer() {
        const entry = await inspectOwned(resources.container);
        if (!entry) return { removed: false };
        const result = await docker.run(['rm', '--force', resources.container.name]);
        if (result.code !== 0) throw failure('CONTAINER_REMOVE_FAILED', 'Docker could not remove the container.', result, { name: resources.container.name });
        return { removed: true };
    }

    async function removeVolume() {
        const entry = await inspectOwned(resources.volume);
        if (!entry) return { removed: false };
        const result = await docker.run(['volume', 'rm', resources.volume.name]);
        if (result.code !== 0) throw failure('VOLUME_REMOVE_FAILED', 'Docker could not remove the volume (is a container still using it?).', result, { name: resources.volume.name });
        return { removed: true };
    }

    async function removeNetwork() {
        const entry = await inspectOwned(resources.network);
        if (!entry) return { removed: false };
        const result = await docker.run(['network', 'rm', resources.network.name]);
        if (result.code !== 0) throw failure('NETWORK_REMOVE_FAILED', 'Docker could not remove the network (is a container still attached?).', result, { name: resources.network.name });
        return { removed: true };
    }

    /** Poll the health check; fail early on an exited or unhealthy container. */
    async function waitHealthy({ timeoutMs = WAIT_HEALTHY_MS, pollMs = POLL_MS } = {}) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const last = await container();
            if (!last.exists) throw new DockerError('CONTAINER_MISSING', 'The container disappeared while it was starting.');
            if (last.health === 'healthy' && last.running) return last;
            if (!last.running && ['exited', 'dead'].includes(last.status)) throw new DockerError('CONTAINER_EXITED', 'The container stopped while it was starting. Read its log with "docker logs" (the name is in the plan).', { name: resources.container.name });
            if (last.health === 'unhealthy') throw new DockerError('CONTAINER_UNHEALTHY', 'The database did not become ready. Read the container log with "docker logs" (the name is in the plan).', { name: resources.container.name });
            if (Date.now() >= deadline) throw new DockerError('HEALTH_TIMEOUT', 'The database was not ready in time.', { name: resources.container.name, waitedMs: timeoutMs });
            await sleep(pollMs);
        }
    }

    /** Every host port some container publishes (running containers only; a stopped one holds none). */
    async function publishedPorts({ ignoreOwn = true } = {}) {
        const result = await docker.run(['ps', '--no-trunc', '--format', '{{json .}}'], { timeoutMs: 15_000 });
        if (result.code !== 0) throw failure('DOCKER_PS_FAILED', 'Docker could not list containers.', result);
        const out = [];
        for (const line of result.stdout.split('\n')) {
            const row = line.trim() ? parseJson(line) : null;
            if (!row) continue;
            const containerName = String(row.Names || '').split(',')[0];
            if (ignoreOwn && containerName === resources.container.name) continue;
            for (const item of parsePublished(row.Ports)) out.push({ ...item, container: containerName });
        }
        return out;
    }

    /** `{ free, reason }` for one port and bind address: a listening socket, then another container's mapping. */
    async function portStatus(port, bind, { ignoreOwn = true } = {}) {
        const published = await publishedPorts({ ignoreOwn });
        const holder = published.find(item => item.port === port && item.protocol === 'tcp');
        if (holder) return { free: false, reason: 'CONTAINER_PUBLISHES', container: holder.container };
        if (!(await listenProbe(port, bind))) return { free: false, reason: 'SOCKET_IN_USE' };
        return { free: true, reason: null };
    }

    /** The first free port at or above `port` (the asked one first), never silently bound. */
    async function nextFreePort(port, bind, options = {}) {
        for (let candidate = port; candidate < Math.min(65536, port + PORT_SEARCH); candidate++) {
            if ((await portStatus(candidate, bind, options)).free) return candidate;
        }
        return null;
    }

    return {
        resources, inspectOwned, container, ensureNetwork, ensureVolume, imagePulled, pull, createContainer,
        start, stop, removeContainer, removeVolume, removeNetwork, waitHealthy, publishedPorts, portStatus, nextFreePort,
        summarizeContainer
    };
}

module.exports = { createContainers, parsePublished, probeListen, CONTAINER_PORT, PGDATA_SUBDIR, WAIT_HEALTHY_MS };
