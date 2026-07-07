const db = require('../db');
const aiConfig = require('../config/aiConfig');
const embeddingService = require('./embeddingService');
const { cosineSimilarity } = require('./embeddingService');

// Skip trivially short or command-like content; it pollutes recall.
const MIN_CONTENT_LENGTH = 20;
// Cap how many candidate rows are scored per recall (newest first).
// Only applies to the brute-force fallback path.
const MAX_CANDIDATES = 2000;

/**
 * Long-term semantic memory backed by SQLite.
 *
 * Messages are embedded asynchronously as conversations happen and recalled
 * via cosine similarity when a new message arrives, letting the bot remember
 * things far beyond the 20-message context window.
 *
 * Recall uses the sqlite-vec extension (indexed KNN inside SQLite, off the
 * JS hot path) when available, with vectors mirrored into per-dimension
 * virtual tables (memory_vec_<dims>, partitioned by guild+model). When the
 * extension can't load on a platform, recall falls back to the original
 * brute-force cosine scan over memory_embeddings.
 */
class MemoryService {
    constructor() {
        this._vecSynced = false;
    }

    isEnabled() {
        return aiConfig.memory.enabled;
    }

    /**
     * Whether indexed vector search is available on this platform.
     */
    isVecIndexAvailable() {
        try {
            return db.vecAvailable();
        } catch {
            return false;
        }
    }

    _vecTableName(dims) {
        return `memory_vec_${Number(dims)}`;
    }

    _ensureVecTable(dims) {
        const d = Number(dims);
        if (!Number.isInteger(d) || d <= 0) throw new Error(`Invalid embedding dims: ${dims}`);
        db.run(
            `CREATE VIRTUAL TABLE IF NOT EXISTS ${this._vecTableName(d)} USING vec0(
                mem_id INTEGER PRIMARY KEY,
                bucket TEXT partition key,
                embedding float[${d}] distance_metric=cosine
            )`
        );
    }

    _existingVecTables() {
        // vec0 creates shadow tables (memory_vec_N_info, _chunks, ...);
        // only the virtual tables themselves may be written to.
        return db.all(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory\\_vec\\_%' ESCAPE '\\'`
        ).map(r => r.name).filter(name => /^memory_vec_\d+$/.test(name));
    }

    /**
     * Bring the vec index in line with memory_embeddings: backfill missing
     * vectors (e.g. rows stored before the index existed or while the
     * extension was unavailable) and drop orphans left by direct deletes.
     * Runs once per process on first use; cheap when already in sync.
     */
    syncVecIndex() {
        if (!this.isVecIndexAvailable()) return;

        for (const { dims } of db.all('SELECT DISTINCT dims FROM memory_embeddings')) {
            const table = this._vecTableName(dims);
            this._ensureVecTable(dims);
            db.run(
                `INSERT INTO ${table} (mem_id, bucket, embedding)
                 SELECT m.id, m.guildId || '|' || m.model, m.embedding
                 FROM memory_embeddings m
                 WHERE m.dims = @dims AND m.id NOT IN (SELECT mem_id FROM ${table})`,
                { dims }
            );
        }
        this.cleanupVecIndex();
    }

    /**
     * Remove vec-index entries whose source memory row is gone. Called after
     * bulk deletions (prune, retention, erasure) so derived vectors don't
     * outlive the memories they were computed from.
     */
    cleanupVecIndex() {
        if (!this.isVecIndexAvailable()) return;
        for (const table of this._existingVecTables()) {
            db.run(`DELETE FROM ${table} WHERE mem_id NOT IN (SELECT id FROM memory_embeddings)`);
        }
    }

