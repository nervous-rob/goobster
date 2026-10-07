/**
 * The field catalog: every installation setting described once.
 *
 * A descriptor says what a setting is (type, validation, default), where it
 * may come from and in what order, whether it is a secret, which feature
 * needs it, whether a change is hot or needs a restart, and where the
 * operator reads about it. The manager's effective-settings report, the
 * `config.set` operation, the provider probes, the instance-defaults
 * operation and the generated reference (documentation/config_reference.md)
 * all read this file; none of them keeps a copy.
 *
 * The runtime modules (config/aiConfig.js and friends) stay what actually
 * resolves a value at run time. `runtime` points at the export that mirrors
 * a field, and tests/configFieldCatalog.test.js pins `default` to what that
 * export resolves with an empty environment and an empty config.json, so
 * the two cannot drift.
 *
 * Pure: requires only the schema constants and a format check; reads no
 * environment, file or database. Core code, never an app.
 *
 * Out of scope here: per-account keys (#269) - every field is an
 * installation setting - and `GOOBSTER_FEATURE_<ID>` overrides, which belong
 * to the feature state (documentation/feature_state.md).
 *
 * Descriptor shape:
 *   id          dotted path in config.json (or `defaults.*` for database-only fields)
 *   type        'secret'|'string'|'enum'|'integer'|'number'|'boolean'|'url'|'duration'|'list'
 *   env         environment variable names, highest precedence first
 *   configPath  config.json path when it differs from `id` (legacy flat keys)
 *   legacyConfigPaths  older config.json paths still read at run time
 *   dbOverride  { store, key, field, wins } - a value kept in instance_state
 *   sources     subset of ['env', 'config', 'db'] the runtime reads
 *   default     what the runtime resolves with nothing set
 *   validate    { enum?, min?, max?, pattern?, custom?, allowEmpty? }
 *   secret      the value is never reported, journaled or audited
 *   feature     the feature that needs it ('core' or a feature id)
 *   alsoFeatures  further features that list the same setting
 *   apply       'hot' (read per request) | 'restart' (read at process start)
 *   help        repo-relative doc (with an optional #anchor) or an https URL
 *   section     grouping in the report
 *   runtime     'config/<module>#<export path>' pinned to `default` by tests
 *   boolEnv     how an environment string reads as a boolean ('off-words' | 'on-words')
 */

const schema = require('./userSettingsSchema');

const SECTIONS = Object.freeze([
    { id: 'discord', title: 'Discord' },
    { id: 'ai.providers', title: 'AI providers' },
    { id: 'ai.models', title: 'AI models' },
    { id: 'ai.memory', title: 'Long-term memory' },
    { id: 'ollama', title: 'Local Ollama' },
    { id: 'search', title: 'Web search' },
    { id: 'voice', title: 'Voice and music generation' },
    { id: 'music', title: 'Music downloads' },
    { id: 'integrations', title: 'GitHub and Cursor' },
    { id: 'identity', title: 'Identity and sign-in' },
    { id: 'mail', title: 'Outbound mail' },
    { id: 'webapp', title: 'Web portal' },
    { id: 'push', title: 'Web Push' },
    { id: 'activity', title: 'Discord Activity' },
    { id: 'screenVision', title: 'Screen Vision' },
    { id: 'mcp', title: 'MCP server' },
    { id: 'sandbox', title: 'Code sandbox' },
    { id: 'projects', title: 'Projects and Observatory' },
    { id: 'selfDocs', title: 'Self-knowledge' },
    { id: 'spitball', title: 'Spitball expeditions' },
    { id: 'manager', title: 'Installation manager' },
    { id: 'limits', title: 'Host usage limits (enforced policy)' },
    { id: 'defaults', title: 'Instance defaults (fallbacks, not policy)' },
    { id: 'general', title: 'General' }
]);

const CONFIG_DOC = 'documentation/configuration.md';
const URL_OPENAI = 'https://platform.openai.com/api-keys';
const URL_ANTHROPIC = 'https://console.anthropic.com/settings/keys';
const URL_GEMINI = 'https://aistudio.google.com/app/apikey';
const URL_PERPLEXITY = 'https://www.perplexity.ai/settings/api';
const URL_ELEVENLABS = 'https://elevenlabs.io/app/settings/api-keys';
const URL_GITHUB = 'https://github.com/settings/personal-access-tokens';
const URL_CURSOR = 'https://cursor.com/dashboard/api';
const URL_SPOTIFY = 'https://developer.spotify.com/dashboard';
const URL_DISCORD = 'https://discord.com/developers/applications';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

const DEFAULT_FIELD = Object.freeze({
    type: 'string',
    env: [],
    configPath: null,
    legacyConfigPaths: [],
    dbOverride: null,
    sources: ['env', 'config'],
    default: null,
    validate: {},
    secret: false,
    feature: 'core',
    alsoFeatures: [],
    apply: 'restart',
    help: CONFIG_DOC,
    section: 'general',
    description: '',
    runtime: null,
    boolEnv: 'off-words'
});

const fields = [];

function define(id, type, options = {}) {
    const field = {
        ...DEFAULT_FIELD,
        ...options,
        id,
        type,
        secret: type === 'secret',
        env: options.env || [],
        legacyConfigPaths: options.legacyConfigPaths || [],
        alsoFeatures: options.alsoFeatures || [],
        validate: options.validate || {},
        sources: options.sources || (options.dbOverride ? ['env', 'config', 'db'] : ['env', 'config'])
    };
    if (type === 'secret') field.default = null;
    fields.push(field);
    return field;
}

function group(base, entries) {
    for (const [id, type, options] of entries) define(id, type, { ...base, ...options });
}

// --- Discord ---------------------------------------------------------------
group({ section: 'discord', feature: 'discord', help: 'documentation/discord_setup.md', sources: ['config'] }, [
    ['discord.token', 'secret', { configPath: 'token', description: 'Discord bot token. Read from config.json only, never from the environment.', help: URL_DISCORD, validate: { custom: 'discordToken' } }],
    ['discord.clientId', 'string', { configPath: 'clientId', description: 'Discord application (client) id.', help: URL_DISCORD, validate: { pattern: '^\\d{5,25}$' } }],
    ['discord.guildIds', 'list', { configPath: 'guildIds', default: [], description: 'Server ids the slash commands are deployed to.', validate: { custom: 'snowflakeList' } }]
]);
define('discord.enabled', 'boolean', {
    section: 'discord',
    feature: 'discord',
    env: ['GOOBSTER_DISCORD_ENABLED'],
    runtime: 'config/discordConfig#explicit',
    default: null,
    description: 'Explicit Discord adapter switch; unset means "on when a bot token is configured".',
    help: 'documentation/independent_runtime.md'
});

