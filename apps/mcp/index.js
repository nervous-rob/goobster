/**
 * goobster-mcp — read-only MCP server over stdio.
 *
 *   GOOBSTER_MCP_TOKEN=gst_... node apps/mcp/index.js
 *
 * The master switch is mcp.enabled (or GOOBSTER_MCP_ENABLED=1). The
 * token selects whose workspace the tools read. stdout is the protocol;
 * this file logs to stderr only, and any other write to stdout (a database
 * migration notice, a library's console.log) is diverted to stderr too.
 *
 * Requiring this module does not start the server. Smoke tests and
 * other tooling can load it.
 */

const mcpConfig = require('@goobster/core/config/mcpConfig');
const mcpTokenService = require('@goobster/core/services/mcpTokenService');
const { serveStdio } = require('@goobster/core/mcp/stdio');
const { reserveStdout } = require('@goobster/core/mcp/stdout');

function log(line) {
    process.stderr.write(`${line}\n`);
}

async function main() {
    // Before the first database open: its migration notices must not reach the client.
    const protocolOutput = reserveStdout();
    if (!mcpConfig.enabled) {
        log('MCP is off. Set mcp.enabled to true in config.json, or GOOBSTER_MCP_ENABLED=1, and restart.');
        process.exitCode = 1;
        return;
    }
    const token = process.env.GOOBSTER_MCP_TOKEN;
    if (!token) {
        log('Set GOOBSTER_MCP_TOKEN to a token from Settings → Connections, or from `npm run mcp:token`.');
        process.exitCode = 1;
        return;
    }
    const auth = await mcpTokenService.resolve(token);
    if (auth.status !== 'ok') {
        log(auth.status === 'expired'
            ? 'That MCP token has expired. Create a new one and try again.'
            : 'That MCP token is not valid. Create a new one and try again.');
        process.exitCode = 1;
        return;
    }
    const { session } = auth;
    log(`Goobster MCP (read-only, ${session.scope}) connected for ${session.userId} (${session.label}).`);
    await serveStdio({ session, output: protocolOutput, log });
}

module.exports = { main };

if (require.main === module) {
    main().catch(error => {
        log(`MCP server failed: ${error?.message || error}`);
        process.exitCode = 1;
    });
}
