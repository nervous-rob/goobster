/**
 * Unified User Settings Schema and Constants (spec §5, §7, §8, Phase 2–3).
 *
 * Defines the canonical sections, field constraints, scopes, default values,
 * and search metadata across Goobster's personal settings.
 *
 * New synced preferences live in user_settings.preferencesJson. Existing
 * AI/voice/instructions/attention values stay in their authoritative stores.
 * Adding keys is a compatible change: missing keys resolve to DEFAULTS at
 * read time. Bump schemaVersion only for an incompatible reshape, and
 * upgrade in getSettings — never a one-off migration script.
 */

const SECTIONS = [
    'profile',
    'chat',
    'voice',
    'initiative',
    'memory',
    'appearance',
    'connections',
    'account'
];

const EDITABLE_SECTIONS = [
    'profile',
    'chat',
    'voice',
    'initiative',
    'memory',
    'appearance',
    'connections'
];

const SCOPES = {
    PRIVATE: 'private',
    ACCOUNT: 'account',
    DEVICE: 'device'
};

const SECTION_METADATA = {
    profile: {
        id: 'profile',
        title: 'Profile & identity',
        scope: SCOPES.PRIVATE,
        description: 'How Goobster identifies and addresses you in private conversations, plus your custom instructions and conversation-style defaults.',
        appliesTo: ['study', 'discord-dm'],
        keywords: ['name', 'nickname', 'call me', 'alias', 'who am i', 'instructions', 'custom instructions', 'personality', 'directive', 'meme', 'meme mode', 'tone', 'length', 'language', 'timezone', 'units', 'preset']
    },
    chat: {
        id: 'chat',
        title: 'Chat & models',
        scope: SCOPES.PRIVATE,
        description: 'AI model, provider, reasoning depth, and Thoughtful Mode presets for private conversations.',
        appliesTo: ['study', 'discord-dm'],
        keywords: ['ai', 'model', 'provider', 'openai', 'anthropic', 'gemini', 'ollama', 'reasoning', 'thinking', 'thoughtful', 'thoughtful mode', 'temperature', 'tokens', 'tools', 'usage']
    },
    voice: {
        id: 'voice',
        title: 'Voice & audio',
        scope: SCOPES.PRIVATE,
        description: 'Speaking voice, playback, and preferred starting mode for voice chat and read-aloud.',
        appliesTo: ['study-voice', 'discord-dm'],
        keywords: ['voice', 'tts', 'speech', 'elevenlabs', 'speaker', 'audio', 'speed', 'read aloud', 'talking', 'captions', 'mute', 'microphone', 'press to send']
    },
    initiative: {
        id: 'initiative',
        title: 'Initiative & attention',
        scope: SCOPES.ACCOUNT,
        description: 'How proactively Goobster reviews information, computes background updates, and contacts you.',
        appliesTo: ['attention-inbox', 'proactive-actions'],
        keywords: ['attention', 'initiative', 'proactive', 'nudge', 'assist', 'delegate', 'observe', 'quiet hours', 'do not disturb', 'budget', 'boundaries', 'notifications', 'presence', 'snooze']
    },
    memory: {
        id: 'memory',
        title: 'Memory & retention',
        scope: SCOPES.PRIVATE,
        description: 'Memory retention window, new-chat privacy, transparency reports, and personal data management.',
        appliesTo: ['study-memory', 'discord-dm-memory'],
        keywords: ['memory', 'retention', 'privacy', 'forget me', 'facts', 'remember', 'history', 'purge', 'incognito', 'export', 'shares', 'learn', 'recall']
    },
    appearance: {
        id: 'appearance',
        title: 'Appearance',
        scope: SCOPES.ACCOUNT,
        description: 'Visual theme, density, keyboard, and working defaults for the web portal.',
        appliesTo: ['web-portal'],
        keywords: ['theme', 'dark', 'light', 'system', 'appearance', 'color', 'look', 'link by tag', 'tags', 'text size', 'motion', 'density', 'enter', 'start page', 'expedition', 'parlor']
    },
    connections: {
        id: 'connections',
        title: 'Connections',
        scope: SCOPES.ACCOUNT,
        description: 'Connected developer accounts and platform credentials.',
        appliesTo: ['account'],
        keywords: ['github', 'notion', 'integrations', 'connect', 'accounts', 'tokens', 'allowlist', 'repos', 'pages']
    },
    account: {
        id: 'account',
        title: 'Account & devices',
        scope: SCOPES.ACCOUNT,
        description: 'Signed-in Discord identity and session management.',
        appliesTo: ['account'],
        keywords: ['account', 'user', 'discord', 'sign out', 'logout', 'session', 'devices']
    }
};

