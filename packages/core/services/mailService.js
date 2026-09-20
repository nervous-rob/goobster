/**
 * Outbound mail (shared-instance Increment B.1).
 *
 * A thin seam over one configured provider - SMTP through nodemailer, or
 * Resend's HTTP API - used for email verification, self-service password
 * recovery, and the operator's test message. Like every other integration
 * it is optional: with nothing configured `enabled` is false and callers
 * fall back (the operator's audited reset link; invitations instead of open
 * sign-up).
 *
 * Messages are plain text. Recipient addresses and bodies are never logged;
 * failures log the provider's status and message only.
 */

const axios = require('axios');
const mailConfig = require('../config/mailConfig');

const RESEND_API = 'https://api.resend.com/emails';

// Practical envelope check: one @, no whitespace, a dot in the domain, and
// a sane length (RFC 5321 caps the whole address at 254 octets).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class MailError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'MailError';
        this.status = status;
        this.code = code;
    }
}

/**
 * Lower-case, trimmed form used for uniqueness and lookups. Local parts
 * are case-insensitive in practice everywhere that matters; we do not
 * strip dots or plus-tags, so those remain distinct addresses.
 * @param {string} raw
 * @returns {string|null} null when the address is not usable
 */
function normalizeEmail(raw) {
    const value = String(raw ?? '').trim();
    if (!value || value.length > 254 || !EMAIL_RE.test(value)) return null;
    return value.toLowerCase();
}

function smtpTransport(config) {
    const nodemailer = require('nodemailer');
    if (config.smtp.url) {
        return nodemailer.createTransport(config.smtp.url, { connectionTimeout: config.timeoutMs });
    }
    return nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
        connectionTimeout: config.timeoutMs,
        greetingTimeout: config.timeoutMs,
        socketTimeout: config.timeoutMs
    });
}

class MailService {
    constructor({ config = mailConfig, logger = console, post = axios.post, createSmtp = smtpTransport } = {}) {
        this.config = config;
        this.logger = logger;
        this._post = post;
        this._createSmtp = createSmtp;
        this._smtp = null;
        this._override = null;
    }

    get enabled() {
        return this._override ? true : this.config.enabled;
    }

    /** The provider in use, or null when mail is off. */
    get provider() {
        if (this._override) return 'custom';
        return this.config.enabled ? this.config.resolvedProvider : null;
    }

    /** What the host panel shows. No credentials. */
    describe() {
        return {
            enabled: this.enabled,
            provider: this.provider,
            from: this.enabled ? (this._override ? 'custom transport' : this.config.from) : null,
            reason: this.enabled ? null : this.config.disabledReason
        };
    }

    /**
     * Replace the transport (tests, or an embedding app with its own mailer).
     * `fn({ to, subject, text, from, replyTo })` resolves when accepted.
     * Pass null to return to the configured provider.
     * @param {Function|null} fn
     */
    setTransport(fn) {
        this._override = typeof fn === 'function' ? fn : null;
    }

    /**
     * Send one plain-text message. Throws MailError when mail is off or
     * the provider refuses; never throws for a bad address silently.
     * @param {{ to: string, subject: string, text: string }} message
     */
    async send({ to, subject, text }) {
        const recipient = normalizeEmail(to) ? String(to).trim() : null;
        if (!recipient) throw new MailError(400, 'BAD_EMAIL', 'That does not look like an email address.');
        if (!this.enabled) throw new MailError(503, 'MAIL_DISABLED', 'Outbound mail is not configured on this installation.');
        const message = {
            to: recipient,
            subject: String(subject || '').slice(0, 200),
            text: String(text || ''),
            from: this.config.from,
            replyTo: this.config.replyTo || undefined
        };
        try {
            if (this._override) {
                await this._override(message);
            } else if (this.provider === 'resend') {
                await this._sendResend(message);
            } else {
                await this._sendSmtp(message);
            }
        } catch (error) {
            if (error instanceof MailError) throw error;
            const status = error?.response?.status;
            const detail = error?.response?.data?.message || error?.message || String(error);
            this.logger.warn?.(`[mail] ${this.provider} send failed${status ? ` (${status})` : ''}: ${detail}`);
            throw new MailError(502, 'MAIL_FAILED', 'The mail provider did not accept the message.');
        }
    }

    async _sendSmtp(message) {
        if (!this._smtp) this._smtp = this._createSmtp(this.config);
        await this._smtp.sendMail({
            from: message.from,
            to: message.to,
            subject: message.subject,
            text: message.text,
            replyTo: message.replyTo
        });
    }

    async _sendResend(message) {
        await this._post(RESEND_API, {
            from: message.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.replyTo ? { reply_to: message.replyTo } : {})
        }, {
            headers: { Authorization: `Bearer ${this.config.resend.apiKey}`, 'Content-Type': 'application/json' },
            timeout: this.config.timeoutMs
        });
    }
}

module.exports = new MailService();
module.exports.MailService = MailService;
module.exports.MailError = MailError;
module.exports.normalizeEmail = normalizeEmail;
