const db = require('../db');
const aiService = require('./aiService');
const factsService = require('./factsService');
const knowledgeGraphService = require('./knowledgeGraphService');
const memoryService = require('./memoryService');
const kgConfig = require('../config/knowledgeGraphConfig');
const { isDmScopeId } = require('../utils/dmScope');

const CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_MEMORIES_PER_RUN = kgConfig.LIMITS.consolidation.maxMemoriesReviewed;

/**
 * Sleep cycle: reviews recent raw memories, distills them into the user
 * knowledge graph (nodes, edges, tags), mirrors critical facts to the legacy
 * facts table, marks memories as distilled, and retires stale distilled rows.
 * Spec: documentation/user_knowledge_graph.md
 */
class MemoryConsolidationService {
    constructor() {
        this.timer = null;
        this.running = false;
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.runOnce().catch(err =>
            console.error('[Consolidation] Run failed:', err.message)
        ), CONSOLIDATION_INTERVAL_MS);
        setTimeout(() => this.runOnce().catch(err =>
            console.error('[Consolidation] Initial run failed:', err.message)
        ), 5 * 60 * 1000);
        console.log('[Consolidation] Scheduled (daily, graph distillation)');
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async runOnce() {
        const outcome = await db.withSingletonLock('memory_consolidation', async () => {
            if (this.running) return;
            this.running = true;
            try {
                return await this._runOnceBody();
            } finally {
                this.running = false;
            }
        });
        if (!outcome.acquired) {
            console.warn('[Consolidation] Run skipped: another process holds the singleton lock');
            return { skipped: true };
        }
        return outcome.result;
    }

