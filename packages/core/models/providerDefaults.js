/** Minimal requests for chat models that have not received a reviewed contract. */
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
    return {
        provider, id, canonicalId: id, profile: `${provider}-defaults`, endpoint: endpoints[provider],
        displayName: id, description: 'Uses provider defaults; advanced controls and limits have not been reviewed.',
        status: 'discovered', aliases: [], workflows: ['chat', 'parlor', 'research'],
        input: ['text'], output: ['text'], contextWindow: null, maxOutputTokens: null,
        pricing: null, checkedAt: null, sources: [],
        reasoning: { levels: [], default: provider === 'ollama' ? null : 'medium', aliases: {} },
        sampling: { mode: 'never', temperatureMax: 2, exclusive: false },
        capabilities: { imageInput: false, tools: provider === 'ollama' ? 'prompt-based' : 'native', streaming: true, nativeSearch: false }
    };
}

module.exports = { describe };