// --- AI providers ------------------------------------------------------------
group({ section: 'ai.providers', help: CONFIG_DOC + '#required-credentials' }, [
    ['ai.provider', 'enum', {
        env: ['AI_PROVIDER'],
        runtime: 'config/aiConfig#provider',
        validate: { enum: ['openai', 'anthropic', 'gemini', 'ollama'], allowEmpty: true },
        description: 'Which AI provider answers; unset auto-detects (OpenAI, Anthropic, Gemini, then Ollama).'
    }],
    ['ai.openai.apiKey', 'secret', { env: ['OPENAI_API_KEY'], configPath: 'openaiKey', help: URL_OPENAI, description: 'OpenAI API key.' }],
    ['ai.anthropic.apiKey', 'secret', { env: ['ANTHROPIC_API_KEY'], configPath: 'anthropicKey', help: URL_ANTHROPIC, description: 'Anthropic API key.' }],
    ['ai.gemini.apiKey', 'secret', { env: ['GEMINI_API_KEY'], configPath: 'googleAIKey', help: URL_GEMINI, description: 'Google Gemini API key.' }]
]);

// --- AI models (every default is pinned to config/aiConfig.js by the tests) --
group({ section: 'ai.models', help: 'documentation/adr/0011-model-registry.md', validate: { pattern: MODEL_ID.source } }, [
    ['ai.openai.chatModel', 'string', { env: ['OPENAI_CHAT_MODEL'], runtime: 'config/aiConfig#openai.chatModel', default: 'gpt-5.6-terra', description: 'OpenAI model for ordinary chat turns.' }],
    ['ai.openai.thoughtfulModel', 'string', { env: ['OPENAI_THOUGHTFUL_MODEL'], runtime: 'config/aiConfig#openai.thoughtfulModel', default: 'gpt-5.6-sol', description: 'OpenAI model for Thoughtful Mode.' }],
    ['ai.openai.imageModel', 'string', { env: ['OPENAI_IMAGE_MODEL'], runtime: 'config/aiConfig#openai.imageModel', default: 'gpt-image-2', description: 'OpenAI image generation model.' }],
    ['ai.openai.embeddingModel', 'string', { env: ['OPENAI_EMBEDDING_MODEL'], runtime: 'config/aiConfig#openai.embeddingModel', default: 'text-embedding-3-small', description: 'OpenAI embedding model for memory and documentation search.' }],
    ['ai.openai.transcriptionModel', 'string', { env: ['OPENAI_TRANSCRIPTION_MODEL'], runtime: 'config/aiConfig#openai.transcriptionModel', default: 'gpt-4o-mini-transcribe', description: 'OpenAI speech-to-text model.' }],
    ['ai.anthropic.chatModel', 'string', { env: ['ANTHROPIC_CHAT_MODEL', 'ANTHROPIC_MODEL'], runtime: 'config/aiConfig#anthropic.chatModel', default: 'claude-sonnet-5', description: 'Anthropic model for ordinary chat turns.' }],
    ['ai.anthropic.thoughtfulModel', 'string', { env: ['ANTHROPIC_THOUGHTFUL_MODEL'], runtime: 'config/aiConfig#anthropic.thoughtfulModel', default: 'claude-fable-5', description: 'Anthropic model for Thoughtful Mode.' }],
    ['ai.anthropic.promptCaching', 'boolean', { env: ['ANTHROPIC_PROMPT_CACHING'], runtime: 'config/aiConfig#anthropic.promptCaching', default: true, help: 'documentation/anthropic_prompt_caching.md', description: 'Use Anthropic prompt caching.' }],
    ['ai.gemini.chatModel', 'string', { env: ['GEMINI_CHAT_MODEL', 'GEMINI_MODEL'], legacyConfigPaths: ['ai.gemini.model'], runtime: 'config/aiConfig#gemini.chatModel', default: 'gemini-3.5-flash', description: 'Gemini model for ordinary chat turns.' }],
    ['ai.gemini.thoughtfulModel', 'string', { env: ['GEMINI_THOUGHTFUL_MODEL'], runtime: 'config/aiConfig#gemini.thoughtfulModel', default: 'gemini-3.1-pro-preview', description: 'Gemini model for Thoughtful Mode.' }]
]);

// --- Memory -------------------------------------------------------------------
group({ section: 'ai.memory', help: 'documentation/knowledge_and_memory.md' }, [
    ['ai.memory.enabled', 'boolean', { env: ['MEMORY_ENABLED'], runtime: 'config/aiConfig#memory.enabled', default: true, description: 'Long-term semantic memory.' }],
    ['ai.memory.maxEntriesPerGuild', 'integer', { env: ['MEMORY_MAX_ENTRIES'], runtime: 'config/aiConfig#memory.maxEntriesPerGuild', default: 5000, validate: { min: 1, max: 10_000_000 }, description: 'Memories kept per server or DM scope.' }],
    ['ai.memory.recallLimit', 'integer', { env: ['MEMORY_RECALL_LIMIT'], runtime: 'config/aiConfig#memory.recallLimit', default: 5, validate: { min: 1, max: 100 }, description: 'Memories recalled into one turn.' }],
    ['ai.memory.minSimilarity', 'number', { env: ['MEMORY_MIN_SIMILARITY'], runtime: 'config/aiConfig#memory.minSimilarity', default: 0.3, validate: { min: 0, max: 1 }, description: 'Smallest similarity a memory needs to be recalled.' }]
]);

// --- Ollama -------------------------------------------------------------------
group({ section: 'ollama', help: 'documentation/raspberry_pi_guide.md' }, [
    ['ollama.host', 'url', { env: ['OLLAMA_HOST'], runtime: 'config/aiConfig#ollama.host', default: 'http://127.0.0.1:11434', validate: { custom: 'httpUrl' }, description: 'Local Ollama server; also the only destination an Ollama probe contacts.' }],
    ['ollama.model', 'string', { env: ['OLLAMA_MODEL'], runtime: 'config/aiConfig#ollama.model', default: 'llama3.2:3b', validate: { pattern: MODEL_ID.source }, description: 'Ollama chat model.' }],
    ['ollama.embeddingModel', 'string', { env: ['OLLAMA_EMBEDDING_MODEL'], runtime: 'config/aiConfig#ollama.embeddingModel', default: 'nomic-embed-text', validate: { pattern: MODEL_ID.source }, description: 'Ollama embedding model.' }]
]);