    async _runOnceBody() {
        try {
            const purged = await memoryService.applyRetentionAll();
            if (purged > 0) {
                console.log(`[Consolidation] Retention purge removed ${purged} memories`);
            }
        } catch (error) {
            console.warn('[Consolidation] Retention purge failed:', error.message);
        }

        try {
            const distilledPurged = await memoryService.purgeDistilledMemories();
            if (distilledPurged > 0) {
                console.log(`[Consolidation] Distilled memory retirement removed ${distilledPurged} rows`);
            }
        } catch (error) {
            console.warn('[Consolidation] Distilled purge failed:', error.message);
        }

        const guilds = await db.all(
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
    }

    async consolidateGuild(guildId) {
        const memories = await db.all(
            `SELECT id, authorName, authorId, content, createdAt, channelId FROM memory_embeddings
             WHERE guildId = @guildId AND createdAt >= datetime('now', '-1 day')
             ORDER BY id ASC LIMIT @max`,
            { guildId, max: MAX_MEMORIES_PER_RUN }
        );
        const minAny = isDmScopeId(guildId)
            ? kgConfig.MIN_MEMORIES_DM_SCOPE
            : kgConfig.MIN_MEMORIES_PER_AUTHOR;
        if (memories.length < minAny) return 0;

        const authorIds = new Map(
            (await db.all(
                `SELECT DISTINCT authorName, authorId FROM memory_embeddings
                 WHERE guildId = @guildId AND authorName IS NOT NULL AND authorId IS NOT NULL`,
                { guildId }
            )).map(r => [r.authorName.toLowerCase(), r.authorId])
        );

        const projectService = require('./projectService');
        const destCache = new Map();
        const buckets = new Map();
        for (const mem of memories) {
            let dest = null;
            if (mem.channelId) {
                if (destCache.has(mem.channelId)) {
                    dest = destCache.get(mem.channelId);
                } else {
                    dest = await projectService.resolveKnowledgeScopeForChannel(mem.channelId);
                    destCache.set(mem.channelId, dest);
                }
            }
            const key = dest
                ? `project:${dest.projectId}`
                : (mem.authorId || '_guild');
            if (!buckets.has(key)) buckets.set(key, { memories: [], dest });
            buckets.get(key).memories.push(mem);
        }

        let totalApplied = 0;
        for (const { memories: batch, dest } of buckets.values()) {
            const isProject = Boolean(dest?.projectId);
            const userId = isProject
                ? dest.ownerId
                : (batch[0].authorId || null);
            const minBatch = (isProject || (userId && isDmScopeId(guildId)))
                ? kgConfig.MIN_MEMORIES_DM_SCOPE
                : kgConfig.MIN_MEMORIES_PER_AUTHOR;
            if (batch.length < minBatch) continue;

            const writeGuildId = isProject ? dest.guildId : guildId;
            const scopeKey = isProject
                ? dest.scopeKey
                : (userId
                    ? knowledgeGraphService.resolveScopeKey({ subjectType: 'USER', subjectId: userId })
                    : 'GUILD');
            const subjectType = userId ? 'USER' : 'GUILD';
            const subjectId = userId;

            const existingGraph = await knowledgeGraphService.describeForPrompt({
                guildId: writeGuildId,
                scopeKey,
                limit: 15
            });
            const existingFacts = (existingGraph || isProject)
                ? []
                : (userId
                    ? (await factsService.getUserFacts(guildId, userId, 30)).map(f => f.content)
                    : (await factsService.getGuildFacts(guildId, 30)).map(f => f.content));

            const transcript = batch
                .map(m => `[${m.createdAt}] ${m.authorName || 'someone'}: ${m.content}`)
                .join('\n');

            const prompt = this._buildPrompt({
                transcript, existingGraph, existingFacts, userId: isProject ? dest.projectId : userId
            });

            const response = await aiService.generateText(prompt, {
                temperature: 0.2,
                max_tokens: 1200
            });

            const parsed = this._parseResponse(response);
            if (!parsed) continue;

            const memoryIds = batch.map(m => m.id);

            if (parsed.mutations) {
                const applied = await knowledgeGraphService.applyMutations({
                    guildId: writeGuildId,
                    scopeKey,
                    subjectType,
                    subjectId,
                    source: 'consolidation',
                    mutations: parsed.mutations
                });
                totalApplied += applied.nodesUpserted + applied.linksCreated
                    + applied.nodesMerged + applied.contradictions;

                if (knowledgeGraphService.hasMutationWork(applied)) {
                    await memoryService.markDistilled(memoryIds);
                }

                if (!isProject) {
                    for (const item of (parsed.facts || []).slice(0, kgConfig.LIMITS.consolidation.maxNewFactsLegacy)) {
                        if (!item?.fact) continue;
                        const isUser = item.about === 'user' && item.userName;
                        const factSubjectId = isUser ? authorIds.get(String(item.userName).toLowerCase()) : userId;
                        await factsService.addFact({
                            guildId,
                            subjectType: isUser && factSubjectId ? 'USER' : 'GUILD',
                            subjectId: isUser && factSubjectId ? factSubjectId : null,
                            content: item.fact,
                            source: 'consolidation'
                        });
                    }
                }
            } else if (Array.isArray(parsed) && !isProject) {
                // Legacy facts-only array
                let factsAdded = 0;
                for (const item of parsed.slice(0, kgConfig.LIMITS.consolidation.maxNewFactsLegacy)) {
                    if (!item?.fact) continue;
                    const isUser = item.about === 'user' && item.userName;
                    const factSubjectId = isUser ? authorIds.get(String(item.userName).toLowerCase()) : userId;
                    const factId = await factsService.addFact({
                        guildId,
                        subjectType: isUser && factSubjectId ? 'USER' : 'GUILD',
                        subjectId: isUser && factSubjectId ? factSubjectId : null,
                        content: item.fact,
                        source: 'consolidation'
                    });
                    if (factId) {
                        factsAdded++;
                        totalApplied++;
                    }
                }
                if (factsAdded > 0) {
                    await memoryService.markDistilled(memoryIds);
                }
            }
        }

        if (totalApplied > 0) {
            console.log(`[Consolidation] Guild ${guildId}: applied ${totalApplied} graph/fact update(s)`);
        }
        return totalApplied;
    }

    _buildPrompt({ transcript, existingGraph, existingFacts, userId }) {
        const limits = kgConfig.LIMITS.consolidation;
        return `You are consolidating a Discord bot's memory into a knowledge graph. Review conversation snippets and produce structured graph mutations.

Extract durable knowledge: preferences, projects, relationships, running jokes, server conventions. Skip small talk and duplicates.

Respond with ONLY JSON:
{
  "mutations": {
    "upsert": [{ "type": "fact|concept|experience|...", "label": "short unique title", "content": "detail", "salience": 0.7, "confidence": 0.8, "tags": ["topic"] }],
    "link": [{ "source": "label", "target": "label", "relation": "caused_by|part_of|relates_to|...", "relationKind": "causal|logical|associative|temporal|social", "weight": 0.8 }],
    "tag": [{ "label": "existing node label", "tags": ["tag"] }],
    "merge": [{ "keep": "label-a", "drop": "label-b" }],
    "delete": ["stale-label"],
    "contradict": [{ "source": "older claim", "target": "newer claim" }]
  },
  "facts": [{ "fact": "legacy mirror sentence", "about": "user|server", "userName": "name if about user" }]
}

Caps: ≤${limits.maxMutationsUpsert} upserts, ≤${limits.maxMutationsLink} links. Empty arrays are fine.

CONVERSATION SNIPPETS:
${transcript}

EXISTING GRAPH:
${existingGraph || '(empty)'}
${existingFacts.length > 0 ? `\nEXISTING FACTS (legacy, do not repeat):\n${existingFacts.map(f => `- ${f}`).join('\n')}` : ''}

Scope: ${userId ? `USER ${userId}` : 'GUILD-wide'}`;
    }

    _parseResponse(response) {
        const jsonMatch = String(response || '').match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (!jsonMatch) return null;
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed)) return parsed;
            if (parsed && typeof parsed === 'object') return parsed;
        } catch {
            console.warn('[Consolidation] Model returned unparseable JSON, skipping run');
        }
        return null;
    }
}

module.exports = new MemoryConsolidationService();
