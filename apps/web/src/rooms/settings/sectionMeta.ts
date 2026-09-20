import type { SettingsSectionId } from '../../lib/types';

export type ScopeLabel = 'Your account' | 'Private chats & DMs' | 'This device';

export type SectionMeta = {
    id: SettingsSectionId;
    title: string;
    icon: string;
    scope: ScopeLabel;
    blurb: string;
    keywords: string[];
};

/** A single control that search can deep-link to (`/settings/<section>#<fieldId>`). */
export type FieldMeta = {
    section: SettingsSectionId;
    fieldId: string;
    label: string;
    keywords: string[];
};

export const SCOPE_FOR: Record<'private' | 'account' | 'device', ScopeLabel> = {
    private: 'Private chats & DMs',
    account: 'Your account',
    device: 'This device'
};

export const SECTIONS: SectionMeta[] = [
    {
        id: 'profile',
        title: 'Profile',
        icon: '🪪',
        scope: 'Private chats & DMs',
        blurb: 'What Goobster calls you, what you call him, standing instructions, and conversation-style defaults.',
        keywords: ['name', 'nickname', 'call me', 'alias', 'identity', 'instructions', 'personality', 'directive', 'meme', 'tone', 'length', 'language', 'timezone', 'units', 'preset']
    },
    {
        id: 'chat',
        title: 'Chat & models',
        icon: '💬',
        scope: 'Private chats & DMs',
        blurb: 'Which AI platform and model answers in the Study and your DMs, and how hard it thinks.',
        keywords: ['ai', 'model', 'provider', 'platform', 'openai', 'anthropic', 'gemini', 'ollama', 'reasoning', 'thinking', 'thoughtful', 'temperature', 'tokens', 'tools', 'usage', 'parlor', 'research']
    },
    {
        id: 'voice',
        title: 'Voice',
        icon: '🎙️',
        scope: 'Private chats & DMs',
        blurb: 'The voice, accent, playback, and preferred starting mode for voice chat and read-alouds.',
        keywords: ['voice', 'tts', 'speech', 'speaker', 'accent', 'audio', 'speed', 'read aloud', 'listen', 'elevenlabs', 'captions', 'mute', 'microphone', 'press to send']
    },
    {
        id: 'initiative',
        title: 'Initiative',
        icon: '🧭',
        scope: 'Your account',
        blurb: 'How proactive Goobster is allowed to be, how often he may reach out, and when to stay quiet.',
        keywords: ['attention', 'initiative', 'proactive', 'nudge', 'assist', 'delegate', 'observe', 'quiet hours', 'do not disturb', 'notifications', 'budget', 'boundaries', 'dm', 'presence', 'snooze']
    },
    {
        id: 'memory',
        title: 'Memory & privacy',
        icon: '🧠',
        scope: 'Private chats & DMs',
        blurb: 'How long private memories are kept, new-chat privacy, what Goobster knows about you, and the exits.',
        keywords: ['memory', 'retention', 'privacy', 'forget me', 'facts', 'remember', 'history', 'purge', 'delete', 'report', 'what do you know', 'incognito', 'export', 'shares', 'learn', 'recall']
    },
    {
        id: 'connections',
        title: 'Connections',
        icon: '🔗',
        scope: 'Your account',
        blurb: 'Developer accounts Goobster may act through on your behalf.',
        keywords: ['github', 'notion', 'integrations', 'connect', 'accounts', 'tokens', 'pat', 'allowlist', 'repos', 'pages']
    },
    {
        id: 'appearance',
        title: 'Appearance',
        icon: '🎨',
        scope: 'Your account',
        blurb: 'Theme, density, keyboard, and working defaults. Theme also keeps a device copy.',
        keywords: ['theme', 'dark', 'light', 'system', 'appearance', 'color', 'look', 'tags', 'link by tag', 'text size', 'motion', 'density', 'enter', 'start page', 'expedition', 'parlor']
    },
    {
        id: 'account',
        title: 'Account & sign-in',
        icon: '👤',
        scope: 'Your account',
        blurb: 'Who you are signed in as, your login name and password, Discord connection, sessions, and signing out.',
        keywords: ['account', 'user', 'discord', 'sign out', 'logout', 'log out', 'session', 'devices', 'password', 'login', 'connect', 'disconnect']
    }
];

export const SECTION_BY_ID = Object.fromEntries(SECTIONS.map((s) => [s.id, s])) as Record<SettingsSectionId, SectionMeta>;

