/**
 * Personalized new-chat suggestions for the Study's empty state.
 *
 * Active portal users see suggested opening queries drawn from what
 * Goobster actually knows about them - open attention loops, their
 * personal knowledge graph, recent conversations, and their projects -
 * instead of the static samples. One cached row per user
 * (web_suggested_queries), regenerated lazily when older than a day:
 * "active users, daily refresh" falls out of the access pattern with no
 * cron. The read path never blocks on the model - a stale cache is
 * served as-is while a background refresh replaces it for the next
 * visit, and a user with no context (or no AI provider) simply gets
 * null, which the client renders as the static defaults. Graceful
 * degradation, never a crash.
 *
 * Privacy: /forget-me deletes the row; auditUser counts it.
 */

const db = require('../db');
const { dmScopeId } = require('../utils/dmScope');
const logger = require('../utils/logger');

const TTL_MS = 24 * 60 * 60 * 1000;
const SUGGESTION_COUNT = 6;
const MAX_SUGGESTION_LENGTH = 90;
const MAX_CONTEXT_CONVERSATIONS = 8;
const MAX_CONTEXT_PROJECTS = 5;

function parseJsonObject(text) {
    if (!text) return null;
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

/** Deterministic legalization: strings only, trimmed, bounded, deduped. */
function legalizeSuggestions(raw) {
    const list = Array.isArray(raw?.suggestions) ? raw.suggestions
        : Array.isArray(raw) ? raw : [];
    const out = [];
    const seen = new Set();
    for (const item of list) {
        if (typeof item !== 'string') continue;
        const text = item.replace(/\s+/g, ' ').trim();
        if (!text || text.length > MAX_SUGGESTION_LENGTH) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= SUGGESTION_COUNT) break;
    }
    return out;
}

class WebSuggestionService {
    constructor() {
        /** userId -> in-flight refresh promise (one per process is plenty) */
        this._refreshing = new Map();
    }

    /**
     * The user's suggestions, cache-first. Returns
     * { suggestions: string[]|null, generatedAt: string|null } - null
     * suggestions mean "nothing personalized, show the defaults". A
     * stale (or missing) cache kicks a background refresh; the response
     * never waits on the model.
     */
    async getSuggestions({ userId }) {
        const row = await db.get(
            'SELECT suggestionsJson, generatedAt FROM web_suggested_queries WHERE userId = @userId',
            { userId }
        );
        let suggestions = null;
        if (row) {
            try {
                const parsed = JSON.parse(row.suggestionsJson);
                suggestions = Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
            } catch {
                suggestions = null;
            }
        }
        const generatedMs = row
            ? new Date(`${row.generatedAt.replace(' ', 'T')}Z`).getTime()
            : 0;
        if (!row || Date.now() - generatedMs > TTL_MS) {
            const refresh = this.refreshUser(userId).catch((error) => {
                logger.debug?.(`[WebSuggestions] refresh failed for ${userId}: ${error.message}`);
            });
            // Exposed so tests (and callers that want fresh-or-nothing)
            // can await the refresh this read started.
            this._lastRefresh = refresh;
        }
        return { suggestions, generatedAt: row?.generatedAt || null };
    }

    /**
     * Regenerate one user's suggestions now (deduped per process).
     * Resolves to the stored suggestions, or null when there was nothing
     * to personalize from or no provider answered.
     */
    async refreshUser(userId) {
        const inFlight = this._refreshing.get(userId);
        if (inFlight) return await inFlight;
        const work = this._generateAndStore(userId).finally(() => {
            this._refreshing.delete(userId);
        });
        this._refreshing.set(userId, work);
        return await work;
    }

