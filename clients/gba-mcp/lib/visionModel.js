/**
 * Vision-model providers for the autonomous player, zero-dep by design
 * (plain fetch — this is a laptop-side harness tool, deliberately not
 * the bot's services/aiService.js provider router).
 *
 * Contract: decide({ system, prompt, imageBase64 }) -> string (raw model
 * text; the agent brain legalizes it).
 *
 *  - ollama (default): a local multimodal model (e.g. qwen2.5vl:7b) via
 *    the Ollama chat API. Free, private, and what the spare-laptop
 *    deployment runs on.
 *  - openai: the Responses API with an image input. Useful as a quality
 *    ceiling ("is the harness dumb or is my local model dumb?") and for
 *    environments where Ollama cannot run.
 */

const DEFAULT_OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5vl:7b';
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-terra';
const REQUEST_TIMEOUT_MS = 120000;

class VisionModelError extends Error {
    constructor(message) {
        super(message);
        this.name = 'VisionModelError';
    }
}

async function fetchJson(url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            const detail = body?.error?.message || body?.error || response.statusText;
            throw new VisionModelError(`${url} -> ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
        }
        return body;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new VisionModelError(`Model request timed out after ${timeoutMs}ms`);
        }
        if (error instanceof VisionModelError) throw error;
        throw new VisionModelError(`Model request failed: ${error.message}`);
    } finally {
        clearTimeout(timer);
    }
}

function createOllamaModel({ host = DEFAULT_OLLAMA_HOST, model = DEFAULT_OLLAMA_MODEL } = {}) {
    const base = host.replace(/\/+$/, '');
    return {
        name: `ollama/${model}`,
        async decide({ system, prompt, imageBase64 }) {
            const body = await fetchJson(`${base}/api/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    model,
                    stream: false,
                    options: { temperature: 0.6 },
                    messages: [
                        { role: 'system', content: system },
                        { role: 'user', content: prompt, images: [imageBase64] }
                    ]
                })
            });
            const text = body?.message?.content;
            if (typeof text !== 'string' || !text.trim()) {
                throw new VisionModelError('Ollama returned an empty response');
            }
            return text;
        }
    };
}

const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];

function createOpenAiModel({
    apiKey = process.env.OPENAI_API_KEY,
    model = DEFAULT_OPENAI_MODEL,
    reasoningEffort = null,
    baseUrl = 'https://api.openai.com/v1'
} = {}) {
    if (!apiKey) {
        throw new VisionModelError('OPENAI_API_KEY is required for --provider openai');
    }
    if (reasoningEffort !== null && !REASONING_EFFORTS.includes(reasoningEffort)) {
        throw new VisionModelError(`Unknown reasoning effort "${reasoningEffort}" (expected ${REASONING_EFFORTS.join(', ')})`);
    }
    return {
        name: `openai/${model}`,
        async decide({ system, prompt, imageBase64 }) {
            const body = await fetchJson(`${baseUrl.replace(/\/+$/, '')}/responses`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model,
                    instructions: system,
                    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
                    input: [{
                        role: 'user',
                        content: [
                            { type: 'input_text', text: prompt },
                            { type: 'input_image', image_url: `data:image/png;base64,${imageBase64}` }
                        ]
                    }]
                })
            });
            // Prefer the SDK-style convenience field; fall back to walking output items.
            let text = typeof body.output_text === 'string' ? body.output_text : null;
            if (!text && Array.isArray(body.output)) {
                text = body.output
                    .flatMap(item => Array.isArray(item.content) ? item.content : [])
                    .filter(part => part.type === 'output_text' && typeof part.text === 'string')
                    .map(part => part.text)
                    .join('');
            }
            if (!text || !text.trim()) {
                throw new VisionModelError('OpenAI returned an empty response');
            }
            return text;
        }
    };
}

/**
 * @param {{ provider?: 'ollama'|'openai', model?: string, host?: string, apiKey?: string, reasoningEffort?: string|null }} options
 */
function createModel({ provider = 'ollama', model, host, apiKey, reasoningEffort = null } = {}) {
    switch (provider) {
        case 'ollama':
            return createOllamaModel({ host, ...(model ? { model } : {}) });
        case 'openai':
            return createOpenAiModel({ apiKey, reasoningEffort, ...(model ? { model } : {}) });
        default:
            throw new VisionModelError(`Unknown provider "${provider}" (expected ollama or openai)`);
    }
}

module.exports = { createModel, createOllamaModel, createOpenAiModel, VisionModelError, REASONING_EFFORTS };
