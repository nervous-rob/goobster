/**
 * The Spitball Expedition research pipeline: one Cycle's worth of stages
 * (spec: documentation/spitball_expeditions.md §8):
 *
 *   build context -> plan -> search -> normalize sources -> filter/rank
 *   -> extract claims -> generate atomic notes -> propose tags/connections
 *   -> legalize via knowledgeGraphLegalizer -> coverage -> Leads
 *
 * This module is the seam between the durable orchestration (the runner and
 * spitballExpeditionService, which own state and budgets) and the semantic
 * work (model calls, search providers, evidence extraction). The runner
 * treats it as a black box with one method:
 *
 *   runCycle({ expedition, cycle, frontierInput, heartbeat })
 *     -> {
 *          plan: Object|null,           // structured research plan
 *          counters: {                  // exact results for the cycle row
 *            sourceCount, sourcesAccepted, claimsExtracted, notesProposed,
 *            notesCreated, notesMerged, edgesCreated, tagsAdded, conflictsFound
 *          },
 *          coverage: {                  // coverage evaluation (spec §22)
 *            summary, coveredQuestions, partiallyCoveredQuestions,
 *            unresolvedQuestions, majorNewConcepts, conflicts,
 *            coverageScore, noveltyScore
 *          },
 *          leads: Array<{               // ranked frontier Leads (spec §23)
 *            topic, kind, reason, relevance, novelty, uncertainty,
 *            expectedValue, suggestedQueries
 *          }>,
 *          noveltyScore: number,
 *          coverageScore: number
 *        }
 *
 * Contract rules the implementation must keep:
 *  - Knowledge mutations flow ONLY through knowledgeGraphLegalizer
 *    (source 'research', provenance { sourceKind: 'expedition' | claimIds }).
 *  - Sources/claims persist in research_sources / research_claims before any
 *    note generation uses them (evidence before synthesis).
 *  - All model outputs are strict-JSON parsed, clamped to
 *    spitballConfig.PIPELINE_CAPS, and degrade safely on malformed output.
 *  - No provider/model IDs hardcoded: routing stays in aiService/aiConfig.
 *
 * The current implementation is the Phase 2 placeholder: it performs no
 * research and reports zero accepted sources, which the deterministic
 * continuation policy turns into a clean NO_NEW_SOURCES stop. The Phase 3
 * single-cycle research MVP replaces the body, not the seam.
 */

async function runCycle({ heartbeat = async () => {} } = {}) {
    await heartbeat();
    return {
        plan: null,
        counters: {
            sourceCount: 0,
            sourcesAccepted: 0,
            claimsExtracted: 0,
            notesProposed: 0,
            notesCreated: 0,
            notesMerged: 0,
            edgesCreated: 0,
            tagsAdded: 0,
            conflictsFound: 0
        },
        coverage: {
            summary: 'The research pipeline is not implemented yet; no sources were gathered.',
            coveredQuestions: [],
            partiallyCoveredQuestions: [],
            unresolvedQuestions: [],
            majorNewConcepts: [],
            conflicts: [],
            coverageScore: 0,
            noveltyScore: 0
        },
        leads: [],
        noveltyScore: 0,
        coverageScore: 0
    };
}

module.exports = { runCycle };