const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];
const INITIATIVE_LEVELS = ['observe', 'nudge', 'assist', 'delegate'];
const THEMES = ['light', 'dark', 'system'];
const ANSWER_LENGTHS = ['concise', 'balanced', 'detailed'];
const TONES = ['neutral', 'warm', 'direct', 'playful'];
const HUMOR_LEVELS = ['off', 'light', 'playful'];
const MEASUREMENT_SYSTEMS = ['follow-locale', 'metric', 'imperial'];
const TIME_FORMATS = ['follow-locale', '12', '24'];
const VOICE_SEND_MODES = ['auto', 'manual'];
const VOICE_CAPTURE_ENGINES = ['auto', 'live', 'batch'];
const REDUCED_MOTION = ['system', 'on', 'off'];
const DENSITIES = ['comfortable', 'compact'];
const TEXT_SIZES = ['s', 'm', 'l'];
const START_PAGES = ['home', 'study', 'noticed', 'spitball', 'parlor', 'exchange', 'conservatory'];
const NEW_CHAT_PRIVACY = ['regular', 'incognito'];
const QUIET_HOURS_TZ_MODES = ['utc', 'local'];
const PERSONALITY_PRESETS = {
    'concise-direct': { answerLength: 'concise', tone: 'direct', humor: 'off' },
    'warm-detailed': { answerLength: 'detailed', tone: 'warm', humor: 'light' },
    'playful-brief': { answerLength: 'concise', tone: 'playful', humor: 'playful' }
};
const PERSONALITY_PRESET_IDS = [null, ...Object.keys(PERSONALITY_PRESETS)];
const EXPEDITION_DEPTHS = ['focused', 'standard', 'deep'];
const OPTIONAL_PERSONAL_TOOLS = [
    'performSearch', 'generateImage', 'runCode', 'observatory', 'requestPythonPackages',
    'playTrack', 'speakMessage', 'launchCursorAgent', 'createGithubIssue', 'executePlan',
    'searchGithubCode', 'readGithubFile', 'searchNotion', 'readNotionPage'
];
const RESPONSE_LANGUAGES = [
    null,
    'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'ja', 'ko', 'zh'
];

const LIMITS = {
    NAME_MAX_LENGTH: 32,
    INSTRUCTIONS_MAX_LENGTH: 2000,
    DIRECTIVE_MAX_LENGTH: 2000,
    MODEL_MAX_LENGTH: 100,
    LANGUAGE_MAX_LENGTH: 16,
    TIMEZONE_MAX_LENGTH: 64,
    DATE_LOCALE_MAX_LENGTH: 32,
    MAX_CONTACTS_MIN: 0,
    MAX_CONTACTS_MAX: 20,
    CONTACT_COOLDOWN_MIN: 5,
    CONTACT_COOLDOWN_MAX: 1440,
    RETENTION_DAYS_MIN: 1,
    RETENTION_DAYS_MAX: 3650,
    SPEECH_PAUSE_MS_MIN: 400,
    SPEECH_PAUSE_MS_MAX: 4000,
    SPEECH_PAUSE_MS_DEFAULT: 1300,
    SNOOZE_HOURS_MIN: 1,
    SNOOZE_HOURS_MAX: 720,
    SNOOZE_HOURS_DEFAULT: 24,
    REPLY_TOKENS_MIN: 256,
    REPLY_TOKENS_MAX: 8192,
    TEMPERATURE_MIN: 0,
    TEMPERATURE_MAX: 2,
    TOP_P_MIN: 0,
    TOP_P_MAX: 1,
    USAGE_ALERT_MIN: 1000,
    USAGE_ALERT_MAX: 100000000,
    ALLOWLIST_MAX_ITEMS: 40,
    ALLOWLIST_ITEM_MAX: 128,
    DISABLED_TOOLS_MAX: 24
};

