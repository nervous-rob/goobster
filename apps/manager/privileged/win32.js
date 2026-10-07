/**
 * The Windows implementation of the privileged operations
 * (documentation/windows_install.md). Two halves in one file, because a
 * platform module is one thing to drop in:
 *
 *   `createHandler(deps)`  the helper's half: runs elevated, inside
 *                          apps/manager/privileged/helper.js, and performs
 *                          the two operations Windows needs:
 *                          `service.register` and `service.unregister`.
 *   `elevation()`          the manager's half: whether the manager is already
 *   `transport()`          an administrator, may ask for UAC, or has no way;
 *   `refusal()`            how the request and the reply travel through
 *   `manualCommand()`      files when UAC cannot pass a pipe; what a dismissed
 *   `serviceFacts()`       prompt looks like; what to tell an operator.
 *
 * The service is registered with `sc.exe` only. The WinSW host executable is
 * copied into `<manager store>\service\`, hash-verified against the pin in
 * ../platform/windowsServiceXml.js before it is written, and never *run* by
 * the helper (WinSW's own `install` verb would start a user-writable program
 * elevated): the service manager runs it later, as the virtual account
 * `NT SERVICE\goobster`, not as an administrator.
 *
 * Nothing here runs a shell: every command is a fixed program started with an
 * argument vector from `%SystemRoot%\System32` with a minimal environment
 * (PowerShell only for the fixed scripts below). Nothing takes a secret. The
 * helper reads only what the request names plus the installation record the
 * request must agree with, and writes only the service folder in the manager
 * store and the access rules on the roots the request names. Node built-ins
 * and the two sibling modules only (the helper's whole code, see
 * tests/windowsHelper.test.js).
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { refuse, HelperError } = require('./protocol');
const xml = require('../platform/windowsServiceXml');

const PLATFORM = 'win32';

/** Operations this platform implements; the rest answer NOT_IMPLEMENTED. */
const OPERATIONS = Object.freeze(['service.register', 'service.unregister']);

/** The files the elevated helper runs on Windows, payload-relative, for the manifest check in ./elevate.js. */
const HELPER_FILES = Object.freeze([
    'app/apps/manager/privileged/helper.js',
    'app/apps/manager/privileged/protocol.js',
    'app/apps/manager/privileged/win32.js',
    'app/apps/manager/platform/windowsServiceXml.js',
    'app/apps/manager/platform/systemdUnit.js'
]);

const COMMAND_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1000;
/** The service's own stop bound (windowsServiceXml.STOP_TIMEOUT, 120 s) plus time to drain and exit. */
const STOP_WAIT_MS = 150_000;
const START_WAIT_MS = 30_000;
const DELETE_WAIT_MS = 20_000;
const TRANSPORT_FLOOR_MS = 7 * 60 * 1000;
const SCM_NO_SERVICE = 1060;
const UAC_CANCELLED = 1223;

const SID_SYSTEM = '*S-1-5-18';
const SID_ADMINISTRATORS = '*S-1-5-32-544';
const SID_USERS = '*S-1-5-32-545';

const STATES = Object.freeze({ 1: 'stopped', 2: 'start-pending', 3: 'stop-pending', 4: 'running', 5: 'continue-pending', 6: 'pause-pending', 7: 'paused' });
const RECOVERY = 'restart/10000/restart/10000/restart/10000';

/**
 * The one PowerShell the helper runs besides Start-Process: read the service's
 * registered image path from the registry and print it as base64 of UTF-8
 * (`sc.exe` prints in the OEM code page, which cannot carry every path).
 * Fixed text; nothing is interpolated into it.
 */
const IMAGE_PATH_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    `$key = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\${xml.SERVICE_ID}'`,
    "if (-not (Test-Path -LiteralPath $key)) { [Console]::Out.Write('ABSENT'); exit 0 }",
    '$image = [string](Get-ItemProperty -LiteralPath $key -Name ImagePath).ImagePath',
    '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($image)))'
].join('\n');

const encodeScript = (script) => Buffer.from(script, 'utf16le').toString('base64');

function systemRootOf(env) {
    const raw = env && typeof env.SystemRoot === 'string' ? env.SystemRoot : '';
    return /^[A-Za-z]:\\Windows$/i.test(raw) ? raw : 'C:\\Windows';
}

