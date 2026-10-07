/**
 * The update policy (documentation/manager_update.md): what the manager may do on its own and
 * where it looks for a release. It is the `update` section of the sealed installation record,
 * and it is explicit: an installation that never chose is `off`, and nothing in an upgrade
 * turns it on.
 *
 *   { channel: 'stable'|'prerelease',
 *     mode: 'off'|'check'|'download'|'apply',
 *     window?: { days: [0-6], startHour, endHour, tz },
 *     source?: { kind: 'github-release', owner, repo }
 *            | { kind: 'directory', dir }
 *            | { kind: 'url', base } }
 *
 * `apply` is honoured only while the installation's updater is the manager (updater.kind);
 * `effectiveMode` says what actually runs. Nothing here reads the network or the disk.
 */

const path = require('node:path');
const { ManagerError } = require('../errors');

const CHANNELS = Object.freeze(['stable', 'prerelease']);
const MODES = Object.freeze(['off', 'check', 'download', 'apply']);
const DEFAULT_SOURCE = Object.freeze({ kind: 'github-release', owner: 'nervous-rob', repo: 'goobster' });
const OWNER_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_SHAPE = /^[A-Za-z0-9._-]{1,100}$/;

function bad(message, strict) {
    return strict ? Object.assign(new Error(message), { code: 'INVALID_POLICY' }) : new ManagerError(400, 'INVALID_INPUT', message);
}

function exact(value, allowed, what, strict) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(`${what} must be an object.`, strict);
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) throw bad(`${what} has a field the update policy does not accept.`, strict);
    }
}

function validTimeZone(tz) {
    if (tz === 'UTC' || tz === 'local') return true;
    if (typeof tz !== 'string' || tz.length > 64) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

function normaliseWindow(value, strict) {
    exact(value, ['days', 'startHour', 'endHour', 'tz'], '"window"', strict);
    const days = value.days === undefined ? [0, 1, 2, 3, 4, 5, 6] : value.days;
    if (!Array.isArray(days) || days.length === 0 || days.length > 7 || days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
        throw bad('"window.days" must be a list of weekdays, 0 (Sunday) to 6.', strict);
    }
    for (const key of ['startHour', 'endHour']) {
        if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 23) throw bad(`"window.${key}" must be an hour from 0 to 23.`, strict);
    }
    if (value.startHour === value.endHour) throw bad('"window.startHour" and "window.endHour" must differ.', strict);
    const tz = value.tz === undefined ? 'UTC' : value.tz;
    if (!validTimeZone(tz)) throw bad('"window.tz" must be UTC, local or an IANA time zone name.', strict);
    return { days: [...new Set(days)].sort((a, b) => a - b), startHour: value.startHour, endHour: value.endHour, tz };
}

function normaliseSource(value, strict) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('"source" must be an object.', strict);
    if (value.kind === 'github-release') {
        exact(value, ['kind', 'owner', 'repo'], '"source"', strict);
        if (typeof value.owner !== 'string' || !OWNER_SHAPE.test(value.owner) || typeof value.repo !== 'string' || !REPO_SHAPE.test(value.repo) || value.repo === '.' || value.repo === '..') {
            throw bad('"source.owner" and "source.repo" must name a GitHub repository.', strict);
        }
        return { kind: 'github-release', owner: value.owner, repo: value.repo };
    }
    if (value.kind === 'directory') {
        exact(value, ['kind', 'dir'], '"source"', strict);
        if (typeof value.dir !== 'string' || value.dir.length === 0 || value.dir.length > 4096 || value.dir.includes('\0')
            || !path.isAbsolute(value.dir) || value.dir.split(/[\\/]/).includes('..')) {
            throw bad('"source.dir" must be an absolute directory path without ".." parts.', strict);
        }
        return { kind: 'directory', dir: path.resolve(value.dir) };
    }
    if (value.kind === 'url') {
        exact(value, ['kind', 'base'], '"source"', strict);
        let parsed;
        try {
            parsed = new URL(value.base);
        } catch {
            throw bad('"source.base" must be an https URL.', strict);
        }
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
        if (!(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)) || parsed.username || parsed.password || parsed.search || parsed.hash) {
            throw bad('"source.base" must be an https URL without credentials, a query or a fragment.', strict);
        }
        return { kind: 'url', base: parsed.href.replace(/\/+$/, '') };
    }
    throw bad('"source.kind" must be github-release, directory or url.', strict);
}

/**
 * Check and normalise a policy. `strict` is the record's check (a plain Error with
 * code INVALID_POLICY); otherwise a refusal is a 400 ManagerError an operator sees.
 * Absent fields take their defaults: `channel` stable, `mode` off, no window.
 */
function normalise(value, { strict = false } = {}) {
    exact(value, ['channel', 'mode', 'window', 'source'], 'The update policy', strict);
    const channel = value.channel === undefined ? 'stable' : value.channel;
    const mode = value.mode === undefined ? 'off' : value.mode;
    if (!CHANNELS.includes(channel)) throw bad('"channel" must be stable or prerelease.', strict);
    if (!MODES.includes(mode)) throw bad('"mode" must be off, check, download or apply.', strict);
    const out = { channel, mode };
    if (value.window !== undefined && value.window !== null) out.window = normaliseWindow(value.window, strict);
    if (value.source !== undefined && value.source !== null) out.source = normaliseSource(value.source, strict);
    return out;
}

/** The policy an installation has: the recorded one, or the default (off). */
function current(doc) {
    return doc && doc.update ? doc.update : { channel: 'stable', mode: 'off' };
}

/** The source in force: the policy's, or the project's own releases. */
function sourceOf(policy) {
    return policy.source || { ...DEFAULT_SOURCE };
}

/**
 * What runs on its own. `apply` needs the manager to be the updater; with another updater the
 * policy is honoured as far as `download`.
 * @returns {{ mode: string, requested: string, capped: boolean }}
 */
function effectiveMode(policy, updater) {
    const owns = Boolean(updater && updater.kind === 'manager');
    if (policy.mode === 'apply' && !owns) return { mode: 'download', requested: 'apply', capped: true };
    return { mode: policy.mode, requested: policy.mode, capped: false };
}

function partsIn(date, tz) {
    if (tz === 'local') return { day: date.getDay(), hour: date.getHours(), minute: date.getMinutes() };
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(date);
    const get = (type) => parts.find(part => part.type === type).value;
    return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')), hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}

/** Is `date` inside the window (a window that wraps midnight belongs to the day it starts on)? No window means always. */
function inWindow(window, date) {
    if (!window) return true;
    const { day, hour } = partsIn(date, window.tz);
    if (window.startHour < window.endHour) return window.days.includes(day) && hour >= window.startHour && hour < window.endHour;
    if (hour >= window.startHour) return window.days.includes(day);
    return window.days.includes((day + 6) % 7) && hour < window.endHour;
}

/** The next minute at or after `date` the window is open, or null when it never is. */
function nextOpen(window, date) {
    if (!window) return date;
    const step = 60_000;
    const start = new Date(Math.floor(date.getTime() / step) * step);
    for (let at = 0; at <= 8 * 24 * 60; at += 1) {
        const candidate = new Date(start.getTime() + at * step);
        if (inWindow(window, candidate)) return candidate;
    }
    return null;
}

module.exports = { CHANNELS, MODES, DEFAULT_SOURCE, normalise, current, sourceOf, effectiveMode, inWindow, nextOpen };
