/**
 * The slice of MCP a read-only server needs, as JSON-RPC 2.0: initialize,
 * ping, tools/list, tools/call, and (when the caller supplies a
 * `resources` provider) resources/list, resources/templates/list, and
 * resources/read. No prompts, no subscriptions, no sampling.
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
async function handleMessage(message, surface) {
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
        const result = await dispatch(method, params || {}, surface);
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

function invalidParams(message) {
    const error = new Error(message);
    error.rpcCode = -32602;
    error.publicMessage = message;
    return error;
}

async function dispatch(method, params, { serverInfo, instructions, listTools, callTool, resources }) {
    switch (method) {
        case 'initialize':
            return {
                protocolVersion: negotiateVersion(params.protocolVersion),
                capabilities: {
                    tools: { listChanged: false },
                    ...(resources ? { resources: { subscribe: false, listChanged: false } } : {})
                },
                serverInfo,
                instructions: instructions || SERVER_INSTRUCTIONS
            };
        case 'ping':
            return {};
        case 'tools/list': {
            if (params.cursor) {
                throw invalidParams('This server returns every tool in one list. Call tools/list without a cursor.');
            }
            return { tools: listTools() };
        }
        case 'resources/list':
            if (!resources) return UNSUPPORTED;
            return resources.list(params.cursor);
        case 'resources/templates/list':
            if (!resources) return UNSUPPORTED;
            return resources.templates();
        case 'resources/read':
            if (!resources) return UNSUPPORTED;
            if (typeof params.uri !== 'string' || !params.uri) throw invalidParams('resources/read needs a uri.');
            return resources.read(params.uri);
        case 'tools/call': {
            const name = params.name;
            if (typeof name !== 'string' || !name) throw invalidParams('tools/call needs a tool name.');
            let args = params.arguments == null ? {} : params.arguments;
            if (typeof args === 'string') {
                try {
                    args = JSON.parse(args);
                } catch {
                    throw invalidParams('Tool arguments must be a JSON object.');
                }
            }
            if (!args || typeof args !== 'object' || Array.isArray(args)) {
                throw invalidParams('Tool arguments must be a JSON object.');
            }
            return await callTool(name, args);
        }
        default:
            return UNSUPPORTED;
    }
}

/**
 * Newline-delimited JSON-RPC on a pair of streams. Requests run
 * concurrently (a reply carries its request's id, so order does not
 * matter). Resolves once the input has ended and every in-flight request
 * has been answered, so a piped client that closes stdin after its last
 * request still gets every reply. Logging stays with the caller; this
 * writes only protocol messages to `output`.
 */
function attachStdio({ input, output, onMessage }) {
    let buffer = '';
    const pending = new Set();
    const write = (body) => {
        output.write(`${JSON.stringify(body)}\n`);
    };

    const handleLine = (raw) => {
        const line = raw.replace(/\r$/, '').trim();
        if (!line) return;
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            write(rpcError(null, -32700, 'Parse error'));
            return;
        }
        const id = message && typeof message === 'object' && !Array.isArray(message) ? message.id ?? null : null;
        const work = Promise.resolve()
            .then(() => onMessage(message))
            .then(outcome => {
                if (outcome?.kind === 'response') write(outcome.body);
            })
            .catch(() => {
                write(rpcError(id, -32603, 'Internal error'));
            })
            .finally(() => pending.delete(work));
        pending.add(work);
    };

    return new Promise(resolve => {
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            Promise.allSettled([...pending]).then(() => resolve());
        };
        input.setEncoding('utf8');
        input.on('data', chunk => {
            buffer += chunk;
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                handleLine(line);
            }
        });
        input.on('end', () => {
            handleLine(buffer);
            buffer = '';
            finish();
        });
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
