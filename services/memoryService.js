const db = require('../db');
const aiConfig = require('../config/aiConfig');
const embeddingService = require('./embeddingService');
const { cosineSimilarity } = require('./embeddingService');

// Skip trivially short or command-like content; it pollutes recall.
const MIN_CONTENT_LENGTH = 20;
// Cap how many candidate rows are scored per recall (newest first).
const MAX_CANDIDATES = 2000;

/**
 * Long-term semantic memory backed by SQLite.
 *
 * Messages are embedded asynchronously as conversations happen and recalled
 * via cosine similarity when a new message arrives, letting the bot remember
 * things far beyond the 20-message context window.
 */
class MemoryService {
    isEnabled() {
        return aiConfig.memory.enabled;
    }

    /**
     * Store a memory. Fire-and-forget friendly: never throws.
     * @param {Object} entry - { guildId, channelId, authorId, authorName, content }
     * @returns {Promise<boolean>} whether the memory was stored
     */
    async remember({ guildId, channelId, authorId, authorName, content }) {
        try {
            if (!this.isEnabled() || !guildId || !content) return false;
            if (channelId && this.isChannelExcluded(guildId, channelId)) return false;

            const trimmed = content.trim();
            if (trimmed.length < MIN_CONTENT_LENGTH || trimmed.startsWith('/')) return false;

            // Skip if we stored identical content for this guild recently
            const duplicate = db.get(
                `SELECT id FROM memory_embeddings
                 WHERE guildId = @guildId AND content = @content
                 ORDER BY id DESC LIMIT 1`,
                { guildId, content: trimmed }
            );
            if (duplicate) return false;

            const { vector, model } = await embeddingService.embed(trimmed);

            db.run(
                `INSERT INTO memory_embeddings (guildId, channelId, authorId, authorName, content, embedding, dims, model)
                 VALUES (@guildId, @channelId, @authorId, @authorName, @content, @embedding, @dims, @model)`,
                {
                    guildId,
                    channelId: channelId || null,
                    authorId: authorId || null,
                    authorName: authorName || null,
                    content: trimmed,
                    embedding: Buffer.from(vector.buffer),
                    dims: vector.length,
                    model
                }
            );

            this._prune(guildId);
            return true;
        } catch (error) {
            console.warn('[MemoryService] Failed to store memory:', error.message);
            return false;
        }
    }

    /**
     * Keep each guild's memory bounded by deleting the oldest entries, and
     * apply the guild's retention window when one is configured.
     */
    _prune(guildId) {
        const max = aiConfig.memory.maxEntriesPerGuild;
        db.run(
            `DELETE FROM memory_embeddings
             WHERE guildId = @guildId
               AND id NOT IN (
                   SELECT id FROM memory_embeddings
                   WHERE guildId = @guildId
                   ORDER BY id DESC LIMIT @max
               )`,
            { guildId, max }
        );
        this.applyRetention(guildId);
    }

    /**
     * Purge memories older than the guild's retention window (if set).
     * @returns {number} rows removed
     */
    applyRetention(guildId) {
        const row = db.get(
            'SELECT memory_retention_days FROM guild_settings WHERE guildId = @guildId',
            { guildId }
        );
        const days = row?.memory_retention_days;
        if (!days || days <= 0) return 0;

        return db.run(
            `DELETE FROM memory_embeddings
             WHERE guildId = @guildId
               AND createdAt < datetime('now', '-' || @days || ' days')`,
            { guildId, days }
        ).changes;
    }

    /**
     * Apply retention for every guild that has a window configured. Runs from
     * the nightly consolidation pass so quiet guilds still get purged.
     * @returns {number} total rows removed
     */
    applyRetentionAll() {
        const guilds = db.all(
            `SELECT guildId FROM guild_settings
             WHERE memory_retention_days IS NOT NULL AND memory_retention_days > 0`
        );
        let removed = 0;
        for (const { guildId } of guilds) {
            removed += this.applyRetention(guildId);
        }
        return removed;
    }

    /**
     * Channels the bot must not remember (privacy scope control).
     */
    isChannelExcluded(guildId, channelId) {
        return Boolean(db.get(
            `SELECT 1 FROM memory_channel_exclusions
             WHERE guildId = @guildId AND channelId = @channelId`,
            { guildId, channelId }
        ));
    }

    excludeChannel(guildId, channelId) {
        db.run(
            `INSERT INTO memory_channel_exclusions (guildId, channelId)
             VALUES (@guildId, @channelId)
             ON CONFLICT(guildId, channelId) DO NOTHING`,
            { guildId, channelId }
        );
        // Drop anything already remembered from that channel
        return db.run(
            `DELETE FROM memory_embeddings
             WHERE guildId = @guildId AND channelId = @channelId`,
            { guildId, channelId }
        ).changes;
    }

