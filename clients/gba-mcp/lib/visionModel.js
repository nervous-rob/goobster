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

function createOllamaModel({ host = DEFAULT_OLLAMA_HOST, model = DEFAULT_OLLAMA_MODEL, think = null, log = () => {} } = {}) {
    const base = host.replace(/\/+$/, '');

    // One best-effort capability probe per run (/api/show): warn when the
    // model cannot actually see the screen, and default hidden thinking
    // OFF for thinking-family models (qwen3 etc.) - with thinking on,
    // Ollama returns the reasoning in message.thinking and can leave
    // message.content empty, which reads as "the brain said nothing".
    let prepared = null;
    async function prepare() {
        let effectiveThink = think;
        try {
            const info = await fetchJson(`${base}/api/show`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ model })
            }, 10000);
            const capabilities = Array.isArray(info?.capabilities) ? info.capabilities : [];
            if (capabilities.length > 0 && !capabilities.includes('vision')) {
                log(`WARNING: ${model} does not report the "vision" capability - it cannot see the screen. Use a multimodal model (e.g. qwen2.5vl:7b or qwen3-vl).`);
            }
            if (effectiveThink === null && capabilities.includes('thinking')) {
                effectiveThink = false;
                log(`${model} is a thinking model - hidden thinking disabled so answers stay fast and non-empty (re-enable with --think)`);
            }
        } catch {
            // The probe is advisory; play with whatever the user chose.
        }
        return effectiveThink;
    }

    return {
        name: `ollama/${model}`,
        async decide({ system, prompt, imageBase64 }) {
            if (!prepared) prepared = prepare();
            const effectiveThink = await prepared;
            const body = await fetchJson(`${base}/api/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    model,
                    stream: false,
                    options: { temperature: 0.6 },
                    ...(effectiveThink === null ? {} : { think: effectiveThink }),
                    messages: [
                        { role: 'system', content: system },
                        { role: 'user', content: prompt, images: [imageBase64] }
                    ]
                })
            });
            const text = body?.message?.content;
            if (typeof text !== 'string' || !text.trim()) {
                if (typeof body?.message?.thinking === 'string' && body.message.thinking.trim()) {
                    throw new VisionModelError('Ollama returned only hidden "thinking" output and no answer - the model spent its whole reply reasoning. Run without --think, or pick a non-thinking model.');
                }
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
 * @param {{ provider?: 'ollama'|'openai', model?: string, host?: string, apiKey?: string,
 *           reasoningEffort?: string|null, think?: boolean|null, log?: (msg: string) => void }} options
 */
function createModel({ provider = 'ollama', model, host, apiKey, reasoningEffort = null, think = null, log } = {}) {
    switch (provider) {
        case 'ollama':
            return createOllamaModel({ host, think, ...(log ? { log } : {}), ...(model ? { model } : {}) });
        case 'openai':
            return createOpenAiModel({ apiKey, reasoningEffort, ...(model ? { model } : {}) });
        default:
            throw new VisionModelError(`Unknown provider "${provider}" (expected ollama or openai)`);
    }
}

module.exports = { createModel, createOllamaModel, createOpenAiModel, VisionModelError, REASONING_EFFORTS };