export const FIELDS: FieldMeta[] = [
    { section: 'profile', fieldId: 'preferred-name', label: 'What Goobster calls you', keywords: ['name', 'nickname', 'call me', 'alias', 'my name'] },
    { section: 'profile', fieldId: 'account-name', label: 'Account-wide preferred name', keywords: ['fallback name', 'account name', 'preferred name', 'display name'] },
    { section: 'profile', fieldId: 'bot-name', label: 'What you call Goobster', keywords: ['bot name', 'rename goobster', 'alias', 'call him'] },
    { section: 'profile', fieldId: 'custom-instructions', label: 'Custom instructions', keywords: ['instructions', 'how to respond', 'style', 'prompt'] },
    { section: 'profile', fieldId: 'personality-directive', label: 'Personality directive', keywords: ['personality', 'directive', 'character', 'persona'] },
    { section: 'profile', fieldId: 'meme-mode', label: 'Meme mode', keywords: ['meme', 'jokes', 'silly', 'fun'] },
    { section: 'profile', fieldId: 'answer-length', label: 'Default answer length', keywords: ['length', 'concise', 'detailed', 'brief', 'verbose'] },
    { section: 'profile', fieldId: 'tone', label: 'Default tone', keywords: ['tone', 'warm', 'direct', 'neutral', 'playful'] },
    { section: 'profile', fieldId: 'humor', label: 'Humor and emoji', keywords: ['humor', 'emoji', 'jokes', 'funny'] },
    { section: 'profile', fieldId: 'language', label: 'Preferred response language', keywords: ['language', 'locale', 'english', 'spanish'] },
    { section: 'profile', fieldId: 'timezone', label: 'Timezone', keywords: ['timezone', 'tz', 'iana', 'local time'] },
    { section: 'profile', fieldId: 'units', label: 'Units and clock', keywords: ['units', 'metric', 'imperial', '12 hour', '24 hour', 'date'] },
    { section: 'profile', fieldId: 'personality-preset', label: 'Personality preset', keywords: ['preset', 'personality pack', 'style preset', 'concise direct', 'warm detailed'] },
    { section: 'chat', fieldId: 'thoughtful', label: 'Thoughtful Mode', keywords: ['thoughtful', 'thinking', 'deeper', 'reasoning', 'preset'] },
    { section: 'chat', fieldId: 'provider', label: 'Model platform', keywords: ['provider', 'platform', 'openai', 'anthropic', 'claude', 'gemini', 'ollama', 'local'] },
    { section: 'chat', fieldId: 'model', label: 'Model', keywords: ['model', 'gpt', 'claude', 'gemini', 'llama'] },
    { section: 'chat', fieldId: 'reasoning', label: 'Reasoning effort', keywords: ['reasoning', 'effort', 'thinking', 'minimal', 'low', 'medium', 'high'] },
    { section: 'chat', fieldId: 'reply-tokens', label: 'Reply length budget', keywords: ['tokens', 'max tokens', 'reply length', 'budget'] },
    { section: 'chat', fieldId: 'sampling', label: 'Sampling', keywords: ['temperature', 'top p', 'sampling', 'creativity'] },
    { section: 'chat', fieldId: 'parlor-model', label: 'Parlor model default', keywords: ['parlor', 'persona model', 'private parlor'] },
    { section: 'chat', fieldId: 'research-model', label: 'Research model default', keywords: ['research', 'expedition model', 'spitball model'] },
    { section: 'chat', fieldId: 'disabled-tools', label: 'Optional tools', keywords: ['tools', 'disable tools', 'search', 'image', 'code'] },
    { section: 'chat', fieldId: 'usage-alert', label: 'Usage alert', keywords: ['usage', 'budget', 'tokens alert', 'spend'] },
    { section: 'chat', fieldId: 'byok', label: 'Personal AI keys', keywords: ['byok', 'api key', 'own key', 'bring your own'] },
    { section: 'voice', fieldId: 'voice-pick', label: 'Speaking voice', keywords: ['voice', 'speaker', 'tts', 'elevenlabs'] },
    { section: 'voice', fieldId: 'voice-accent', label: 'Spoken accent', keywords: ['accent', 'british', 'american', 'irish', 'australian', 'dialect'] },
    { section: 'voice', fieldId: 'voice-speed', label: 'Playback speed', keywords: ['speed', 'faster', 'slower', 'rate', 'tempo'] },
    { section: 'voice', fieldId: 'voice-send-mode', label: 'Auto-send vs press-to-send', keywords: ['press to send', 'auto send', 'hands free', 'push to talk'] },
    { section: 'voice', fieldId: 'voice-engine', label: 'Preferred capture engine', keywords: ['live', 'batch', 'engine', 'transcription'] },
    { section: 'voice', fieldId: 'speech-pause', label: 'Pause before sending speech', keywords: ['hangover', 'pause', 'silence', 'wait after speaking'] },
    { section: 'voice', fieldId: 'start-muted', label: 'Start voice sessions muted', keywords: ['mute', 'start muted', 'microphone off'] },
    { section: 'voice', fieldId: 'captions', label: 'Show live captions', keywords: ['captions', 'transcript', 'subtitles'] },
    { section: 'voice', fieldId: 'auto-read', label: 'Read replies aloud', keywords: ['read aloud', 'autoplay', 'speak replies'] },
    { section: 'voice', fieldId: 'preferred-mic', label: 'Preferred microphone', keywords: ['microphone', 'mic', 'input device'] },
    { section: 'voice', fieldId: 'voice-volume', label: 'Voice volume', keywords: ['volume', 'gain', 'loud'] },
    { section: 'initiative', fieldId: 'attention-enabled', label: 'Pay attention on my behalf', keywords: ['attention', 'enable', 'disable', 'proactive', 'on', 'off'] },
    { section: 'initiative', fieldId: 'initiative-level', label: 'Initiative level', keywords: ['initiative', 'observe', 'nudge', 'assist', 'delegate', 'agency'] },
    { section: 'initiative', fieldId: 'contact-budget', label: 'Contact budget', keywords: ['budget', 'dms per day', 'cooldown', 'how often', 'notifications', 'messages'] },
    { section: 'initiative', fieldId: 'quiet-hours', label: 'Quiet hours', keywords: ['quiet', 'do not disturb', 'dnd', 'night', 'sleep', 'hours'] },
    { section: 'initiative', fieldId: 'quiet-hours-tz', label: 'Quiet hours timezone', keywords: ['local quiet hours', 'dst', 'timezone quiet'] },
    { section: 'initiative', fieldId: 'notifications', label: 'Notification channels', keywords: ['notifications', 'sounds', 'banners', 'in-app', 'outbound'] },
    { section: 'initiative', fieldId: 'presence', label: 'Show me as online', keywords: ['presence', 'online', 'visibility', 'friends'] },
    { section: 'initiative', fieldId: 'snooze', label: 'Default snooze', keywords: ['snooze', 'later', 'remind'] },
    { section: 'initiative', fieldId: 'boundaries', label: 'Boundaries by category', keywords: ['boundaries', 'permissions', 'read', 'compute', 'write', 'confirm', 'github', 'research'] },
    { section: 'memory', fieldId: 'retention', label: 'Memory retention', keywords: ['retention', 'auto delete', 'expire', 'days', 'purge', 'keep forever'] },
    { section: 'memory', fieldId: 'new-chat-privacy', label: 'Default new-chat privacy', keywords: ['incognito', 'private chat', 'new chat'] },
    { section: 'memory', fieldId: 'learn-memories', label: 'Learn new long-term memories', keywords: ['learn', 'extract memories', 'write memories'] },
    { section: 'memory', fieldId: 'use-memories', label: 'Use existing memories', keywords: ['recall', 'use memories', 'read memories'] },
    { section: 'memory', fieldId: 'chat-history', label: 'Study chat-history retention', keywords: ['chat history', 'transcripts', 'conversation expiry'] },
    { section: 'memory', fieldId: 'export', label: 'Export settings and report', keywords: ['export', 'download', 'backup'] },
    { section: 'memory', fieldId: 'shares', label: 'Shared links', keywords: ['shares', 'links', 'revoke', 'public'] },
    { section: 'memory', fieldId: 'applets', label: 'Applet access', keywords: ['applets', 'grants', 'workshop', 'capabilities'] },
    { section: 'memory', fieldId: 'memory-report', label: 'What Goobster knows about you', keywords: ['report', 'what do you know', 'facts', 'memories', 'transparency'] },
    { section: 'memory', fieldId: 'forget-me', label: 'Forget me', keywords: ['forget', 'erase', 'delete everything', 'wipe', 'gdpr'] },
    { section: 'connections', fieldId: 'github', label: 'GitHub', keywords: ['github', 'git', 'repos', 'pull requests', 'token'] },
    { section: 'connections', fieldId: 'notion', label: 'Notion', keywords: ['notion', 'pages', 'notes', 'token'] },
    { section: 'connections', fieldId: 'github-allowlist', label: 'GitHub repos Goobster may use', keywords: ['allowlist', 'repos', 'github repos'] },
    { section: 'connections', fieldId: 'notion-allowlist', label: 'Notion pages Goobster may use', keywords: ['allowlist', 'pages', 'notion pages'] },
    { section: 'appearance', fieldId: 'theme', label: 'Theme', keywords: ['theme', 'dark', 'light', 'system', 'color scheme'] },
    { section: 'appearance', fieldId: 'text-size', label: 'Text size', keywords: ['font', 'text size', 'bigger', 'smaller'] },
    { section: 'appearance', fieldId: 'reduced-motion', label: 'Reduced motion', keywords: ['motion', 'animation', 'accessibility'] },
    { section: 'appearance', fieldId: 'density', label: 'Interface density', keywords: ['compact', 'comfortable', 'spacing'] },
    { section: 'appearance', fieldId: 'enter-to-send', label: 'Enter to send', keywords: ['enter', 'newline', 'keyboard', 'ime'] },
    { section: 'appearance', fieldId: 'expand-details', label: 'Expand chat details', keywords: ['tools', 'thinking', 'code', 'attachments'] },
    { section: 'appearance', fieldId: 'start-page', label: 'Start page', keywords: ['home', 'landing', 'default room'] },
    { section: 'appearance', fieldId: 'exchange-server', label: 'Preferred Exchange server', keywords: ['exchange', 'guild', 'trading'] },
    { section: 'appearance', fieldId: 'link-by-tag', label: 'Link notes by shared tag', keywords: ['tags', 'link by tag', 'map', 'graph', 'spitball'] },
    { section: 'appearance', fieldId: 'expedition-defaults', label: 'Defaults for new expeditions', keywords: ['expedition', 'depth', 'lens', 'spitball defaults'] },
    { section: 'appearance', fieldId: 'parlor-defaults', label: 'Defaults for new personas', keywords: ['parlor', 'persona defaults', 'charter', 'emoji'] },
    { section: 'appearance', fieldId: 'conservatory', label: 'Conservatory library', keywords: ['conservatory', 'music', 'local storage'] },
    { section: 'account', fieldId: 'identity', label: 'Signed in as', keywords: ['account', 'discord', 'who am i', 'identity', 'user id'] },
    { section: 'account', fieldId: 'sign-in-password', label: 'Login name & password', keywords: ['password', 'passphrase', 'login name', 'username', 'change password', 'sign in without discord'] },
    { section: 'account', fieldId: 'sign-in-discord', label: 'Discord connection', keywords: ['discord', 'connect', 'disconnect', 'link', 'unlink'] },
    { section: 'account', fieldId: 'sessions', label: 'Active sessions', keywords: ['devices', 'sessions', 'revoke', 'sign out other'] },
    { section: 'account', fieldId: 'clear-device', label: 'Clear device-local data', keywords: ['clear', 'local storage', 'this device'] },
    { section: 'account', fieldId: 'sign-out', label: 'Sign out', keywords: ['sign out', 'logout', 'log out', 'leave', 'session'] }
];

