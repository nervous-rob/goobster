/**
 * Best guesses for chat models that have no reviewed contract.
 *
 * A newly listed id (a dated snapshot, a next-generation model, a local
 * pull) still has a recognizable family in its name. This module reads that
 * name and borrows the request contract of the nearest reviewed sibling in
 * `catalog.js` - the effort levels, the sampling rule, the capability flags -
 * together with a readable display name and a description that says it is a
 * guess. Token limits are never guessed: they stay null until a provider
 * listing or a reviewed entry supplies them.
 *
 * Everything here is deterministic and keyless, so request validation in one
 * worker and the picker in another always agree. Reviewed and custom
 * entries always take precedence (registry.js consults this only as the
 * fallback). See documentation/adr/0011-model-registry.md.
 */
const { PROFILES, MODELS } = require('./catalog');

const PHRASES = {
    'openai-chat': 'text and image chat with sampling controls',
    'openai-reasoning': 'reasoning with effort levels and tools',
    'openai-gpt5': 'GPT-5 style reasoning with effort levels',
    'openai-o3': 'reasoning with low, medium and high effort',
    'claude-adaptive': 'adaptive thinking with effort levels and tools',
    'claude-standard': 'standard generation with sampling controls',
    'gemini-thinking': 'thinking with effort levels and tools',
    'gemini-legacy': 'chat with default thinking and sampling controls',
    'ollama-text': 'local text chat with prompt-based tool calls'
};

const DATE_SUFFIX = /-(20\d{2})-?(\d{2})-?(\d{2})$/;
const SIZE = /^\d+(?:\.\d+)?b$/i;

function reviewed(id) {
    return MODELS.find(model => model.id === id) || null;
}

function piece(word) {
    if (SIZE.test(word)) return word.toUpperCase();
    if (/^\d/.test(word)) return word;
    if (word.length <= 2) return word.toUpperCase();
    return word[0].toUpperCase() + word.slice(1);
}

function splitDate(id) {
    const match = id.match(DATE_SUFFIX);
    return match ? { base: id.slice(0, match.index), date: `${match[1]}-${match[2]}-${match[3]}` } : { base: id, date: null };
}

/** A readable name for an id: "claude-sonnet-6-20270101" -> "Claude Sonnet 6 (2027-01-01)". */
function displayName(provider, id) {
    const { base, date } = splitDate(id);
    const suffix = date ? ` (${date})` : '';
    if (provider === 'anthropic') {
        let match = base.match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?$/);
        if (match) return `Claude ${piece(match[1])} ${match[2]}${match[3] ? `.${match[3]}` : ''}${suffix}`;
        match = base.match(/^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)$/);
        if (match) return `Claude ${piece(match[3])} ${match[1]}${match[2] ? `.${match[2]}` : ''}${suffix}`;
        return `${base.split('-').map(piece).join(' ')}${suffix}`;
    }
    if (provider === 'openai') {
        const words = base.split('-');
        if (words[0] === 'gpt' && /^\d/.test(words[1] || '')) return `GPT-${words[1]}${words.slice(2).map(word => ` ${piece(word)}`).join('')}${suffix}`;
        if (/^o\d+$/.test(words[0])) return `${words.join(' ')}${suffix}`;
        return `${words.map(piece).join(' ')}${suffix}`;
    }
    if (provider === 'ollama') {
        const [name, tag] = base.split(':');
        const tagText = tag && tag !== 'latest' ? ` ${piece(tag)}` : '';
        return `${name.split(/[-_]/).map(piece).join(' ')}${tagText} (local)`;
    }
    return `${base.split('-').map(piece).join(' ')}${suffix}`;
}

/** The reviewed sibling whose contract this id most plausibly shares, or null. */
function basisFor(provider, id) {
    const { base } = splitDate(id.toLowerCase());
    if (provider === 'openai') {
        if (/chat/.test(base)) return 'gpt-4.1';
        if (/^gpt-4o/.test(base)) return 'gpt-4o';
        if (/^gpt-4\.1/.test(base)) return 'gpt-4.1';
        if (/^gpt-5(?:-|$)/.test(base)) return /nano/.test(base) ? 'gpt-5-nano' : /mini/.test(base) ? 'gpt-5-mini' : 'gpt-5';
        if (/^gpt-5\.\d/.test(base)) return /terra/.test(base) ? 'gpt-5.6-terra' : 'gpt-5.6-sol';
        if (/^gpt-(?:[6-9]|[1-9]\d+)(?:[.-]|$)/.test(base)) return /astra/.test(base) ? 'gpt-6-astra' : /luna/.test(base) ? 'gpt-6-luna' : 'gpt-6-sol';
        if (/^o(?:[3-9]|[1-9]\d+)(?:-|$)/.test(base)) return /mini|nano/.test(base) ? 'o3-mini' : 'o3';
        return null;
    }
    if (provider === 'anthropic') {
        let family = null;
        let version = null;
        let match = base.match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/);
        if (match) { family = match[1]; version = Number(`${match[2]}.${match[3] || 0}`); }
        match = match || base.match(/^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)/);
        if (!family && match) { family = match[3]; version = Number(`${match[1]}.${match[2] || 0}`); }
        if (!family) return null;
        if (family === 'haiku' || version < 4.5) return 'claude-haiku-4-5';
        return family === 'opus' ? 'claude-opus-5-5' : family === 'sonnet' ? 'claude-sonnet-5' : 'claude-fable-5-1';
    }
    if (provider === 'gemini') {
        const match = base.match(/^gemini-(\d+)(?:\.(\d+))?/);
        if (match) {
            const version = Number(`${match[1]}.${match[2] || 0}`);
            if (version >= 3) return /pro/.test(base) ? 'gemini-3.1-pro-preview' : 'gemini-3.5-flash';
            return 'gemini-2.5-flash';
        }
        if (/^gemini-(?:flash|pro)-latest$/.test(base)) return /pro/.test(base) ? 'gemini-3.1-pro-preview' : 'gemini-3.5-flash';
        return null;
    }
    if (provider === 'ollama') return 'llama3.2:3b';
    return null;
}

/**
 * @returns {null | { profile: string, basis: string, basisName: string, displayName: string,
 *   description: string, input: string[], reasoning: object, sampling: object, capabilities: object }}
 */
function infer(provider, id) {
    if (typeof id !== 'string' || !id) return null;
    const basisId = basisFor(provider, id);
    const basis = basisId && reviewed(basisId);
    if (!basis) return null;
    const profile = PROFILES[basis.profile];
    const capabilities = { ...profile.capabilities, ...basis.capabilities };
    if (provider === 'ollama' && /llava|vision|-vl\b|moondream|minicpm-v|pixtral|bakllava/i.test(id)) capabilities.imageInput = true;
    const reasoning = { ...profile.reasoning, ...basis.reasoning };
    const sampling = { ...profile.sampling, ...basis.sampling };
    const name = displayName(provider, id);
    return {
        profile: basis.profile, basis: basis.id, basisName: basis.displayName, displayName: name,
        description: `Best guess from the name: ${PHRASES[basis.profile]}, like ${basis.displayName}. Not yet reviewed.`,
        input: ['text', ...(capabilities.imageInput ? ['image'] : [])],
        reasoning, sampling, capabilities
    };
}

module.exports = { infer, displayName, basisFor, PHRASES };
