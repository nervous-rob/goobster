/**
 * Versioned, reviewed chat-model contracts. Discovery never edits this file.
 * Capabilities describe what Goobster's adapter implements, not every feature
 * advertised by the provider. Null limits mean unverified, not unlimited.
 * See documentation/adr/0011-model-registry.md before adding an entry.
 */
const VERSION = 1;
const CHECKED = '2026-09-22';
const OPENAI = 'https://developers.openai.com/api/docs/';
const CLAUDE = 'https://platform.claude.com/docs/en/';
const GEMINI = 'https://ai.google.dev/gemini-api/docs/';

const PROFILES = {
    'openai-chat': {
        provider: 'openai', endpoint: 'responses',
        reasoning: { levels: [], default: null, aliases: {} },
        sampling: { mode: 'always', temperatureMax: 2, exclusive: false },
        capabilities: { imageInput: true, tools: 'native', streaming: true, nativeSearch: true }
    },
    'openai-reasoning': {
        provider: 'openai', endpoint: 'responses',
        reasoning: { levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'medium', aliases: { minimal: 'low' } },
        sampling: { mode: 'reasoning-off', temperatureMax: 2, exclusive: false },
        capabilities: { imageInput: true, tools: 'native', streaming: true, nativeSearch: true }
    },
    'openai-gpt5': {
        provider: 'openai', endpoint: 'responses',
        reasoning: { levels: ['minimal', 'low', 'medium', 'high'], default: 'medium', aliases: {} },
        sampling: { mode: 'never', temperatureMax: 2, exclusive: false },
        capabilities: { imageInput: true, tools: 'native', streaming: true, nativeSearch: true, nativeSearchExcludedEfforts: ['minimal'] }
    },
    'openai-o3': {
        provider: 'openai', endpoint: 'responses',
        reasoning: { levels: ['low', 'medium', 'high'], default: 'medium', aliases: { minimal: 'low' } },
        sampling: { mode: 'never', temperatureMax: 2, exclusive: false },
        capabilities: { imageInput: true, tools: 'native', streaming: true, nativeSearch: true }
    },
    'claude-adaptive': {
        provider: 'anthropic', endpoint: 'messages',
        // The initial adapter contract exposes the common supported effort
        // levels. Additional provider levels need their own budget/test policy.
        reasoning: { levels: ['low', 'medium', 'high'], default: 'high', aliases: { minimal: 'low' } },
        sampling: { mode: 'never', temperatureMax: 1, exclusive: true },
        capabilities: { imageInput: true, tools: 'native', streaming: true, nativeSearch: true }
    },
    'claude-standard': {
        provider: 'anthropic', endpoint: 'messages',
        reasoning: { levels: [], default: null, aliases: {} },
        sampling: { mode: 'always', temperatureMax: 1, exclusive: true },
        capabilities: { imageInput: true, tools: 'native', streaming: true, nativeSearch: true }
    },
    'gemini-thinking': {
        provider: 'gemini', endpoint: 'generateContent',
        reasoning: { levels: ['minimal', 'low', 'medium', 'high'], default: 'medium', aliases: {} },
        sampling: { mode: 'never', temperatureMax: 2, exclusive: false },
        capabilities: { imageInput: true, tools: 'native', streaming: true, nativeSearch: true }
    },
    'gemini-legacy': {
        provider: 'gemini', endpoint: 'generateContent',
        // Goobster does not send the 2.5 thinkingBudget parameter. Reserve
        // output room for its default thinking even without an effort control.
        reasoning: { levels: [], default: 'medium', aliases: {} },
        sampling: { mode: 'always', temperatureMax: 2, exclusive: false },
        capabilities: { imageInput: true, tools: 'native', streaming: true, nativeSearch: true }
    },
    'ollama-text': {
        provider: 'ollama', endpoint: 'chat',
        reasoning: { levels: [], default: null, aliases: {} },
        sampling: { mode: 'always', temperatureMax: 2, exclusive: false },
        capabilities: { imageInput: false, tools: 'prompt-based', streaming: true, nativeSearch: false }
    }
};

function entry(id, profile, displayName, description, extra = {}) {
    const contract = PROFILES[profile];
    return {
        id, profile, provider: contract.provider, displayName, description,
        status: 'supported', workflows: ['chat', 'parlor', 'research'],
        input: ['text', ...(contract.capabilities.imageInput ? ['image'] : [])], output: ['text'],
        contextWindow: null, maxOutputTokens: null, pricing: null,
        checkedAt: CHECKED, sources: [], aliases: [],
        ...extra
    };
}

