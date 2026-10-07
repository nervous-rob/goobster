/**
 * Configuration routes of the manager API (documentation/manager_configuration.md).
 *
 *   GET  /manager/api/config         effective settings by section, with source,
 *                                    env-controlled flags and masked secrets
 *   POST /manager/api/config/probe   one explicit provider connection check
 *
 * Changing a setting is not a route: it is the `config.set` and
 * `defaults.set` operation kinds, through the operations API.
 *
 * The report reads the database-backed fields (host limits, instance
 * defaults) only when the manager's probe says the application database is
 * reachable; otherwise those fields report `source: "unknown-db"` and the
 * response says `appDatabase.reachable: false`. A probe is never run by a
 * status or page load: the request body names the target and either
 * `useSaved: true` or a credential to try before saving, and is never
 * journaled, audited or logged.
 */

const catalog = require('@goobster/core/config/fieldCatalog');
const effective = require('@goobster/core/config/effectiveConfig');
const probes = require('@goobster/core/services/providerProbeService');
const { ManagerError } = require('../errors');
const view = require('../configView');

const BODY_KEYS = new Set(['target', 'useSaved', 'credential']);
const PROBE_WINDOW_MS = 60_000;
const PROBE_LIMIT = 20;

const SAVED_SECRET = Object.freeze({
    openai: 'ai.openai.apiKey',
    anthropic: 'ai.anthropic.apiKey',
    gemini: 'ai.gemini.apiKey',
    perplexity: 'perplexity.apiKey',
    elevenlabs: 'elevenlabs.apiKey',
    github: 'github.token',
    cursor: 'cursor.apiKey'
});

function decorate(entry) {
    const field = catalog.get(entry.id);
    const out = { ...entry, description: field.description, help: field.help };
    if (!field.secret) {
        out.default = field.default === undefined ? null : field.default;
        if (field.validate.enum) out.options = field.validate.enum;
        if (field.validate.min !== undefined) out.min = field.validate.min;
        if (field.validate.max !== undefined) out.max = field.validate.max;
    }
    out.editable = Boolean(catalog.filePath(field));
    out.sources = field.sources;
    return out;
}

