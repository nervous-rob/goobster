/**
 * Descriptor text for the delivery adapters. Names only: env var names,
 * config.json paths and documentation paths. No values, no defaults that
 * could hold a secret. Ownership, dependencies and fresh defaults come from
 * ../inventory.js and are merged in by ../catalog.js.
 */
module.exports = {
    discord: {
        title: 'Discord',
        summary: 'The Discord gateway adapter: slash commands, message routing, voice channels and DM delivery. The portal, schedulers and the Inbox keep working with it switched off.',
        legacy: {
            kind: 'derived',
            semantics: 'tri-state-or-token',
            note: 'GOOBSTER_DISCORD_ENABLED / discord.enabled when set (env first); otherwise on when config.json has a non-empty token (config/discordConfig.js).'
        },
        apiKeys: [],
        configKeys: ['token', 'clientId', 'guildIds', 'discord.enabled'],
        docs: ['documentation/discord_setup.md', 'documentation/independent_runtime.md'],
        helpUrl: 'https://discord.com/developers/applications'
    },
    push: {
        title: 'Web Push',
        summary: 'Browser push notifications for the portal PWA. A VAPID key pair is generated and kept under data/ when none is configured.',
        legacy: {
            kind: 'derived',
            semantics: 'tri-state-keys',
            note: 'GOOBSTER_WEB_PUSH_ENABLED / webapp.push.enabled (default on); off when only one half of the VAPID pair is set (config/pushConfig.js).'
        },
        apiKeys: [
            {
                name: 'GOOBSTER_VAPID_PUBLIC_KEY',
                configPath: 'webapp.push.vapidPublicKey',
                purpose: 'Public half of the VAPID key pair; generated automatically when absent.',
                required: false
            },
            {
                name: 'GOOBSTER_VAPID_PRIVATE_KEY',
                configPath: 'webapp.push.vapidPrivateKey',
                purpose: 'Private half of the VAPID key pair; must be set together with the public key.',
                required: false
            },
            {
                name: 'GOOBSTER_VAPID_SUBJECT',
                configPath: 'webapp.push.subject',
                purpose: 'Contact for push services: a mailto: address or an https URL.',
                required: false
            }
        ],
        configKeys: ['webapp.push.enabled', 'webapp.publicUrl'],
        docs: ['documentation/pwa.md']
    },
    mail: {
        title: 'Mail',
        summary: 'Outbound transactional mail (SMTP or Resend) for verified recovery addresses and open registration. Optional: the operator recovery link never needs it.',
        legacy: {
            kind: 'derived',
            semantics: 'provider-credentials',
            note: 'There is no mail.enabled switch: on when a provider (smtp, then resend) has credentials and a from address (config/mailConfig.js).'
        },
        apiKeys: [
            {
                name: 'GOOBSTER_MAIL_PROVIDER',
                configPath: 'mail.provider',
                purpose: 'smtp or resend; empty picks the first provider with credentials.',
                required: false
            },
            {
                name: 'GOOBSTER_MAIL_FROM',
                configPath: 'mail.from',
                purpose: 'Sender address, for example "Goobster <goobster@example.org>".',
                required: false
            },
            {
                name: 'GOOBSTER_SMTP_URL',
                configPath: 'mail.smtp.url',
                purpose: 'smtp:// or smtps:// URL; wins over the discrete SMTP fields.',
                required: false
            },
            {
                name: 'GOOBSTER_SMTP_HOST',
                configPath: 'mail.smtp.host',
                purpose: 'SMTP server host (with GOOBSTER_SMTP_PORT, GOOBSTER_SMTP_USER and GOOBSTER_SMTP_PASS).',
                required: false
            },
            {
                name: 'GOOBSTER_SMTP_USER',
                configPath: 'mail.smtp.user',
                purpose: 'SMTP account name.',
                required: false
            },
            {
                name: 'GOOBSTER_SMTP_PASS',
                configPath: 'mail.smtp.pass',
                purpose: 'SMTP account password.',
                required: false
            },
            {
                name: 'RESEND_API_KEY',
                configPath: 'mail.resend.apiKey',
                purpose: 'Resend HTTP API key, for hosts whose network blocks outbound SMTP.',
                required: false
            }
        ],
        configKeys: ['mail.provider', 'mail.from', 'mail.replyTo', 'mail.smtp.port', 'mail.smtp.secure'],
        docs: ['documentation/identity.md']
    }
};
