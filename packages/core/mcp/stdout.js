/**
 * Keep stdout clean for a process whose stdout is a protocol or a secret.
 *
 * The database layer (and any library) may `console.log` on first open, for
 * example `[DB] Migrated: added ...` after an upgrade. On a stdio MCP
 * server that text would land in the middle of the JSON-RPC stream, and in
 * `npm run mcp:token -- create` it would land in front of the secret.
 *
 * `reserveStdout()` hands back a writer bound to the real stdout and turns
 * every other write to `process.stdout` (console.log, winston's console
 * transport, a stray `process.stdout.write`) into a write to stderr.
 */

/**
 * @param {NodeJS.WriteStream} [stdout]
 * @param {NodeJS.WriteStream} [stderr]
 * @returns {{ write: (chunk: string) => boolean }} the only path to the real stdout
 */
function reserveStdout(stdout = process.stdout, stderr = process.stderr) {
    const write = stdout.write.bind(stdout);
    stdout.write = (...args) => stderr.write(...args);
    return { write: (chunk) => write(chunk) };
}

module.exports = { reserveStdout };
