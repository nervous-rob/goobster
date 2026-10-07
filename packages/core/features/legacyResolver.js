/**
 * Legacy switch resolution for installations without `data/features.json`.
 *
 * Two sources produce the same answers:
 *
 * - the default source reuses the config modules that already compute each
 *   switch (discordConfig, mcpConfig, sandboxConfig, observatoryConfig,
 *   spitballConfig, mailConfig), so "no state file" really is today's
 *   behaviour and not a reimplementation of it;
 * - the injected source evaluates a plain config.json-shaped object plus an
 *   env object with the same parsing rules, so tests and the future manager
 *   can ask "what would this configuration do" without touching process
 *   state. tests/featureState.test.js proves the two agree for every flag
 *   combination.
 *
 * Push is the one exception to module reuse: pushConfig.enabled generates a
 * key file under data/ as a side effect of resolving, and a resolver that is
 * promised to be read-only cannot trigger that. Push is therefore evaluated
 * from its switch and key pair directly in both sources.
 *
 * Nothing here returns a value from config or env; only booleans and the
 * NAMES of missing settings leave this module.
 */

const OFF_VALUES = new Set(['0', 'false', 'no', 'off']);

function envValue(env, name) {
    if (!name) return undefined;
    const raw = env[name];
    return raw === undefined || raw === null || raw === '' ? undefined : String(raw);
}

function getPath(object, dotted) {
    return dotted.split('.').reduce((node, key) => (node == null ? undefined : node[key]), object);
}

/** Env first (any value but an off word is on), then config as a boolean, else null. */
function triState(env, envName, fileValue) {
    const raw = envValue(env, envName);
    if (raw !== undefined) return !OFF_VALUES.has(raw.trim().toLowerCase());
    if (fileValue === undefined || fileValue === null) return null;
    return Boolean(fileValue);
}

function triStateOr(env, envName, fileValue, def) {
    const value = triState(env, envName, fileValue);
    return value === null ? def : value;
}

function trimmed(env, envName, fileValue) {
    const raw = envValue(env, envName);
    if (raw !== undefined) return raw.trim();
    if (fileValue === undefined || fileValue === null || fileValue === '') return '';
    return String(fileValue).trim();
}

function isPresent(value) {
    if (typeof value === 'string') return value.trim().length > 0;
    return value !== undefined && value !== null && value !== false;
}

const MAIL_PROVIDERS = ['smtp', 'resend'];

/**
 * Names of the settings that keep mail off, or [] when it is on. Mirrors
 * config/mailConfig.js `disabledReason` without ever returning a value.
 *
 * @param {{ provider: string, from: string, smtp: { url: string, host: string }, resend: { apiKey: string } }} mail
 */
function mailMissing(mail) {
    const provider = mail.provider || '';
    if (provider && !MAIL_PROVIDERS.includes(provider)) return ['GOOBSTER_MAIL_PROVIDER'];
    let resolved = provider;
    if (!resolved) {
        if (mail.smtp.url || mail.smtp.host) resolved = 'smtp';
        else if (mail.resend.apiKey) resolved = 'resend';
    }
    if (!resolved) return ['GOOBSTER_SMTP_URL|GOOBSTER_SMTP_HOST|RESEND_API_KEY'];
    const missing = [];
    if (!mail.from) missing.push('GOOBSTER_MAIL_FROM');
    if (resolved === 'smtp' && !mail.smtp.url && !mail.smtp.host) missing.push('GOOBSTER_SMTP_URL|GOOBSTER_SMTP_HOST');
    if (resolved === 'resend' && !mail.resend.apiKey) missing.push('RESEND_API_KEY');
    return missing;
}

function mailShape(config, env) {
    const mail = config.mail || {};
    const smtp = mail.smtp || {};
    return {
        provider: trimmed(env, 'GOOBSTER_MAIL_PROVIDER', mail.provider).toLowerCase(),
        from: trimmed(env, 'GOOBSTER_MAIL_FROM', mail.from),
        smtp: {
            url: trimmed(env, 'GOOBSTER_SMTP_URL', smtp.url),
            host: trimmed(env, 'GOOBSTER_SMTP_HOST', smtp.host)
        },
        resend: { apiKey: trimmed(env, 'RESEND_API_KEY', mail.resend?.apiKey) }
    };
}

/** Names of the VAPID settings that are half-set, or []. */
function pushMissing(config, env) {
    const push = config.webapp?.push || {};
    const pub = trimmed(env, 'GOOBSTER_VAPID_PUBLIC_KEY', push.vapidPublicKey);
    const priv = trimmed(env, 'GOOBSTER_VAPID_PRIVATE_KEY', push.vapidPrivateKey);
    if (pub && !priv) return ['GOOBSTER_VAPID_PRIVATE_KEY'];
    if (priv && !pub) return ['GOOBSTER_VAPID_PUBLIC_KEY'];
    return [];
}

