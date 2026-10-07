#!/usr/bin/env node
/**
 * The privileged helper (documentation/linux_install.md, "Elevation").
 *
 *   sudo -n <node> apps/manager/privileged/helper.js   < request.json
 *   <node> apps/manager/privileged/helper.js --request <file> --reply <file>   (file transport)
 *
 * Reads one JSON request from stdin, validates it against the closed shapes
 * in ./protocol.js, performs the one operation through the platform module
 * (./<platform>.js) and writes one JSON reply to stdout. Exit code 0 when the
 * reply is `ok`, 1 for a refusal or a failure, 2 for a request it could not
 * even parse. It takes no argument and reads no environment for values; its
 * code is this file, ./protocol.js, the platform module (./linux.js and the
 * service text it renders, ../platform/systemdUnit.js) - the platform module's
 * HELPER_FILES names them - and the manager checks their hashes against the
 * release manifest before it starts it elevated (./elevate.js).
 *
 * The one environment variable it honours is GOOBSTER_HELPER_SANDBOX, a
 * directory, and only when it is NOT running as root: a non-root helper can
 * touch nothing a normal process could not, which is how the tests and CI
 * exercise the protocol against fake `systemctl` and `useradd` programs.
 */

const fs = require('node:fs');
const path = require('node:path');
const protocol = require('./protocol');

const PLATFORMS = Object.freeze({ linux: () => require('./linux'), win32: () => require('./win32'), darwin: () => require('./darwin') });

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

/**
 * The handler dependencies for a sandboxed (non-root) run, shaped by the
 * platform module; nothing when the helper is root or no sandbox is named.
 */
function sandboxDeps(env, implementation = require('./linux')) {
    const dir = env.GOOBSTER_HELPER_SANDBOX;
    const root = typeof process.geteuid === 'function' ? process.geteuid() === 0 : false;
    if (!dir || root || !path.isAbsolute(dir)) return {};
    return implementation.sandboxDeps(dir);
}

/**
 * @param {string} text the request document
 * @param {Object} [options]
 * @param {string} [options.platform]
 * @param {Object} [options.deps] handler dependencies (tests)
 * @returns {{ reply: Object, code: number }}
 */
function execute(text, { platform = process.platform, deps = null, env = process.env } = {}) {
    let request;
    try {
        request = protocol.parseRequest(text);
    } catch (error) {
        const code = error instanceof protocol.HelperError ? error.code : 'INVALID_REQUEST';
        const message = error instanceof protocol.HelperError ? error.message : 'The request could not be read.';
        return { reply: protocol.errorReply('unknown', code, message), code: 2 };
    }
    const load = PLATFORMS[platform];
    if (!load) {
        return { reply: protocol.errorReply(request.operation, 'PLATFORM_UNSUPPORTED', `There is no privileged helper for ${platform} yet.`), code: 1 };
    }
    const implementation = load();
    try {
        const handler = implementation.createHandler(deps || sandboxDeps(env, implementation));
        const result = handler.handle(request.operation, request.input);
        return { reply: protocol.okReply(request.operation, result.outcome, result.detail, result.log), code: 0 };
    } catch (error) {
        if (error instanceof protocol.HelperError) {
            return { reply: protocol.errorReply(request.operation, error.code, error.message, error.log || []), code: 1 };
        }
        return { reply: protocol.errorReply(request.operation, 'HELPER_FAILED', 'The helper failed.'), code: 1 };
    }
}

/**
 * `--request <file>` and `--reply <file>`: the file transport for a platform
 * whose elevation cannot pass a pipe (./elevate.js `transport()`). The paths
 * are the only arguments the helper ever takes; the values stay in the files.
 */
function parseArgs(argv) {
    const out = { requestFile: null, replyFile: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--request' && argv[i + 1]) out.requestFile = argv[++i];
        else if (argv[i] === '--reply' && argv[i + 1]) out.replyFile = argv[++i];
    }
    return out;
}

function readRequest(requestFile) {
    if (!requestFile) return readStdin();
    try {
        return fs.readFileSync(requestFile, 'utf8');
    } catch {
        return '';
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const { reply, code } = execute(readRequest(args.requestFile));
    const text = `${JSON.stringify(reply)}\n`;
    if (args.replyFile) {
        try {
            fs.writeFileSync(args.replyFile, text, { mode: 0o600 });
        } catch {
            process.stdout.write(text);
        }
        process.exit(code);
        return;
    }
    process.stdout.write(text, () => process.exit(code));
}

if (require.main === module) main();

module.exports = { execute, sandboxDeps, parseArgs, readRequest };