/**
 * Synced preferences stored in user_settings.preferencesJson.
 * Device hardware ids (microphone, output) stay in browser storage.
 */
const PREFERENCE_DEFAULTS = {
    accountPreferredName: null,
    answerLength: 'balanced',
    tone: 'warm',
    humor: 'light',
    responseLanguage: null,
    timezone: null,
    measurementSystem: 'follow-locale',
    timeFormat: 'follow-locale',
    dateLocale: null,
    voiceSendMode: 'auto',
    voiceCaptureEngine: 'auto',
    speechPauseMs: LIMITS.SPEECH_PAUSE_MS_DEFAULT,
    startVoiceMuted: false,
    showCaptions: true,
    autoReadReplies: false,
    notifyInApp: true,
    notifyMentionBanners: true,
    notifyOutbound: true,
    notifySounds: false,
    presenceVisible: true,
    defaultSnoozeHours: LIMITS.SNOOZE_HOURS_DEFAULT,
    quietHoursTzMode: 'utc',
    defaultNewChatPrivacy: 'regular',
    theme: 'dark',
    linkByTag: true,
    textSize: 'm',
    reducedMotion: 'system',
    density: 'comfortable',
    enterToSend: true,
    expandChatDetails: false,
    startPage: 'home',
    preferredExchangeGuild: null,
    personalityPreset: null,
    replyMaxTokens: null,
    temperature: null,
    topP: null,
    parlorProvider: null,
    parlorModel: null,
    researchProvider: null,
    researchModel: null,
    disabledTools: [],
    usageAlertTokens: null,
    learnMemories: true,
    useMemories: true,
    chatHistoryRetentionDays: null,
    githubAllowlist: [],
    notionAllowlist: [],
    expeditionDefaultDepth: 'standard',
    expeditionDefaultLens: 'general',
    parlorDefaultEmoji: null,
    parlorDefaultCharter: null
};

const PREFERENCE_KEYS_BY_SECTION = {
    profile: [
        'accountPreferredName', 'answerLength', 'tone', 'humor', 'responseLanguage',
        'timezone', 'measurementSystem', 'timeFormat', 'dateLocale', 'personalityPreset'
    ],
    chat: [
        'replyMaxTokens', 'temperature', 'topP',
        'parlorProvider', 'parlorModel', 'researchProvider', 'researchModel',
        'disabledTools', 'usageAlertTokens'
    ],
    voice: [
        'voiceSendMode', 'voiceCaptureEngine', 'speechPauseMs',
        'startVoiceMuted', 'showCaptions', 'autoReadReplies'
    ],
    initiative: [
        'notifyInApp', 'notifyMentionBanners', 'notifyOutbound', 'notifySounds',
        'presenceVisible', 'defaultSnoozeHours', 'quietHoursTzMode'
    ],
    memory: ['defaultNewChatPrivacy', 'learnMemories', 'useMemories', 'chatHistoryRetentionDays'],
    appearance: [
        'theme', 'linkByTag', 'textSize', 'reducedMotion', 'density',
        'enterToSend', 'expandChatDetails', 'startPage', 'preferredExchangeGuild',
        'expeditionDefaultDepth', 'expeditionDefaultLens', 'parlorDefaultEmoji', 'parlorDefaultCharter'
    ],
    connections: ['githubAllowlist', 'notionAllowlist']
};

const BOOLEAN_PREF_KEYS = new Set([
    'startVoiceMuted', 'showCaptions', 'autoReadReplies',
    'notifyInApp', 'notifyMentionBanners', 'notifyOutbound', 'notifySounds',
    'presenceVisible', 'linkByTag', 'enterToSend', 'expandChatDetails',
    'learnMemories', 'useMemories'
]);