function pushEnabled(config, env) {
    if (!triStateOr(env, 'GOOBSTER_WEB_PUSH_ENABLED', config.webapp?.push?.enabled, true)) return false;
    return pushMissing(config, env).length === 0;
}

/** Mirrors config/observatoryConfig.js `flag()` (projects). */
function explicitBoolean(envName, env, fileValue, def) {
    const raw = envValue(env, envName);
    if (raw === '0' || raw === 'false') return false;
    if (raw === '1' || raw === 'true') return true;
    if (fileValue === true || fileValue === false) return fileValue;
    return def;
}

function onOrTrue(env, envName, fileValue) {
    const raw = envValue(env, envName);
    return raw === '1' || raw === 'true' || fileValue === true;
}

/** Evaluate every legacy switch from a plain config object and env. */
function configSource(config, env) {
    return {
        discord() {
            const explicit = triState(env, 'GOOBSTER_DISCORD_ENABLED', config.discord?.enabled);
            if (explicit !== null) return explicit;
            return typeof config.token === 'string' && config.token.trim().length > 0;
        },
        push: () => pushEnabled(config, env),
        mail: () => mailMissing(mailShape(config, env)).length === 0,
        mcp: () => triStateOr(env, 'GOOBSTER_MCP_ENABLED', config.mcp?.enabled, false),
        sandbox: () => onOrTrue(env, 'GOOBSTER_SANDBOX_ENABLED', config.sandbox?.enabled),
        observatory: () => onOrTrue(env, 'GOOBSTER_OBSERVATORY_ENABLED', config.observatory?.enabled),
        projects: () => explicitBoolean('GOOBSTER_PROJECTS_ENABLED', env, config.projects?.enabled, true),
        expeditions() {
            const raw = envValue(env, 'GOOBSTER_SPITBALL_ENABLED');
            return !(raw === '0' || raw === 'false' || config.spitball?.enabled === false);
        },
        gba: () => config.gbaRun?.enabled === true,
        screenVision: () => config.screenVision?.enabled === true,
        discordActivity: () => config.activity?.enabled === true,
        mailMissing: () => mailMissing(mailShape(config, env)),
        pushMissing: () => pushMissing(config, env)
    };
}

/**
 * The same switches read from the live config modules. Requires are lazy so
 * importing this file never loads a config module, and each module is read
 * through a getter so a test double or setEnabledForTests override applies.
 */
function moduleSource(config, env) {
    return {
        discord: () => require('../config/discordConfig').enabled,
        push: () => pushEnabled(config, env),
        mail: () => require('../config/mailConfig').enabled,
        mcp: () => require('../config/mcpConfig').enabled,
        sandbox: () => require('../config/sandboxConfig').enabled,
        observatory: () => require('../config/observatoryConfig').enabled,
        projects: () => require('../config/observatoryConfig').projectsEnabled,
        expeditions: () => require('../config/spitballConfig').enabled,
        gba: () => config.gbaRun?.enabled === true,
        screenVision: () => config.screenVision?.enabled === true,
        discordActivity: () => config.activity?.enabled === true,
        mailMissing: () => mailMissing(require('../config/mailConfig')),
        pushMissing: () => pushMissing(config, env)
    };
}

/**
 * @param {{ config?: Object, env: Object }} params `config` undefined selects
 *   the live config modules; an object selects the injected source.
 */
function createLegacyResolver({ config, env }) {
    const injected = config !== undefined && config !== null;
    const fileConfig = injected ? config : require('../config/aiConfig').fileConfig || {};
    const source = injected ? configSource(fileConfig, env) : moduleSource(fileConfig, env);

    return {
        injected,
        /** The effective legacy value of one switch (boolean). */
        value(id) {
            const read = source[id];
            if (typeof read !== 'function') throw new Error(`No legacy switch is defined for "${id}".`);
            return Boolean(read());
        },
        /** Names of the mail settings that keep mail off; [] when on. */
        mailMissing: () => source.mailMissing(),
        /** Names of half-set VAPID settings; [] when fine. */
        pushMissing: () => source.pushMissing(),
        /** True when the env var or the config path holds a non-empty value. Never returns the value. */
        isSet(envName, configPath) {
            if (isPresent(envValue(env, envName))) return true;
            return configPath ? isPresent(getPath(fileConfig, configPath)) : false;
        }
    };
}

module.exports = { createLegacyResolver, mailMissing, pushMissing, OFF_VALUES };
