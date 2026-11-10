/**
 * A small, bounded diff of two pieces of prose, for showing a person what a
 * proposed edit would change before they apply it (ADR 0027). Pure; no I/O.
 *
 * The text is compared by sentence or line, not by character: a note is
 * short, and a reader judges "this sentence was replaced" faster than a
 * character-level splice. The result is a list of `{ op, text }` entries in
 * reading order, `op` being 'same', 'del' (only in the old text) or 'add'
 * (only in the new text). Unchanged runs longer than `context` entries are
 * folded into a single `{ op: 'skip', text: '... N unchanged ...' }` so the
 * diff stays small whatever the note's size.
 */

const MAX_SEGMENTS = 60;
const MAX_SEGMENT_CHARS = 300;
const CONTEXT = 1;

function segments(value) {
    const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
    if (!text) return [];
    return text
        .split(/\n+|(?<=[.!?])\s+/)
        .map(part => part.trim())
        .filter(Boolean)
        .slice(0, MAX_SEGMENTS)
        .map(part => (part.length > MAX_SEGMENT_CHARS ? `${part.slice(0, MAX_SEGMENT_CHARS - 1)}…` : part));
}

/** Longest-common-subsequence table over two short segment lists. */
function lcsTable(a, b) {
    const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
            table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    return table;
}

/**
 * @param {string|null} before
 * @param {string|null} after
 * @param {{ context?: number }} [options]
 * @returns {Array<{ op: 'same'|'add'|'del'|'skip', text: string }>}
 */
function diffText(before, after, { context = CONTEXT } = {}) {
    const a = segments(before);
    const b = segments(after);
    const table = lcsTable(a, b);
    const full = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            full.push({ op: 'same', text: a[i] });
            i += 1;
            j += 1;
        } else if (table[i + 1][j] >= table[i][j + 1]) {
            full.push({ op: 'del', text: a[i] });
            i += 1;
        } else {
            full.push({ op: 'add', text: b[j] });
            j += 1;
        }
    }
    for (; i < a.length; i += 1) full.push({ op: 'del', text: a[i] });
    for (; j < b.length; j += 1) full.push({ op: 'add', text: b[j] });

    // Keep `context` unchanged entries on each side of a change; fold the rest.
    const keep = new Array(full.length).fill(false);
    full.forEach((entry, index) => {
        if (entry.op === 'same') return;
        for (let k = Math.max(0, index - context); k <= Math.min(full.length - 1, index + context); k += 1) keep[k] = true;
    });
    const out = [];
    let folded = 0;
    full.forEach((entry, index) => {
        if (keep[index]) {
            if (folded) out.push({ op: 'skip', text: `${folded} unchanged ${folded === 1 ? 'passage' : 'passages'}` });
            folded = 0;
            out.push(entry);
        } else {
            folded += 1;
        }
    });
    if (folded) out.push({ op: 'skip', text: `${folded} unchanged ${folded === 1 ? 'passage' : 'passages'}` });
    return out;
}

module.exports = { diffText, segments };
