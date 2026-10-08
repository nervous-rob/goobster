'use strict';

/**
 * The evidence format of the release acceptance matrix (documentation/release_acceptance.md, issue #343).
 *
 * One cell of the matrix writes one evidence file. A step or an injection is `pass`, `fail`,
 * `not-applicable` (it cannot run in this cell, with the reason) or `deferred` (promised, but no host in
 * reach can run it, with the reason). Nothing here ever records a secret, a token, user content or a path
 * with a user name: every string passes through `redact()` on the way in, and `findLeaks()` is the
 * check the driver and the report both apply to the finished document.
 */

const os = require('node:os');

const SCHEMA_VERSION = 1;

/** The lifecycle, in the order the driver runs it. */
const STEPS = Object.freeze([
    { id: 'install', title: 'install' },
    { id: 'owner', title: 'first owner' },
    { id: 'chat', title: 'first chat turn' },
    { id: 'features', title: 'feature remove and add, with restart' },
    { id: 'defaults-keys', title: 'defaults and keys survive a restart' },
    { id: 'boot-recovery', title: 'boot recovery' },
    { id: 'update', title: 'staged update' },
    { id: 'repair', title: 'repair with a corrupted database' },
    { id: 'backup-restore', title: 'backup and restore' },
    { id: 'migrate', title: 'SQLite to Postgres migration' },
    { id: 'reset', title: 'reset' },
    { id: 'uninstall-keep', title: 'uninstall, keeping data' },
    { id: 'uninstall-full', title: 'confirmed full removal' }
]);

/** Failure injection and negative authorization. */
const INJECTIONS = Object.freeze([
    { id: 'stale-setup-token', title: 'stale setup token' },
    { id: 'lost-manager-store', title: 'lost manager store' },
    { id: 'port-in-use', title: 'port already in use' },
    { id: 'storage-refusal', title: 'read-only or full storage root' },
    { id: 'update-interrupted', title: 'update interrupted at the handoff' },
    { id: 'restore-interrupted', title: 'restore interrupted' },
    { id: 'disabled-feature-route', title: 'direct request to a disabled feature' },
    { id: 'unauthenticated-manager', title: 'manager mutation without a session' },
    { id: 'recovery-not-remote', title: 'recovery refused through a proxy' }
]);

const STATUSES = Object.freeze(['pass', 'fail', 'not-applicable', 'deferred']);
const INSTALLS = Object.freeze(['new', 'adopt']);
const DATABASES = Object.freeze(['sqlite', 'existing-pg', 'managed-pg']);
const FEATURE_SETS = Object.freeze(['minimal', 'representative', 'full']);

const MAX_RESULT = 240;
const MAX_COMMAND = 300;

class Redactor {
    constructor() {
        this.literals = new Map();
    }

    /** Replace `value` with `label` wherever it appears. Short values are ignored: they would shred ordinary text. */
    add(value, label) {
        if (typeof value !== 'string') return;
        const text = value.trim();
        if (text.length < 4) return;
        this.literals.set(text, label);
        const slashed = text.replace(/\\/g, '/');
        if (slashed !== text) this.literals.set(slashed, label);
    }

    secret(value) {
        this.add(value, '[redacted]');
    }

    path(value, label) {
        this.add(value, label);
    }

