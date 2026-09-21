require('dotenv').config();

// config.json is optional (e.g. env-only deployments); never crash at import time.
let fileConfig = {};
try {
    fileConfig = require('../../../config.json');
} catch {
    // config.json optional at load time
}

const mail = fileConfig.mail || {};
const smtp = mail.smtp || {};

function str(envName, fileValue) {
    const raw = process.env[envName];
    if (raw !== undefined && raw !== '') return String(raw).trim();
    if (fileValue === undefined || fileValue === null || fileValue === '') return '';
    return String(fileValue).trim();
}

function bool(envName, fileValue, def) {
    const raw = process.env[envName];
    if (raw !== undefined && raw !== '') {
        return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
    }
    if (fileValue === undefined || fileValue === null) return def;
    return Boolean(fileValue);
}

function int(envName, fileValue, def) {
    const raw = process.env[envName] !== undefined && process.env[envName] !== ''
        ? process.env[envName]
        : fileValue;
    const n = Number.parseInt(String(raw ?? ''), 10);
    return Number.isFinite(n) ? n : def;
}

const PROVIDERS = ['smtp', 'resend'];

/**
 * Outbound mail (shared-instance Increment B.1). Optional, like every other
 * integration: with nothing configured `enabled` is false, verification
 * and self-service password recovery stay hidden, and the operator's
 * audited reset link remains the recovery path.
 *
 * Provider resolution: `provider` when set, otherwise the first provider
 * whose credentials are present (SMTP, then Resend). Both need a `from`
 * address. Resolution order for every value is environment variable,
 * then config.json `mail.*`, then the default - the same as aiConfig.
 */
const config = {
    /** '' = auto-detect from credentials. */
    provider: str('GOOBSTER_MAIL_PROVIDER', mail.provider).toLowerCase(),
    /** Sender, e.g. "Goobster <goobster@example.org>". Required. */
    from: str('GOOBSTER_MAIL_FROM', mail.from),
    /** Optional Reply-To. */
    replyTo: str('GOOBSTER_MAIL_REPLY_TO', mail.replyTo),
    smtp: {
        /** smtp(s)://user:pass@host:port - wins over the discrete fields. */
        url: str('GOOBSTER_SMTP_URL', smtp.url),
        host: str('GOOBSTER_SMTP_HOST', smtp.host),
        port: int('GOOBSTER_SMTP_PORT', smtp.port, 587),
        /** Implicit TLS (port 465). STARTTLS is negotiated on 587 regardless. */
        secure: bool('GOOBSTER_SMTP_SECURE', smtp.secure, false),
        user: str('GOOBSTER_SMTP_USER', smtp.user),
        pass: str('GOOBSTER_SMTP_PASS', smtp.pass)
    },
    resend: {
        apiKey: str('RESEND_API_KEY', mail.resend?.apiKey)
    },
    /** Outbound request timeout for HTTP providers and SMTP connection. */
    timeoutMs: Math.max(1000, int('GOOBSTER_MAIL_TIMEOUT_MS', mail.timeoutMs, 15000)),

    get providers() {
        return PROVIDERS.slice();
    },

    /** The provider whose credentials are present, or null. */
    get resolvedProvider() {
        const explicit = this.provider;
        if (explicit) return PROVIDERS.includes(explicit) ? explicit : null;
        if (this.smtp.url || this.smtp.host) return 'smtp';
        if (this.resend.apiKey) return 'resend';
        return null;
    },

    /** Why mail is off, or null when it is on (shown to the operator). */
    get disabledReason() {
        if (this.provider && !PROVIDERS.includes(this.provider)) {
            return `Unknown mail provider "${this.provider}" (choose ${PROVIDERS.join(' or ')}).`;
        }
        const provider = this.resolvedProvider;
        if (!provider) return 'No mail provider is configured.';
        if (!this.from) return 'GOOBSTER_MAIL_FROM (mail.from) is not set.';
        if (provider === 'smtp' && !this.smtp.url && !this.smtp.host) return 'SMTP host or URL is not set.';
        if (provider === 'resend' && !this.resend.apiKey) return 'RESEND_API_KEY is not set.';
        return null;
    },

    get enabled() {
        return this.disabledReason === null;
    }
};

module.exports = config;
