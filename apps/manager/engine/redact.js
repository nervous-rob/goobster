/**
 * Redaction for anything that reaches the operations journal or the audit
 * log. Plans name settings; they never carry a credential value. A value
 * under a secret-shaped key is replaced by a short prefix and a marker
 * (`"sk-…[redacted]"`), whatever the operation kind put there.
 */

const SECRET_KEY = /(key|token|secret|password|passphrase|credential|assertion|cookie|authorization)/i;
const MARK = '…[redacted]';

function redactSecret(value) {
    if (value === null || value === undefined || value === '') return value;
    const text = String(value);
    const prefix = text.length >= 12 ? text.slice(0, 3) : '';
    return `${prefix}${MARK}`;
}

/** Deep copy with every value under a secret-shaped key redacted. */
function scrub(value, depth = 0) {
    if (depth > 8) return '[truncated]';
    if (Array.isArray(value)) return value.map(item => scrub(item, depth + 1));
    if (value === null || typeof value !== 'object') return value;
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
        out[key] = SECRET_KEY.test(key) && (typeof inner === 'string' || typeof inner === 'number')
            ? redactSecret(inner)
            : scrub(inner, depth + 1);
    }
    return out;
}

module.exports = { redactSecret, scrub, SECRET_KEY, MARK };
