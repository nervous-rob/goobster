/**
 * The slice of MCP a tools-only server needs: initialize, tools/list,
 * tools/call, and ping, as JSON-RPC 2.0.
 *
 * Batches are rejected (protocol 2025-06-18). Notifications get no
 * response. Tool failures are a normal result with `isError: true`;
 * only a broken request is a JSON-RPC error.
 *
 * The GBA harness (`clients/gba-mcp`) keeps its own zero-dependency copy
 * of this framing so that companion stays install-free.
 */

const JSONRPC = '2.0';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_INSTRUCTIONS = 'Goobster MCP is read-only. These tools search the token owner\'s '
    + 'private workspace: documentation, memories, facts, knowledge notes, projects, inbox, '
    + 'expeditions, and research briefs. They do not create, edit, or delete anything.';

function rpcError(id, code, message) {
    return { jsonrpc: JSONRPC, id: id ?? null, error: { code, message } };
}

function negotiateVersion(requested) {
    return SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
}

/**
 * Handle one JSON-RPC message.
 * @returns {Promise<{ kind: 'response', body: object } | { kind: 'accept' }>}
 */
async function handleMessage(message, { serverInfo, listTools, callTool }) {
    if (Array.isArray(message)) {
        return {
            kind: 'response',
            status: 400,
            body: rpcError(null, -32600, 'JSON-RPC batches are not supported')
        };
    }
    if (!message || typeof message !== 'object') {
        return { kind: 'response', status: 400, body: rpcError(null, -32600, 'Invalid Request') };
    }
    if (message.jsonrpc !== JSONRPC || typeof message.method !== 'string') {
        return { kind: 'response', status: 400, body: rpcError(message.id ?? null, -32600, 'Invalid Request') };
    }

    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;
    if (isNotification) return { kind: 'accept' };

    try {
        const result = await dispatch(method, params || {}, { serverInfo, listTools, callTool });
        if (result === UNSUPPORTED) {
            return {
                kind: 'response',
                status: 200,
                body: rpcError(id, -32601, `Method not found: ${method}`)
            };
        }
        return { kind: 'response', status: 200, body: { jsonrpc: JSONRPC, id, result } };
    } catch (error) {
        const code = Number.isInteger(error?.rpcCode) ? error.rpcCode : -32603;
        return {
            kind: 'response',
            status: 200,
            body: rpcError(id, code, error?.publicMessage || 'Internal error')
        };
    }
}

async function dispatch(method, params, { serverInfo, listTools, callTool }) {
    switch (method) {
        case 'initialize':
            return {
                protocolVersion: negotiateVersion(params.protocolVersion),
                capabilities: { tools: { listChanged: false } },
                serverInfo,
                instructions: SERVER_INSTRUCTIONS
            };
        case 'ping':
            return {};
        case 'tools/list': {
            if (params.cursor) {
                const error = new Error('cursor');
                error.rpcCode = -32602;
                error.publicMessage = 'This server returns every tool in one list. Call tools/list without a cursor.';
                throw error;
            }
            return { tools: listTools() };
        }
        case 'tools/call': {
            const name = params.name;
            if (typeof name !== 'string' || !name) {
                const error = new Error('name');
                error.rpcCode = -32602;
                error.publicMessage = 'tools/call needs a tool name.';
                throw error;
            }
            let args = params.arguments == null ? {} : params.arguments;
            if (typeof args === 'string') {
                try {
                    args = JSON.parse(args);
                } catch {
                    const error = new Error('arguments');
                    error.rpcCode = -32602;
                    error.publicMessage = 'Tool arguments must be a JSON object.';
                    throw error;
                }
            }
            if (!args || typeof args !== 'object' || Array.isArray(args)) {
                const error = new Error('arguments');
                error.rpcCode = -32602;
                error.publicMessage = 'Tool arguments must be a JSON object.';
                throw error;
            }
            return await callTool(name, args);
        }
        default:
            return UNSUPPORTED;
    }
}

/**
 * Newline-delimited JSON-RPC on a pair of streams. Resolves when the
 * input ends. Logging stays with the caller; this writes only protocol
 * messages to `output`.
 */
function attachStdio({ input, output, onMessage }) {
    let buffer = '';
    const write = (body) => {
        output.write(`${JSON.stringify(body)}\n`);
    };
    return new Promise(resolve => {
        const finish = () => resolve();
        input.setEncoding('utf8');
        input.on('data', chunk => {
            buffer += chunk;
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, idx).replace(/\r$/, '').trim();
                buffer = buffer.slice(idx + 1);
                if (!line) continue;
                let message;
                try {
                    message = JSON.parse(line);
                } catch {
                    write(rpcError(null, -32700, 'Parse error'));
                    continue;
                }
                Promise.resolve(onMessage(message)).then(outcome => {
                    if (outcome?.kind === 'response') write(outcome.body);
                }).catch(() => {
                    write(rpcError(null, -32603, 'Internal error'));
                });
            }
        });
        input.on('end', finish);
        input.on('error', finish);
    });
}

const UNSUPPORTED = Symbol('unsupported');

module.exports = {
    JSONRPC,
    SUPPORTED_PROTOCOL_VERSIONS,
    SERVER_INSTRUCTIONS,
    rpcError,
    negotiateVersion,
    handleMessage,
    attachStdio
};
