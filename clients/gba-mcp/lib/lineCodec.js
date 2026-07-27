/**
 * Wire codec for the mGBA bridge protocol.
 *
 * The bridge (goobster-gba.lua, running inside mGBA) and the MCP server
 * exchange single-line messages over TCP so the Lua side never has to
 * parse JSON:
 *
 *   request:  <id> <verb> [key=value]...
 *   response: <id> ok  [key=value]...
 *   response: <id> err msg=<encoded> [key=value]...
 *
 * Values are percent-encoded so they can carry spaces, '=', '%' and
 * newlines. Keys are bare [A-Za-z0-9_]+ tokens and never encoded.
 */

/** Characters that must be escaped inside a value. */
const ENCODE_RE = /[%\s=]/g;

/**
 * Percent-encode a value for the wire.
 * @param {string|number|boolean} value
 * @returns {string}
 */
function encodeValue(value) {
    return String(value).replace(ENCODE_RE, c =>
        `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/**
 * Decode a percent-encoded value.
 * @param {string} encoded
 * @returns {string}
 */
function decodeValue(encoded) {
    return String(encoded).replace(/%([0-9A-Fa-f]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Format a protocol line (without the trailing newline).
 * @param {string|number} id
 * @param {string} verb
 * @param {Object<string, string|number|boolean>} [params]
 * @returns {string}
 */
function formatLine(id, verb, params = {}) {
    const parts = [String(id), verb];
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (!/^[A-Za-z0-9_]+$/.test(key)) {
            throw new Error(`Invalid protocol key: ${key}`);
        }
        parts.push(`${key}=${encodeValue(value)}`);
    }
    return parts.join(' ');
}

/**
 * Parse a protocol line into { id, verb, params }.
 * Returns null for blank lines.
 * @param {string} line
 * @returns {{ id: string, verb: string, params: Object<string, string> }|null}
 */
function parseLine(line) {
    const tokens = String(line).trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    if (tokens.length < 2) {
        throw new Error(`Malformed protocol line: ${line}`);
    }
    const [id, verb, ...rest] = tokens;
    const params = {};
    for (const token of rest) {
        const eq = token.indexOf('=');
        if (eq <= 0) {
            throw new Error(`Malformed protocol parameter: ${token}`);
        }
        params[token.slice(0, eq)] = decodeValue(token.slice(eq + 1));
    }
    return { id, verb, params };
}

/**
 * Incremental line splitter: feed chunks, get complete lines back.
 * Handles both \n and \r\n endings.
 */
class LineBuffer {
    constructor() {
        this._buffer = '';
    }

    /**
     * @param {string|Buffer} chunk
     * @returns {string[]} complete lines (without line endings)
     */
    push(chunk) {
        this._buffer += chunk.toString('utf8');
        const lines = [];
        let idx;
        while ((idx = this._buffer.indexOf('\n')) !== -1) {
            let line = this._buffer.slice(0, idx);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            this._buffer = this._buffer.slice(idx + 1);
            if (line.length > 0) lines.push(line);
        }
        return lines;
    }
}

module.exports = { encodeValue, decodeValue, formatLine, parseLine, LineBuffer };
