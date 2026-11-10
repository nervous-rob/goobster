/**
 * Helpers and limits shared by the run tool modules and the run service.
 */

const crypto = require('node:crypto');

/** The most text one tool call returns to the model (and stores in the journal). */
const RESULT_CHARS = 16_000;
/** The most text a run's reported summary keeps. */
const SUMMARY_CHARS = 2000;

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function clip(text, max) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** A workspace-relative path as the journal records it (no leading `./`). */
function cleanPath(value) {
    return String(value ?? '').trim().replace(/^\.\//, '');
}

module.exports = { sha, clip, cleanPath, RESULT_CHARS, SUMMARY_CHARS };
