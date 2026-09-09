/**
 * ElevenLabs accent direction for portal TTS.
 *
 * Flash (`eleven_flash_v2_5`) is the realtime default — it is fast and
 * ignores audio tags (it would speak "[British accent]" as words). Accent
 * emulation lives on Eleven v3, which reads bracketed cues in the text.
 * Portal read-aloud happens after the full reply, so we switch that
 * request to `eleven_v3` and prefix a legalized tag. Discord live voice
 * stays on Flash unless the operator changes `elevenlabs.modelId`.
 */

const AUDIO_TAG_MODEL = 'eleven_v3';

const ACCENTS = [
    { id: 'american', label: 'American', tag: '[American accent]', aliases: ['us', 'usa', 'english-us'] },
    { id: 'british', label: 'British', tag: '[British accent]', aliases: ['uk', 'england', 'english', 'rp'] },
    { id: 'irish', label: 'Irish', tag: '[Irish accent]', aliases: [] },
    { id: 'scottish', label: 'Scottish', tag: '[Scottish accent]', aliases: ['scots'] },
    { id: 'australian', label: 'Australian', tag: '[Australian accent]', aliases: ['aussie'] },
    { id: 'indian', label: 'Indian English', tag: '[Indian English]', aliases: ['indian-english'] },
    { id: 'french', label: 'French', tag: '[French accent]', aliases: [] },
    { id: 'german', label: 'German', tag: '[German accent]', aliases: [] },
    { id: 'spanish', label: 'Spanish', tag: '[Spanish accent]', aliases: [] },
    { id: 'italian', label: 'Italian', tag: '[Italian accent]', aliases: [] },
    { id: 'southern-us', label: 'Southern US', tag: '[Southern US accent]', aliases: ['southern', 'southern-us'] }
];

const byAlias = new Map();
for (const accent of ACCENTS) {
    byAlias.set(accent.id, accent);
    byAlias.set(accent.label.toLowerCase(), accent);
    for (const alias of accent.aliases) byAlias.set(alias, accent);
}

function normalizeAccentQuery(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[_]+/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/\s+accent$/, '')
        .trim();
}

function listAccents() {
    return ACCENTS.map(({ id, label }) => ({ id, label }));
}

/**
 * Map a free-form request ("British", "uk", "cockney-ish british") to a
 * catalog entry. Returns null for empty/clear. Throws on unknown values
 * so callers can surface a 400 with the allowed names.
 * @param {string|null|undefined} value
 * @returns {{ id: string, label: string, tag: string }|null}
 */
function legalizeAccent(value) {
    if (value === undefined || value === null) return null;
    const raw = String(value).trim();
    if (!raw || /^(none|clear|off|default)$/i.test(raw)) return null;
    const key = normalizeAccentQuery(raw);
    const hyphen = key.replace(/\s+/g, '-');
    const compact = key.replace(/[\s-]+/g, '');
    const match = byAlias.get(key) || byAlias.get(hyphen)
        || ACCENTS.find(a => a.id.replace(/-/g, '') === compact);
    if (!match) {
        const names = ACCENTS.map(a => a.label).join(', ');
        throw new Error(`Unknown accent "${raw}". Known: ${names}.`);
    }
    return { id: match.id, label: match.label, tag: match.tag };
}

function modelSupportsAudioTags(modelId) {
    return /^eleven_v3/i.test(String(modelId || ''));
}

/** Prefix a v3 audio tag unless the text already starts with it. */
function applyAccentTag(text, accent) {
    const speakable = String(text || '');
    if (!accent?.tag || !speakable) return speakable;
    if (speakable.startsWith(accent.tag)) return speakable;
    return `${accent.tag} ${speakable}`;
}

module.exports = {
    AUDIO_TAG_MODEL,
    listAccents,
    legalizeAccent,
    modelSupportsAudioTags,
    applyAccentTag
};