    async _generateAndStore(userId) {
        const context = await this._buildContext(userId);
        if (!context) return null;

        const aiService = require('./aiService');
        const response = await aiService.generateText(
            'You write suggested opening queries for a returning user starting a new chat with '
            + 'Goobster - a playful, capable AI companion (long-term memory, research, image '
            + 'generation, sandboxed code and simulations, projects with apps/scripts/automations, '
            + 'a knowledge graph). Using what Goobster knows about THIS user below, write '
            + `${SUGGESTION_COUNT} short suggestions they would plausibly want to type today.\n\n`
            + 'Rules: each under 80 characters, phrased in the user\'s own voice ("Show me...", '
            + '"What happened with..."), specific to their actual context - never generic filler, '
            + 'never fabricated facts. Vary the type: follow up an open loop, check on a project, '
            + 'dig into something they know about, plus at most one playful/creative one.\n\n'
            + `${context}\n\n`
            + 'Respond with ONLY JSON: {"suggestions": ["...", "..."]}',
            { max_tokens: 400, usageContext: { guildId: dmScopeId(userId), userId } }
        );
        const suggestions = legalizeSuggestions(parseJsonObject(response));
        if (suggestions.length === 0) return null;

        await db.run(
            `INSERT INTO web_suggested_queries (userId, suggestionsJson, generatedAt)
             VALUES (@userId, @json, datetime('now'))
             ON CONFLICT (userId) DO UPDATE SET
                suggestionsJson = excluded.suggestionsJson,
                generatedAt = excluded.generatedAt`,
            { userId, json: JSON.stringify(suggestions) }
        );
        return suggestions;
    }

    /**
     * The compact personalization context, or null when the user has
     * nothing to personalize from yet (new users keep the defaults).
     */
    async _buildContext(userId) {
        const sections = [];

        try {
            const attentionLedgerService = require('./attentionLedgerService');
            const attention = await attentionLedgerService.describeForPrompt({ userId, limit: 8 });
            if (attention) sections.push(attention);
        } catch { /* attention is optional context */ }

        try {
            const knowledgeGraphService = require('./knowledgeGraphService');
            const knowledge = await knowledgeGraphService.describeForPrompt({
                guildId: dmScopeId(userId),
                scopeKey: `USER:${userId}`,
                limit: 10
            });
            if (knowledge) sections.push(`WHAT GOOBSTER KNOWS ABOUT THEM:\n${knowledge}`);
        } catch { /* knowledge is optional context */ }

        try {
            // Incognito chats are never persisted, so every stored row is
            // fair personalization context.
            const conversations = await db.all(
                `SELECT title FROM web_conversations
                 WHERE userId = @userId AND title IS NOT NULL
                 ORDER BY id DESC LIMIT @limit`,
                { userId, limit: MAX_CONTEXT_CONVERSATIONS }
            );
            if (conversations.length > 0) {
                sections.push('THEIR RECENT CHAT TOPICS (newest first):\n'
                    + conversations.map(row => `- ${row.title}`).join('\n'));
            }
        } catch { /* schema drift must not break suggestions */ }

        try {
            const projects = await db.all(
                `SELECT p.name FROM observatory_projects p
                 WHERE p.userId = @userId
                    OR EXISTS (SELECT 1 FROM project_members m
                               WHERE m.projectId = p.id AND m.userId = @userId)
                 ORDER BY p.updatedAt DESC LIMIT @limit`,
                { userId, limit: MAX_CONTEXT_PROJECTS }
            );
            if (projects.length > 0) {
                sections.push('THEIR PROJECTS:\n' + projects.map(row => `- ${row.name}`).join('\n'));
            }
        } catch { /* projects are optional context */ }

        return sections.length > 0 ? sections.join('\n\n') : null;
    }

    /** /forget-me: drop the cached suggestions. */
    async forgetUser(userId) {
        return (await db.run(
            'DELETE FROM web_suggested_queries WHERE userId = @userId', { userId }
        )).changes;
    }

    async countUser(userId) {
        return (await db.get(
            'SELECT COUNT(*) AS c FROM web_suggested_queries WHERE userId = @userId', { userId }
        ))?.c || 0;
    }
}

module.exports = new WebSuggestionService();
module.exports.legalizeSuggestions = legalizeSuggestions;
module.exports.SUGGESTION_TTL_MS = TTL_MS;
