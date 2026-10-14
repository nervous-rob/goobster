/**
 * Live output of a running Observatory job (documentation/projects.md,
 * "Live run output"): the sandbox hands over each chunk as the program
 * writes it; this keeps a bounded, display-ready tail per stream and
 * writes it to the job row at most every `flushMs`, so any process serving
 * the portal (lite, standalone or paired) can read it. Cleared when the
 * segment ends - the settled tails are the record after that.
 *
 * Display-ready: UTF-8 decoded across chunk boundaries, ANSI escape codes
 * removed, and a carriage-return progress line collapsed to its last state.
 */

const { StringDecoder } = require('node:string_decoder');

const DEFAULT_TAIL_CHARS = 16 * 1024;
const DEFAULT_FLUSH_MS = 2000;
// CSI / OSC escape sequences (colours, cursor moves, titles).
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Strip escapes and keep what a terminal would show for each line after its last \r. */
function displayText(text) {
    return String(text)
        .replace(ANSI, '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => {
            const at = line.lastIndexOf('\r');
            return at === -1 ? line : line.slice(at + 1);
        })
        .join('\n');
}

class LiveTail {
    constructor(maxChars = DEFAULT_TAIL_CHARS) {
        this.maxChars = maxChars;
        this.decoder = new StringDecoder('utf8');
        this.text = '';
        this.bytes = 0;
    }

    push(chunk) {
        this.bytes += chunk.length;
        this.text += this.decoder.write(chunk);
        // Keep some slack beyond the cap so a progress line is not cut mid-\r.
        if (this.text.length > this.maxChars * 2) this.text = this.text.slice(-this.maxChars * 2);
    }

    value() {
        const shown = displayText(this.text);
        return shown.length > this.maxChars ? shown.slice(-this.maxChars) : shown;
    }
}

class JobLiveOutput {
    /**
     * @param {Object} params
     * @param {(snapshot: { stdout: string, stderr: string, bytes: number }) => Promise<void>} params.write
     * @param {number} [params.flushMs]
     * @param {number} [params.maxChars] per stream
     */
    constructor({ write, flushMs = DEFAULT_FLUSH_MS, maxChars = DEFAULT_TAIL_CHARS }) {
        this._write = write;
        this.flushMs = flushMs;
        this.stdout = new LiveTail(maxChars);
        this.stderr = new LiveTail(maxChars);
        this._dirty = false;
        this._timer = null;
        this._writing = null;
        this._closed = false;
    }

    /** The sandbox's onOutput callback. */
    get onOutput() {
        return (stream, chunk) => {
            if (this._closed) return;
            (stream === 'stderr' ? this.stderr : this.stdout).push(chunk);
            this._dirty = true;
            if (!this._timer) {
                this._timer = setTimeout(() => { this._timer = null; this.flush(); }, this.flushMs);
                this._timer.unref?.();
            }
        };
    }

    snapshot() {
        return { stdout: this.stdout.value(), stderr: this.stderr.value(), bytes: this.stdout.bytes + this.stderr.bytes };
    }

    /** Write the current tail if it changed. Never throws; writes never overlap. */
    async flush() {
        if (!this._dirty || this._closed) return;
        if (this._writing) await this._writing;
        if (this._closed) return;
        this._dirty = false;
        this._writing = Promise.resolve()
            .then(() => this._write(this.snapshot()))
            .catch(() => { /* live output is best effort */ })
            .finally(() => { this._writing = null; });
        await this._writing;
    }

    /** Stop: no more writes after this resolves. */
    async close() {
        this._closed = true;
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
        if (this._writing) await this._writing;
    }
}

module.exports = { JobLiveOutput, LiveTail, displayText, DEFAULT_TAIL_CHARS, DEFAULT_FLUSH_MS };