export type SearchHit = { field: FieldMeta; section: SectionMeta; score: number };

function tokens(text: string): string[] {
    return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Rank controls by query. Matches on the control label, its synonyms, and the
 * section's own keywords/title, so "call me", "dnd", and "thinking" all land
 * on the right control rather than just the right section.
 */
export function searchSettings(query: string): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const qTokens = tokens(q);
    const hits: SearchHit[] = [];
    for (const field of FIELDS) {
        const section = SECTION_BY_ID[field.section];
        const label = field.label.toLowerCase();
        let score = 0;
        if (label.includes(q)) score += 10;
        for (const kw of field.keywords) {
            if (kw === q) score += 8;
            else if (kw.includes(q) || q.includes(kw)) score += 5;
        }
        for (const t of qTokens) {
            if (tokens(label).includes(t)) score += 3;
            if (field.keywords.some((kw) => tokens(kw).includes(t))) score += 2;
            if (section.keywords.some((kw) => tokens(kw).includes(t))) score += 1;
            if (tokens(section.title).includes(t)) score += 1;
        }
        if (score > 0) hits.push({ field, section, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, 12);
}

export function isSectionId(value: string | undefined): value is SettingsSectionId {
    return Boolean(value) && Object.prototype.hasOwnProperty.call(SECTION_BY_ID, value as string);
}
