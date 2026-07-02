const db = require('../db');
const aiService = require('./aiService');
const factsService = require('./factsService');

const CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const MAX_MEMORIES_PER_RUN = 120;
const MAX_NEW_FACTS_PER_RUN = 10;

/**
 * The "sleep cycle": periodically reviews each guild's recent raw memories,
 * distills durable facts out of them (deduplicated against existing facts),
 * and stores them via factsService. Raw embeddings stay for similarity
 * recall; facts capture what's *true* rather than what was *said*.
 */
class MemoryConsolidationService {
    constructor() {
        this.timer = null;
        this.running = false;
    }

    start() {
        if (this.timer) return;
        // First run shortly after boot (let the bot settle), then daily
        this.timer = setInterval(() => this.runOnce().catch(err =>
            console.error('[Consolidation] Run failed:', err.message)
        ), CONSOLIDATION_INTERVAL_MS);
        setTimeout(() => this.runOnce().catch(err =>
            console.error('[Consolidation] Initial run failed:', err.message)
        ), 5 * 60 * 1000);
        console.log('[Consolidation] Scheduled (daily)');
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /**
     * Consolidate all guilds with fresh memories from the last 24 hours.
     */
    async runOnce() {
        if (this.running) return;
        this.running = true;
        try {
            const guilds = db.all(
                `SELECT DISTINCT guildId FROM memory_embeddings
                 WHERE createdAt >= datetime('now', '-1 day')`
            );
            for (const { guildId } of guilds) {
                try {
                    await this.consolidateGuild(guildId);
                } catch (error) {
                    console.error(`[Consolidation] Guild ${guildId} failed:`, error.message);
                }
            }
        } finally {
            this.running = false;
        }
    }

    /**
     * Distill one guild's recent memories into new facts.
     * @returns {Promise<number>} number of new facts stored
     */
    async consolidateGuild(guildId) {
        const memories = db.all(
            `SELECT authorName, content, createdAt FROM memory_embeddings
             WHERE guildId = @guildId AND createdAt >= datetime('now', '-1 day')
             ORDER BY id ASC LIMIT @max`,
            { guildId, max: MAX_MEMORIES_PER_RUN }
        );
        if (memories.length < 3) return 0;

        const existingFacts = [
            ...factsService.getGuildFacts(guildId, 50).map(f => f.content),
            ...db.all(
                `SELECT content FROM facts WHERE guildId = @guildId AND subjectType = 'USER'
                 ORDER BY updatedAt DESC LIMIT 100`,
                { guildId }
            ).map(f => f.content)
        ];

        const transcript = memories
            .map(m => `[${m.createdAt}] ${m.authorName || 'someone'}: ${m.content}`)
            .join('\n');

        const prompt = `You are consolidating a Discord bot's memory. Below are raw conversation snippets from the last day, followed by facts already known.

Extract up to ${MAX_NEW_FACTS_PER_RUN} NEW durable facts worth remembering long-term: user preferences, ongoing projects, life events, running jokes, server conventions. Skip small talk, one-off questions, and anything already covered by an existing fact.

Respond with ONLY a JSON array. Each element: {"fact": "...", "about": "server"} or {"fact": "...", "about": "user", "userName": "<name from the transcript>"}. Respond with [] if nothing qualifies.

CONVERSATION SNIPPETS:
${transcript}

EXISTING FACTS (do not repeat these):
${existingFacts.length > 0 ? existingFacts.map(f => `- ${f}`).join('\n') : '(none)'}`;

        const response = await aiService.generateText(prompt, {
            temperature: 0.2,
            max_tokens: 800
        });

        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return 0;

        let extracted;
        try {
            extracted = JSON.parse(jsonMatch[0]);
        } catch {
            console.warn('[Consolidation] Model returned unparseable JSON, skipping run');
            return 0;
        }
        if (!Array.isArray(extracted)) return 0;

        // Map transcript author names back to Discord user ids
        const authorIds = new Map(
            db.all(
                `SELECT DISTINCT authorName, authorId FROM memory_embeddings
                 WHERE guildId = @guildId AND authorName IS NOT NULL AND authorId IS NOT NULL`,
                { guildId }
            ).map(r => [r.authorName.toLowerCase(), r.authorId])
        );

        let stored = 0;
        for (const item of extracted.slice(0, MAX_NEW_FACTS_PER_RUN)) {
            if (!item?.fact) continue;
            const isUser = item.about === 'user' && item.userName;
            const subjectId = isUser ? authorIds.get(String(item.userName).toLowerCase()) : null;

            const id = factsService.addFact({
                guildId,
                subjectType: isUser && subjectId ? 'USER' : 'GUILD',
                subjectId: isUser && subjectId ? subjectId : null,
                content: item.fact,
                source: 'consolidation'
            });
            if (id) stored++;
        }

        if (stored > 0) {
            console.log(`[Consolidation] Guild ${guildId}: stored ${stored} new fact(s)`);
        }
        return stored;
    }
}

module.exports = new MemoryConsolidationService();