const MODELS = [
    entry('gpt-6-sol', 'openai-reasoning', 'GPT-6 Sol', 'Reasoning, coding, and work with tools.', {
        contextWindow: 1050000, maxOutputTokens: 128000,
        sources: [`${OPENAI}models/gpt-6-sol`, `${OPENAI}guides/latest-model`]
    }),
    entry('gpt-6-astra', 'openai-reasoning', 'GPT-6 Astra', 'Complex reasoning and extended work with tools.', {
        reasoning: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium', aliases: { minimal: 'low' } },
        contextWindow: 1050000, maxOutputTokens: 128000,
        sources: [`${OPENAI}models/gpt-6-astra`, `${OPENAI}guides/latest-model`]
    }),
    entry('gpt-6-luna', 'openai-reasoning', 'GPT-6 Luna', 'Efficient reasoning for repeatable tasks.', {
        contextWindow: 1050000, maxOutputTokens: 128000,
        sources: [`${OPENAI}models/gpt-6-luna`, `${OPENAI}guides/latest-model`]
    }),
    entry('gpt-5.6-sol', 'openai-reasoning', 'GPT-5.6 Sol', 'General reasoning and complex tasks.', {
        aliases: ['gpt-5.6'], contextWindow: 1050000, maxOutputTokens: 128000,
        sources: [`${OPENAI}models/gpt-5.6-sol`]
    }),
    entry('gpt-5.6-terra', 'openai-reasoning', 'GPT-5.6 Terra', 'Everyday reasoning with lower resource use.', {
        contextWindow: 1050000, maxOutputTokens: 128000, sources: [`${OPENAI}models/gpt-5.6-terra`]
    }),
    ...['gpt-5', 'gpt-5-mini', 'gpt-5-nano'].map(id => entry(id, 'openai-gpt5', id, 'Earlier GPT-5 reasoning model.', {
        contextWindow: 400000, maxOutputTokens: 128000, sources: [`${OPENAI}models/${id}`]
    })),
    ...['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano'].map(id => entry(id, 'openai-chat', id, 'Text and image chat with sampling controls.', {
        capabilities: { nativeSearch: ['gpt-4.1', 'gpt-4.1-mini'].includes(id) },
        contextWindow: id.startsWith('gpt-4o') ? 128000 : 1047576,
        maxOutputTokens: id.startsWith('gpt-4o') ? 16384 : 32768, sources: [`${OPENAI}models/${id}`]
    })),
    entry('o3', 'openai-o3', 'o3', 'Earlier reasoning model with tool support.', { contextWindow: 200000, maxOutputTokens: 100000, sources: [`${OPENAI}models/o3`] }),
    entry('o3-mini', 'openai-o3', 'o3 mini', 'Text reasoning; no image input or built-in search in Goobster.', {
        contextWindow: 200000, maxOutputTokens: 100000, input: ['text'], capabilities: { imageInput: false, nativeSearch: false }, sources: [`${OPENAI}models/o3-mini`]
    }),
    entry('claude-sonnet-5', 'claude-adaptive', 'Claude Sonnet 5', 'General conversation and tools with adaptive thinking.', {
        contextWindow: 1000000, maxOutputTokens: 128000,
        sources: [`${CLAUDE}models/sonnet-5/overview`, `${CLAUDE}build-with-claude/effort`]
    }),
    entry('claude-fable-5', 'claude-adaptive', 'Claude Fable 5', 'Demanding reasoning and longer tasks.', {
        sources: [`${CLAUDE}build-with-claude/effort`]
    }),
    entry('claude-fable-5-1', 'claude-adaptive', 'Claude Fable 5.1', 'Demanding reasoning and extended work with tools.', {
        contextWindow: 1000000, maxOutputTokens: 128000, sources: [`${CLAUDE}models/overview`, `${CLAUDE}build-with-claude/effort`]
    }),
    entry('claude-opus-5-5', 'claude-adaptive', 'Claude Opus 5.5', 'Coding and knowledge work with adaptive thinking.', {
        reasoning: { ...PROFILES['claude-adaptive'].reasoning, default: 'medium' },
        contextWindow: 1000000, maxOutputTokens: 128000, sources: [`${CLAUDE}models/overview`, `${CLAUDE}build-with-claude/effort`]
    }),
    entry('claude-haiku-4-5', 'claude-standard', 'Claude Haiku 4.5', 'Fast chat and tool use. Goobster uses standard generation.', {
        aliases: ['claude-haiku-4-5-20251001'], contextWindow: 200000, maxOutputTokens: 64000,
        sources: [`${CLAUDE}models/overview`]
    }),
    entry('gemini-3.5-flash', 'gemini-thinking', 'Gemini 3.5 Flash', 'Everyday multimodal tasks and tools.', {
        contextWindow: 1048576, maxOutputTokens: 65536,
        sources: [`${GEMINI}models/gemini-3.5-flash`, `${GEMINI}thinking`]
    }),
    entry('gemini-3.1-pro-preview', 'gemini-thinking', 'Gemini 3.1 Pro Preview', 'Complex tasks with reasoning. Provider preview model.', {
        status: 'preview', reasoning: { levels: ['low', 'medium', 'high'], default: 'high', aliases: { minimal: 'low' } },
        sources: [`${GEMINI}models`, `${GEMINI}thinking`]
    }),
    entry('gemini-2.5-flash', 'gemini-legacy', 'Gemini 2.5 Flash', 'Earlier Flash model. Provider access may be restricted.', {
        sources: [`${GEMINI}models`, `${GEMINI}thinking`]
    }),
    entry('llama3.2:3b', 'ollama-text', 'Llama 3.2 3B (local)', 'Local text chat with prompt-based tool calls.', {
        sources: ['https://ollama.com/library/llama3.2', 'https://docs.ollama.com/api/chat']
    })
];

module.exports = { VERSION, PROFILES, MODELS };
