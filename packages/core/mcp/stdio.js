/**
 * stdio transport for the read-only MCP server.
 *
 * stdout is protocol only. The caller authenticates once (a local process
 * that can read the database still needs a token, so a shared host does
 * not silently become every user) and passes the resolved session.
 */

const { handleMessage, attachStdio } = require('./protocol');
const { toolDescriptors, callTool } = require('./tools');
const { consume } = require('./rateLimit');
const mcpConfig = require('../config/mcpConfig');
const { SERVER_INFO } = require('./http');

/**
 * @param {object} params
 * @param {{ id: number, userId: string }} params.session
 * @param {NodeJS.ReadableStream} [params.input]
 * @param {NodeJS.WritableStream} [params.output]
 * @param {(line: string) => void} [params.log] stderr
 */
function serveStdio({ session, input = process.stdin, output = process.stdout, log = () => {} }) {
    return attachStdio({
        input,
        output,
        onMessage: async (message) => {
            if (!consume(`mcp:${session.id}`, mcpConfig.requestsPerMinute)) {
                const id = message && typeof message === 'object' ? message.id ?? null : null;
                return {
                    kind: 'response',
                    body: {
                        jsonrpc: '2.0',
                        id,
                        error: { code: -32000, message: 'Too many MCP requests. Wait a minute and try again.' }
                    }
                };
            }
            const method = message?.method;
            const toolName = method === 'tools/call' ? message?.params?.name : '';
            log(`MCP ${method || 'request'}${toolName ? ` ${toolName}` : ''}`);
            return handleMessage(message, {
                serverInfo: SERVER_INFO,
                listTools: toolDescriptors,
                callTool: (name, args) => callTool(session.userId, name, args)
            });
        }
    });
}

module.exports = { serveStdio };