function isValidTimeZone(value) {
    if (!value || typeof value !== 'string') return false;
    if (value.length > LIMITS.TIMEZONE_MAX_LENGTH) return false;
    try {
        Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

function isValidDateLocale(value) {
    if (!value || typeof value !== 'string') return false;
    if (value.length > LIMITS.DATE_LOCALE_MAX_LENGTH) return false;
    try {
        new Intl.DateTimeFormat(value);
        return true;
    } catch {
        return false;
    }
}

function coercePreference(key, raw) {
    if (raw === undefined) return { ok: false };
    if (BOOLEAN_PREF_KEYS.has(key)) {
        if (typeof raw !== 'boolean') return { ok: false, code: 'BAD_REQUEST', message: `${key} must be a boolean.` };
        return { ok: true, value: raw };
    }
    switch (key) {
        case 'accountPreferredName': {
            if (raw === null || raw === '') return { ok: true, value: null };
            const clean = String(raw).trim();
            if (clean.length > LIMITS.NAME_MAX_LENGTH) {
                return { ok: false, code: 'BAD_NAME', message: `Preferred name must be at most ${LIMITS.NAME_MAX_LENGTH} characters.` };
            }
            return { ok: true, value: clean || null };
        }
        case 'answerLength':
            if (!ANSWER_LENGTHS.includes(raw)) {
                return { ok: false, code: 'BAD_ANSWER_LENGTH', message: `answerLength must be one of: ${ANSWER_LENGTHS.join(', ')}.` };
            }
            return { ok: true, value: raw };
        case 'tone':
            if (!TONES.includes(raw)) {
                return { ok: false, code: 'BAD_TONE', message: `tone must be one of: ${TONES.join(', ')}.` };
            }
            return { ok: true, value: raw };
        case 'humor':
            if (!HUMOR_LEVELS.includes(raw)) {
                return { ok: false, code: 'BAD_HUMOR', message: `humor must be one of: ${HUMOR_LEVELS.join(', ')}.` };
            }
            return { ok: true, value: raw };
        case 'responseLanguage': {
            if (raw === null || raw === '' || raw === 'follow') return { ok: true, value: null };
            const lang = String(raw).trim().toLowerCase();
            if (lang.length > LIMITS.LANGUAGE_MAX_LENGTH || !RESPONSE_LANGUAGES.includes(lang)) {
                return { ok: false, code: 'BAD_LANGUAGE', message: 'responseLanguage must be a supported language code, or null to follow the conversation.' };
            }
            return { ok: true, value: lang };
        }
        case 'timezone': {
            if (raw === null || raw === '') return { ok: true, value: null };
            const tz = String(raw).trim();
            if (!isValidTimeZone(tz)) {
                return { ok: false, code: 'BAD_TIMEZONE', message: 'timezone must be a valid IANA time zone (for example America/New_York).' };
            }
            return { ok: true, value: tz };
        }
        case 'measurementSystem':
            if (!MEASUREMENT_SYSTEMS.includes(raw)) {
                return { ok: false, code: 'BAD_UNITS', message: `measurementSystem must be one of: ${MEASUREMENT_SYSTEMS.join(', ')}.` };
            }
            return { ok: true, value: raw };
        case 'timeFormat':
            if (!TIME_FORMATS.includes(raw)) {
                return { ok: false, code: 'BAD_TIME_FORMAT', message: `timeFormat must be one of: ${TIME_FORMATS.join(', ')}.` };
            }
            return { ok: true, value: raw };
        case 'dateLocale': {
            if (raw === null || raw === '') return { ok: true, value: null };
            const loc = String(raw).trim();
            if (!isValidDateLocale(loc)) {
                return { ok: false, code: 'BAD_DATE_LOCALE', message: 'dateLocale must be a valid BCP 47 locale, or null to follow the browser.' };
            }
            return { ok: true, value: loc };
        }
        case 'voiceSendMode':
            if (!VOICE_SEND_MODES.includes(raw)) {
                return { ok: false, code: 'BAD_VOICE_MODE', message: `voiceSendMode must be one of: ${VOICE_SEND_MODES.join(', ')}.` };
            }
            return { ok: true, value: raw };
        case 'voiceCaptureEngine':
            if (!VOICE_CAPTURE_ENGINES.includes(raw)) {
                return { ok: false, code: 'BAD_VOICE_ENGINE', message: `voiceCaptureEngine must be one of: ${VOICE_CAPTURE_ENGINES.join(', ')}.` };
            }
            return { ok: true, value: raw };
        case 'speechPauseMs': {
            const n = Number(raw);
            if (!Number.isInteger(n) || n < LIMITS.SPEECH_PAUSE_MS_MIN || n > LIMITS.SPEECH_PAUSE_MS_MAX) {
                return {
                    ok: false,
                    code: 'BAD_SPEECH_PAUSE',
                    message: `speechPauseMs must be an integer between ${LIMITS.SPEECH_PAUSE_MS_MIN} and ${LIMITS.SPEECH_PAUSE_MS_MAX}.`
                };
            }
            return { ok: true, value: n };
        }
        case 'defaultSnoozeHours': {
            const n = Number(raw);
            if (!Number.isInteger(n) || n < LIMITS.SNOOZE_HOURS_MIN || n > LIMITS.SNOOZE_HOURS_MAX) {
                return {
                    ok: false,
                    code: 'BAD_SNOOZE',
                    message: `defaultSnoozeHours must be an integer between ${LIMITS.SNOOZE_HOURS_MIN} and ${LIMITS.SNOOZE_HOURS_MAX}.`
                };
            }
            return { ok: true, value: n };
        }
        case 'quietHoursTzMode':
            if (!QUIET_HOURS_TZ_MODES.includes(raw)) {
                return { ok: false, code: 'BAD_QUIET_HOURS_MODE', message: 'quietHoursTzMode must be utc or local.' };
            }
            return { ok: true, value: raw };
        case 'defaultNewChatPrivacy':
            if (!NEW_CHAT_PRIVACY.includes(raw)) {
                return { ok: false, code: 'BAD_CHAT_PRIVACY', message: 'defaultNewChatPrivacy must be regular or incognito.' };
            }
            return { ok: true, value: raw };
        case 'theme':
            if (!THEMES.includes(raw)) {
                return { ok: false, code: 'BAD_THEME', message: `theme must be one of: ${THEMES.join(', ')}.` };
            }
            return { ok: true, value: raw };
        case 'textSize':
            if (!TEXT_SIZES.includes(raw)) {
                return { ok: false, code: 'BAD_TEXT_SIZE', message: `textSize must be one of: ${TEXT_SIZES.join(', ')}.` };
            }
            return { ok: true, value: raw };
        case 'reducedMotion':
            if (!REDUCED_MOTION.includes(raw)) {
                return { ok: false, code: 'BAD_MOTION', message: `reducedMotion must be one of: ${REDUCED_MOTION.join(', ')}.` };
            }
            return { ok: true, value: raw };
        case 'density':
            if (!DENSITIES.includes(raw)) {
                return { ok: false, code: 'BAD_DENSITY', message: `density must be one of: ${DENSITIES.join(', ')}.` };
            }
            return { ok: true, value: raw };
        case 'startPage':
            if (!START_PAGES.includes(raw)) {
                return { ok: false, code: 'BAD_START_PAGE', message: `startPage must be one of: ${START_PAGES.join(', ')}.` };
            }
            return { ok: true, value: raw };
        case 'personalityPreset': {
            if (raw === null || raw === '' || raw === 'custom') return { ok: true, value: null };
            if (!PERSONALITY_PRESET_IDS.includes(raw)) {
                return { ok: false, code: 'BAD_PRESET', message: `personalityPreset must be one of: ${Object.keys(PERSONALITY_PRESETS).join(', ')}.` };
            }
            return { ok: true, value: raw };
        }
        case 'replyMaxTokens': {
            if (raw === null || raw === '') return { ok: true, value: null };
            const n = Number(raw);
            if (!Number.isInteger(n) || n < LIMITS.REPLY_TOKENS_MIN || n > LIMITS.REPLY_TOKENS_MAX) {
                return {
                    ok: false,
                    code: 'BAD_REPLY_TOKENS',
                    message: `replyMaxTokens must be an integer between ${LIMITS.REPLY_TOKENS_MIN} and ${LIMITS.REPLY_TOKENS_MAX}, or null.`
                };
            }
            return { ok: true, value: n };
        }
        case 'temperature': {
            if (raw === null || raw === '') return { ok: true, value: null };
            const n = Number(raw);
            if (!Number.isFinite(n) || n < LIMITS.TEMPERATURE_MIN || n > LIMITS.TEMPERATURE_MAX) {
                return { ok: false, code: 'BAD_TEMPERATURE', message: 'temperature must be a number between 0 and 2, or null.' };
            }
            return { ok: true, value: n };
        }
        case 'topP': {
            if (raw === null || raw === '') return { ok: true, value: null };
            const n = Number(raw);
            if (!Number.isFinite(n) || n < LIMITS.TOP_P_MIN || n > LIMITS.TOP_P_MAX) {
                return { ok: false, code: 'BAD_TOP_P', message: 'topP must be a number between 0 and 1, or null.' };
            }
            return { ok: true, value: n };
        }
        case 'parlorProvider':
        case 'researchProvider': {
            if (raw === null || raw === '') return { ok: true, value: null };
            const v = String(raw).trim().toLowerCase();
            if (!['openai', 'anthropic', 'gemini', 'ollama'].includes(v)) {
                return { ok: false, code: 'BAD_PROVIDER', message: `${key} must be openai, anthropic, gemini, ollama, or null.` };
            }
            return { ok: true, value: v };
        }
        case 'parlorModel':
        case 'researchModel': {
            if (raw === null || raw === '') return { ok: true, value: null };
            const v = String(raw).trim();
            if (v.length > LIMITS.MODEL_MAX_LENGTH) {
                return { ok: false, code: 'BAD_MODEL', message: `${key} must be at most ${LIMITS.MODEL_MAX_LENGTH} characters.` };
            }
            return { ok: true, value: v };
        }
        case 'disabledTools': {
            if (raw == null || raw === '') return { ok: true, value: [] };
            const list = Array.isArray(raw) ? raw : String(raw).split(',');
            const clean = [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
            if (clean.length > LIMITS.DISABLED_TOOLS_MAX) {
                return { ok: false, code: 'BAD_TOOLS', message: `disabledTools accepts at most ${LIMITS.DISABLED_TOOLS_MAX} names.` };
            }
            for (const name of clean) {
                if (!OPTIONAL_PERSONAL_TOOLS.includes(name)) {
                    return { ok: false, code: 'BAD_TOOLS', message: `${name} is not an optional personal tool.` };
                }
            }
            return { ok: true, value: clean };
        }
        case 'usageAlertTokens': {
            if (raw === null || raw === '') return { ok: true, value: null };
            const n = Number(raw);
            if (!Number.isInteger(n) || n < LIMITS.USAGE_ALERT_MIN || n > LIMITS.USAGE_ALERT_MAX) {
                return { ok: false, code: 'BAD_USAGE_ALERT', message: 'usageAlertTokens must be an integer threshold, or null.' };
            }
            return { ok: true, value: n };
        }
        case 'chatHistoryRetentionDays': {
            if (raw === null || raw === '') return { ok: true, value: null };
            const n = Number(raw);
            if (!Number.isInteger(n) || n < LIMITS.RETENTION_DAYS_MIN || n > LIMITS.RETENTION_DAYS_MAX) {
                return { ok: false, code: 'BAD_CHAT_RETENTION', message: 'chatHistoryRetentionDays must be 1–3650, or null for forever.' };
            }
            return { ok: true, value: n };
        }
        case 'githubAllowlist':
        case 'notionAllowlist': {
            if (raw == null || raw === '') return { ok: true, value: [] };
            const list = Array.isArray(raw) ? raw : String(raw).split(/[\n,]/);
            const clean = [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
            if (clean.length > LIMITS.ALLOWLIST_MAX_ITEMS) {
                return { ok: false, code: 'BAD_ALLOWLIST', message: `${key} accepts at most ${LIMITS.ALLOWLIST_MAX_ITEMS} entries.` };
            }
            if (clean.some((item) => item.length > LIMITS.ALLOWLIST_ITEM_MAX)) {
                return { ok: false, code: 'BAD_ALLOWLIST', message: `${key} entries must be at most ${LIMITS.ALLOWLIST_ITEM_MAX} characters.` };
            }
            return { ok: true, value: clean };
        }
        case 'expeditionDefaultDepth':
            if (!EXPEDITION_DEPTHS.includes(raw)) {
                return { ok: false, code: 'BAD_DEPTH', message: `expeditionDefaultDepth must be one of: ${EXPEDITION_DEPTHS.join(', ')}.` };
            }
            return { ok: true, value: raw };
        case 'expeditionDefaultLens': {
            if (raw === null || raw === '') return { ok: true, value: 'general' };
            const id = String(raw).trim();
            if (id.length > 40) {
                return { ok: false, code: 'BAD_LENS', message: 'expeditionDefaultLens is too long.' };
            }
            return { ok: true, value: id };
        }
        case 'parlorDefaultEmoji': {
            if (raw === null || raw === '') return { ok: true, value: null };
            const v = String(raw).trim();
            if (v.length > 8) return { ok: false, code: 'BAD_EMOJI', message: 'parlorDefaultEmoji must be at most 8 characters.' };
            return { ok: true, value: v };
        }
        case 'parlorDefaultCharter': {
            if (raw === null || raw === '') return { ok: true, value: null };
            const v = String(raw).trim();
            if (v.length > LIMITS.DIRECTIVE_MAX_LENGTH) {
                return { ok: false, code: 'BAD_CHARTER', message: `parlorDefaultCharter must be at most ${LIMITS.DIRECTIVE_MAX_LENGTH} characters.` };
            }
            return { ok: true, value: v };
        }
        case 'preferredExchangeGuild': {
            if (raw === null || raw === '') return { ok: true, value: null };
            const id = String(raw).trim();
            if (!/^\d{5,20}$/.test(id)) {
                return { ok: false, code: 'BAD_GUILD_ID', message: 'preferredExchangeGuild must be a Discord snowflake, or null.' };
            }
            return { ok: true, value: id };
        }
        default:
            return { ok: false, code: 'UNKNOWN_FIELD', message: `Unknown preference: ${key}` };
    }
}

function parsePreferences(json) {
    let raw = {};
    if (typeof json === 'string' && json) {
        try { raw = JSON.parse(json) || {}; } catch { raw = {}; }
    } else if (json && typeof json === 'object' && !Array.isArray(json)) {
        raw = json;
    }
    const out = { ...PREFERENCE_DEFAULTS };
    for (const key of Object.keys(PREFERENCE_DEFAULTS)) {
        if (!(key in raw) || raw[key] === undefined) continue;
        const checked = coercePreference(key, raw[key]);
        if (checked.ok) out[key] = checked.value;
    }
    return out;
}

function pickSectionPrefs(prefs, section) {
    const keys = PREFERENCE_KEYS_BY_SECTION[section] || [];
    const out = {};
    for (const key of keys) out[key] = prefs[key];
    return out;
}

function localMinuteInZone(now, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: 'numeric',
        minute: 'numeric',
        hourCycle: 'h23'
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    return hour * 60 + minute;
}

module.exports = {
    SECTIONS,
    EDITABLE_SECTIONS,
    SCOPES,
    SECTION_METADATA,
    REASONING_EFFORTS,
    INITIATIVE_LEVELS,
    THEMES,
    ANSWER_LENGTHS,
    TONES,
    HUMOR_LEVELS,
    MEASUREMENT_SYSTEMS,
    TIME_FORMATS,
    VOICE_SEND_MODES,
    VOICE_CAPTURE_ENGINES,
    REDUCED_MOTION,
    DENSITIES,
    TEXT_SIZES,
    START_PAGES,
    NEW_CHAT_PRIVACY,
    QUIET_HOURS_TZ_MODES,
    PERSONALITY_PRESETS,
    PERSONALITY_PRESET_IDS,
    EXPEDITION_DEPTHS,
    OPTIONAL_PERSONAL_TOOLS,
    RESPONSE_LANGUAGES,
    LIMITS,
    PREFERENCE_DEFAULTS,
    PREFERENCE_KEYS_BY_SECTION,
    BOOLEAN_PREF_KEYS,
    isValidTimeZone,
    isValidDateLocale,
    coercePreference,
    parsePreferences,
    pickSectionPrefs,
    localMinuteInZone
};
