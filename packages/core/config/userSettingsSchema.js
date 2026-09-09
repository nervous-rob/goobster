/**
 * Unified User Settings Schema and Constants (spec §5, §7, §8).
 *
 * Defines the canonical sections, field constraints, scopes, default values,
 * and search metadata across Goobster's personal settings.
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
    'appearance'
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
        description: 'How Goobster identifies and addresses you in private conversations, plus your custom instructions.',
        appliesTo: ['study', 'discord-dm'],
        keywords: ['name', 'nickname', 'call me', 'alias', 'who am i', 'instructions', 'custom instructions', 'personality', 'directive', 'meme', 'meme mode']
    },
    chat: {
        id: 'chat',
        title: 'Chat & models',
        scope: SCOPES.PRIVATE,
        description: 'AI model, provider, reasoning depth, and Thoughtful Mode presets for private conversations.',
        appliesTo: ['study', 'discord-dm'],
        keywords: ['ai', 'model', 'provider', 'openai', 'anthropic', 'gemini', 'ollama', 'reasoning', 'thinking', 'thoughtful', 'thoughtful mode']
    },
    voice: {
        id: 'voice',
        title: 'Voice & audio',
        scope: SCOPES.PRIVATE,
        description: 'Speaking voice selection and playback speed multiplier for voice chat and read-aloud.',
        appliesTo: ['study-voice', 'discord-dm'],
        keywords: ['voice', 'tts', 'speech', 'elevenlabs', 'speaker', 'audio', 'speed', 'read aloud', 'talking']
    },
    initiative: {
        id: 'initiative',
        title: 'Initiative & attention',
        scope: SCOPES.ACCOUNT,
        description: 'How proactively Goobster reviews information, computes background updates, and contacts you.',
        appliesTo: ['attention-inbox', 'proactive-actions'],
        keywords: ['attention', 'initiative', 'proactive', 'nudge', 'assist', 'delegate', 'observe', 'quiet hours', 'do not disturb', 'budget', 'boundaries']
    },
    memory: {
        id: 'memory',
        title: 'Memory & retention',
        scope: SCOPES.PRIVATE,
        description: 'Memory retention window, transparency reports, and personal data management.',
        appliesTo: ['study-memory', 'discord-dm-memory'],
        keywords: ['memory', 'retention', 'privacy', 'forget me', 'facts', 'remember', 'history', 'purge']
    },
    appearance: {
        id: 'appearance',
        title: 'Appearance',
        scope: SCOPES.DEVICE,
        description: 'Visual theme and display options for the web portal.',
        appliesTo: ['web-portal'],
        keywords: ['theme', 'dark', 'light', 'system', 'appearance', 'color', 'look', 'link by tag', 'tags']
    },
    connections: {
        id: 'connections',
        title: 'Connections',
        scope: SCOPES.ACCOUNT,
        description: 'Connected developer accounts and platform credentials.',
        appliesTo: ['account'],
        keywords: ['github', 'notion', 'integrations', 'connect', 'accounts', 'tokens']
    },
    account: {
        id: 'account',
        title: 'Account & devices',
        scope: SCOPES.ACCOUNT,
        description: 'Signed-in Discord identity and session management.',
        appliesTo: ['account'],
        keywords: ['account', 'user', 'discord', 'sign out', 'logout', 'session']
    }
};

const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];
const INITIATIVE_LEVELS = ['observe', 'nudge', 'assist', 'delegate'];
const THEMES = ['light', 'dark', 'system'];

const LIMITS = {
    NAME_MAX_LENGTH: 32,
    INSTRUCTIONS_MAX_LENGTH: 2000,
    DIRECTIVE_MAX_LENGTH: 2000,
    MODEL_MAX_LENGTH: 100,
    MAX_CONTACTS_MIN: 0,
    MAX_CONTACTS_MAX: 20,
    CONTACT_COOLDOWN_MIN: 5,
    CONTACT_COOLDOWN_MAX: 1440,
    RETENTION_DAYS_MIN: 1,
    RETENTION_DAYS_MAX: 3650
};

module.exports = {
    SECTIONS,
    EDITABLE_SECTIONS,
    SCOPES,
    SECTION_METADATA,
    REASONING_EFFORTS,
    INITIATIVE_LEVELS,
    THEMES,
    LIMITS
};
