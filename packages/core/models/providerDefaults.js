/**
 * Requests for chat models that have not received a reviewed contract.
 *
 * When the id names a recognizable family, `inference.js` supplies a best
 * guess: the nearest reviewed sibling's controls, a readable name and a
 * description that says so (`guess` is set). Otherwise the model receives
 * the minimal provider-default contract: no explicit reasoning or sampling
 * parameters and no image or search claims.
 */
const inference = require('./inference');

/**
 * What the last provider listing said about each id in this process
 * (discovery.js sets it after every listing, live or snapshot). Evidence
 * for unreviewed ids only: a display name, and for Gemini the published
 * description, token limits, thinking flag and temperature ceiling.
 */
const evidence = new Map();

/**
 * Controls Goobster read from the provider's documentation for an id
 * (services/modelProfileGuessService.js): limits, image input, web search,
 * effort levels (already clamped to the adapter's set) and the sampling
 * rule. Applied over the name guess and under the live listing.
 */
const stored = new Map();

function setListingEvidence(provider, meta) {
    evidence.set(provider, meta && typeof meta === 'object' ? meta : {});
}

function replaceStoredControls(provider, controlsById) {
    stored.set(provider, controlsById && typeof controlsById === 'object' ? { ...controlsById } : {});
}

function setStoredControls(provider, id, controls) {
    const current = { ...(stored.get(provider) || {}) };
    if (controls && typeof controls === 'object') current[id] = controls;
    else delete current[id];
    stored.set(provider, current);
}

function withStoredControls(model, controls) {
    if (!controls) return model;
    const next = { ...model, guess: { ...(model.guess || { source: 'heuristic', basis: null, basisName: null, profile: null }), controls: Object.keys(controls) } };
    if (controls.contextWindow) next.contextWindow = controls.contextWindow;
    if (controls.maxOutputTokens) next.maxOutputTokens = controls.maxOutputTokens;
    if (typeof controls.imageInput === 'boolean') {
        next.capabilities = { ...next.capabilities, imageInput: controls.imageInput };
        next.input = ['text', ...(controls.imageInput ? ['image'] : [])];
    }
    if (typeof controls.nativeSearch === 'boolean') next.capabilities = { ...next.capabilities, nativeSearch: controls.nativeSearch };
    if (controls.reasoning) {
        const levels = Array.isArray(controls.reasoning.levels) ? [...controls.reasoning.levels] : [];
        next.reasoning = { levels, default: levels.includes(controls.reasoning.default) ? controls.reasoning.default : (levels.length ? levels[0] : null), aliases: { ...model.reasoning.aliases } };
        if (!levels.length) next.sampling = { ...next.sampling, mode: 'always' };
    }
    if (controls.sampling) next.sampling = { ...next.sampling, mode: controls.sampling };
    return next;
}

function withEvidence(model, meta) {
    if (!meta) return model;
    const next = { ...model, guess: { ...(model.guess || { source: 'heuristic', basis: null, basisName: null, profile: null }), listing: Object.keys(meta) } };
    if (meta.displayName) next.displayName = meta.displayName;
    if (meta.description) { next.description = meta.description; next.guess.source = 'provider'; }
    if (meta.contextWindow) next.contextWindow = meta.contextWindow;
    if (meta.maxOutputTokens) next.maxOutputTokens = meta.maxOutputTokens;
    // A listing that says the model does not think wins over the family
    // guess: no effort control, sampling always applies.
    if (meta.thinking === false && (model.reasoning.levels.length || model.reasoning.default)) {
        next.reasoning = { levels: [], default: null, aliases: {} };
        next.sampling = { ...model.sampling, mode: 'always' };
    }
    if (meta.maxTemperature) next.sampling = { ...next.sampling, temperatureMax: meta.maxTemperature };
    if (typeof meta.nativeSearch === 'boolean') next.capabilities = { ...next.capabilities, nativeSearch: meta.nativeSearch };
    return next;
}

function describe(provider, id) {
    if (typeof id !== 'string' || !id || id.length > 100 || /\s/.test(id)) return null;
    // Provider lists also contain models for other endpoints. Never offer those
    // as chat, even when their names start with a familiar model family.
    if (/(?:image|audio|realtime|transcrib|tts|embed|moderation|instruct|search|computer-use|robotics|\bbert\b|\bbge\b)/i.test(id)) return null;
    const endpoints = { openai: 'responses', anthropic: 'messages', gemini: 'generateContent', ollama: 'chat' };
    if (!Object.hasOwn(endpoints, provider)) return null;
    if (provider === 'openai' && !/^(?:gpt-(?:4(?:o|\.1)|[5-9]|[1-9]\d+)(?:[.-]|$)|o(?:[3-9]|[1-9]\d+)(?:-|$))/.test(id)) return null;
    if (provider === 'anthropic' && !/^claude-/.test(id)) return null;
    if (provider === 'gemini' && !/^gemini-/.test(id)) return null;
    const base = {
        provider, id, canonicalId: id, profile: `${provider}-defaults`, endpoint: endpoints[provider],
        displayName: inference.displayName(provider, id),
        description: 'Uses provider defaults; advanced controls and limits have not been reviewed.',
        status: 'discovered', aliases: [], workflows: ['chat', 'parlor', 'research'],
        input: ['text'], output: ['text'], contextWindow: null, maxOutputTokens: null,
        pricing: null, checkedAt: null, sources: [], guess: null,
        reasoning: { levels: [], default: provider === 'ollama' ? null : 'medium', aliases: {} },
        sampling: { mode: 'never', temperatureMax: 2, exclusive: false },
        capabilities: { imageInput: false, tools: provider === 'ollama' ? 'prompt-based' : 'native', streaming: true, nativeSearch: false }
    };
    const guess = inference.infer(provider, id);
    const model = !guess ? base : {
        ...base, profile: guess.profile, displayName: guess.displayName, description: guess.description,
        input: guess.input, reasoning: guess.reasoning, sampling: guess.sampling, capabilities: guess.capabilities,
        guess: { source: 'heuristic', basis: guess.basis, basisName: guess.basisName, profile: guess.profile }
    };
    return withEvidence(withStoredControls(model, stored.get(provider)?.[id]), evidence.get(provider)?.[id]);
}

module.exports = { describe, setListingEvidence, setStoredControls, replaceStoredControls };
