const axios = require('axios');
const aiConfig = require('../config/aiConfig');

/**
 * Text embedding service with two backends:
 * - OpenAI (text-embedding-3-small by default) when an API key is configured
 * - Ollama (nomic-embed-text by default) for fully self-hosted setups
 *
 * Embeddings from different models/dimensions are not comparable, so every
 * embedding is tagged with the model name and consumers must only compare
 * vectors produced by the same model.
 */
class EmbeddingService {
    constructor() {
        this._openaiService = null; // lazy to avoid require cycles
    }

    _getOpenAI() {
        if (!this._openaiService) {
            this._openaiService = require('./openaiService');
        }
        return this._openaiService;
    }

    /**
     * Which backend will be used: 'openai' | 'ollama'.
     */
    getBackend() {
        return this._getOpenAI().isConfigured() ? 'openai' : 'ollama';
    }

    /**
     * The model identifier embeddings will be tagged with, e.g.
     * "openai/text-embedding-3-small" or "ollama/nomic-embed-text".
     */
    getModelId() {
        return this.getBackend() === 'openai'
            ? `openai/${aiConfig.openai.embeddingModel}`
            : `ollama/${aiConfig.ollama.embeddingModel}`;
    }

    /**
     * Embed a single text.
     * @param {string} text
     * @returns {Promise<{vector: Float32Array, model: string}>}
     */
    async embed(text) {
        const [result] = await this.embedBatch([text]);
        return result;
    }

    /**
     * Embed multiple texts in one request.
     * @param {string[]} texts
     * @returns {Promise<Array<{vector: Float32Array, model: string}>>}
     */
    async embedBatch(texts) {
        const inputs = texts.map(t => String(t).slice(0, 8000));

        if (this.getBackend() === 'openai') {
            const client = this._getOpenAI().client;
            const response = await client.embeddings.create({
                model: aiConfig.openai.embeddingModel,
                input: inputs
            });
            const model = `openai/${aiConfig.openai.embeddingModel}`;
            return response.data.map(d => ({ vector: Float32Array.from(d.embedding), model }));
        }

        // Ollama /api/embed accepts a string or array and returns { embeddings: [[...]] }
        const response = await axios.post(`${aiConfig.ollama.host}/api/embed`, {
            model: aiConfig.ollama.embeddingModel,
            input: inputs
        }, { timeout: 120000 });

        const embeddings = response.data?.embeddings;
        if (!Array.isArray(embeddings) || embeddings.length !== inputs.length) {
            throw new Error('Invalid embedding response from Ollama');
        }
        const model = `ollama/${aiConfig.ollama.embeddingModel}`;
        return embeddings.map(e => ({ vector: Float32Array.from(e), model }));
    }
}

/**
 * Cosine similarity between two Float32Array vectors of equal length.
 */
function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dot / denominator;
}

module.exports = new EmbeddingService();
module.exports.cosineSimilarity = cosineSimilarity;