// --- Search, voice, music ---------------------------------------------------
define('perplexity.apiKey', 'secret', {
    section: 'search', feature: 'expeditions', env: ['PERPLEXITY_API_KEY'], help: URL_PERPLEXITY,
    description: 'Perplexity API key for web search and Spitball research.'
});
define('perplexity.model', 'string', {
    section: 'search', feature: 'expeditions', env: ['PERPLEXITY_MODEL'], runtime: 'config/aiConfig#perplexity.model',
    default: 'sonar-pro', validate: { pattern: MODEL_ID.source }, description: 'Perplexity model.'
});
group({ section: 'voice', feature: 'voice', alsoFeatures: [] }, [
    ['elevenlabs.apiKey', 'secret', { env: ['ELEVENLABS_API_KEY'], alsoFeatures: ['music'], help: URL_ELEVENLABS, validate: { custom: 'elevenlabsKey' }, description: 'ElevenLabs key for speech, music and sound-effect generation.' }],
    ['elevenlabs.voiceId', 'string', { env: ['ELEVENLABS_VOICE_ID'], default: '21m00Tcm4TlvDq8ikWAM', validate: { pattern: '^[A-Za-z0-9]{8,64}$' }, help: 'documentation/voice_commands.md', description: 'Default voice for servers that have not chosen one.' }],
    ['elevenlabs.modelId', 'string', { env: ['ELEVENLABS_MODEL_ID'], default: 'eleven_flash_v2_5', validate: { pattern: MODEL_ID.source }, help: 'documentation/voice_commands.md', description: 'ElevenLabs text-to-speech model.' }]
]);
group({ section: 'music', feature: 'music', help: 'documentation/music_system.md' }, [
    ['spotify.clientId', 'string', { env: ['SPOTIFY_CLIENT_ID'], help: URL_SPOTIFY, description: 'Spotify application id for spotdl downloads (needs the secret too).' }],
    ['spotify.clientSecret', 'secret', { env: ['SPOTIFY_CLIENT_SECRET'], help: URL_SPOTIFY, description: 'Spotify application secret for spotdl downloads.' }],
    ['spotdl.path', 'string', { sources: ['config'], description: 'Path to the spotdl executable; empty auto-discovers it.' }],
    ['spotdl.batchSize', 'integer', { sources: ['config'], default: 15, validate: { min: 1, max: 100 }, description: 'Tracks per spotdl batch.' }],
    ['spotdl.threads', 'integer', { sources: ['config'], default: 2, validate: { min: 1, max: 16 }, description: 'spotdl download threads.' }],
    ['spotdl.audioProviders', 'list', { sources: ['config'], default: [], description: 'Audio providers spotdl may use, in order; empty keeps the spotdl default.' }],
    ['ytdlp.path', 'string', { sources: ['config'], description: 'Path to the yt-dlp executable; empty auto-discovers it.' }]
]);

// --- GitHub and Cursor --------------------------------------------------------
group({ section: 'integrations', help: 'documentation/github_cursor_integration.md' }, [
    ['github.token', 'secret', { feature: 'github', env: ['GITHUB_TOKEN'], help: URL_GITHUB, description: 'Fine-grained GitHub token: higher rate limit, code search and private repositories.' }],
    ['github.webhookSecret', 'secret', { feature: 'github', env: ['GITHUB_WEBHOOK_SECRET'], description: 'HMAC secret shared with the repository webhook; setting it enables the receiver.' }],
    ['github.agentLabel', 'string', { feature: 'github', env: ['GITHUB_AGENT_LABEL'], runtime: 'config/integrationsConfig#github.agentLabel', default: 'goobster-fix', validate: { pattern: '^[\\w .:/-]{1,50}$' }, description: 'Issue label that proposes a Cursor agent launch.' }],
    ['cursor.apiKey', 'secret', { feature: 'cursor', env: ['CURSOR_API_KEY'], help: URL_CURSOR, description: 'Cursor API key used to launch and poll agents.' }],
    ['cursor.model', 'string', { feature: 'cursor', env: ['CURSOR_AGENT_MODEL'], runtime: 'config/integrationsConfig#cursor.defaultModel', default: 'claude-opus-4-8', validate: { pattern: '^[A-Za-z0-9][A-Za-z0-9._: /-]{0,99}$', allowEmpty: true }, description: 'Default model for launched Cursor agents; empty means the account default.' }],
    ['cursor.webhookSecret', 'secret', { feature: 'cursor', env: ['CURSOR_WEBHOOK_SECRET'], description: 'HMAC secret for the Cursor status webhook; setting it enables the receiver.' }],
    ['cursor.pollIntervalMs', 'duration', { feature: 'cursor', env: ['CURSOR_POLL_INTERVAL_MS'], runtime: 'config/integrationsConfig#cursor.pollIntervalMs', default: 60000, validate: { min: 5000, max: 3_600_000 }, description: 'How often active Cursor runs are polled, in milliseconds.' }]
]);

// --- Identity -----------------------------------------------------------------
group({ section: 'identity', help: 'documentation/identity.md' }, [
    ['identity.installationId', 'string', { env: ['GOOBSTER_INSTALLATION_ID'], runtime: 'config/identityConfig#installationId', default: 'local', validate: { pattern: '^[A-Za-z0-9._-]{1,64}$' }, description: 'Stable label for this installation, carried on every actor context.' }],
    ['identity.installationName', 'string', { env: ['GOOBSTER_INSTALLATION_NAME'], runtime: 'config/identityConfig#installationName', default: 'Goobster', validate: { pattern: '^.{1,64}$' }, description: 'Human name of this installation on invitations and the login screen.' }],
    ['identity.assistantName', 'string', { env: ['GOOBSTER_ASSISTANT_NAME'], runtime: 'config/identityConfig#assistantName', default: 'Goobster', validate: { pattern: '^.{1,32}$' }, description: "The assistant's own name on every surface." }],
    ['identity.requireAccount', 'boolean', { env: ['GOOBSTER_IDENTITY_REQUIRE_ACCOUNT'], runtime: 'config/identityConfig#requireAccount', default: false, help: 'documentation/identity.md#the-requireaccount-release-gate', description: 'Require an active account for every web session.' }],
    ['identity.nativeLogin', 'boolean', { env: ['GOOBSTER_IDENTITY_NATIVE_LOGIN'], runtime: 'config/identityConfig#nativeLogin', default: false, description: 'Username and password sign-in, invitations and recovery.' }],
    ['identity.registration', 'enum', { env: ['GOOBSTER_IDENTITY_REGISTRATION'], runtime: 'config/identityConfig#registration', default: 'invite', validate: { enum: ['invite', 'open'] }, help: 'documentation/identity.md#open-sign-up', description: "Who may create an account: 'invite' or 'open' (open needs outbound mail)." }],
    ['identity.operators', 'list', { env: ['GOOBSTER_IDENTITY_OPERATORS'], runtime: 'config/identityConfig#operators', default: [], validate: { custom: 'snowflakeList' }, description: 'Discord user ids bootstrapped into the operator role.' }],
    ['identity.passwordMinLength', 'integer', { env: ['GOOBSTER_IDENTITY_PASSWORD_MIN_LENGTH'], runtime: 'config/identityConfig#passwordMinLength', default: 15, validate: { min: 12, max: 128 }, description: 'Minimum password length.' }],
    ['identity.passwordCostLog2', 'integer', { env: ['GOOBSTER_IDENTITY_PASSWORD_COST'], runtime: 'config/identityConfig#passwordCostLog2', default: 15, validate: { min: 14, max: 18 }, description: 'scrypt cost as log2(N).' }],
    ['identity.recentAuthMinutes', 'integer', { env: ['GOOBSTER_IDENTITY_RECENT_AUTH_MINUTES'], runtime: 'config/identityConfig#recentAuthMinutes', default: 15, validate: { min: 1, max: 1440 }, description: 'How long a sign-in counts as recent for sensitive changes.' }],
    ['identity.inviteTtlHours', 'integer', { env: ['GOOBSTER_IDENTITY_INVITE_TTL_HOURS'], runtime: 'config/identityConfig#inviteTtlHours', default: 72, validate: { min: 1, max: 720 }, description: 'Default lifetime of an invitation link, in hours.' }],
    ['identity.recoveryTtlMinutes', 'integer', { env: ['GOOBSTER_IDENTITY_RECOVERY_TTL_MINUTES'], runtime: 'config/identityConfig#recoveryTtlMinutes', default: 60, validate: { min: 5, max: 1440 }, description: 'Lifetime of a password reset link, in minutes.' }],
    ['identity.emailVerifyTtlMinutes', 'integer', { env: ['GOOBSTER_IDENTITY_EMAIL_VERIFY_TTL_MINUTES'], runtime: 'config/identityConfig#emailVerifyTtlMinutes', default: 1440, validate: { min: 5, max: 10080 }, description: 'Lifetime of an email verification link, in minutes.' }]
]);