function createConfigMount({ probe = probes.probe, probeOptions = {} } = {}) {
    return function mountConfigRoutes(api, helpers) {
        const { route, authenticate, readAuth, checkActor, manager } = helpers;
        const settings = manager.settings;
        const now = helpers.now || (() => new Date());
        const probeTimes = [];

        function stateRule(auth) {
            const state = manager.currentState();
            if (state.state === 'unclaimed' || (state.state === 'recovery' && auth.via !== 'recovery')) {
                throw new ManagerError(409, 'STATE_NOT_ALLOWED', `Not available in the ${state.state} state with this authentication.`, { state: state.state });
            }
        }

        function throttleProbes() {
            const t = now().getTime();
            while (probeTimes.length > 0 && t - probeTimes[0] >= PROBE_WINDOW_MS) probeTimes.shift();
            if (probeTimes.length >= PROBE_LIMIT) {
                throw new ManagerError(429, 'TOO_MANY_PROBES', 'Too many connection checks; wait a minute.');
            }
            probeTimes.push(t);
        }

        api.get('/config', route(async (req) => {
            readAuth(req);
            const reachability = await manager.probe();
            const read = await view.readOverrides(settings, { reachability });
            const file = view.readFile(settings);
            const features = view.featureStates(manager.createFeatureState);
            const report = view.resolve({ settings, overrides: read.overrides, features });
            return {
                revision: file.revision,
                file: { present: file.present, readable: file.readable, ...(file.error ? { error: file.error } : {}) },
                appDatabase: {
                    reachable: reachability.reachable === true && reachability.reason !== 'SQLITE_EMPTY',
                    engine: reachability.engine,
                    ...(reachability.reason ? { reason: reachability.reason } : {})
                },
                defaults: read.overrides ? { revision: view.defaultsRevision(read.overrides.defaults) } : null,
                sections: report.sections.map(section => ({ ...section, fields: section.fields.map(decorate) })),
                probes: probes.describeTargets()
            };
        }));

        function parseProbeBody(body) {
            for (const key of Object.keys(body)) {
                if (!BODY_KEYS.has(key)) throw new ManagerError(400, 'INVALID_INPUT', 'The request has a field the probe does not accept.');
            }
            const { target, useSaved, credential } = body;
            if (typeof target !== 'string' || !probes.TARGET_IDS.includes(target)) {
                throw new ManagerError(400, 'UNKNOWN_TARGET', 'There is no such probe target.');
            }
            if (useSaved !== undefined && typeof useSaved !== 'boolean') throw new ManagerError(400, 'INVALID_INPUT', '"useSaved" must be true or false.');
            if (credential !== undefined && typeof credential !== 'string') throw new ManagerError(400, 'INVALID_INPUT', '"credential" must be a string.');
            if ((useSaved === true) === (credential !== undefined)) {
                throw new ManagerError(400, 'INVALID_INPUT', 'Send exactly one of "useSaved": true or "credential".');
            }
            if (credential !== undefined && (target === 'ollama')) {
                throw new ManagerError(400, 'INVALID_INPUT', 'That target takes no credential; use "useSaved": true.');
            }
            return { target, useSaved: useSaved === true, credential };
        }

        function resolveProbe({ target, useSaved, credential }) {
            const env = view.loadEnv(settings);
            const fileConfig = view.readFile(settings).doc || {};
            const options = {};
            if (target === 'ollama') {
                options.endpoint = { host: effective.resolveValue('ollama.host', { env, fileConfig }) };
                return options;
            }
            if (target === 'mail') {
                if (!useSaved) {
                    options.mail = { provider: 'resend' };
                    options.credentials = { apiKey: credential };
                    return options;
                }
                const report = view.resolve({ settings, overrides: {} });
                const value = (id) => (report.fields.find(entry => entry.id === id) || {}).value;
                const present = (id) => Boolean((report.fields.find(entry => entry.id === id) || {}).present);
                const explicit = String(value('mail.provider') || '').toLowerCase();
                const smtpUrl = effective.resolveSecretValue('mail.smtp.url', { env, fileConfig });
                const smtpReady = Boolean(smtpUrl) || Boolean(value('mail.smtp.host'));
                const provider = explicit || (smtpReady ? 'smtp' : (present('mail.resend.apiKey') ? 'resend' : ''));
                if (provider === 'resend') {
                    options.mail = { provider: 'resend' };
                    options.credentials = { apiKey: effective.resolveSecretValue('mail.resend.apiKey', { env, fileConfig }) };
                } else if (provider === 'smtp' && smtpReady) {
                    const parsed = smtpUrl ? probes.smtpTargetFromUrl(smtpUrl) : null;
                    options.mail = parsed || { host: value('mail.smtp.host'), port: value('mail.smtp.port'), secure: Boolean(value('mail.smtp.secure')) };
                } else {
                    throw new ManagerError(409, 'NOT_CONFIGURED', 'No mail provider is configured, so there is nothing to check.');
                }
                return options;
            }
            options.credentials = {
                apiKey: useSaved ? effective.resolveSecretValue(SAVED_SECRET[target], { env, fileConfig }) : credential
            };
            return options;
        }

        api.post('/config/probe', route(async (req) => {
            const auth = authenticate(req);
            stateRule(auth);
            checkActor(req, auth.principal);
            const body = parseProbeBody(req.body);
            throttleProbes();
            const options = resolveProbe(body);
            try {
                const outcome = await probe(body.target, { ...probeOptions, ...options });
                return { ...outcome, usedSaved: body.useSaved };
            } catch (error) {
                if (!(error instanceof probes.ProbeInputError)) throw error;
                if (error.code === 'NO_CREDENTIAL' && body.useSaved) {
                    throw new ManagerError(409, 'NO_SAVED_CREDENTIAL', 'No credential is saved for that target, so there is nothing to check. Enter one to try it first.');
                }
                const status = error.code === 'BAD_HOST' ? 409 : 400;
                throw new ManagerError(status, error.code, error.message);
            }
        }));
    };
}

module.exports = { createConfigMount, SAVED_SECRET };
