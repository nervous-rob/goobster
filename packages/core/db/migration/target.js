/**
 * Describing a Postgres migration target without exposing it.
 *
 * The connection URL carries a password, so everything here either reads it
 * into a small non-secret description (host, port, database, user, schema)
 * or removes it from text. The schema comes from a `search_path` startup
 * option on the URL (`?options=-c search_path=<schema>,public`), the same
 * mechanism the test isolation uses; without one the target is whatever
 * schema the server's own search_path resolves first (normally `public`).
 */

const crypto = require('node:crypto');
const { MigrationError } = require('./errors');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * @param {string} url
 * @returns {{ host: string, port: number, database: string, user: string|null, schema: string|null, local: boolean, fingerprint: string }}
 */
function describeTarget(url) {
    let parsed;
    try {
        parsed = new URL(String(url));
    } catch {
        throw new MigrationError('INVALID_TARGET', 'The target is not a Postgres connection URL.');
    }
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
        throw new MigrationError('INVALID_TARGET', 'The target must be a postgres:// or postgresql:// URL.');
    }
    const host = decodeURIComponent(parsed.hostname || '').toLowerCase();
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    if (!host || !database) {
        throw new MigrationError('INVALID_TARGET', 'The target URL must name a host and a database.');
    }
    const port = parsed.port ? Number(parsed.port) : 5432;
    const schema = schemaFromOptions(parsed.searchParams.get('options'));
    const local = LOOPBACK.has(host) || host.startsWith('/');
    const fingerprint = crypto.createHash('sha256').update([host, port, database, schema || ''].join('|')).digest('hex').slice(0, 24);
    return {
        host,
        port,
        database,
        user: parsed.username ? decodeURIComponent(parsed.username) : null,
        schema,
        local,
        fingerprint
    };
}

/** The first schema named by `-c search_path=a,b` in a startup `options` value, or null. */
function schemaFromOptions(options) {
    if (!options) return null;
    const match = /search_path\s*=\s*([^\s]+)/.exec(String(options));
    if (!match) return null;
    const first = match[1].split(',')[0].trim().replace(/^"|"$/g, '');
    return first && /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(first) ? first : null;
}

/** The non-secret part of a target, safe for a record, a report or a log. */
function publicTarget(description) {
    const { host, port, database, user, schema, local, fingerprint } = description;
    return { host, port, database, user, schema, local, fingerprint };
}

/** Remove a connection URL (and anything shaped like one) from text. */
function redactText(text, secrets = []) {
    let out = String(text == null ? '' : text);
    for (const secret of secrets) {
        if (secret && String(secret).length >= 3) out = out.split(String(secret)).join('***');
    }
    return out.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgres://***');
}

module.exports = { describeTarget, publicTarget, schemaFromOptions, redactText };