// --- Mail ---------------------------------------------------------------------
group({ section: 'mail', feature: 'mail', help: 'documentation/identity.md#email-increment-b1' }, [
    ['mail.provider', 'enum', { env: ['GOOBSTER_MAIL_PROVIDER'], runtime: 'config/mailConfig#provider', default: null, validate: { enum: ['smtp', 'resend'], allowEmpty: true }, description: 'Mail provider; unset picks the first provider with credentials.' }],
    ['mail.from', 'string', { env: ['GOOBSTER_MAIL_FROM'], runtime: 'config/mailConfig#from', validate: { pattern: '^[^\\r\\n]{3,200}$' }, description: 'Sender address, e.g. "Goobster <goobster@example.org>". Required for mail.' }],
    ['mail.replyTo', 'string', { env: ['GOOBSTER_MAIL_REPLY_TO'], runtime: 'config/mailConfig#replyTo', validate: { pattern: '^[^\\r\\n]{3,200}$' }, description: 'Optional Reply-To address.' }],
    ['mail.smtp.url', 'secret', { env: ['GOOBSTER_SMTP_URL'], validate: { custom: 'smtpUrl' }, description: 'smtp(s)://user:pass@host:port; carries a password, so it is treated as a secret. Wins over the discrete fields.' }],
    ['mail.smtp.host', 'string', { env: ['GOOBSTER_SMTP_HOST'], runtime: 'config/mailConfig#smtp.host', validate: { pattern: '^[A-Za-z0-9.-]{1,253}$' }, description: 'SMTP host; the only destination a mail probe contacts.' }],
    ['mail.smtp.port', 'integer', { env: ['GOOBSTER_SMTP_PORT'], runtime: 'config/mailConfig#smtp.port', default: 587, validate: { min: 1, max: 65535 }, description: 'SMTP port.' }],
    ['mail.smtp.secure', 'boolean', { env: ['GOOBSTER_SMTP_SECURE'], runtime: 'config/mailConfig#smtp.secure', default: false, description: 'Implicit TLS (port 465); STARTTLS is negotiated on 587 regardless.' }],
    ['mail.smtp.user', 'string', { env: ['GOOBSTER_SMTP_USER'], runtime: 'config/mailConfig#smtp.user', validate: { pattern: '^[^\\r\\n]{1,200}$' }, description: 'SMTP user name.' }],
    ['mail.smtp.pass', 'secret', { env: ['GOOBSTER_SMTP_PASS'], description: 'SMTP password.' }],
    ['mail.resend.apiKey', 'secret', { env: ['RESEND_API_KEY'], help: 'https://resend.com/api-keys', description: 'Resend API key.' }],
    ['mail.timeoutMs', 'duration', { env: ['GOOBSTER_MAIL_TIMEOUT_MS'], runtime: 'config/mailConfig#timeoutMs', default: 15000, validate: { min: 1000, max: 120000 }, description: 'Outbound mail request timeout, in milliseconds.' }]
]);

// --- Web portal, push, activity, screen vision ------------------------------
group({ section: 'webapp', help: 'documentation/webapp_setup.md', sources: ['config'] }, [
    ['webapp.enabled', 'boolean', { default: false, description: 'Serve the web portal.' }],
    ['webapp.devMode', 'boolean', { default: false, description: 'Mint a session for any snowflake without OAuth. Never on a public host.' }],
    ['webapp.publicUrl', 'url', { alsoFeatures: ['push'], validate: { custom: 'httpUrl', allowEmpty: true }, description: 'Public address of the portal (needed for OAuth, mail links and push).' }]
]);
group({ section: 'push', feature: 'push', help: 'documentation/pwa.md' }, [
    ['webapp.push.enabled', 'boolean', { env: ['GOOBSTER_WEB_PUSH_ENABLED'], default: true, description: 'Web Push notifications.' }],
    ['webapp.push.subject', 'string', { env: ['GOOBSTER_VAPID_SUBJECT'], validate: { pattern: '^(mailto:[^\\s]+|https://[^\\s]+)$', allowEmpty: true }, description: 'VAPID subject: a mailto: or https URL.' }],
    ['webapp.push.vapidPublicKey', 'string', { env: ['GOOBSTER_VAPID_PUBLIC_KEY'], validate: { pattern: '^[A-Za-z0-9_-]{20,200}$', allowEmpty: true }, description: 'VAPID public key (not a secret); empty uses the generated pair.' }],
    ['webapp.push.vapidPrivateKey', 'secret', { env: ['GOOBSTER_VAPID_PRIVATE_KEY'], description: 'VAPID private key; must be set together with the public key.' }]
]);
group({ section: 'activity', feature: 'discordActivity', help: 'documentation/activity_setup.md', sources: ['config'] }, [
    ['activity.enabled', 'boolean', { default: false, description: 'Serve the Discord Activity.' }],
    ['activity.devMode', 'boolean', { default: false, description: 'Activity development mode.' }],
    ['activity.clientSecret', 'secret', { sources: ['env', 'config'], env: ['DISCORD_CLIENT_SECRET'], legacyConfigPaths: ['webapp.clientSecret'], help: URL_DISCORD, description: 'Discord application secret shared by the portal OAuth and the Activity.' }],
    ['activity.bot.enabled', 'boolean', { default: true, description: 'The Activity bot companion.' }],
    ['activity.bot.textComments', 'boolean', { default: false, description: 'Activity bot text comments.' }],
    ['activity.bot.voiceComments', 'boolean', { default: true, description: 'Activity bot voice comments.' }],
    ['activity.bot.persona', 'string', { description: 'Activity bot persona; empty uses the default.' }]
]);
group({ section: 'screenVision', feature: 'screenVision', help: 'documentation/screen_vision_setup.md', sources: ['config'] }, [
    ['screenVision.enabled', 'boolean', { default: false, description: 'Screen Vision companion page and WebSocket.' }],
    ['screenVision.publicUrl', 'url', { validate: { custom: 'httpUrl', allowEmpty: true }, description: 'Public address of the Screen Vision companion.' }],
    ['screenVision.releasesUrl', 'url', { validate: { custom: 'httpUrl', allowEmpty: true }, description: 'Where companion releases are published.' }]
]);

