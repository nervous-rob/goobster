#!/usr/bin/env node
/**
 * The privileged helper (documentation/linux_install.md, "Elevation").
 *
 *   sudo -n <node> apps/manager/privileged/helper.js   < request.json
 *
 * Reads one JSON request from stdin, validates it against the closed shapes
 * in ./protocol.js, performs the one operation through the platform module
 * (./<platform>.js) and writes one JSON reply to stdout. Exit code 0 when the
 * reply is `ok`, 1 for a refusal or a failure, 2 for a request it could not
 * even parse. It takes no argument and reads no environment for values; its
 * code is this file, ./protocol.js, ./linux.js and ../platform/systemdUnit.js,
 * and the manager checks their hashes against the release manifest before it
 * starts it elevated (./elevate.js).
 *
 * The one environment variable it honours is GOOBSTER_HELPER_SANDBOX, a
 * directory, and only when it is NOT running as root: a non-root helper can
 * touch nothing a normal process could not, which is how the tests and CI
 * exercise the protocol against fake `systemctl` and `useradd` programs.
 */

const fs = require('node:fs');
const path = require('node:path');
const protocol = require('./protocol');

const PLATFORMS = Object.freeze({ linux: './linux' });

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function sandboxDeps(env) {
    const dir = env.GOOBSTER_HELPER_SANDBOX;
    const root = typeof process.geteuid === 'function' ? process.geteuid() === 0 : false;
    if (!dir || root || !path.isAbsolute(dir)) return {};
    return {
        sandbox: true,
        unitDir: path.join(dir, 'etc', 'systemd', 'system'),
        cronDir: path.join(dir, 'etc', 'cron.d'),
        updateConf: path.join(dir, 'etc', 'goobster-update.conf'),
        commandDirs: [path.join(dir, 'bin')]
    };
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
    const modulePath = PLATFORMS[platform];
    if (!modulePath) {
        return { reply: protocol.errorReply(request.operation, 'PLATFORM_UNSUPPORTED', `There is no privileged helper for ${platform} yet.`), code: 1 };
    }
    const implementation = require(modulePath);
    try {
        const handler = implementation.createHandler(deps || sandboxDeps(env));
        const result = handler.handle(request.operation, request.input);
        return { reply: protocol.okReply(request.operation, result.outcome, result.detail, result.log), code: 0 };
    } catch (error) {
        if (error instanceof protocol.HelperError) {
            return { reply: protocol.errorReply(request.operation, error.code, error.message, error.log || []), code: 1 };
        }
        return { reply: protocol.errorReply(request.operation, 'HELPER_FAILED', 'The helper failed.'), code: 1 };
    }
}

function main() {
    const { reply, code } = execute(readStdin());
    process.stdout.write(`${JSON.stringify(reply)}\n`, () => process.exit(code));
}

if (require.main === module) main();

module.exports = { execute, sandboxDeps };