    _vecIndexInsert(memId, guildId, model, vector) {
        if (!this.isVecIndexAvailable()) return;
        try {
            this._ensureVecTable(vector.length);
            db.run(
                `INSERT INTO ${this._vecTableName(vector.length)} (mem_id, bucket, embedding)
                 VALUES (@memId, @bucket, @embedding)`,
                {
                    // vec0 only accepts strict INTEGER bindings for its
                    // primary key; JS numbers bind as REAL, so use BigInt.
                    memId: BigInt(memId),
                    bucket: `${guildId}|${model}`,
                    embedding: Buffer.from(vector.buffer)
                }
            );
        } catch (error) {
            console.warn('[MemoryService] Failed to index memory vector:', error.message);
        }
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

            const { lastInsertRowid } = db.run(
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
            this._vecIndexInsert(Number(lastInsertRowid), guildId, model, vector);

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
        const pruned = db.run(
            `DELETE FROM memory_embeddings
             WHERE guildId = @guildId
               AND id NOT IN (
                   SELECT id FROM memory_embeddings
                   WHERE guildId = @guildId
                   ORDER BY id DESC LIMIT @max
               )`,
            { guildId, max }
        ).changes;
        const retained = this.applyRetention(guildId);
        if (pruned > 0 || retained > 0) this.cleanupVecIndex();
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
        if (removed > 0) this.cleanupVecIndex();
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
        const removed = db.run(
            `DELETE FROM memory_embeddings
             WHERE guildId = @guildId AND channelId = @channelId`,
            { guildId, channelId }
        ).changes;
        if (removed > 0) this.cleanupVecIndex();
        return removed;
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
            const excluded = new Set(excludeContents.map(c => String(c).trim()));

            if (this.isVecIndexAvailable()) {
                try {
                    return this._recallIndexed({ guildId, model, queryVector, k, threshold, excluded });
                } catch (error) {
                    console.warn('[MemoryService] Indexed recall failed, falling back to scan:', error.message);
                }
            }

            return this._recallBruteForce({ guildId, model, queryVector, k, threshold, excluded });
        } catch (error) {
            console.warn('[MemoryService] Recall failed:', error.message);
            return [];
        }
    }

    /**
     * KNN recall through the sqlite-vec index (partitioned by guild+model,
     * cosine distance computed inside SQLite).
     */
    _recallIndexed({ guildId, model, queryVector, k, threshold, excluded }) {
        if (!this._vecSynced) {
            this.syncVecIndex();
            this._vecSynced = true;
        }

        const table = this._vecTableName(queryVector.length);
        this._ensureVecTable(queryVector.length);

        // Over-fetch to absorb entries filtered out below (context-window
        // exclusions and stale index rows deleted since the last cleanup).
        const fetchK = k + excluded.size + 8;

        const rows = db.all(
            `SELECT m.content, m.authorName, m.channelId, m.createdAt, v.distance
             FROM (
                 SELECT mem_id, distance FROM ${table}
                 WHERE bucket = @bucket AND embedding MATCH @queryVec AND k = @fetchK
             ) v
             JOIN memory_embeddings m ON m.id = v.mem_id
             ORDER BY v.distance ASC`,
            {
                bucket: `${guildId}|${model}`,
                queryVec: Buffer.from(queryVector.buffer),
                fetchK
            }
        );

        const results = [];
        for (const row of rows) {
            const similarity = 1 - row.distance; // cosine distance -> similarity
            if (similarity < threshold) break;   // rows are sorted by distance
            if (excluded.has(row.content)) continue;
            results.push({
                content: row.content,
                authorName: row.authorName,
                channelId: row.channelId,
                createdAt: row.createdAt,
                similarity
            });
            if (results.length >= k) break;
        }
        return results;
    }

    /**
     * Original brute-force cosine scan (used when sqlite-vec is unavailable).
     */
    _recallBruteForce({ guildId, model, queryVector, k, threshold, excluded }) {
        // Only compare vectors from the same embedding model
        const rows = db.all(
            `SELECT content, authorName, channelId, createdAt, embedding, dims
             FROM memory_embeddings
             WHERE guildId = @guildId AND model = @model
             ORDER BY id DESC LIMIT @max`,
            { guildId, model, max: MAX_CANDIDATES }
        );

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
        if (result.changes > 0) this.cleanupVecIndex();
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
        const removed = db.run(
            `DELETE FROM memory_embeddings
             WHERE guildId = @guildId AND authorId = @authorId`,
            { guildId, authorId }
        ).changes;
        if (removed > 0) this.cleanupVecIndex();
        return removed;
    }
}

module.exports = new MemoryService();