function commandPaths(systemRoot) {
    const system32 = path.win32.join(systemRoot, 'System32');
    return {
        'sc.exe': path.win32.join(system32, 'sc.exe'),
        'icacls.exe': path.win32.join(system32, 'icacls.exe'),
        'whoami.exe': path.win32.join(system32, 'whoami.exe'),
        'powershell.exe': path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    };
}

/** The minimal environment every fixed program gets. */
function minimalEnv(systemRoot) {
    return { SystemRoot: systemRoot, windir: systemRoot, PATH: `${path.win32.join(systemRoot, 'System32')};${systemRoot}` };
}

function defaultExec(file, args, { env, timeout = COMMAND_TIMEOUT_MS } = {}) {
    const result = childProcess.spawnSync(file, args, { encoding: 'latin1', env, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return { status: result.status === null ? 1 : result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error ? result.error.code || 'EXEC' : null };
}

function defaultSleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sha256Of(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Whether this process holds a High (or System) integrity token, which is what "elevated" means under UAC. */
function isElevated({ exec = defaultExec, systemRoot = 'C:\\Windows' } = {}) {
    const result = exec(commandPaths(systemRoot)['whoami.exe'], ['/groups'], { env: minimalEnv(systemRoot) });
    return result.status === 0 && /S-1-16-(12288|16384)\b/.test(String(result.stdout || ''));
}

/** The installed image path out of what the registry holds: `"C:\x\y.exe"` or `C:\x\y.exe` followed by arguments. */
function imagePathOf(raw) {
    const text = String(raw || '').trim();
    if (text.startsWith('"')) {
        const end = text.indexOf('"', 1);
        return end > 1 ? text.slice(1, end) : null;
    }
    const match = /^(.*?\.exe)(?:\s|$)/i.exec(text);
    return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// the helper's half
// ---------------------------------------------------------------------------

/**
 * @param {Object} [deps]
 * @param {Object} [deps.fs]
 * @param {Function} [deps.exec]        `(file, args, { env }) => { status, stdout, stderr }`
 * @param {Function} [deps.sleep]       `(ms) => void`, synchronous
 * @param {boolean} [deps.elevated]     tests: skip the token check
 * @param {string} [deps.systemRoot]
 * @param {string} [deps.payloadRoot]   the payload this helper runs from; its sibling `service-host` holds the host executable
 * @param {string[]} [deps.hostCandidates] extra places to look for the host executable
 * @param {Object} [deps.waits]         `{ stop, start, remove }` bounds in milliseconds (tests)
 * @param {Object} [deps.pin]           the host pin (tests)
 */
function createHandler(deps = {}) {
    const fs = deps.fs || nodeFs;
    const systemRoot = deps.systemRoot || systemRootOf(process.env);
    const exec = deps.exec || defaultExec;
    const sleep = deps.sleep || defaultSleep;
    const payloadRoot = deps.payloadRoot || path.resolve(__dirname, '..', '..', '..', '..');
    const pin = deps.pin || xml.WINSW;
    const waits = { stop: STOP_WAIT_MS, start: START_WAIT_MS, remove: DELETE_WAIT_MS, ...(deps.waits || {}) };
    const commands = commandPaths(systemRoot);
    const env = minimalEnv(systemRoot);

    function run(log, label, name, args, { allowFailure = false } = {}) {
        const result = exec(commands[name], args, { env });
        log.push(`${label} -> ${result.status}`);
        if (result.status !== 0 && !allowFailure) {
            const code = /FAILED\s+(\d+)/.exec(String(result.stdout || '')) || /FAILED\s+(\d+)/.exec(String(result.stderr || ''));
            throw refuse('COMMAND_FAILED', `${label} failed with status ${result.status}${code ? ` (error ${code[1]})` : ''}.`);
        }
        return result;
    }

    function requireElevated() {
        const elevated = deps.elevated !== undefined ? deps.elevated : isElevated({ exec, systemRoot });
        if (!elevated) throw refuse('NOT_ELEVATED', 'The helper is not running as an administrator.');
    }

    function readText(file) {
        try {
            return fs.readFileSync(file, 'utf8');
        } catch (error) {
            if (error && error.code === 'ENOENT') return null;
            throw error;
        }
    }

    function readBuffer(file) {
        try {
            return fs.readFileSync(file);
        } catch {
            return null;
        }
    }

    function verifyRecord(input) {
        const text = readText(path.win32.join(input.roots.managerStore, 'installation.json'));
        let doc = null;
        try {
            doc = text ? JSON.parse(text) : null;
        } catch { }
        if (!doc || doc.installationId !== input.installationId) {
            throw refuse('INSTALLATION_MISMATCH', 'The installation record does not name this installation id.');
        }
        if (doc.roots) {
            for (const role of Object.keys(input.roots)) {
                if (doc.roots[role] !== input.roots[role]) throw refuse('INSTALLATION_MISMATCH', `The installation record names another ${role} root.`);
            }
        }
    }

    function verifyInstall(input) {
        if (input.mode !== 'payload') throw refuse('NOT_IMPLEMENTED', 'A Windows service runs an activated payload; there is no source-checkout service here.');
        const current = path.win32.join(input.codeRoot, 'current');
        for (const rel of ['payload-manifest.json', 'runtime\\node.exe', 'app\\apps\\manager\\index.js']) {
            if (!fs.existsSync(path.win32.join(current, rel))) throw refuse('PAYLOAD_MISSING', 'The code root holds no activated payload; install it before registering the service.');
        }
    }

    /** The registered service: `{ exists, imagePath }`. `imagePath` is null when the registry holds one this module cannot read. */
    function lookup(log) {
        const result = run(log, 'registry query', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeScript(IMAGE_PATH_SCRIPT)], { allowFailure: true });
        const out = String(result.stdout || '').trim();
        if (result.status !== 0) throw refuse('SERVICE_QUERY_FAILED', 'The registered service could not be read.');
        if (out === 'ABSENT') return { exists: false, imagePath: null };
        let image = '';
        try {
            image = Buffer.from(out, 'base64').toString('utf8');
        } catch { }
        return { exists: true, imagePath: imagePathOf(image) };
    }

    /** Whether the registered service is this installation's: its host sits beside a definition that carries our marker. */
    function ownership(found, installationId) {
        const expected = xml.HOST_FILE_NAME.toLowerCase();
        if (!found.imagePath || path.win32.basename(found.imagePath).toLowerCase() !== expected) return { ours: false };
        try {
            xml.assertSafePath(found.imagePath, 'the registered image');
        } catch {
            return { ours: false };
        }
        const dir = path.win32.dirname(found.imagePath);
        const definition = readText(path.win32.join(dir, xml.XML_FILE_NAME));
        if (definition === null) return { ours: false, dir };
        const parsed = xml.parseDefinition(definition);
        return { ours: parsed.installationId === installationId && parsed.serviceId === xml.SERVICE_ID, dir, foreignMarker: parsed.installationId !== null && parsed.installationId !== installationId };
    }

    function stateOf() {
        const result = exec(commands['sc.exe'], ['query', xml.SERVICE_ID], { env });
        if (result.status === SCM_NO_SERVICE) return 'absent';
        const match = /STATE\s*:\s*(\d+)/.exec(String(result.stdout || ''));
        return match ? (STATES[Number(match[1])] || 'unknown') : 'unknown';
    }

    function waitFor(log, wanted, limitMs) {
        let state = stateOf();
        for (let waited = 0; !wanted.includes(state) && waited < limitMs; waited += POLL_INTERVAL_MS) {
            sleep(POLL_INTERVAL_MS);
            state = stateOf();
        }
        log.push(`service ${state}`);
        return state;
    }

    function stopService(log, state) {
        if (state === 'stopped' || state === 'absent') return state;
        if (state !== 'stop-pending') run(log, 'sc.exe stop', 'sc.exe', ['stop', xml.SERVICE_ID], { allowFailure: true });
        const after = waitFor(log, ['stopped', 'absent'], waits.stop);
        if (after !== 'stopped' && after !== 'absent') {
            throw refuse('SERVICE_STILL_ACTIVE', `The goobster service is still ${after} after the stop bound; nothing was changed.`);
        }
        return after;
    }

    /** The host executable, read once into memory and checked against the pin; the bytes written are the bytes verified. */
    function locateHost(input) {
        const paths = xml.servicePaths(input.roots);
        const candidates = [paths.exe, path.win32.join(path.win32.dirname(payloadRoot), 'service-host', xml.HOST_FILE_NAME), ...(deps.hostCandidates || [])];
        let sawFile = false;
        for (const candidate of candidates) {
            const buffer = readBuffer(candidate);
            if (!buffer) continue;
            sawFile = true;
            if (sha256Of(buffer) === pin.sha256) return buffer;
        }
        if (sawFile) throw refuse('SERVICE_HOST_UNVERIFIED', 'The service host executable does not match the pinned release; it was not installed.');
        throw refuse('SERVICE_HOST_MISSING', 'The service host executable is not in the installer payload; run the installer again.');
    }

    function writeAtomic(file, data) {
        const tmp = path.win32.join(path.win32.dirname(file), `.${path.win32.basename(file)}.${process.pid}.tmp`);
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, file);
    }

    function lockServiceDir(log, dir) {
        fs.mkdirSync(dir, { recursive: true });
        run(log, 'icacls.exe owner service folder', 'icacls.exe', [dir, '/setowner', SID_ADMINISTRATORS]);
        run(log, 'icacls.exe lock service folder', 'icacls.exe', [dir, '/inheritance:r', '/grant:r', `${SID_SYSTEM}:(OI)(CI)F`, `${SID_ADMINISTRATORS}:(OI)(CI)F`, `${SID_USERS}:(OI)(CI)RX`]);
    }

    function grant(log, label, target, rights, { inherit = true } = {}) {
        run(log, `icacls.exe grant ${label}`, 'icacls.exe', [target, '/grant', `${xml.ACCOUNT}:${inherit ? '(OI)(CI)' : ''}${rights}`]);
    }

    function applyAccess(log, input, serviceDir) {
        grant(log, 'service folder', serviceDir, 'RX');
        grant(log, 'code', input.roots.code, 'RX');
        let index = 0;
        for (const target of xml.mutablePaths({ roots: input.roots })) {
            index += 1;
            if (target === input.roots.config) {
                // The config file lies inside the code root: only the file itself is writable, and only once it exists.
                if (fs.existsSync(target)) grant(log, `mutable root ${index}`, target, 'M', { inherit: false });
                continue;
            }
            fs.mkdirSync(target, { recursive: true });
            grant(log, `mutable root ${index}`, target, 'M');
        }
    }

    function removeFiles(paths) {
        for (const file of [paths.exe, paths.xml]) fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 200 });
        try {
            fs.rmdirSync(paths.dir);
        } catch { }
    }

    // ---- service.register -------------------------------------------------
    function serviceRegister(input, log) {
        requireElevated();
        verifyRecord(input);
        verifyInstall(input);
        const paths = xml.servicePaths(input.roots);
        const found = lookup(log);
        let owned = null;
        if (found.exists) {
            owned = ownership(found, input.installationId);
            if (!owned.ours) {
                throw refuse('SERVICE_FOREIGN', 'A goobster service exists that this installation did not register; it was left as it is.');
            }
        }
        const host = locateHost(input);
        const definition = xml.renderXml({
            name: input.name,
            installationId: input.installationId,
            runtimeUser: input.runtimeUser,
            codeRoot: input.codeRoot,
            roots: input.roots,
            layout: input.layout
        });

        let state = found.exists ? stateOf() : 'absent';
        const sameHost = found.exists && owned.dir.toLowerCase() === paths.dir.toLowerCase();
        const unchanged = sameHost && readText(paths.xml) === definition && (readBuffer(paths.exe) || Buffer.alloc(0)).equals(host);
        if (unchanged && state === 'running') {
            log.push('service unchanged');
            return { outcome: 'noop', detail: { service: xml.SERVICE_ID, written: false, active: state } };
        }

        let written = false;
        if (!unchanged) {
            state = stopService(log, state);
            lockServiceDir(log, paths.dir);
            writeAtomic(paths.exe, host);
            writeAtomic(paths.xml, definition);
            written = true;
            log.push('service folder written');
        } else {
            log.push('service folder unchanged');
        }

        const binPath = `"${paths.exe}"`;
        if (!found.exists) {
            run(log, 'sc.exe create', 'sc.exe', ['create', xml.SERVICE_ID, 'binPath=', binPath, 'DisplayName=', xml.DISPLAY_NAME, 'start=', 'auto', 'obj=', xml.ACCOUNT]);
        } else if (!sameHost) {
            run(log, 'sc.exe config', 'sc.exe', ['config', xml.SERVICE_ID, 'binPath=', binPath, 'start=', 'auto']);
        }
        if (!found.exists || written) {
            run(log, 'sc.exe description', 'sc.exe', ['description', xml.SERVICE_ID, `${xml.DISPLAY_NAME} Discord bot, installation ${input.installationId}`]);
            run(log, 'sc.exe failure', 'sc.exe', ['failure', xml.SERVICE_ID, 'reset=', '86400', 'actions=', RECOVERY]);
            run(log, 'sc.exe failureflag', 'sc.exe', ['failureflag', xml.SERVICE_ID, '1'], { allowFailure: true });
            run(log, 'sc.exe sidtype', 'sc.exe', ['sidtype', xml.SERVICE_ID, 'unrestricted'], { allowFailure: true });
        }
        applyAccess(log, input, paths.dir);

        if (found.exists && !sameHost) {
            removeFiles({ dir: owned.dir, exe: path.win32.join(owned.dir, xml.HOST_FILE_NAME), xml: path.win32.join(owned.dir, xml.XML_FILE_NAME) });
            log.push('previous service folder removed');
        }

        if (state !== 'running' && state !== 'start-pending') run(log, 'sc.exe start', 'sc.exe', ['start', xml.SERVICE_ID], { allowFailure: true });
        const active = waitFor(log, ['running'], waits.start);
        return { outcome: written || !found.exists ? 'done' : 'noop', detail: { service: xml.SERVICE_ID, written, active } };
    }

    // ---- service.unregister -----------------------------------------------
    function serviceUnregister(input, log) {
        requireElevated();
        const found = lookup(log);
        if (!found.exists) {
            log.push('service already absent');
            return { outcome: 'noop', detail: { service: xml.SERVICE_ID, removed: false } };
        }
        const owned = ownership(found, input.installationId);
        if (!owned.ours) {
            throw refuse('SERVICE_FOREIGN', 'The goobster service was not registered by this installation; it was left as it is.');
        }
        stopService(log, stateOf());
        run(log, 'sc.exe delete', 'sc.exe', ['delete', xml.SERVICE_ID]);
        const after = waitFor(log, ['absent'], waits.remove);
        if (after !== 'absent') log.push('service marked for deletion');
        removeFiles({ dir: owned.dir, exe: path.win32.join(owned.dir, xml.HOST_FILE_NAME), xml: path.win32.join(owned.dir, xml.XML_FILE_NAME) });
        return { outcome: 'done', detail: { service: xml.SERVICE_ID, removed: true } };
    }

    const table = {
        'service.register': serviceRegister,
        'service.unregister': serviceUnregister
    };

    /**
     * @param {string} operation
     * @param {Object} input the validated input (protocol.validateInput)
     * @returns {{ outcome: 'done'|'noop', detail: Object, log: string[] }}
     * @throws {HelperError}
     */
    function handle(operation, input) {
        const log = [];
        const action = table[operation];
        if (!action) throw refuse('NOT_IMPLEMENTED', `${operation} is not implemented on Windows.`);
        if (input.kind !== 'windows-service') throw refuse('NOT_IMPLEMENTED', 'This platform registers Windows services only.');
        if (input.scope && input.scope !== 'machine') throw refuse('NOT_IMPLEMENTED', 'A Windows service is registered for the machine.');
        try {
            const result = action(input, log);
            return { ...result, log };
        } catch (error) {
            if (error instanceof HelperError) {
                error.log = log;
                throw error;
            }
            const failure = refuse('HELPER_FAILED', `The operation failed (${error && error.code ? error.code : 'error'}).`);
            failure.log = log;
            throw failure;
        }
    }

    return { handle, lookup, stateOf };
}

