require('dotenv').config();

// config.json is optional (e.g. env-only deployments); never crash at import time.
let fileConfig = {};
try {
    fileConfig = require('../../../config.json');
} catch {
    // config.json optional at load time
}

const identity = fileConfig.identity || {};

/** Env switch first, then config.json, then the default. */
function flag(envName, fileValue, def) {
    const raw = process.env[envName];
    if (raw !== undefined && raw !== '') {
        return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
    }
    if (fileValue === undefined || fileValue === null) return def;
    return Boolean(fileValue);
}

/** Comma/space separated string or array -> trimmed non-empty tokens. */
function tokens(value) {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,\s]+/);
    return raw.map(v => String(v ?? '').trim()).filter(Boolean);
}

/** Integer from env, then config.json, then default - clamped to [min, max]. */
function int(envName, fileValue, def, min, max) {
    const raw = process.env[envName] !== undefined && process.env[envName] !== ''
        ? process.env[envName]
        : fileValue;
    const n = Number.parseInt(String(raw ?? ''), 10);
    const value = Number.isFinite(n) ? n : def;
    return Math.min(max, Math.max(min, value));
}

/**
 * Application identity configuration (shared-instance Increment A; spec in
 * documentation/shared_instance_product_spec.md). Resolution order matches
 * the other config modules: environment variable, then config.json, then a
 * default.
 *
 * Everything here is inert by default so a single-user installation keeps
 * behaving exactly as before: Discord users still sign in through OAuth
 * and a session is all the portal requires. `requireAccount` is the
 * release gate that turns installation membership into an explicit
 * entitlement (an app_accounts row).
 */
module.exports = {
    /**
     * Stable label for this installation, carried on every ActorContext so
     * a job or event can be traced to the instance that produced it.
     */
    installationId: process.env.GOOBSTER_INSTALLATION_ID
        || identity.installationId
        || 'local',
    /**
     * Release gate: when true, a web session whose principal has no active
     * app_accounts row is rejected with 403 NO_ACCOUNT. Off by default -
     * existing Discord logins must keep working until the operator has
     * granted accounts (see scripts/identity-report.js).
     */
    requireAccount: flag('GOOBSTER_IDENTITY_REQUIRE_ACCOUNT', identity.requireAccount, false),
    /**
     * Discord user ids that receive the operator role through the explicit
     * bootstrap (`node scripts/identity-report.js --bootstrap-operators`).
     * Never inferred from "first visitor" or from Manage Server.
     */
    operators: tokens(process.env.GOOBSTER_IDENTITY_OPERATORS || identity.operators || []),
    /**
     * Human name of this installation, shown on the invitation page and the
     * login screen so people know whose instance they are joining.
     */
    installationName: process.env.GOOBSTER_INSTALLATION_NAME
        || identity.installationName
        || 'Goobster',
    /**
     * Release gate for native (username + password) authentication:
     * invitations, registration, login, recovery, and credential enrollment.
     * Off by default - Discord OAuth remains the only sign-in until the
     * operator turns it on. Discord linking/unlinking is not behind it.
     */
    nativeLogin: flag('GOOBSTER_IDENTITY_NATIVE_LOGIN', identity.nativeLogin, false),
    /** Minimum password length (OWASP: long passphrases over composition rules). */
    passwordMinLength: int('GOOBSTER_IDENTITY_PASSWORD_MIN_LENGTH', identity.passwordMinLength, 15, 12, 128),
    /**
     * scrypt cost as log2(N). 15 = 32 MiB per hash, about 60-120 ms on a
     * Raspberry Pi 4; raise on faster hosts. Stored with each hash, so
     * changing it re-hashes on the next successful login.
     */
    passwordCostLog2: int('GOOBSTER_IDENTITY_PASSWORD_COST', identity.passwordCostLog2, 15, 14, 18),
    /** How long a login/re-auth counts as "recent" for sensitive account changes. */
    recentAuthMinutes: int('GOOBSTER_IDENTITY_RECENT_AUTH_MINUTES', identity.recentAuthMinutes, 15, 1, 1440),
    /** Default lifetime of a new invitation link. */
    inviteTtlHours: int('GOOBSTER_IDENTITY_INVITE_TTL_HOURS', identity.inviteTtlHours, 72, 1, 24 * 30),
    /** Lifetime of a password reset link (operator-issued or emailed). */
    recoveryTtlMinutes: int('GOOBSTER_IDENTITY_RECOVERY_TTL_MINUTES', identity.recoveryTtlMinutes, 60, 5, 24 * 60),
    /**
     * Who may create an account: 'invite' (an operator's link, the
     * default) or 'open' (anyone with an email address they can prove).
     * Open sign-up needs outbound mail; without it the effective mode
     * stays 'invite' and the host panel says why.
     */
    registration: (() => {
        const raw = String(process.env.GOOBSTER_IDENTITY_REGISTRATION || identity.registration || 'invite').trim().toLowerCase();
        return raw === 'open' ? 'open' : 'invite';
    })(),
    /** Lifetime of an email verification link (and of an unverified open sign-up). */
    emailVerifyTtlMinutes: int('GOOBSTER_IDENTITY_EMAIL_VERIFY_TTL_MINUTES', identity.emailVerifyTtlMinutes, 24 * 60, 5, 7 * 24 * 60)
};
