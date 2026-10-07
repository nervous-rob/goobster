/**
 * Seen-nonce set for replay resistance. An entry lives until the expiry of
 * the assertion or session that carried it; the set is bounded and fails
 * closed (a full set refuses new nonces rather than forgetting live ones).
 */

function createNonceCache({ now = () => Date.now(), max = 10_000 } = {}) {
    const seen = new Map();

    function prune() {
        const t = now();
        for (const [nonce, expiresAt] of seen) {
            if (expiresAt <= t) seen.delete(nonce);
        }
    }

    /**
     * @param {string} nonce
     * @param {number} expiresAtMs
     * @returns {boolean} false when the nonce was already used (or the set is full)
     */
    function use(nonce, expiresAtMs) {
        const t = now();
        const known = seen.get(nonce);
        if (known !== undefined && known > t) return false;
        if (seen.size >= max) prune();
        if (seen.size >= max) return false;
        seen.set(nonce, Math.max(expiresAtMs, t + 1000));
        return true;
    }

    return { use, size: () => seen.size, prune };
}

module.exports = { createNonceCache };