// --- MCP ----------------------------------------------------------------------
group({ section: 'mcp', feature: 'mcp', help: 'documentation/mcp.md' }, [
    ['mcp.enabled', 'boolean', { env: ['GOOBSTER_MCP_ENABLED'], runtime: 'config/mcpConfig#enabled', default: false, description: 'Read-only MCP server.' }],
    ['mcp.maxTokensPerUser', 'integer', { env: ['GOOBSTER_MCP_MAX_TOKENS'], runtime: 'config/mcpConfig#maxTokensPerUser', default: 10, validate: { min: 1, max: 25 }, description: 'MCP access tokens one person may hold.' }],
    ['mcp.requestsPerMinute', 'integer', { env: ['GOOBSTER_MCP_REQUESTS_PER_MINUTE'], runtime: 'config/mcpConfig#requestsPerMinute', default: 120, validate: { min: 10, max: 600 }, description: 'MCP requests per minute.' }],
    ['mcp.defaultTokenDays', 'integer', { env: ['GOOBSTER_MCP_TOKEN_DAYS'], runtime: 'config/mcpConfig#defaultTokenDays', default: 90, validate: { min: 0, max: 365 }, description: 'Default lifetime of a new MCP token in days; 0 never expires.' }]
]);

// --- Sandbox ------------------------------------------------------------------
group({ section: 'sandbox', feature: 'sandbox', help: 'documentation/code_sandbox.md' }, [
    ['sandbox.enabled', 'boolean', { env: ['GOOBSTER_SANDBOX_ENABLED'], boolEnv: 'on-words', runtime: 'config/sandboxConfig#enabled', default: false, description: 'The runCode tool.' }],
    ['sandbox.scope', 'enum', { env: ['GOOBSTER_SANDBOX_SCOPE'], runtime: 'config/sandboxConfig#scope', default: 'web', validate: { enum: ['web', 'everywhere'] }, description: "Where the tool may run: 'web' or 'everywhere'." }],
    ['sandbox.timeoutMs', 'duration', { runtime: 'config/sandboxConfig#timeoutMs', default: 20000, validate: { min: 1000, max: 12_000_000 }, sources: ['config'], description: 'Wall-clock limit per run, in milliseconds.' }],
    ['sandbox.maxCpuSeconds', 'integer', { runtime: 'config/sandboxConfig#maxCpuSeconds', default: 20, validate: { min: 1, max: 6000 }, sources: ['config'], description: 'CPU-seconds limit per run.' }],
    ['sandbox.maxMemoryMb', 'integer', { runtime: 'config/sandboxConfig#maxMemoryMb', default: 2048, validate: { min: 64, max: 409600 }, sources: ['config'], description: 'Address-space limit per run, in MB.' }],
    ['sandbox.maxWriteMb', 'integer', { runtime: 'config/sandboxConfig#maxWriteMb', default: 256, validate: { min: 1, max: 25600 }, sources: ['config'], description: 'Largest single file a run may write, in MB.' }],
    ['sandbox.maxOutputBytes', 'integer', { runtime: 'config/sandboxConfig#maxOutputBytes', default: 65536, validate: { min: 1024, max: 104_857_600 }, sources: ['config'], description: 'stdout and stderr are each truncated to this many bytes.' }],
    ['sandbox.maxOutputFiles', 'integer', { runtime: 'config/sandboxConfig#maxOutputFiles', default: 8, validate: { min: 1, max: 2500 }, sources: ['config'], description: 'Output files collected per run.' }],
    ['sandbox.maxFileSizeBytes', 'integer', { runtime: 'config/sandboxConfig#maxFileSizeBytes', default: 8_388_608, validate: { min: 1024, max: 6_710_886_400 }, sources: ['config'], description: 'Largest collected output file, in bytes.' }],
    ['sandbox.runsPerWindow', 'integer', { env: ['GOOBSTER_SANDBOX_RUNS_PER_WINDOW'], runtime: 'config/sandboxConfig#runsPerWindow', default: 10, validate: { min: 1, max: 10000 }, description: 'Runs per person per five minutes.' }],
    ['sandbox.maxFetchRequestsPerHour', 'integer', { runtime: 'config/sandboxConfig#maxFetchRequestsPerHour', default: 10, validate: { min: 1, max: 1000 }, sources: ['config'], description: 'Package and data-fetch requests per person per hour.' }],
    ['sandbox.maxPendingRequestsPerUser', 'integer', { runtime: 'config/sandboxConfig#maxPendingRequestsPerUser', default: 5, validate: { min: 1, max: 50 }, sources: ['config'], description: 'Pending approval requests per person.' }],
    ['sandbox.maxConcurrent', 'integer', { env: ['GOOBSTER_SANDBOX_MAX_CONCURRENT'], runtime: 'config/sandboxConfig#maxConcurrent', default: 1, validate: { min: 1, max: 400 }, description: 'Concurrent runs across the installation.' }],
    ['sandbox.maxPerAccount', 'integer', { env: ['GOOBSTER_SANDBOX_MAX_PER_ACCOUNT'], runtime: 'config/sandboxConfig#maxPerAccount', default: 1, validate: { min: 1, max: 40 }, description: 'Concurrent runs per account.' }],
    ['sandbox.retentionHours', 'integer', { runtime: 'config/sandboxConfig#retentionHours', default: 24, validate: { min: 1, max: 16800 }, sources: ['config'], description: 'Hours collected output files are kept.' }],
    ['sandbox.allowNetwork', 'boolean', { runtime: 'config/sandboxConfig#allowNetwork', default: false, sources: ['config'], description: 'Network access inside the sandbox.' }],
    ['sandbox.pythonCommand', 'string', { env: ['GOOBSTER_SANDBOX_PYTHON'], runtime: 'config/sandboxConfig#pythonCommand', default: 'python3', validate: { pattern: '^[^\\r\\n]{1,300}$' }, description: 'Interpreter for python runs; empty uses the managed toolkit venv when present, else python3.' }],
    ['sandbox.pythonBundles', 'list', { env: ['GOOBSTER_SANDBOX_PYTHON_BUNDLES'], runtime: 'config/sandboxConfig#pythonBundles', default: ['core', 'astro', 'imaging'], description: 'Bundles of the curated Python toolkit to install.' }],
    ['sandbox.extraPythonPackages', 'list', { env: ['GOOBSTER_SANDBOX_PYTHON_EXTRAS'], runtime: null, default: [], description: 'Extra pip packages, each pip-name or pip-name:import_name.' }],
    ['sandbox.approverUserIds', 'list', { env: ['GOOBSTER_SANDBOX_APPROVERS'], runtime: 'config/sandboxConfig#approverUserIds', default: [], validate: { custom: 'snowflakeList' }, description: 'People who may approve package installs and off-list fetches.' }],
    ['sandbox.fetchAllowedHosts', 'list', { env: ['GOOBSTER_SANDBOX_FETCH_HOSTS'], runtime: 'config/sandboxConfig#fetchAllowedHosts', default: [], validate: { custom: 'hostnameList' }, description: 'Hosts with standing consent for data fetches.' }],
    ['sandbox.maxFetchMb', 'integer', { runtime: 'config/sandboxConfig#maxFetchMb', default: 512, validate: { min: 1, max: 4096 }, sources: ['config'], description: 'Largest single data fetch, in MB.' }],
    ['sandbox.maxOverlayMb', 'integer', { runtime: 'config/sandboxConfig#maxOverlayMb', default: 512, validate: { min: 16, max: 51200 }, sources: ['config'], description: 'Size budget for approved packages, in MB.' }],
    ['sandbox.extraBinds', 'list', { runtime: 'config/sandboxConfig#extraBinds', default: [], validate: { custom: 'absolutePathList' }, sources: ['config'], description: 'Extra read-only directories bound into bubblewrap runs.' }],
    ['sandbox.requireStrongIsolation', 'boolean', { env: ['GOOBSTER_SANDBOX_REQUIRE_STRONG_ISOLATION'], runtime: 'config/sandboxConfig#requireStrongIsolation', default: true, description: 'Fail closed unless bubblewrap can isolate the filesystem.' }]
]);

