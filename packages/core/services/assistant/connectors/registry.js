/**
 * The outside-connector registry (DA-11d, ADR 0028).
 *
 * A connector is a typed adapter to one outside service: a manifest that
 * says exactly what it can read and write, which of the person's own
 * credentials it uses, and the functions that do it. A responsibility
 * grants a connector's named resource by id (`{ kind: 'external', ids:
 * ['<connector>:<resource>'] }`), never the service as a whole. This
 * module only holds and checks manifests; it calls nothing outside.
 *
 * The product ships with no connector (`shipped.js` is empty). A connector
 * is added by a pull request that adds its module to `shipped.js` with the
 * owner's recorded decision in its manifest; `register()` refuses a
 * manifest without one. `testOnly` manifests (the test double in tests and
 * the browser journey's fixture) skip that rule and are never loaded here.
 *
 * Manifest:
 *   id           lower-case letters, digits and dashes
 *   name         what the person sees
 *   description  one sentence
 *   feature      optional feature id that must be on
 *   decision     { recordedBy, recordedAt, reference }: the owner's decision
 *   credential   { provider }: a key of userIntegrationService's catalog
 *   resource     { describe, pattern }: what a named resource looks like
 *   reads        [{ operation, describe, validate?, run }]
 *   writes       [{ operation, describe, validate?, run, reconcile? }]
 *
 * `run({ resource, input, token, operationId })` returns the text the model
 * sees. A write that certainly did not happen throws
 * `declined(code, message)`; any other throw means it may have happened.
 * `reconcile(...)` asks the outside service whether the write with that
 * `operationId` happened and returns `{ state: 'done'|'absent'|'unknown',
 * result? }`; a write without one stops for review after any uncertainty.
 */

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const OPERATION = /^[a-z][A-Za-z0-9_.-]{1,39}$/;
const RESOURCE_MAX = 150;
const INPUT_MAX_CHARS = 8000;

class ConnectorError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ConnectorError';
        this.code = code;
    }
}

/** What an adapter throws when it knows the outside service changed nothing. */
class ConnectorDeclined extends Error {
    constructor(code, message) {
        super(message || code);
        this.name = 'ConnectorDeclined';
        this.code = String(code || 'DECLINED').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 40);
        this.declined = true;
    }
}

const declined = (code, message) => new ConnectorDeclined(code, message);

const connectors = new Map();

function bad(message) {
    return new ConnectorError('INVALID_CONNECTOR', message);
}

function operationList(list, kind, field) {
    if (!Array.isArray(list)) throw bad(`${field} must be a list.`);
    const seen = new Set();
    return list.map((entry, index) => {
        const where = `${field}[${index}]`;
        if (!entry || typeof entry !== 'object') throw bad(`${where} must be an object.`);
        if (typeof entry.operation !== 'string' || !OPERATION.test(entry.operation)) throw bad(`${where}.operation is not a valid name.`);
        if (seen.has(entry.operation)) throw bad(`${where}.operation "${entry.operation}" is listed twice.`);
        seen.add(entry.operation);
        if (typeof entry.describe !== 'string' || !entry.describe.trim()) throw bad(`${where}.describe must say what it does.`);
        if (typeof entry.run !== 'function') throw bad(`${where}.run must be a function.`);
        if (entry.validate !== undefined && typeof entry.validate !== 'function') throw bad(`${where}.validate must be a function.`);
        if (entry.reconcile !== undefined && (kind !== 'write' || typeof entry.reconcile !== 'function')) {
            throw bad(`${where}.reconcile is for writes, and must be a function.`);
        }
        return Object.freeze({
            operation: entry.operation, describe: entry.describe.trim(), run: entry.run,
            validate: entry.validate || null, reconcile: entry.reconcile || null
        });
    });
}