// ---------------------------------------------------------------------------
// the manager's half
// ---------------------------------------------------------------------------

/** A session a person is sitting at: a UAC prompt can be answered. A service, a scheduled task or an SSH login cannot. */
function hasInteractiveSession(env) {
    if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
    const session = String(env.SESSIONNAME || '');
    return session !== '' && session.toLowerCase() !== 'services';
}

/**
 * How the manager reaches administrator rights for the helper.
 * @returns {{ kind: 'administrator'|'uac'|'none', prefix: string[], reason?: string }}
 */
function elevation({ env = process.env, exec = defaultExec } = {}) {
    const systemRoot = systemRootOf(env);
    if (isElevated({ exec, systemRoot })) return { kind: 'administrator', prefix: [] };
    if (hasInteractiveSession(env)) return { kind: 'uac', prefix: [] };
    return { kind: 'none', prefix: [], reason: 'NO_INTERACTIVE_SESSION' };
}

/** The line an operator can run by hand, from an administrator Command Prompt, when no elevation is available. */
function manualCommand({ nodePath, helperPath, requestFile }) {
    const reply = String(requestFile).replace(/\.request\.json$/i, '.reply.json');
    return `"${nodePath}" "${helperPath}" --request "${requestFile}" --reply "${reply}"`;
}