// --- Projects and Observatory -------------------------------------------------
group({ section: 'projects', help: 'documentation/observatory.md' }, [
    ['projects.enabled', 'boolean', { feature: 'projects', env: ['GOOBSTER_PROJECTS_ENABLED'], boolEnv: 'on-words', runtime: 'config/observatoryConfig#projectsEnabled', default: true, help: 'documentation/projects.md', description: 'The Projects room.' }],
    ['observatory.enabled', 'boolean', { feature: 'observatory', env: ['GOOBSTER_OBSERVATORY_ENABLED'], boolEnv: 'on-words', runtime: 'config/observatoryConfig#enabled', default: false, description: 'Observatory execution (needs the sandbox).' }],
    ['observatory.scope', 'enum', { feature: 'observatory', env: ['GOOBSTER_OBSERVATORY_SCOPE'], runtime: 'config/observatoryConfig#scope', default: 'web', validate: { enum: ['web', 'everywhere'] }, description: "Where the observatory tool may run: 'web' or 'everywhere'." }],
    ['observatory.maxProjectsPerUser', 'integer', { feature: 'observatory', runtime: 'config/observatoryConfig#maxProjectsPerUser', default: 5, validate: { min: 1, max: 200 }, sources: ['config'], description: 'Projects one person may keep.' }],
    ['observatory.maxProjectMb', 'integer', { feature: 'observatory', runtime: 'config/observatoryConfig#maxProjectMb', default: 1024, validate: { min: 1, max: 102400 }, sources: ['config'], description: 'Disk quota per project, in MB.' }],
    ['observatory.maxActiveJobsPerUser', 'integer', { feature: 'observatory', runtime: 'config/observatoryConfig#maxActiveJobsPerUser', default: 1, validate: { min: 1, max: 50 }, sources: ['config'], description: 'Background jobs one person may run at once.' }],
    ['observatory.maxResumes', 'integer', { feature: 'observatory', runtime: 'config/observatoryConfig#maxResumes', default: 12, validate: { min: 0, max: 500 }, sources: ['config'], description: 'Checkpoint resumes per job.' }],
    ['observatory.maxAssetsPerProject', 'integer', { feature: 'observatory', runtime: 'config/observatoryConfig#maxAssetsPerProject', default: 20, validate: { min: 1, max: 200 }, sources: ['config'], description: 'Named assets per project.' }],
    ['observatory.maxVersionsPerAsset', 'integer', { feature: 'observatory', runtime: 'config/observatoryConfig#maxVersionsPerAsset', default: 50, validate: { min: 1, max: 500 }, sources: ['config'], description: 'Versions kept per asset.' }],
    ['observatory.maxWorkspaceFiles', 'integer', { feature: 'observatory', runtime: 'config/observatoryConfig#maxWorkspaceFiles', default: 50, validate: { min: 1, max: 5000 }, sources: ['config'], description: 'Files listed from a project workspace per query.' }],
    ['observatory.maxRenderFrames', 'integer', { feature: 'observatory', runtime: 'config/observatoryConfig#maxRenderFrames', default: 2000, validate: { min: 2, max: 100000 }, sources: ['config'], description: 'Frames stitched into one video.' }],
    ['observatory.renderFps', 'integer', { feature: 'observatory', runtime: 'config/observatoryConfig#renderFps', default: 24, validate: { min: 1, max: 120 }, sources: ['config'], description: 'Default render framerate.' }],
    ['observatory.ffmpegCommand', 'string', { feature: 'observatory', env: ['GOOBSTER_OBSERVATORY_FFMPEG'], runtime: 'config/observatoryConfig#ffmpegCommand', default: 'ffmpeg', validate: { pattern: '^[^\\r\\n]{1,300}$' }, description: 'ffmpeg binary for the render pipeline.' }],
    ['gbaRun.enabled', 'boolean', { feature: 'gba', default: false, sources: ['config'], help: 'documentation/goobster_plays_pokemon.md', description: 'The Game Boy Advance harness.' }]
]);

// --- Self-knowledge -----------------------------------------------------------
group({ section: 'selfDocs', help: 'documentation/self_knowledge.md' }, [
    ['selfDocs.enabled', 'boolean', { env: ['GOOBSTER_SELF_DOCS_ENABLED'], runtime: 'config/selfDocsConfig#enabled', default: true, description: 'Seed the documentation and register the consultDocs tool.' }],
    ['selfDocs.seedOnStartup', 'boolean', { env: ['GOOBSTER_SELF_DOCS_SEED_ON_STARTUP'], runtime: 'config/selfDocsConfig#seedOnStartup', default: true, description: 'Re-seed the documentation at every start.' }],
    ['selfDocs.embeddings', 'boolean', { env: ['GOOBSTER_SELF_DOCS_EMBEDDINGS'], runtime: 'config/selfDocsConfig#embeddings', default: true, description: 'Compute documentation embeddings when a backend exists.' }],
    ['selfDocs.sources', 'list', { env: ['GOOBSTER_SELF_DOCS_SOURCES'], runtime: 'config/selfDocsConfig#sources', default: ['README.md', 'documentation'], description: 'Files and directories that make up the documentation corpus.' }],
    ['selfDocs.operatorDir', 'string', { env: ['GOOBSTER_SELF_DOCS_OPERATOR_DIR'], description: 'Directory of operator-authored notes; empty uses data/self-docs.' }]
]);

// --- Spitball -----------------------------------------------------------------
group({ section: 'spitball', feature: 'expeditions', help: 'documentation/spitball_expeditions.md' }, [
    ['spitball.enabled', 'boolean', { env: ['GOOBSTER_SPITBALL_ENABLED'], runtime: 'config/spitballConfig#enabled', default: true, description: 'Spitball expeditions.' }],
    ['spitball.maxActiveExpeditionsPerUser', 'integer', { runtime: 'config/spitballConfig#maxActiveExpeditionsPerUser', default: 2, validate: { min: 1, max: 20 }, sources: ['config'], description: 'Expeditions one person may have queued or running.' }]
]);