    text(input) {
        let out = String(input === undefined || input === null ? '' : input);
        const ordered = [...this.literals.entries()].sort((a, b) => b[0].length - a[0].length);
        for (const [literal, label] of ordered) out = out.split(literal).join(label);
        out = out.replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gi, '<home>').replace(/\/(home|Users)\/[^/\s"']+/g, '<home>');
        // eslint-disable-next-line no-control-regex -- strips terminal colour codes
        out = out.replace(/\u001b\[[0-9;]*m/g, '');
        out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1[redacted]');
        out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
        out = out.replace(/(goobster[_-](?:web_)?session=)[^;\s"']+/gi, '$1[redacted]');
        return out;
    }
}

/** A redactor that knows the user name and home of this process. */
function hostRedactor() {
    const redactor = new Redactor();
    try { redactor.add(os.homedir(), '<home>'); } catch { /* no home */ }
    try {
        const name = os.userInfo().username;
        if (name && name.length >= 3 && !['root', 'runner', 'admin'].includes(name)) redactor.add(name, '<user>');
    } catch { /* no user */ }
    return redactor;
}

const LEAKS = [
    ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['a bearer token', /Bearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/],
    ['a provider key', /\bsk-(?!\[)[A-Za-z0-9_-]{8,}/],
    ['a session cookie', /(?:session|credential|token)=(?!\[redacted\])[A-Za-z0-9_-]{16,}/i],
    ['a home directory', /(?:\/home\/[^/\s"'<]+|\/Users\/[^/\s"'<]+|[A-Za-z]:\\Users\\[^\\\s"'<]+)/],
    ['a long opaque token', /(?<![A-Za-z0-9+/=_-])(?![0-9a-f]+(?![A-Za-z0-9+/=_-]))[A-Za-z0-9_-]{43,}(?![A-Za-z0-9+/=_-])/]
];
const SECRET_KEYS = /^(?:password|passphrase|secret|token|credential|apikey|api_key|authorization|cookie)$/i;

/**
 * Anything in an evidence document that looks like a secret, a token, a key, a cookie, user content
 * or a home directory. Returns the list of findings (empty when clean); each names where and what, never the value.
 */
function findLeaks(document) {
    const findings = [];
    const walk = (value, where) => {
        if (typeof value === 'string') {
            for (const [label, pattern] of LEAKS) if (pattern.test(value)) findings.push({ where, kind: label });
        } else if (Array.isArray(value)) {
            value.forEach((item, index) => walk(item, `${where}[${index}]`));
        } else if (value && typeof value === 'object') {
            for (const [key, item] of Object.entries(value)) {
                if (SECRET_KEYS.test(key) && typeof item === 'string' && item !== '' && item !== '[redacted]') findings.push({ where: `${where}.${key}`, kind: 'a secret-named field with a value' });
                walk(item, `${where}.${key}`);
            }
        }
    };
    walk(document, '$');
    return findings;
}

function clip(text, max) {
    const flat = String(text).replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

/** Thrown by a check that did not hold; the message is the one-line result of the failed step. */
class CheckFailed extends Error {
    constructor(message) {
        super(message);
        this.name = 'CheckFailed';
    }
}

function check(condition, message) {
    if (!condition) throw new CheckFailed(message);
}

const notApplicable = (reason) => ({ status: 'not-applicable', result: reason });
const deferred = (reason) => ({ status: 'deferred', result: reason });

class Recorder {
    /**
     * @param {Object} options
     * @param {Redactor} options.redactor
     * @param {Function} [options.now]
     */
    constructor({ redactor, now = () => Date.now() }) {
        this.redactor = redactor;
        this.now = now;
        this.steps = new Map();
        this.injections = new Map();
        this.failedSteps = new Set();
        this.engine = 'sqlite';
    }

    _entry(kind, def) {
        return { id: def.id, title: def.title, status: 'not-applicable', result: 'did not run', durationMs: 0, engine: this.engine, commands: [] };
    }

    /**
     * Run one step or injection. `fn(handle)` returns nothing (a pass with the handle's note), a
     * `notApplicable()` / `deferred()` value, or `{ result }`; it fails by throwing.
     * @param {'step'|'injection'} kind
     * @param {{id:string,title:string}} def
     * @param {Function} fn
     * @param {{needs?: string[]}} [options]
     */
    async run(kind, def, fn, { needs = [] } = {}) {
        const table = kind === 'step' ? this.steps : this.injections;
        const entry = this._entry(kind, def);
        table.set(def.id, entry);
        const blocked = needs.find((id) => this.failedSteps.has(id));
        if (blocked) {
            entry.result = clip(`not run: the ${blocked} step failed`, MAX_RESULT);
            return entry;
        }
        const handle = {
            note: '',
            commands: entry.commands,
            command: (record) => {
                entry.commands.push({
                    command: clip(this.redactor.text(record.command), MAX_COMMAND),
                    exitCode: record.exitCode === undefined ? null : record.exitCode,
                    durationMs: Math.round(record.durationMs || 0)
                });
            },
            setEngine: (engine) => { entry.engine = engine; this.engine = engine; }
        };
        const started = this.now();
        try {
            const outcome = await fn(handle);
            const value = outcome && typeof outcome === 'object' ? outcome : {};
            entry.status = STATUSES.includes(value.status) ? value.status : 'pass';
            entry.result = clip(this.redactor.text(value.result || handle.note || 'ok'), MAX_RESULT);
        } catch (error) {
            entry.status = 'fail';
            entry.result = clip(this.redactor.text(error instanceof CheckFailed ? error.message : `${error && error.name ? error.name : 'Error'}: ${error && error.message ? error.message : 'unexpected failure'}`), MAX_RESULT);
            if (kind === 'step') this.failedSteps.add(def.id);
        }
        entry.durationMs = Math.round(this.now() - started);
        if (entry.status === 'fail' && kind === 'step') this.failedSteps.add(def.id);
        return entry;
    }

    step(id, fn, options) {
        const def = STEPS.find((item) => item.id === id);
        if (!def) throw new Error(`unknown step ${id}`);
        return this.run('step', def, fn, options);
    }

    injection(id, fn, options) {
        const def = INJECTIONS.find((item) => item.id === id);
        if (!def) throw new Error(`unknown injection ${id}`);
        return this.run('injection', def, fn, options);
    }

    /** Every defined step and injection in its fixed order, the ones that never ran as not-applicable. */
    ordered() {
        const fill = (defs, table, reason) => defs.map((def) => table.get(def.id) || { id: def.id, title: def.title, status: 'not-applicable', result: reason, durationMs: 0, engine: this.engine, commands: [] });
        return {
            steps: fill(STEPS, this.steps, 'the driver stopped before this step'),
            injections: fill(INJECTIONS, this.injections, 'the driver stopped before this check')
        };
    }
}

function summarize(entries) {
    const out = { pass: 0, fail: 0, notApplicable: 0, deferred: 0 };
    for (const entry of entries) {
        if (entry.status === 'pass') out.pass += 1;
        else if (entry.status === 'fail') out.fail += 1;
        else if (entry.status === 'deferred') out.deferred += 1;
        else out.notApplicable += 1;
    }
    return out;
}

function cellId({ platform, arch, install, db, features }) {
    return `${platform}-${arch}/${install}/${db}/${features}`;
}

function fileNameFor(cell) {
    return `evidence-${cell.platform}-${cell.arch}-${cell.install}-${cell.db}-${cell.features}.json`;
}

/** Structural validation of an evidence document (what report.js requires before it renders one). */
function validate(doc) {
    const problems = [];
    const need = (condition, text) => { if (!condition) problems.push(text); };
    need(doc && typeof doc === 'object', 'not an object');
    if (!doc || typeof doc !== 'object') return problems;
    need(doc.schema === SCHEMA_VERSION, `schema must be ${SCHEMA_VERSION}`);
    const cell = doc.cell || {};
    need(typeof cell.platform === 'string' && typeof cell.arch === 'string', 'cell needs platform and arch');
    need(INSTALLS.includes(cell.install), 'cell.install is new or adopt');
    need(DATABASES.includes(cell.db), 'cell.db is sqlite, existing-pg or managed-pg');
    need(FEATURE_SETS.includes(cell.features), 'cell.features is minimal, representative or full');
    need(doc.artifact && typeof doc.artifact.version === 'string', 'artifact.version is required');
    need(typeof doc.commit === 'string' && doc.commit !== '', 'commit is required');
    need(typeof doc.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(doc.date), 'date must be YYYY-MM-DD');
    for (const [name, defs] of [['steps', STEPS], ['injections', INJECTIONS]]) {
        const list = Array.isArray(doc[name]) ? doc[name] : [];
        need(Array.isArray(doc[name]), `${name} must be a list`);
        for (const def of defs) {
            const entry = list.find((item) => item && item.id === def.id);
            need(Boolean(entry), `${name} lacks ${def.id}`);
            if (entry) {
                need(STATUSES.includes(entry.status), `${def.id}: status ${String(entry.status)} is not one of ${STATUSES.join(', ')}`);
                if (entry.status === 'not-applicable' || entry.status === 'deferred') need(typeof entry.result === 'string' && entry.result.trim() !== '', `${def.id}: ${entry.status} needs a reason`);
            }
        }
    }
    return problems;
}

module.exports = {
    SCHEMA_VERSION,
    STEPS,
    INJECTIONS,
    STATUSES,
    INSTALLS,
    DATABASES,
    FEATURE_SETS,
    Redactor,
    hostRedactor,
    findLeaks,
    Recorder,
    CheckFailed,
    check,
    notApplicable,
    deferred,
    summarize,
    cellId,
    fileNameFor,
    validate,
    clip
};