/** Is the service control manager there? `sc.exe query state= all` lists services whenever it is. */
function serviceFacts({ env = process.env, exec = null } = {}) {
    const systemRoot = systemRootOf(env);
    const run = exec || ((file, args, options) => {
        if (process.platform !== 'win32') return { status: 1, stdout: '', stderr: '' };
        return defaultExec(file, args, { ...options, timeout: 15_000 });
    });
    const result = run(commandPaths(systemRoot)['sc.exe'], ['query', 'state=', 'all'], { env: minimalEnv(systemRoot) });
    const available = result.status === 0;
    return { available, state: available ? 'running' : null, reason: available ? null : 'SCM_UNAVAILABLE' };
}

function unsafeForArgument(value) {
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    return typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f"]/.test(value);
}

function psQuote(value) {
    return `'${String(value).replace(/['\u2018\u2019\u201a\u201b]/g, match => match + match)}'`;
}

function currentSid({ exec, systemRoot }) {
    const result = exec(commandPaths(systemRoot)['whoami.exe'], ['/user', '/fo', 'csv', '/nh'], { env: minimalEnv(systemRoot) });
    const match = result.status === 0 ? /"(S-\d-\d+(?:-\d+)+)"/.exec(String(result.stdout || '')) : null;
    return match ? match[1] : null;
}

