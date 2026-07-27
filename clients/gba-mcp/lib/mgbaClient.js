/**
 * TCP client for the mGBA bridge (goobster-gba.lua).
 *
 * Connects lazily on the first request and reconnects on demand, so the
 * MCP server can start before mGBA does and survives emulator restarts
 * (graceful degradation, like every other Goobster integration). Requests
 * are matched to responses by id; frame-consuming commands (press/wait)
 * get timeouts sized from their frame budget.
 */

const net = require('node:net');
const { formatLine, parseLine, LineBuffer } = require('./lineCodec');

class BridgeError extends Error {
    /**
     * @param {string} message
     * @param {string} code machine-readable: UNREACHABLE | TIMEOUT | REMOTE | DISCONNECTED
     */
    constructor(message, code) {
        super(message);
        this.name = 'BridgeError';
        this.code = code;
    }
}

class MgbaClient {
    /**
     * @param {object} [options]
     * @param {string} [options.host]
     * @param {number} [options.port]
     * @param {number} [options.baseTimeoutMs] timeout for instant commands
     * @param {(msg: string) => void} [options.log]
     */
    constructor({ host = '127.0.0.1', port = 5771, baseTimeoutMs = 5000, log = () => {} } = {}) {
        this.host = host;
        this.port = port;
        this.baseTimeoutMs = baseTimeoutMs;
        this.log = log;
        this._socket = null;
        this._connecting = null;
        this._pending = new Map(); // id -> { resolve, reject, timer }
        this._nextId = 1;
        this._lineBuffer = new LineBuffer();
    }

    get connected() {
        return this._socket !== null && !this._socket.destroyed;
    }

    /**
     * Send a request to the bridge and await its response params.
     * @param {string} verb
     * @param {Object<string, string|number|boolean>} [params]
     * @param {{ timeoutMs?: number }} [options]
     * @returns {Promise<Object<string, string>>}
     */
    async request(verb, params = {}, { timeoutMs } = {}) {
        await this._ensureConnected();
        const id = String(this._nextId++);
        const line = formatLine(id, verb, params);
        const effectiveTimeout = timeoutMs || this.baseTimeoutMs;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(id);
                reject(new BridgeError(`mGBA bridge did not answer "${verb}" within ${effectiveTimeout}ms (is a game loaded and running?)`, 'TIMEOUT'));
            }, effectiveTimeout);
            this._pending.set(id, { resolve, reject, timer });
            this._socket.write(`${line}\n`, error => {
                if (error) {
                    clearTimeout(timer);
                    this._pending.delete(id);
                    reject(new BridgeError(`Failed to write to mGBA bridge: ${error.message}`, 'DISCONNECTED'));
                }
            });
        });
    }

    /** Close the connection and fail all in-flight requests. */
    close() {
        if (this._socket) {
            this._socket.destroy();
            this._socket = null;
        }
        this._failAll(new BridgeError('Bridge connection closed', 'DISCONNECTED'));
    }

    async _ensureConnected() {
        if (this.connected) return;
        if (this._connecting) return this._connecting;

        this._connecting = new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: this.host, port: this.port });
            socket.setNoDelay(true);

            const onConnectError = error => {
                this._connecting = null;
                reject(new BridgeError(
                    `Cannot reach the mGBA bridge at ${this.host}:${this.port} (${error.code || error.message}). ` +
                    'Start mGBA with the bridge script loaded, e.g.: mgba-qt --script goobster-gba.lua <rom.gba> ' +
                    '(or load it via Tools > Scripting on mGBA 0.10.x).', 'UNREACHABLE'));
            };

            socket.once('error', onConnectError);
            socket.once('connect', () => {
                socket.removeListener('error', onConnectError);
                this._socket = socket;
                this._connecting = null;
                this._lineBuffer = new LineBuffer();
                this.log(`Connected to mGBA bridge at ${this.host}:${this.port}`);

                socket.on('data', chunk => this._onData(chunk));
                socket.on('error', error => {
                    this.log(`Bridge socket error: ${error.message}`);
                });
                socket.on('close', () => {
                    this._socket = null;
                    this._failAll(new BridgeError('mGBA bridge disconnected mid-request (was the emulator closed?)', 'DISCONNECTED'));
                });
                resolve();
            });
        });
        return this._connecting;
    }

    _onData(chunk) {
        for (const line of this._lineBuffer.push(chunk)) {
            let parsed;
            try {
                parsed = parseLine(line);
            } catch (error) {
                this.log(`Ignoring malformed bridge line: ${line} (${error.message})`);
                continue;
            }
            if (!parsed) continue;
            const pending = this._pending.get(parsed.id);
            if (!pending) {
                this.log(`Ignoring response for unknown request id ${parsed.id}`);
                continue;
            }
            this._pending.delete(parsed.id);
            clearTimeout(pending.timer);
            if (parsed.verb === 'ok') {
                pending.resolve(parsed.params);
            } else {
                pending.reject(new BridgeError(parsed.params.msg || 'Bridge reported an error', 'REMOTE'));
            }
        }
    }

    _failAll(error) {
        for (const { reject, timer } of this._pending.values()) {
            clearTimeout(timer);
            reject(error);
        }
        this._pending.clear();
    }
}

/**
 * Timeout for a frame-consuming command: allow 2x real-time plus slack,
 * so it works both at mGBA's normal 60fps and under heavy host load.
 * @param {number} frames
 * @param {number} [baseMs]
 * @returns {number}
 */
function frameTimeout(frames, baseMs = 5000) {
    return baseMs + Math.ceil((frames / 60) * 1000 * 2);
}

module.exports = { MgbaClient, BridgeError, frameTimeout };
