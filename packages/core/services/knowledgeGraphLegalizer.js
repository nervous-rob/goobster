const db = require('../db');
const embeddingService = require('./embeddingService');
const { cosineSimilarity } = require('./embeddingService');
const kgConfig = require('../config/knowledgeGraphConfig');

/**
 * Deterministic legalizer for knowledge-graph mutations.
 * The model proposes; this module decides. Spec: documentation/user_knowledge_graph.md
 */
class KnowledgeGraphLegalizer {
    /**
     * @param {Object} kg - knowledgeGraphService instance (for upsert/link helpers)
     */
    constructor(kg) {
        this.kg = kg;
    }

    /**
     * Apply a batch of mutations within caps.
     * @param {Object} params
     * @param {string} params.guildId
     * @param {string} [params.scopeKey]
     * @param {string} [params.subjectType]
     * @param {string} [params.subjectId]
     * @param {string} [params.source]
     * @param {Object} params.mutations
     * @param {Object} [params.limits]
     * @param {Array<{sourceKind: string, sourceId?: number}>} [params.provenanceBatch]
     * @returns {Promise<Object>} applied counts
     */
    async applyMutations({
        guildId,
        scopeKey = '',
        subjectType = null,
        subjectId = null,
        source = 'consolidation',
        mutations = {},
        limits = kgConfig.LIMITS.consolidation,
        provenanceBatch = []
    } = {}) {
        const applied = {
            nodesUpserted: 0,
            linksCreated: 0,
            nodesDeleted: 0,
            nodesMerged: 0,
            tagsApplied: 0,
            contradictions: 0
        };

        const upserts = Array.isArray(mutations.upsert) ? mutations.upsert : [];
        for (const node of upserts.slice(0, limits.maxMutationsUpsert || 12)) {
            if (!node?.label) continue;
            const merged = await this._resolveSemanticDuplicate({
                guildId,
                scopeKey,
                label: node.label,
                content: node.content
            });
            const targetLabel = merged?.label || node.label;
            const result = await this.kg.upsertNode({
                guildId,
                scopeKey,
                subjectType,
                subjectId,
                source,
                type: node.type,
                label: targetLabel,
                content: merged ? this._mergeContent(merged.content, node.content) : node.content,
                salience: merged ? Math.max(merged.salience ?? 0.5, node.salience ?? 0.5) : node.salience,
                confidence: merged
                    ? this._mergeConfidence(merged.confidence, node.confidence)
                    : node.confidence
            });
            if (result) {
                applied.nodesUpserted++;
                if (Array.isArray(node.tags)) {
                    applied.tagsApplied += await this.kg.addTagsToNode({
                        guildId,
                        scopeKey,
                        label: targetLabel,
                        tags: node.tags
                    });
                }
                for (const prov of provenanceBatch) {
                    await this.kg.addProvenance({
                        nodeId: result.id,
                        sourceKind: prov.sourceKind,
                        sourceId: prov.sourceId ?? null
                    });
                }
            }
            if (merged && merged.label.toLowerCase() !== String(node.label).trim().toLowerCase()) {
                applied.nodesMerged++;
            }
        }

        if (Array.isArray(mutations.tag)) {
            for (const entry of mutations.tag.slice(0, limits.maxMutationsUpsert || 12)) {
                if (!entry?.label || !Array.isArray(entry.tags)) continue;
                applied.tagsApplied += await this.kg.addTagsToNode({
                    guildId,
                    scopeKey,
                    label: entry.label,
                    tags: entry.tags
                });
            }
        }

        if (Array.isArray(mutations.link)) {
            for (const edge of mutations.link.slice(0, limits.maxMutationsLink || 15)) {
                if (edge && await this.kg.link({
                    guildId,
                    scopeKey,
                    source: edge.source,
                    target: edge.target,
                    relation: edge.relation,
                    relationKind: edge.relationKind,
                    weight: edge.weight
                })) {
                    applied.linksCreated++;
                }
            }
        }

        if (Array.isArray(mutations.contradict)) {
            for (const pair of mutations.contradict.slice(0, limits.maxMutationsLink || 15)) {
                if (!pair?.source || !pair?.target) continue;
                if (await this.kg.link({
                    guildId,
                    scopeKey,
                    source: pair.source,
                    target: pair.target,
                    relation: 'contradicts',
                    relationKind: 'logical',
                    weight: 0.9
                })) {
                    applied.contradictions++;
                    applied.linksCreated++;
                }
            }
        }

        if (Array.isArray(mutations.merge)) {
            for (const merge of mutations.merge.slice(0, limits.maxMutationsMerge || 4)) {
                if (!merge?.keep || !merge?.drop) continue;
                if (await this.kg.mergeNodes({
                    guildId,
                    scopeKey,
                    keepLabel: merge.keep,
                    dropLabel: merge.drop
                })) {
                    applied.nodesMerged++;
                }
            }
        }

        if (Array.isArray(mutations.delete)) {
            for (const label of mutations.delete.slice(0, limits.maxMutationsDelete || 6)) {
                applied.nodesDeleted += await this.kg.deleteNode(guildId, label, scopeKey);
            }
        }

        await this.kg.pruneScope(guildId, scopeKey);
        return applied;
    }

    _mergeContent(existing, incoming) {
        const a = String(existing || '').trim();
        const b = String(incoming || '').trim();
        if (!a) return b || null;
        if (!b || a.toLowerCase() === b.toLowerCase()) return a;
        return a.length >= b.length ? a : b;
    }

    _mergeConfidence(a, b) {
        const x = Number(a);
        const y = Number(b);
        const left = Number.isFinite(x) ? x : 0.5;
        const right = Number.isFinite(y) ? y : 0.5;
        return Math.min(1, Math.max(0, (left + right) / 2));
    }

    async _resolveSemanticDuplicate({ guildId, scopeKey, label, content }) {
        const exact = await this.kg.getNode(guildId, label, scopeKey);
        if (exact) return exact;

        const trimmed = String(content || '').trim();
        if (trimmed) {
            const byContent = await db.get(
                `SELECT * FROM kg_nodes
                 WHERE guildId = @guildId AND scopeKey = @scopeKey AND content = @content`,
                { guildId, scopeKey, content: trimmed.slice(0, kgConfig.MAX_CONTENT_LENGTH) }
            );
            if (byContent) return byContent;
        }

        try {
            const text = `${label} ${content || ''}`.trim();
            if (text.length < 12) return null;
            const { vector, model } = await embeddingService.embed(text);
            const candidates = await db.all(
                `SELECT * FROM kg_nodes
                 WHERE guildId = @guildId AND scopeKey = @scopeKey
                 ORDER BY updatedAt DESC LIMIT 40`,
                { guildId, scopeKey }
            );
            for (const candidate of candidates) {
                const candidateText = `${candidate.label} ${candidate.content || ''}`.trim();
                if (candidateText.length < 8) continue;
                const embedded = await embeddingService.embed(candidateText);
                if (embedded.model !== model) continue;
                const score = cosineSimilarity(vector, embedded.vector);
                if (score >= kgConfig.SEMANTIC_MERGE_THRESHOLD) return candidate;
            }
        } catch {
            // Embedding unavailable — skip semantic dedupe
        }
        return null;
    }
}

module.exports = KnowledgeGraphLegalizer;