/** The fixed script UAC runs: start the helper elevated, wait, and say whether the prompt was dismissed. */
function elevationScript({ nodePath, helperPath, requestFile, replyFile }) {
    const args = `"${helperPath}" --request "${requestFile}" --reply "${replyFile}"`;
    return [
        "$ErrorActionPreference = 'Stop'",
        'try {',
        `    $p = Start-Process -FilePath ${psQuote(nodePath)} -ArgumentList ${psQuote(args)} -Verb RunAs -Wait -PassThru -WindowStyle Hidden`,
        '    exit $p.ExitCode',
        '} catch {',
        '    [Console]::Error.WriteLine($_.Exception.Message)',
        "    if ($_.Exception.Message -match 'canceled by the user') { exit 1223 }",
        '    exit 1',
        '}'
    ].join('\n');
}

function collect(stream, limit) {
    const chunks = [];
    let size = 0;
    if (!stream) return () => '';
    stream.on('data', (chunk) => {
        if (size < limit) chunks.push(chunk);
        size += chunk.length;
    });
    return () => Buffer.concat(chunks.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))).toString('utf8');
}

function waitForChild(child, timeoutMs) {
    return new Promise((resolve) => {
        const out = collect(child.stdout, 64 * 1024);
        const err = collect(child.stderr, 64 * 1024);
        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch { }
        }, timeoutMs);
        child.once('error', (error) => {
            clearTimeout(timer);
            resolve({ spawnError: error && error.code ? error.code : 'EXEC', status: null, stdout: out(), stderr: err() });
        });
        child.once('close', (status, signal) => {
            clearTimeout(timer);
            resolve({ status, signal, stdout: out(), stderr: err() });
        });
    });
}

