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
        blurb: 'What Goobster calls you, what you call him, and standing instructions for private chats.',
        keywords: ['name', 'nickname', 'call me', 'alias', 'identity', 'instructions', 'personality', 'directive', 'meme']
    },
    {
        id: 'chat',
        title: 'Chat & models',
        icon: '💬',
        scope: 'Private chats & DMs',
        blurb: 'Which AI platform and model answers in the Study and your DMs, and how hard it thinks.',
        keywords: ['ai', 'model', 'provider', 'platform', 'openai', 'anthropic', 'gemini', 'ollama', 'reasoning', 'thinking', 'thoughtful']
    },
    {
        id: 'voice',
        title: 'Voice',
        icon: '🎙️',
        scope: 'Private chats & DMs',
        blurb: 'The voice, accent, and playback speed for voice chat and read-alouds.',
        keywords: ['voice', 'tts', 'speech', 'speaker', 'accent', 'audio', 'speed', 'read aloud', 'listen', 'elevenlabs']
    },
    {
        id: 'initiative',
        title: 'Initiative',
        icon: '🧭',
        scope: 'Your account',
        blurb: 'How proactive Goobster is allowed to be, how often he may reach out, and when to stay quiet.',
        keywords: ['attention', 'initiative', 'proactive', 'nudge', 'assist', 'delegate', 'observe', 'quiet hours', 'do not disturb', 'notifications', 'budget', 'boundaries', 'dm']
    },
    {
        id: 'memory',
        title: 'Memory & privacy',
        icon: '🧠',
        scope: 'Private chats & DMs',
        blurb: 'How long private memories are kept, what Goobster knows about you, and the exits.',
        keywords: ['memory', 'retention', 'privacy', 'forget me', 'facts', 'remember', 'history', 'purge', 'delete', 'report', 'what do you know']
    },
    {
        id: 'connections',
        title: 'Connections',
        icon: '🔗',
        scope: 'Your account',
        blurb: 'Developer accounts Goobster may act through on your behalf.',
        keywords: ['github', 'notion', 'integrations', 'connect', 'accounts', 'tokens', 'pat']
    },
    {
        id: 'appearance',
        title: 'Appearance',
        icon: '🎨',
        scope: 'This device',
        blurb: 'Theme and display options for the portal on this device.',
        keywords: ['theme', 'dark', 'light', 'system', 'appearance', 'color', 'look', 'tags', 'link by tag']
    },
    {
        id: 'account',
        title: 'Account & devices',
        icon: '👤',
        scope: 'Your account',
        blurb: 'The Discord identity you are signed in with, and signing out.',
        keywords: ['account', 'user', 'discord', 'sign out', 'logout', 'log out', 'session', 'devices']
    }
];

export const SECTION_BY_ID = Object.fromEntries(SECTIONS.map((s) => [s.id, s])) as Record<SettingsSectionId, SectionMeta>;

export const FIELDS: FieldMeta[] = [
    { section: 'profile', fieldId: 'preferred-name', label: 'What Goobster calls you', keywords: ['name', 'nickname', 'call me', 'alias', 'my name'] },
    { section: 'profile', fieldId: 'bot-name', label: 'What you call Goobster', keywords: ['bot name', 'rename goobster', 'alias', 'call him'] },
    { section: 'profile', fieldId: 'custom-instructions', label: 'Custom instructions', keywords: ['instructions', 'how to respond', 'style', 'tone', 'prompt'] },
    { section: 'profile', fieldId: 'personality-directive', label: 'Personality directive', keywords: ['personality', 'directive', 'character', 'persona'] },
    { section: 'profile', fieldId: 'meme-mode', label: 'Meme mode', keywords: ['meme', 'jokes', 'silly', 'fun'] },
    { section: 'chat', fieldId: 'thoughtful', label: 'Thoughtful Mode', keywords: ['thoughtful', 'thinking', 'deeper', 'reasoning', 'preset'] },
    { section: 'chat', fieldId: 'provider', label: 'Model platform', keywords: ['provider', 'platform', 'openai', 'anthropic', 'claude', 'gemini', 'ollama', 'local'] },
    { section: 'chat', fieldId: 'model', label: 'Model', keywords: ['model', 'gpt', 'claude', 'gemini', 'llama'] },
    { section: 'chat', fieldId: 'reasoning', label: 'Reasoning effort', keywords: ['reasoning', 'effort', 'thinking', 'minimal', 'low', 'medium', 'high'] },
    { section: 'voice', fieldId: 'voice-pick', label: 'Speaking voice', keywords: ['voice', 'speaker', 'tts', 'elevenlabs'] },
    { section: 'voice', fieldId: 'voice-accent', label: 'Spoken accent', keywords: ['accent', 'british', 'american', 'irish', 'australian', 'dialect'] },
    { section: 'voice', fieldId: 'voice-speed', label: 'Playback speed', keywords: ['speed', 'faster', 'slower', 'rate', 'tempo'] },
    { section: 'initiative', fieldId: 'attention-enabled', label: 'Pay attention on my behalf', keywords: ['attention', 'enable', 'disable', 'proactive', 'on', 'off'] },
    { section: 'initiative', fieldId: 'initiative-level', label: 'Initiative level', keywords: ['initiative', 'observe', 'nudge', 'assist', 'delegate', 'agency'] },
    { section: 'initiative', fieldId: 'contact-budget', label: 'Contact budget', keywords: ['budget', 'dms per day', 'cooldown', 'how often', 'notifications', 'messages'] },
    { section: 'initiative', fieldId: 'quiet-hours', label: 'Quiet hours', keywords: ['quiet', 'do not disturb', 'dnd', 'night', 'sleep', 'hours'] },
    { section: 'initiative', fieldId: 'boundaries', label: 'Boundaries by category', keywords: ['boundaries', 'permissions', 'read', 'compute', 'write', 'confirm', 'github', 'research'] },
    { section: 'memory', fieldId: 'retention', label: 'Memory retention', keywords: ['retention', 'auto delete', 'expire', 'days', 'purge', 'keep forever'] },
    { section: 'memory', fieldId: 'memory-report', label: 'What Goobster knows about you', keywords: ['report', 'what do you know', 'facts', 'memories', 'transparency'] },
    { section: 'memory', fieldId: 'forget-me', label: 'Forget me', keywords: ['forget', 'erase', 'delete everything', 'wipe', 'gdpr'] },
    { section: 'connections', fieldId: 'github', label: 'GitHub', keywords: ['github', 'git', 'repos', 'pull requests', 'token'] },
    { section: 'connections', fieldId: 'notion', label: 'Notion', keywords: ['notion', 'pages', 'notes', 'token'] },
    { section: 'appearance', fieldId: 'theme', label: 'Theme', keywords: ['theme', 'dark', 'light', 'system', 'color scheme'] },
    { section: 'appearance', fieldId: 'link-by-tag', label: 'Link notes by shared tag', keywords: ['tags', 'link by tag', 'map', 'graph', 'spitball'] },
    { section: 'account', fieldId: 'identity', label: 'Signed in as', keywords: ['account', 'discord', 'who am i', 'identity', 'user id'] },
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
