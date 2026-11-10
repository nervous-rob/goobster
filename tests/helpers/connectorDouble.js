/**
 * A test-double connector for the connector framework (DA-11d, ADR 0028).
 *
 * Goobster ships no connector, so the framework is exercised against this
 * fake notebook: it reads and writes entries in memory, can lose the
 * answer to a write (the entry lands, the caller sees an error), and can
 * say whether a write with a given operation id landed. It uses the one
 * credential slot the integration catalog has besides GitHub (`notion`),
 * only because a manifest must name a catalog provider; it never calls
 * that service. Used by the Jest suites and the browser journey's fixture;
 * a `testOnly` manifest is never loaded in production.
 */

const registry = require('@goobster/core/services/assistant/connectors/registry');

function createDouble({ id = 'notebook', provider = 'notion' } = {}) {
    const state = {
        entries: new Map(),
        applied: new Map(),
        tokensSeen: new Set(),
        calls: [],
        mode: 'ok',
        unreachable: false
    };

    const log = (kind, operation, resource, input, token) => {
        state.tokensSeen.add(token);
        state.calls.push({ kind, operation, resource, input });
    };
    const list = (resource) => {
        if (!state.entries.has(resource)) state.entries.set(resource, []);
        return state.entries.get(resource);
    };
    const text = (input) => String(input?.text ?? '');

    const manifest = {
        id,
        name: 'Test notebook',
        description: 'A fake notebook that keeps entries in memory.',
        decision: null,
        credential: { provider },
        resource: { describe: 'a notebook name (letters, digits and dashes)', pattern: /^[a-z0-9-]{1,40}$/ },
        reads: [{
            operation: 'search',
            describe: 'Find entries containing some text. Input: { query }.',
            validate: (input) => (typeof input.query === 'string' && input.query.trim() ? null : 'BAD_QUERY'),
            run: async ({ resource, input, token }) => {
                log('read', 'search', resource, input, token);
                const found = list(resource).filter(entry => entry.text.includes(input.query));
                return `${found.length} entries in ${resource} mention "${input.query}": ${found.map(entry => entry.text).join(' | ')}`;
            }
        }],
        writes: [
            {
                operation: 'append',
                describe: 'Add an entry. Input: { text }.',
                validate: (input) => (text(input).trim() ? null : 'EMPTY_TEXT'),
                run: async ({ resource, input, token, operationId }) => {
                    log('write', 'append', resource, input, token);
                    if (state.mode === 'declined') throw registry.declined('READ_ONLY', 'that notebook is read only');
                    const entry = { n: list(resource).length + 1, text: text(input), operationId };
                    list(resource).push(entry);
                    state.applied.set(operationId, entry);
                    // The entry landed, the answer did not.
                    if (state.mode === 'lost') throw Object.assign(new Error('connection reset'), { code: 'NETWORK' });
                    return `entry ${entry.n} added`;
                },
                reconcile: async ({ operationId }) => {
                    if (state.unreachable) return { state: 'unknown' };
                    const entry = state.applied.get(operationId);
                    return entry ? { state: 'done', result: `entry ${entry.n} added` } : { state: 'absent' };
                }
            },
            {
                // No reconcile: after any uncertainty the work stops for review.
                operation: 'clear',
                describe: 'Delete every entry in the notebook. Input: {}.',
                run: async ({ resource, input, token, operationId }) => {
                    log('write', 'clear', resource, input, token);
                    state.applied.set(operationId, { cleared: true });
                    if (state.mode === 'lost') throw Object.assign(new Error('connection reset'), { code: 'NETWORK' });
                    list(resource).length = 0;
                    return 'notebook cleared';
                }
            }
        ]
    };

    return {
        manifest,
        state,
        register: () => { registry.unregister(id); return registry.register(manifest, { testOnly: true }); },
        unregister: () => registry.unregister(id),
        reset() {
            state.entries.clear(); state.applied.clear(); state.tokensSeen.clear();
            state.calls.length = 0; state.mode = 'ok'; state.unreachable = false;
        }
    };
}

module.exports = { createDouble };