/** Check a manifest and return the frozen copy the registry keeps. */
function normalize(manifest, { testOnly = false } = {}) {
    if (!manifest || typeof manifest !== 'object') throw bad('A connector manifest is an object.');
    if (typeof manifest.id !== 'string' || !ID.test(manifest.id)) throw bad('id must be lower-case letters, digits and dashes.');
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw bad('name is required.');
    if (typeof manifest.description !== 'string' || !manifest.description.trim()) throw bad('description is required.');
    if (manifest.feature != null) {
        const { FEATURE_IDS } = require('../../../features/inventory');
        if (!FEATURE_IDS.includes(manifest.feature)) throw bad(`feature "${manifest.feature}" is not a feature of this installation.`);
    }
    // The owner's decision comes first: a connector nobody decided on does not ship.
    let decision = null;
    if (manifest.decision != null) {
        const d = manifest.decision;
        if (!d || typeof d.recordedBy !== 'string' || !d.recordedBy.trim() || typeof d.recordedAt !== 'string'
            || !/^\d{4}-\d{2}-\d{2}$/.test(d.recordedAt) || typeof d.reference !== 'string' || !d.reference.trim()) {
            throw bad('decision needs recordedBy, recordedAt (YYYY-MM-DD) and a reference.');
        }
        decision = Object.freeze({ recordedBy: d.recordedBy.trim(), recordedAt: d.recordedAt, reference: d.reference.trim() });
    } else if (!testOnly) {
        throw new ConnectorError('NO_OWNER_DECISION', 'A connector ships only with the owner\'s recorded decision for it.');
    }
    const provider = manifest.credential?.provider;
    const integrations = require('../../userIntegrationService');
    if (typeof provider !== 'string' || !integrations.providerKeys.includes(provider)) {
        throw bad(`credential.provider must be one of: ${integrations.providerKeys.join(', ')}.`);
    }
    const resource = manifest.resource || {};
    if (typeof resource.describe !== 'string' || !resource.describe.trim()) throw bad('resource.describe must say what a named resource is.');
    if (resource.pattern != null && !(resource.pattern instanceof RegExp)) throw bad('resource.pattern must be a regular expression.');
    const reads = operationList(manifest.reads ?? [], 'read', 'reads');
    const writes = operationList(manifest.writes ?? [], 'write', 'writes');
    if (!reads.length && !writes.length) throw bad('A connector reads or writes something.');
    return Object.freeze({
        id: manifest.id, name: manifest.name.trim(), description: manifest.description.trim(),
        feature: manifest.feature || null, decision, testOnly: Boolean(testOnly),
        credential: Object.freeze({ provider }),
        resource: Object.freeze({ describe: resource.describe.trim(), pattern: resource.pattern || null }),
        reads: Object.freeze(reads), writes: Object.freeze(writes)
    });
}

/**
 * Add a connector. Throws `ConnectorError` for an invalid manifest, a
 * missing owner decision (`NO_OWNER_DECISION`) or a taken id.
 */
function register(manifest, options = {}) {
    const entry = normalize(manifest, options);
    if (connectors.has(entry.id)) throw new ConnectorError('DUPLICATE_CONNECTOR', `A connector "${entry.id}" is already registered.`);
    connectors.set(entry.id, entry);
    return entry;
}

function unregister(id) {
    return connectors.delete(String(id));
}

function get(id) {
    return connectors.get(String(id)) || null;
}

function list() {
    return [...connectors.values()];
}

/** `<connector>:<resource>` as a grant's id and a call name it. */
function refOf(connectorId, resource) {
    return `${connectorId}:${resource}`;
}

/**
 * Split a grant id. Returns `{ connector, resource }` only when the
 * connector is registered and the resource is a named, wildcard-free
 * resource of the shape the manifest accepts; otherwise null.
 */
function parseRef(ref) {
    const text = String(ref ?? '');
    const cut = text.indexOf(':');
    if (cut < 1) return null;
    const connector = get(text.slice(0, cut));
    const resource = text.slice(cut + 1);
    if (!connector || !validResource(connector, resource)) return null;
    return { connector, resource };
}

function validResource(connector, resource) {
    if (typeof resource !== 'string' || !resource || resource.length > RESOURCE_MAX) return false;
    if (/[\s*?\\\0]/.test(resource)) return false;
    return connector.resource.pattern ? connector.resource.pattern.test(resource) : true;
}

/** An operation of the connector by kind and name, or null. */
function operationOf(connector, kind, name) {
    const list = kind === 'write' ? connector.writes : connector.reads;
    return list.find(entry => entry.operation === name) || null;
}

/**
 * Check a call's input: a plain object that is not enormous, then the
 * operation's own `validate(input)`, which returns a refusal code or null.
 * Returns a code, or null when it is acceptable.
 */
function inputProblem(operation, input) {
    if (input == null) input = {};
    if (typeof input !== 'object' || Array.isArray(input)) return 'BAD_INPUT';
    let text;
    try { text = JSON.stringify(input); } catch { return 'BAD_INPUT'; }
    if (text.length > INPUT_MAX_CHARS) return 'BAD_INPUT';
    if (operation.validate) {
        let code;
        try { code = operation.validate(input); } catch { return 'BAD_INPUT'; }
        if (code) return /^[A-Z_]{2,40}$/.test(String(code)) ? String(code) : 'BAD_INPUT';
    }
    return null;
}

/** A connector without its functions: what the person is shown and the host's manifest lists. */
function describe(connector) {
    return {
        id: connector.id,
        name: connector.name,
        description: connector.description,
        feature: connector.feature,
        decision: connector.decision,
        provider: connector.credential.provider,
        resource: connector.resource.describe,
        reads: connector.reads.map(entry => ({ operation: entry.operation, describe: entry.describe })),
        writes: connector.writes.map(entry => ({ operation: entry.operation, describe: entry.describe, reconcilable: Boolean(entry.reconcile) }))
    };
}

/** Shipped connectors, registered once when this module is first required. */
for (const manifest of require('./shipped')) register(manifest);

module.exports = {
    register, unregister, get, list, refOf, parseRef, validResource, operationOf, inputProblem, describe,
    declined, ConnectorError, ConnectorDeclined, INPUT_MAX_CHARS
};