// --- Host usage limits: enforced policy, kept in instance_state -----------------
group({
    section: 'limits',
    help: 'documentation/work_ledger.md',
    apply: 'hot'
}, [
    ['limits.dailyTokens', 'integer', {
        env: ['GOOBSTER_LIMITS_DAILY_TOKENS'], runtime: 'config/limitsConfig#dailyTokens', default: null,
        validate: { min: 1, max: Number.MAX_SAFE_INTEGER, allowEmpty: true },
        dbOverride: { store: 'instance_state', key: 'limits', field: 'dailyTokens', wins: true },
        description: 'Token cap per window (unset means no cap). A host override in the database wins over this value.'
    }],
    ['limits.windowHours', 'integer', {
        env: ['GOOBSTER_LIMITS_WINDOW_HOURS'], runtime: 'config/limitsConfig#windowHours', default: 24, validate: { min: 1, max: 24 },
        dbOverride: { store: 'instance_state', key: 'limits', field: 'windowHours', wins: true },
        description: 'Length of the token window, in hours.'
    }],
    ['limits.retentionDays', 'integer', {
        env: ['GOOBSTER_LIMITS_RETENTION_DAYS'], runtime: 'config/limitsConfig#retentionDays', default: 90, validate: { min: 1, max: 3650 },
        dbOverride: { store: 'instance_state', key: 'limits', field: 'retentionDays', wins: true },
        description: 'Days usage reservations are kept.'
    }]
]);

// --- Instance defaults: fallbacks a person inherits until they choose -----------
const DEFAULTS_DB = (field) => ({ store: 'instance_state', key: 'defaults', field, wins: true });
group({ section: 'defaults', apply: 'hot', sources: ['db'], help: 'documentation/manager_configuration.md#instance-defaults-versus-enforced-policy' }, [
    ['defaults.chat.provider', 'enum', {
        dbOverride: DEFAULTS_DB('chat.provider'), validate: { enum: ['openai', 'anthropic', 'gemini', 'ollama'] },
        description: 'Provider used for a person who has not chosen one.'
    }],
    ['defaults.chat.model', 'string', {
        dbOverride: DEFAULTS_DB('chat.model'), validate: { pattern: MODEL_ID.source },
        description: 'Model used for a person who has not chosen one.'
    }],
    ['defaults.appearance.theme', 'enum', {
        dbOverride: DEFAULTS_DB('appearance.theme'), validate: { enum: schema.THEMES },
        runtime: 'config/userSettingsSchema#PREFERENCE_DEFAULTS.theme', default: 'dark',
        description: 'Portal theme for a person who has not chosen one.'
    }],
    ['defaults.appearance.startPage', 'enum', {
        dbOverride: DEFAULTS_DB('appearance.startPage'), validate: { enum: schema.START_PAGES },
        runtime: 'config/userSettingsSchema#PREFERENCE_DEFAULTS.startPage', default: 'home',
        description: 'Portal start page for a person who has not chosen one.'
    }],
    ['defaults.memory.chatHistoryRetentionDays', 'integer', {
        dbOverride: DEFAULTS_DB('memory.chatHistoryRetentionDays'),
        validate: { min: schema.LIMITS.RETENTION_DAYS_MIN, max: schema.LIMITS.RETENTION_DAYS_MAX },
        description: 'Study chat history window for a person who has not chosen one. Unset keeps history forever.'
    }],
    ['defaults.budget.usageAlertTokens', 'integer', {
        dbOverride: DEFAULTS_DB('budget.usageAlertTokens'),
        validate: { min: schema.LIMITS.USAGE_ALERT_MIN, max: schema.LIMITS.USAGE_ALERT_MAX },
        description: 'Personal usage-alert threshold for a person who has not set one. A notice only, never a cap.'
    }]
]);

group({ section: 'manager', help: 'documentation/host_operations.md#manager-unavailable' }, [
    ['manager.baseUrl', 'url', { env: ['GOOBSTER_MANAGER_URL'], runtime: 'config/managerConfig#url', default: 'http://127.0.0.1:3400', validate: { custom: 'httpUrl' }, description: 'Where the portal reaches the installation manager for the Host pages (server side only, never the browser). Loopback by default; anything else must be https.' }]
]);

group({ section: 'general', sources: ['config'] }, [
    ['DEFAULT_PROMPT', 'string', { description: "The assistant's default system prompt." }]
]);

fields.forEach(Object.freeze);
Object.freeze(fields);

const BY_ID = new Map(fields.map(field => [field.id, field]));
const BY_ENV = new Map();
for (const field of fields) {
    for (const name of field.env) BY_ENV.set(name, field);
}

if (BY_ID.size !== fields.length) throw new Error('fieldCatalog: duplicate field id');

const OFF_WORDS = ['0', 'false', 'no', 'off'];
const ON_WORDS = ['1', 'true'];
const MASKS = ['••••', '[redacted]', '…[redacted]', 'sk-…[redacted]', '********'];
const MAX_SECRET_LENGTH = 4096;

function list() {
    return fields;
}

function get(id) {
    return BY_ID.get(id) || null;
}

function byEnv(name) {
    return BY_ENV.get(name) || null;
}

function inSection(sectionId) {
    return fields.filter(field => field.section === sectionId);
}

/** The path in config.json the runtime reads for `field` (the id unless a legacy flat key applies). */
function filePath(field) {
    if (!field.sources.includes('config')) return null;
    return field.configPath || field.id;
}

function getPath(object, dotted) {
    let cursor = object;
    for (const part of String(dotted).split('.')) {
        if (cursor === null || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, part)) return undefined;
        cursor = cursor[part];
    }
    return cursor;
}