/**
 * Carry one request to the helper and bring its reply back through files
 * under `requestDir` (UAC cannot pass a pipe): `<operation>.request.json`
 * readable only by the asking person and the administrators, `<operation>.reply.json`
 * written by the helper. Both are removed once a reply was read; a request
 * nobody answered stays, because the by-hand command names it.
 * @returns {Promise<{ status: number|null, stdout: string, stderr: string, spawnError?: string }>}
 */
async function transport({ plan, request, nodePath, helperPath, requestDir, spawn = childProcess.spawn, fs = nodeFs, env = process.env, timeoutMs = 0, exec = defaultExec }) {
    const failed = (spawnError) => ({ spawnError, status: null, stdout: '', stderr: '' });
    if (!requestDir) return failed('NO_REQUEST_DIR');
    if (unsafeForArgument(nodePath) || unsafeForArgument(helperPath) || unsafeForArgument(requestDir)) return failed('UNSAFE_PATH');
    let operation;
    try {
        operation = JSON.parse(request).operation;
    } catch {
        return failed('BAD_REQUEST');
    }
    if (typeof operation !== 'string' || !/^[a-z]+\.[a-z]+$/.test(operation)) return failed('BAD_REQUEST');

    const systemRoot = systemRootOf(env);
    const requestFile = path.join(requestDir, `${operation}.request.json`);
    const replyFile = path.join(requestDir, `${operation}.reply.json`);
    try {
        fs.mkdirSync(requestDir, { recursive: true });
        fs.writeFileSync(requestFile, `${request}\n`);
        fs.rmSync(replyFile, { force: true });
        const sid = currentSid({ exec, systemRoot });
        const acl = sid ? exec(commandPaths(systemRoot)['icacls.exe'], [requestFile, '/inheritance:r', '/grant:r', `*${sid}:F`, `${SID_ADMINISTRATORS}:F`], { env: minimalEnv(systemRoot) }) : { status: 1 };
        if (acl.status !== 0) {
            fs.rmSync(requestFile, { force: true });
            return failed('ACL_FAILED');
        }
    } catch {
        return failed('REQUEST_NOT_WRITTEN');
    }

    const bound = Math.max(timeoutMs || 0, TRANSPORT_FLOOR_MS);
    let child;
    try {
        if (plan.kind === 'uac') {
            const script = elevationScript({ nodePath, helperPath, requestFile, replyFile });
            child = spawn(commandPaths(systemRoot)['powershell.exe'], ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeScript(script)], { stdio: ['ignore', 'pipe', 'pipe'], env: minimalEnv(systemRoot), windowsHide: true });
        } else {
            child = spawn(nodePath, [helperPath, '--request', requestFile, '--reply', replyFile], { stdio: ['ignore', 'pipe', 'pipe'], env: minimalEnv(systemRoot), windowsHide: true });
        }
    } catch (error) {
        return failed(error && error.code ? error.code : 'EXEC');
    }
    const finished = await waitForChild(child, bound);
    let reply = '';
    try {
        reply = fs.readFileSync(replyFile, 'utf8');
    } catch { }
    if (reply) {
        for (const file of [requestFile, replyFile]) {
            try {
                fs.rmSync(file, { force: true });
            } catch { }
        }
    }
    return { ...finished, stdout: reply };
}

/** How UAC says the person declined: PowerShell exits 1223 (ERROR_CANCELLED) or reports "canceled by the user". */
function refusal({ status, stderr = '' }) {
    if (status === UAC_CANCELLED || /canceled by the user/i.test(String(stderr))) return { reason: 'ELEVATION_DECLINED' };
    return null;
}

/**
 * The sandbox a non-elevated helper acts in (tests, CI on another platform).
 * On Windows the helper never honours a sandbox: an elevated process must not
 * take its programs from an environment variable.
 */
function sandboxDeps() {
    if (process.platform === 'win32') return {};
    return { systemRoot: 'C:\\Windows', elevated: true };
}

module.exports = {
    PLATFORM,
    OPERATIONS,
    HELPER_FILES,
    IMAGE_PATH_SCRIPT,
    createHandler,
    sandboxDeps,
    elevation,
    transport,
    refusal,
    manualCommand,
    serviceFacts,
    isElevated,
    imagePathOf,
    elevationScript
};
