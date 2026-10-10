/** Per-account OpenRouter/OpenAI-compatible completions, never global credentials. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { Readable } = require('node:stream');
const axios = require('axios');
const db = require('../db');
const { assessUrl, resolvePinned } = require('../utils/safeFetch');

const DEFAULT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const FUNCTIONS = ['chat', 'voiceChat', 'image', 'speech', 'transcription', 'parlor', 'research'];
const EMPTY_MODELS = Object.fromEntries(FUNCTIONS.map(key => [key, null]));
const TTL_MS = 10 * 60 * 1000;
const RETRY_MS = 30000;

class PersonalAiError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status; this.code = code;
    }
}

function encryptionKey() {
    const configured = process.env.GOOBSTER_USER_AI_ENCRYPTION_KEY;
    if (configured) {
        const key = Buffer.from(configured, 'base64');
        if (key.length !== 32) throw new PersonalAiError(503, 'AI_KEY_STORAGE', 'The host encryption key must be 32 bytes encoded as base64.');
        return key;
    }
    const keyPath = path.join(require('../runtimePaths').dataDir, 'user-ai.key');
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    if (!fs.existsSync(keyPath)) {
        const temporary = `${keyPath}.${crypto.randomUUID()}`;
        try {
            fs.writeFileSync(temporary, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
            // A completed key becomes visible atomically. A second worker can
            // never open an empty/partially written file during first setup.
            try { fs.linkSync(temporary, keyPath); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
        } finally { fs.rmSync(temporary, { force: true }); }
    }
    const key = fs.readFileSync(keyPath);
    if (key.length !== 32) throw new PersonalAiError(503, 'AI_KEY_STORAGE', 'The host encryption key is invalid.');
    return key;
}

function encrypt(token) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

function decrypt(value) {
    try {
        const data = Buffer.from(value, 'base64');
        const cipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), data.subarray(0, 12));
        cipher.setAuthTag(data.subarray(12, 28));
        return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
    } catch {
        throw new PersonalAiError(503, 'AI_KEY_STORAGE', 'Your API key could not be opened. Ask the host to restore the encryption key or reconnect.');
    }
}

function completionUrl(value) {
    const { url } = assessUrl(value || DEFAULT_URL);
    const allowed = ['openrouter.ai', ...(require('../config/aiConfig').personalEndpointHosts || [])];
    if (!allowed.includes(url.hostname)) throw new PersonalAiError(403, 'AI_ENDPOINT_REFUSED', 'The host must allow this endpoint hostname before it can receive your key.');
    if (url.search || url.hash || !url.pathname.endsWith('/chat/completions')) {
        throw new PersonalAiError(400, 'BAD_AI_ENDPOINT', 'Enter the full HTTPS completion URL ending in /chat/completions, without a query or fragment.');
    }
    return url.toString();
}

function catalogModels(rows) {
    if (!Array.isArray(rows)) throw new PersonalAiError(502, 'AI_MODELS_FAILED', 'The endpoint returned an invalid model list.');
    const unique = new Map();
    for (const row of rows) {
        if (typeof row?.id !== 'string' || !row.id || row.id.length > 200) continue;
        const input = row.architecture?.input_modalities || ['text'];
        const output = row.architecture?.output_modalities || ['text'];
        if (!Array.isArray(input) || !Array.isArray(output)) continue;
        if (!row.architecture && /embed|moderation|whisper|tts/i.test(row.id)) continue;
        const tools = (row.supported_parameters || []).includes('tools');
        unique.set(row.id, {
            id: row.id, name: String(row.name || row.id), input, output, tools,
            // OpenRouter advertises modalities; compatible /models endpoints
            // without metadata support text only until they advertise more.
            functions: FUNCTIONS.filter(fn => fn === 'image' ? output.includes('image')
                : fn === 'speech' ? output.includes('audio')
                    : fn === 'transcription' ? input.includes('audio') && output.includes('text')
                        : input.includes('text') && output.includes('text'))
        });
    }
    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

class PersonalAiService {
    constructor(deps = {}) { this.deps = deps; this.cache = new Map(); this.inFlight = new Map(); }
    async _row(userId) { return userId ? (this.deps.db || db).get('SELECT * FROM user_ai_connections WHERE userId = @userId', { userId }) : null; }
    _public(row) {
        return { connected: Boolean(row), enabled: Boolean(row?.enabled), completionUrl: row?.completionUrl || DEFAULT_URL,
            models: { ...EMPTY_MODELS, ...JSON.parse(row?.modelsJson || '{}') } };
    }
    async settings(userId) { return this._public(await this._row(userId)); }

    async _request(connection, url, body, signal) {
        const checked = completionUrl(connection.completionUrl);
        if (new URL(url).origin !== new URL(checked).origin) throw new PersonalAiError(400, 'BAD_AI_ENDPOINT', 'Endpoint origin mismatch.');
        if (this.deps.request) return this.deps.request(connection, url, body, signal);
        // Direct deployments pin public DNS. On hosts with an outbound proxy,
        // axios preserves that proxy and its destination policy.
        const pinned = await resolvePinned(new URL(url).hostname);
        const agent = new https.Agent({ lookup: (_host, options, callback) => callback(null,
            options.all ? [pinned] : pinned.address, pinned.family) });
        try {
            const response = await axios({ url, method: body ? 'POST' : 'GET',
                headers: { Authorization: `Bearer ${connection.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Goobster' },
                data: body, timeout: 120000, signal, maxRedirects: 0,
                maxContentLength: 40 * 1024 * 1024, maxBodyLength: 25 * 1024 * 1024, httpsAgent: agent });
            if (response.data?.error) throw new Error('Provider error');
            return response.data;
        } catch (error) {
            if (signal?.aborted) throw signal.reason || error;
            // Never propagate upstream text/URLs, or axios' config (which
            // includes Authorization) into logs or public errors.
            throw new PersonalAiError(502, 'PERSONAL_AI_FAILED', 'Your AI endpoint could not complete the request. Check your key, credits, endpoint, and selected model.');
        } finally { agent.destroy(); }
    }

    async _catalog(connection, { refresh = false } = {}) {
        const key = crypto.createHash('sha256').update(connection.completionUrl).update(connection.apiKey).digest('hex');
        const prior = this.cache.get(key);
        if (prior && Date.now() < (refresh ? prior.retryAt : prior.expiresAt)) return { ...prior, status: prior.status === 'live' ? 'cached' : prior.status };
        if (this.inFlight.has(key)) return this.inFlight.get(key);
        const task = (async () => {
            let result;
            try {
                const url = connection.completionUrl.replace(/chat\/completions$/, 'models');
                const data = await this._request(connection, url, null, AbortSignal.timeout(8000));
                result = { models: catalogModels(data.data), status: 'live', checkedAt: new Date().toISOString(), expiresAt: Date.now() + TTL_MS };
            } catch {
                result = { models: prior?.models || [], status: prior?.checkedAt ? 'stale' : 'unavailable', checkedAt: prior?.checkedAt || null, expiresAt: Date.now() + RETRY_MS };
            }
            result.retryAt = Date.now() + RETRY_MS;
            this.cache.set(key, result);
            // Bound caches without persisting keys or another account's data.
            if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
            return result;
        })();
        this.inFlight.set(key, task);
        try { return await task; } finally { this.inFlight.delete(key); }
    }

    async catalog(userId, options) {
        const row = await this._row(userId);
        if (!row) return { models: [], status: 'not-configured', checkedAt: null };
        const result = await this._catalog({ completionUrl: row.completionUrl, apiKey: decrypt(row.encryptedKey) }, options);
        return { models: result.models, status: result.status, checkedAt: result.checkedAt };
    }

    async save(userId, changes = {}) {
        const prior = await this._row(userId);
        const url = completionUrl(changes.completionUrl ?? prior?.completionUrl);
        const key = changes.apiKey;
        if (key != null && (typeof key !== 'string' || key.trim().length < 8 || key.length > 1000 || /\s/.test(key))) {
            throw new PersonalAiError(400, 'BAD_API_KEY', 'Enter a valid API key without whitespace.');
        }
        if (!prior && !key) throw new PersonalAiError(400, 'API_KEY_REQUIRED', 'Enter your API key to connect.');
        if (prior && url !== prior.completionUrl && !key) throw new PersonalAiError(400, 'API_KEY_REQUIRED', 'Re-enter your key when changing the endpoint.');
        if (changes.enabled !== undefined && typeof changes.enabled !== 'boolean') throw new PersonalAiError(400, 'BAD_AI_SETTINGS', 'enabled must be a boolean.');
        const models = { ...EMPTY_MODELS, ...(url === prior?.completionUrl ? JSON.parse(prior.modelsJson) : {}), ...changes.models };
        if (changes.models != null && (typeof changes.models !== 'object' || Array.isArray(changes.models)
            || Object.keys(changes.models).some(fn => !FUNCTIONS.includes(fn)))) throw new PersonalAiError(400, 'BAD_AI_SETTINGS', 'Unknown AI function.');
        const connection = { completionUrl: url, apiKey: key || decrypt(prior.encryptedKey) };
        // Verify a new key/endpoint and newly selected models before writing.
        if (key || Object.values(changes.models || {}).some(id => id !== null)) {
            const catalog = await this._catalog(connection);
            if (!['live', 'cached'].includes(catalog.status)) throw new PersonalAiError(400, 'AI_VERIFY_FAILED', 'Could not verify your key or load models from this endpoint.');
            for (const [fn, id] of Object.entries(changes.models || {})) {
                if (id !== null && !catalog.models.some(model => model.id === id && model.functions.includes(fn))) {
                    throw new PersonalAiError(400, 'BAD_AI_MODEL', `Choose a listed model that supports ${fn}.`);
                }
            }
        }
        await (this.deps.db || db).run(`INSERT INTO user_ai_connections (userId, completionUrl, encryptedKey, enabled, modelsJson)
            VALUES (@userId, @completionUrl, @encryptedKey, @enabled, @modelsJson)
            ON CONFLICT(userId) DO UPDATE SET completionUrl = @completionUrl, encryptedKey = @encryptedKey,
                enabled = @enabled, modelsJson = @modelsJson, updatedAt = datetime('now')`, {
            userId, completionUrl: url, encryptedKey: key ? encrypt(key) : prior.encryptedKey,
            enabled: changes.enabled ?? Boolean(prior?.enabled), modelsJson: JSON.stringify(models)
        });
        return this.settings(userId);
    }
    async disconnect(userId) {
        await (this.deps.db || db).run('DELETE FROM user_ai_connections WHERE userId = @userId', { userId });
        return this.settings(userId);
    }
    async selection(userId, fn) {
        const row = await this._row(userId);
        const model = row?.enabled && JSON.parse(row.modelsJson)[fn];
        return model ? { completionUrl: row.completionUrl, apiKey: decrypt(row.encryptedKey), model, userId } : null;
    }
    async _log(connection, data, operation) {
        await require('./usageTracker').log({ provider: 'openrouter', model: connection.model, operation,
            usageKnown: Number.isFinite(data.usage?.prompt_tokens) && Number.isFinite(data.usage?.completion_tokens),
            inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0,
            userId: connection.userId, guildId: `dm:${connection.userId}` });
    }
    async complete(connection, body, opts = {}) {
        const data = await this._request(connection, connection.completionUrl, { ...body, model: connection.model }, opts.signal);
        await this._log(connection, data, opts.operation || 'chat');
        if (!data.choices?.[0]?.message) throw new PersonalAiError(502, 'PERSONAL_AI_FAILED', 'Your AI endpoint returned no completion.');
        return data.choices[0].message;
    }
    async chat(connection, messages, opts = {}) {
        const input = Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages) }];
        const wire = input.map(message => {
            if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: String(message.content) };
            if (message.role === 'assistant' && message.toolCalls?.length) return { role: 'assistant', content: message.content || null,
                tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments) } })) };
            if (message.images?.length) return { role: message.role, content: [{ type: 'text', text: message.content || '' },
                ...message.images.map(url => ({ type: 'image_url', image_url: { url } }))] };
            return { role: message.role, content: String(message.content || '') };
        });
        const catalog = await this._catalog(connection);
        const descriptor = catalog.models.find(model => model.id === connection.model);
        const maxTokens = opts.max_tokens ?? 4096;
        if (!Number.isFinite(maxTokens) || maxTokens < 0) throw new PersonalAiError(400, 'BAD_TOKEN_BUDGET', 'Output token budget must be a finite non-negative number.');
        const body = { messages: wire, max_tokens: Math.max(16, Math.ceil(maxTokens)) };
        if (opts.functions?.length && descriptor?.tools) body.tools = opts.functions.map(fn => ({ type: 'function', function: fn }));
        const message = await this.complete(connection, body, opts);
        const content = typeof message.content === 'string' ? message.content : (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('');
        if (content && opts.onDelta) opts.onDelta(content);
        return { content, toolCalls: (message.tool_calls || []).map(call => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })) };
    }
    async image(connection, prompt, signal) {
        const message = await this.complete(connection, { messages: [{ role: 'user', content: prompt }], modalities: ['image', 'text'] }, { signal, operation: 'image' });
        const data = message.images?.[0]?.image_url?.url;
        const match = typeof data === 'string' && /^data:image\/(?:png|jpeg|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(data);
        if (!match) throw new PersonalAiError(502, 'AI_IMAGE_FAILED', 'The endpoint returned no inline generated image.');
        return require('sharp')(Buffer.from(match[1], 'base64'), { limitInputPixels: 40 * 1024 * 1024 }).png().toBuffer();
    }
    async speech(connection, text, signal) {
        const message = await this.complete(connection, { messages: [{ role: 'user', content: `Read this text aloud exactly: ${text}` }],
            modalities: ['text', 'audio'], audio: { voice: 'alloy', format: 'wav' } }, { signal, operation: 'tts' });
        if (!message.audio?.data) throw new PersonalAiError(502, 'AI_SPEECH_FAILED', 'The endpoint returned no generated audio.');
        return { stream: Readable.from(Buffer.from(message.audio.data, 'base64')), contentType: 'audio/wav' };
    }
    async transcribe(connection, buffer, mimeType, signal) {
        // The completions audio-input contract accepts WAV and MP3. Browser
        // recordings are transcoded by the existing transcription service.
        const format = mimeType === 'audio/mpeg' ? 'mp3' : 'wav';
        const message = await this.complete(connection, { messages: [{ role: 'user', content: [
            { type: 'text', text: 'Transcribe this recording verbatim. Return only the transcript.' },
            { type: 'input_audio', input_audio: { data: buffer.toString('base64'), format } }
        ] }] }, { signal, operation: 'transcription' });
        return { text: String(message.content || '').trim() };
    }
}

module.exports = new PersonalAiService();
module.exports.PersonalAiService = PersonalAiService;
module.exports.PersonalAiError = PersonalAiError;
module.exports.FUNCTIONS = FUNCTIONS;