function setPath(object, dotted, value) {
    const parts = String(dotted).split('.');
    let cursor = object;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (cursor[part] === null || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
        cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = value;
}

/** Remove a path and any parent object the removal leaves empty. */
function deletePath(object, dotted) {
    const parts = String(dotted).split('.');
    const trail = [object];
    let cursor = object;
    for (let i = 0; i < parts.length - 1; i++) {
        cursor = cursor && typeof cursor === 'object' ? cursor[parts[i]] : undefined;
        if (cursor === null || typeof cursor !== 'object') return false;
        trail.push(cursor);
    }
    const last = parts[parts.length - 1];
    if (!Object.prototype.hasOwnProperty.call(cursor, last)) return false;
    delete cursor[last];
    for (let i = trail.length - 1; i > 0; i--) {
        if (Object.keys(trail[i]).length > 0) break;
        delete trail[i - 1][parts[i - 1]];
    }
    return true;
}

/** Last four characters when the secret is at least 12 long; never more, never less than that. */
function fingerprintOf(value) {
    const text = typeof value === 'string' ? value : '';
    return text.length >= 12 ? text.slice(-4) : null;
}

function fingerprintPresentation(fingerprint) {
    return fingerprint ? `••••${fingerprint}` : '••••';
}

/** A value that is a display mask, not a replacement secret. */
function isMaskedValue(value, { fingerprint = null } = {}) {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (text === '') return false;
    if (MASKS.includes(text)) return true;
    if (/[•●]/.test(text)) return true;
    if (/\[redacted\]/i.test(text) || /…\[redacted\]/.test(text)) return true;
    if (fingerprint && (text === fingerprint || text === fingerprintPresentation(fingerprint) || text === `…${fingerprint}`)) return true;
    return false;
}

const CUSTOM = {
    httpUrl(value, { allowEmpty }) {
        if (value === '' && allowEmpty) return true;
        try {
            const url = new URL(value);
            if (!['http:', 'https:'].includes(url.protocol)) return false;
            return !url.username && !url.password;
        } catch {
            return false;
        }
    },
    smtpUrl(value) {
        try {
            const url = new URL(value);
            return ['smtp:', 'smtps:'].includes(url.protocol) && Boolean(url.hostname);
        } catch {
            return false;
        }
    },
    discordToken(value) {
        return typeof value === 'string' && value.trim().length >= 20 && !value.startsWith('YOUR_') && !/\s/.test(value);
    },
    elevenlabsKey(value) {
        return require('../utils/configValidator').validateElevenLabsApiKey(value);
    },
    snowflakeList(list) {
        return list.every(item => /^\d{5,25}$/.test(item));
    },
    hostnameList(list) {
        return list.every(item => /^[a-z0-9.-]{1,253}$/.test(item));
    },
    absolutePathList(list) {
        return list.every(item => typeof item === 'string' && item.startsWith('/') && !/[\r\n\0]/.test(item));
    }
};

function bad(field, code, message) {
    return { ok: false, code, message: `${field.id}: ${message}` };
}

/**
 * Check and normalise a value for `field`. Returns `{ ok: true, value }` with the value coerced to the field's
 * type (a numeric string becomes a number, a comma list becomes an array), or `{ ok: false, code, message }`.
 * The message names the field and the rule, never the value.
 */
function validateValue(field, raw) {
    const rules = field.validate || {};
    const type = field.type;
    if (raw === null || raw === undefined) return bad(field, 'REQUIRED', 'a value is required (use remove to unset it).');

    if (type === 'secret') {
        if (typeof raw !== 'string') return bad(field, 'INVALID_TYPE', 'must be text.');
        if (raw.trim() === '') return bad(field, 'REQUIRED', 'a value is required (use remove to unset it).');
        if (raw.length > MAX_SECRET_LENGTH || /[\s\0]/.test(raw)) return bad(field, 'INVALID_VALUE', 'has an unusable shape (whitespace or too long).');
        if (rules.custom && !CUSTOM[rules.custom](raw, rules)) return bad(field, 'INVALID_VALUE', `does not look like a valid ${rules.custom}.`);
        return { ok: true, value: raw };
    }

    if (type === 'boolean') {
        if (typeof raw === 'boolean') return { ok: true, value: raw };
        if (typeof raw === 'string' && ['true', 'false'].includes(raw.trim().toLowerCase())) {
            return { ok: true, value: raw.trim().toLowerCase() === 'true' };
        }
        return bad(field, 'INVALID_TYPE', 'must be true or false.');
    }

    if (type === 'integer' || type === 'number' || type === 'duration') {
        const text = typeof raw === 'string' ? raw.trim() : raw;
        if (text === '' && rules.allowEmpty) return { ok: true, value: null };
        const n = typeof text === 'number' ? text : Number(text);
        if (typeof text !== 'number' && typeof text !== 'string') return bad(field, 'INVALID_TYPE', 'must be a number.');
        if (!Number.isFinite(n)) return bad(field, 'INVALID_TYPE', 'must be a number.');
        if (type !== 'number' && !Number.isSafeInteger(n)) return bad(field, 'INVALID_TYPE', 'must be a whole number.');
        if (rules.min !== undefined && n < rules.min) return bad(field, 'OUT_OF_RANGE', `must be at least ${rules.min}.`);
        if (rules.max !== undefined && n > rules.max) return bad(field, 'OUT_OF_RANGE', `must be at most ${rules.max}.`);
        return { ok: true, value: n };
    }

    if (type === 'list') {
        const items = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(/[,\s]+/) : null);
        if (!items) return bad(field, 'INVALID_TYPE', 'must be a list.');
        const clean = items.map(item => (typeof item === 'string' ? item.trim() : item)).filter(item => item !== '');
        if (clean.some(item => typeof item !== 'string' || /[\0\r\n]/.test(item) || item.length > 300)) {
            return bad(field, 'INVALID_VALUE', 'every entry must be short text.');
        }
        if (clean.length > 200) return bad(field, 'OUT_OF_RANGE', 'has too many entries.');
        if (rules.custom && !CUSTOM[rules.custom](clean, rules)) return bad(field, 'INVALID_VALUE', 'has an entry that is not accepted.');
        return { ok: true, value: clean };
    }

    if (typeof raw !== 'string') return bad(field, 'INVALID_TYPE', 'must be text.');
    const text = raw.trim();
    if (text === '') {
        if (rules.allowEmpty || (!rules.enum && !rules.pattern && !rules.custom)) return { ok: true, value: '' };
        return bad(field, 'REQUIRED', 'a value is required (use remove to unset it).');
    }
    if (/[\0\r\n]/.test(text) || text.length > 2000) return bad(field, 'INVALID_VALUE', 'has an unusable shape.');
    if (type === 'enum') {
        const wanted = text.toLowerCase();
        if (!(rules.enum || []).includes(wanted)) return bad(field, 'INVALID_CHOICE', `must be one of: ${(rules.enum || []).join(', ')}.`);
        return { ok: true, value: wanted };
    }
    if (rules.pattern && !new RegExp(rules.pattern).test(text)) return bad(field, 'INVALID_VALUE', 'does not match the accepted format.');
    if (rules.custom && !CUSTOM[rules.custom](text, rules)) return bad(field, 'INVALID_VALUE', `does not look like a valid ${rules.custom}.`);
    return { ok: true, value: text };
}

/**
 * Validate every catalogued path present in a config.json document. Unknown keys are not an error: they are
 * preserved and never inspected. Placeholders from config.example.json ("YOUR_...") count as unset.
 * @returns {{ ok: boolean, errors: Array<{ id: string, code: string, message: string }> }}
 */
function validateDocument(doc) {
    const errors = [];
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
        return { ok: false, errors: [{ id: '', code: 'INVALID_TYPE', message: 'config.json must contain a JSON object.' }] };
    }
    for (const field of fields) {
        const dotted = filePath(field);
        if (!dotted) continue;
        const paths = [dotted, ...field.legacyConfigPaths];
        for (const candidate of paths) {
            const value = getPath(doc, candidate);
            if (value === undefined || value === null) continue;
            if (JSON.stringify(value).includes('YOUR_')) continue;
            if (value === '' && field.type !== 'boolean') continue;
            const checked = validateValue(field, value);
            if (!checked.ok) errors.push({ id: field.id, code: checked.code, message: checked.message });
        }
    }
    return { ok: errors.length === 0, errors };
}

module.exports = {
    SECTIONS,
    OFF_WORDS,
    ON_WORDS,
    list,
    get,
    byEnv,
    inSection,
    filePath,
    getPath,
    setPath,
    deletePath,
    fingerprintOf,
    fingerprintPresentation,
    isMaskedValue,
    validateValue,
    validateDocument
};