    includeChannel(guildId, channelId) {
        return db.run(
            `DELETE FROM memory_channel_exclusions
             WHERE guildId = @guildId AND channelId = @channelId`,
            { guildId, channelId }
        ).changes;
    }

    getExcludedChannels(guildId) {
        return db.all(
            `SELECT channelId FROM memory_channel_exclusions
             WHERE guildId = @guildId ORDER BY createdAt ASC`,
            { guildId }
        ).map(r => r.channelId);
    }

    /**
     * Recall memories relevant to a query via cosine similarity.
     * Never throws; returns [] on any failure.
     *
     * @param {Object} params - { guildId, query, limit, minSimilarity, excludeContents }
     * @returns {Promise<Array<{content, authorName, createdAt, similarity}>>}
     */
    async recall({ guildId, query, limit, minSimilarity, excludeContents = [] }) {
        try {
            if (!this.isEnabled() || !guildId || !query) return [];

            const k = limit ?? aiConfig.memory.recallLimit;
            const threshold = minSimilarity ?? aiConfig.memory.minSimilarity;

            const { vector: queryVector, model } = await embeddingService.embed(query);

            // Only compare vectors from the same embedding model
            const rows = db.all(
                `SELECT content, authorName, channelId, createdAt, embedding, dims
                 FROM memory_embeddings
                 WHERE guildId = @guildId AND model = @model
                 ORDER BY id DESC LIMIT @max`,
                { guildId, model, max: MAX_CANDIDATES }
            );

            const excluded = new Set(excludeContents.map(c => String(c).trim()));
            const scored = [];

            for (const row of rows) {
                if (row.dims !== queryVector.length) continue;
                if (excluded.has(row.content)) continue;

                const vector = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dims);
                const similarity = cosineSimilarity(queryVector, vector);
                if (similarity >= threshold) {
                    scored.push({
                        content: row.content,
                        authorName: row.authorName,
                        channelId: row.channelId,
                        createdAt: row.createdAt,
                        similarity
                    });
                }
            }

            scored.sort((a, b) => b.similarity - a.similarity);
            return scored.slice(0, k);
        } catch (error) {
            console.warn('[MemoryService] Recall failed:', error.message);
            return [];
        }
    }

    /**
     * Format recalled memories as a system-prompt block. Returns null when
     * there is nothing to inject.
     */
    formatForPrompt(memories) {
        if (!memories || memories.length === 0) return null;

        const lines = memories.map(m => {
            const when = m.createdAt ? m.createdAt.split(' ')[0] : 'unknown date';
            const who = m.authorName || 'someone';
            return `- [${when}] ${who}: ${m.content}`;
        });

        return `LONG-TERM MEMORY:
The following are relevant excerpts from past conversations in this server (retrieved by semantic similarity). Use them for context when helpful, but don't force references to them:
${lines.join('\n')}`;
    }

    /**
     * Memory stats for a guild.
     */
    getStats(guildId) {
        const row = db.get(
            `SELECT COUNT(*) AS count, MIN(createdAt) AS oldest, MAX(createdAt) AS newest
             FROM memory_embeddings WHERE guildId = @guildId`,
            { guildId }
        );
        return {
            count: row?.count || 0,
            oldest: row?.oldest || null,
            newest: row?.newest || null,
            backend: embeddingService.getBackend(),
            model: embeddingService.getModelId(),
            enabled: this.isEnabled()
        };
    }

    /**
     * Delete all memories for a guild. Returns number of rows removed.
     */
    forgetGuild(guildId) {
        const result = db.run('DELETE FROM memory_embeddings WHERE guildId = @guildId', { guildId });
        return result.changes;
    }

    /**
     * Count memories authored by a user in a guild.
     */
    countUserMemories(guildId, authorId) {
        const row = db.get(
            `SELECT COUNT(*) AS count FROM memory_embeddings
             WHERE guildId = @guildId AND authorId = @authorId`,
            { guildId, authorId }
        );
        return row?.count || 0;
    }

    /**
     * Delete all memories authored by a user in a guild (per-user erasure).
     * @returns {number} rows removed
     */
    forgetUser(guildId, authorId) {
        return db.run(
            `DELETE FROM memory_embeddings
             WHERE guildId = @guildId AND authorId = @authorId`,
            { guildId, authorId }
        ).changes;
    }
}

module.exports = new MemoryService();
