/**
 * The service ownership record: `<manager store>/services.json`.
 *
 * It says which operating-system services this installation's installer
 * registered, under which installation id, and when. `service.unregister`
 * (uninstall, reconfigure) acts only on what it names; discovery
 * (install/discover.js) reads it to report `registeredBy: 'installer'`
 * instead of `system` for a unit that is ours. The privileged helper
 * independently checks the unit's own `X-Goobster-Installation` marker, so a
 * stale or edited record can never make it touch someone else's service.
 *
 * Names, kinds, paths and timestamps only.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const files = require('../store/files');

const VERSION = 1;
const FILE_NAME = 'services.json';
const KINDS = Object.freeze(['systemd', 'windows-service', 'launchd']);
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

const recordPath = (storeDir) => path.join(storeDir, FILE_NAME);

function validEntry(entry) {
    return Boolean(entry && typeof entry === 'object'
        && KINDS.includes(entry.kind)
        && typeof entry.name === 'string' && NAME.test(entry.name)
        && typeof entry.unitPath === 'string' && path.isAbsolute(entry.unitPath)
        && typeof entry.installationId === 'string' && entry.installationId.length > 0
        && entry.registeredBy === 'installer'
        && typeof entry.registeredAt === 'string');
}

/** @returns {{ present: boolean, problem: string|null, services: Array<Object> }} a damaged file reads as no services plus a problem */
function readRecord(storeDir, fs = nodeFs) {
    const read = files.readJson(recordPath(storeDir), fs);
    if (!read.exists) return { present: false, problem: null, services: [] };
    const value = read.value;
    if (read.problem || !files.isPlainObject(value) || value.version !== VERSION || !Array.isArray(value.services)) {
        return { present: true, problem: 'SERVICES_RECORD_INVALID', services: [] };
    }
    return { present: true, problem: null, services: value.services.filter(validEntry).map(entry => ({ ...entry })) };
}

function writeRecord(storeDir, services, fs = nodeFs) {
    files.ensureDir(storeDir, fs);
    if (services.length === 0) {
        files.removeIfPresent(recordPath(storeDir), fs);
        return;
    }
    files.writeJsonAtomic(recordPath(storeDir), { version: VERSION, services }, fs);
}

/** Add or replace the entry for `name`; the first registration time is kept. */
function recordRegistered(storeDir, { kind, name, unitPath, installationId }, { now = () => new Date(), fs = nodeFs } = {}) {
    const current = readRecord(storeDir, fs).services;
    const previous = current.find(entry => entry.kind === kind && entry.name === name);
    const entry = { kind, name, unitPath, installationId, registeredBy: 'installer', registeredAt: previous ? previous.registeredAt : now().toISOString() };
    writeRecord(storeDir, [...current.filter(item => item !== previous), entry], fs);
    return entry;
}

function recordUnregistered(storeDir, { kind, name }, { fs = nodeFs } = {}) {
    const current = readRecord(storeDir, fs).services;
    const next = current.filter(entry => !(entry.kind === kind && entry.name === name));
    if (next.length === current.length) return false;
    writeRecord(storeDir, next, fs);
    return true;
}

module.exports = { VERSION, FILE_NAME, KINDS, recordPath, readRecord, recordRegistered, recordUnregistered };
