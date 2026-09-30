/**
 * In-process request cap for the MCP endpoint. One bucket per token.
 * A restart clears it; the cap exists to stop a stuck client, not to
 * survive a reboot.
 */

const buckets = new Map();

/**
 * @param {string} key
 * @param {number} limit requests allowed inside the window
 * @param {number} [windowMs]
 * @returns {boolean} true when the call may proceed
 */
function consume(key, limit, windowMs = 60_000) {
    const now = Date.now();
    const stamps = (buckets.get(key) || []).filter(stamp => now - stamp < windowMs);
    if (stamps.length >= limit) {
        buckets.set(key, stamps);
        return false;
    }
    stamps.push(now);
    buckets.set(key, stamps);
    return true;
}

function _resetForTests() {
    buckets.clear();
}

module.exports = { consume, _resetForTests };
