/** Descriptor text for the developer integrations and the opt-in companion features. See adapters.js for the rules. */
module.exports = {
    github: {
        title: 'GitHub',
        summary: 'Repository reads, issue and PR summaries, repo watches, the webhook receiver and issue capture. Public-repo reads work without a token.',
        legacy: {
            kind: 'presence',
            semantics: 'presence',
            note: 'No enabled flag: a token or webhook secret only raises limits and mounts the receiver; /github and the chat tools exist without them (config/integrationsConfig.js).'
        },
        apiKeys: [
            {
                name: 'GITHUB_TOKEN',
                configPath: 'github.token',
                purpose: 'Fine-grained personal access token: higher rate limit, code search and private repositories.',
                obtainUrl: 'https://github.com/settings/personal-access-tokens',
                required: false
            },
            {
                name: 'GITHUB_WEBHOOK_SECRET',
                configPath: 'github.webhookSecret',
                purpose: 'HMAC secret shared with the repository webhook; setting it enables the receiver.',
                required: false
            }
        ],
        configKeys: ['github.agentLabel'],
        docs: ['documentation/github_cursor_integration.md']
    },
    cursor: {
        title: 'Cursor agents',
        summary: 'Launch and track Cursor cloud agents, including mission-control threads. Depends on GitHub.',
        legacy: {
            kind: 'presence',
            semantics: 'presence',
            note: 'No enabled flag: the feature is always requested and cursorAgentService.isConfigured reports a missing API key (reported as a warning, never a gate); the webhook secret only mounts the receiver (config/integrationsConfig.js).'
        },
        apiKeys: [
            {
                name: 'CURSOR_API_KEY',
                configPath: 'cursor.apiKey',
                purpose: 'Cursor user or service-account API key used to launch and poll agents.',
                obtainUrl: 'https://cursor.com/dashboard/api',
                required: true
            },
            {
                name: 'CURSOR_WEBHOOK_SECRET',
                configPath: 'cursor.webhookSecret',
                purpose: 'HMAC secret for the Cursor status webhook; setting it enables the receiver.',
                required: false
            }
        ],
        configKeys: ['cursor.model', 'cursor.pollIntervalMs'],
        docs: ['documentation/github_cursor_integration.md'],
        helpUrl: 'https://cursor.com/docs/cloud-agent'
    },
    screenVision: {
        title: 'Screen Vision',
        summary: 'The companion page and WebSocket that let Goobster see a shared screen.',
        legacy: {
            kind: 'flag',
            semantics: 'strict-true',
            note: 'screenVision.enabled === true, default off; no env variable (services/screenVisionService.js isEnabled).'
        },
        apiKeys: [],
        configKeys: ['screenVision.enabled', 'screenVision.publicUrl', 'screenVision.releasesUrl'],
        docs: ['documentation/screen_vision_setup.md']
    },
    gba: {
        title: 'GBA',
        summary: 'The Game Boy Advance harness (/gbarun, gba-mcp pairing and audience advice). The emulator runs on a separate machine.',
        legacy: {
            kind: 'flag',
            semantics: 'strict-true',
            note: 'gbaRun.enabled === true, default off and absent from config.example.json; no env variable (services/gbaRunService.js).'
        },
        apiKeys: [],
        configKeys: ['gbaRun.enabled'],
        docs: ['documentation/goobster_plays_pokemon.md']
    },
    discordActivity: {
        title: 'Discord Activity',
        summary: 'The Discord Embedded Activity transport. Depends on the Discord adapter.',
        legacy: {
            kind: 'flag',
            semantics: 'strict-true',
            note: 'activity.enabled === true, default off; no env variable (apps/bot/web/server.js).'
        },
        apiKeys: [
            {
                name: 'DISCORD_CLIENT_SECRET',
                configPath: 'activity.clientSecret',
                purpose: 'Discord OAuth client secret, shared with portal sign-in.',
                obtainUrl: 'https://discord.com/developers/applications',
                required: false
            }
        ],
        configKeys: ['activity.enabled', 'activity.devMode'],
        docs: ['documentation/activity_setup.md']
    }
};
