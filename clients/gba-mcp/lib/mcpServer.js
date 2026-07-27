/**
 * Minimal MCP (Model Context Protocol) server over stdio.
 *
 * Implements just the slice of MCP a tools-only server needs — initialize,
 * tools/list, tools/call, ping — as newline-delimited JSON-RPC 2.0, with
 * zero dependencies (same philosophy as the other clients/ apps: a single
 * `node` invocation, nothing to npm install).
 *
 * Transport per the MCP spec: one JSON-RPC message per line on
 * stdin/stdout. Logging goes to stderr only; stdout is protocol.
 */

const JSONRPC = '2.0';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

class McpServer {
    /**
     * @param {object} options
     * @param {string} options.name server name reported to clients
     * @param {string} options.version server version
     * @param {() => Array<object>} options.listTools returns MCP tool descriptors
     * @param {(name: string, args: object) => Promise<{content: Array<object>, isError?: boolean}>} options.callTool
     * @param {(msg: string) => void} [options.log] stderr logger
     */
    constructor({ name, version, listTools, callTool, log = () => {} }) {
        this.name = name;
        this.version = version;
        this.listTools = listTools;
        this.callTool = callTool;
        this.log = log;
        this._buffer = '';
        this._out = null;
    }

    /**
     * Attach to a pair of streams and start serving. Returns a promise
     * that resolves when the input stream ends.
     * @param {NodeJS.ReadableStream} input
     * @param {NodeJS.WritableStream} output
     * @returns {Promise<void>}
     */
    attach(input, output) {
        this._out = output;
        return new Promise(resolve => {
            input.setEncoding('utf8');
            input.on('data', chunk => this._onData(chunk));
            input.on('end', () => resolve());
            input.on('error', () => resolve());
        });
    }

    _onData(chunk) {
        this._buffer += chunk;
        let idx;
        while ((idx = this._buffer.indexOf('\n')) !== -1) {
            const line = this._buffer.slice(0, idx).trim();
            this._buffer = this._buffer.slice(idx + 1);
            if (line.length === 0) continue;
            this._handleLine(line);
        }
    }

    _handleLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            this._send({ jsonrpc: JSONRPC, id: null, error: { code: -32700, message: 'Parse error' } });
            return;
        }
        // Tolerate JSON-RPC batches even though MCP clients rarely send them.
        const messages = Array.isArray(message) ? message : [message];
        for (const msg of messages) {
            Promise.resolve(this._handleMessage(msg)).catch(error => {
                this.log(`Unhandled error: ${error?.stack || error}`);
            });
        }
    }

    async _handleMessage(msg) {
        if (!msg || typeof msg !== 'object' || msg.jsonrpc !== JSONRPC) return;
        const { id, method, params } = msg;
        const isRequest = id !== undefined && id !== null && typeof method === 'string';
        const isNotification = (id === undefined || id === null) && typeof method === 'string';

        if (isNotification) {
            // notifications/initialized, notifications/cancelled, etc.
            return;
        }
        if (!isRequest) return; // a response to a server-initiated request; we send none

        try {
            const result = await this._dispatch(method, params || {});
            if (result === UNSUPPORTED) {
                this._send({ jsonrpc: JSONRPC, id, error: { code: -32601, message: `Method not found: ${method}` } });
            } else {
                this._send({ jsonrpc: JSONRPC, id, result });
            }
        } catch (error) {
            this._send({
                jsonrpc: JSONRPC,
                id,
                error: { code: -32603, message: error?.message || 'Internal error' }
            });
        }
    }

    async _dispatch(method, params) {
        switch (method) {
            case 'initialize': {
                const requested = params.protocolVersion;
                const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
                    ? requested
                    : SUPPORTED_PROTOCOL_VERSIONS[0];
                this.log(`Client connected: ${params.clientInfo?.name || 'unknown'} (protocol ${protocolVersion})`);
                return {
                    protocolVersion,
                    capabilities: { tools: {} },
                    serverInfo: { name: this.name, version: this.version }
                };
            }
            case 'ping':
                return {};
            case 'tools/list':
                return { tools: this.listTools() };
            case 'tools/call': {
                const name = params.name;
                const args = params.arguments || {};
                this.log(`tools/call ${name} ${JSON.stringify(args)}`);
                return await this.callTool(name, args);
            }
            default:
                return UNSUPPORTED;
        }
    }

    _send(message) {
        this._out.write(`${JSON.stringify(message)}\n`);
    }
}

const UNSUPPORTED = Symbol('unsupported');

module.exports = { McpServer, SUPPORTED_PROTOCOL_VERSIONS };
