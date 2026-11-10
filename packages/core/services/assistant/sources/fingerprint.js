const crypto = require('node:crypto');

/** A short stable revision for the parts of a record that are material. */
function fingerprint(parts) {
    return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

module.exports = { fingerprint };
