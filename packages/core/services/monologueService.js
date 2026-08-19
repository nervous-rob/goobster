const db = require('../db');
const aiService = require('./aiService');
const factsService = require('./factsService');
const memoryService = require('./memoryService');
const knowledgeGraphService = require('./knowledgeGraphService');
const kgConfig = require('../config/knowledgeGraphConfig');
const { resolveDisplayNames } = require('../utils/channelDigest');
const { getMonologueMode, MONOLOGUE_MODE } = require('../utils/guildSettings');

// How often the monologue considers running (per process tick)
const TICK_INTERVAL_MS = 15 * 60 * 1000;
// Minimum gap between introspections in the same guild (persisted via the
// monologue_thoughts table, so restarts don't reset it)
const INTROSPECTION_COOLDOWN_MS = 30 * 60 * 1000;
// Only introspect when humans talked this recently
const ACTIVITY_WINDOW_MS = 2 * 60 * 60 * 1000;
// Minimum human messages in the window before a tick is worth spending on
const MIN_HUMAN_MESSAGES = 2;

// Storage caps
const MAX_SCRATCHPAD_NOTES = 25;
const MAX_THOUGHTS_KEPT = 200;
const MAX_NOTE_LENGTH = 300;
const MAX_THOUGHT_LENGTH = 1200;

// Per-tick action caps (defense against runaway model output)
const MAX_NOTE_ADDS_PER_TICK = 4;
const MAX_NOTE_REMOVES_PER_TICK = 6;

const DISCORD_EPOCH = 1420070400000n;

function snowflakeToTimestamp(id) {
    try {
        return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
    } catch {
        return 0;
    }
}

/** Parse a UTC 'YYYY-MM-DD HH:MM:SS' timestamp into epoch milliseconds. */
function utcTextToEpoch(text) {
    if (!text) return 0;
    const parsed = Date.parse(String(text).replace(' ', 'T') + 'Z');
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The internal monologue: a background thought process that runs per guild
 * when enabled via /monologue. Each introspection tick the persona privately
 * reviews recent chat context, its scratch pad, recalled long-term memories,
 * known facts, and its knowledge graph - then thinks. The resulting private
 * thought is journaled, the scratch pad is curated (notes added/removed),
 * and the knowledge graph is updated (nodes created/updated/deleted, edges
 * linked) so understanding accumulates between ticks.
 *
 * Nothing here posts to Discord. The only outward effect is a compact
 * "inner life" block injected into normal chat prompts (buildChatContext),
 * which lets the private thought process subtly inform replies.
 */
class MonologueService {
    constructor(client) {
        this.client = client;
        this.tickTimer = null;
        this.ticking = false;
        // Singleton handle for prompt injection; detached helper instances
        // (client-less, DB reads only) must not clobber the live service.
        if (client) MonologueService.instance = this;
    }

    start() {
        if (this.tickTimer) return;
        this.tickTimer = setInterval(() => this.tick().catch(err =>
            console.error('[Monologue] Tick failed:', err.message)
        ), TICK_INTERVAL_MS);
        console.log('[Monologue] Started (tick every 15m, per-guild cooldown 30m)');
    }

    stop() {
        if (this.tickTimer) clearInterval(this.tickTimer);
        this.tickTimer = null;
    }

    /**
     * One pass over all opted-in guilds.
     * @returns {Promise<{skipped: boolean}|undefined>}
     */
    async tick() {
        const outcome = await db.withSingletonLock('monologue', async () => {
            if (this.ticking) return;
            this.ticking = true;
            try {
                for (const guild of this.client.guilds.cache.values()) {
                    try {
                        const mode = await getMonologueMode(guild.id);
                        if (mode !== MONOLOGUE_MODE.ENABLED) continue;

                        if (Date.now() - await this.lastThoughtAt(guild.id) < INTROSPECTION_COOLDOWN_MS) continue;

                        await this.considerGuild(guild);
                    } catch (error) {
                        console.error(`[Monologue] Guild ${guild.id} failed:`, error.message);
                    }
                }
            } finally {
                this.ticking = false;
            }
        });
        if (!outcome.acquired) {
            console.warn('[Monologue] Tick skipped: another process holds the singleton lock');
            return { skipped: true };
        }
        return outcome.result;
    }

    /**
     * Epoch ms of the guild's most recent journaled thought (0 when none).
     * Derived from the monologue_thoughts table so it survives restarts.
     */
    async lastThoughtAt(guildId) {
        const row = await db.get(
            'SELECT MAX(createdAt) AS last FROM monologue_thoughts WHERE guildId = @guildId',
            { guildId }
        );
        return utcTextToEpoch(row?.last);
    }

    /**
     * Find the most recently active eligible text channel in a guild.
     */
    _findActiveChannel(guild) {
        let best = null;
        let bestTime = 0;
        for (const channel of guild.channels.cache.values()) {
            if (!channel.isTextBased?.() || channel.isThread?.()) continue;
            if (!channel.viewable || !channel.lastMessageId) continue;
            const permissions = channel.permissionsFor(guild.members.me);
            if (!permissions?.has('ReadMessageHistory')) continue;

            const lastTime = snowflakeToTimestamp(channel.lastMessageId);
            if (lastTime > bestTime) {
                bestTime = lastTime;
                best = channel;
            }
        }
        return bestTime > Date.now() - ACTIVITY_WINDOW_MS ? best : null;
    }

    /**
     * Gather live chat context for one guild and run an introspection.
     */
    async considerGuild(guild) {
        const channel = this._findActiveChannel(guild);
        if (!channel) return null;

        // Respect memory privacy scope: excluded channels feed nothing
        if (await memoryService.isChannelExcluded(guild.id, channel.id)) return null;

        const fetched = await channel.messages.fetch({ limit: 20 });
        const cutoff = Date.now() - ACTIVITY_WINDOW_MS;
        const recent = [...fetched.values()]
            .filter(m => m.createdTimestamp > cutoff && m.content)
            .reverse();

        const humanMessages = recent.filter(m => !m.author.bot);
        if (humanMessages.length < MIN_HUMAN_MESSAGES) return null;

        // Skip when nothing new happened since the last thought
        const newestHuman = humanMessages[humanMessages.length - 1];
        if (newestHuman.createdTimestamp <= await this.lastThoughtAt(guild.id)) return null;

        const names = await resolveDisplayNames(guild, recent);
        const transcript = recent
            .map(m => `${names.get(m.author.id)}${m.author.bot ? ' (bot)' : ''}: ${m.content.slice(0, 300)}`)
            .join('\n');

        return await this.runIntrospection({
            guildId: guild.id,
            guildName: guild.name,
            channelId: channel.id,
            channelName: channel.name,
            transcript
        });
    }

    /**
     * One private introspection pass. Pure with respect to Discord: callers
     * supply the transcript, everything else comes from SQLite.
     * @param {Object} params - { guildId, guildName, channelId, channelName, transcript }
     * @returns {Promise<{thoughtId: number, applied: Object}|null>} null when
     *   the model produced nothing usable
     */
    async runIntrospection({ guildId, guildName = 'this server', channelId = null, channelName = null, transcript = '' }) {
        const scratchpad = await this.getScratchpad(guildId);
        const recentThoughts = await this.getRecentThoughts(guildId, 3);
        const memories = await memoryService.recall({
            guildId,
            query: transcript || 'what has been happening in this server lately',
            limit: 5
        });

        const graphExcerpt = await knowledgeGraphService.describeForPrompt({
            guildId,
            query: transcript,
            limit: 12
        });
        const guildFacts = graphExcerpt
            ? []
            : await factsService.getGuildFacts(guildId, 8);

        const prompt = this._buildIntrospectionPrompt({
            guildName,
            channelName,
            transcript,
            scratchpad,
            recentThoughts,
            guildFacts,
            memories,
            graphExcerpt
        });

        const response = await aiService.generateText(prompt, {
            temperature: 0.6,
            max_tokens: 900,
            usageContext: { guildId }
        });

        const decision = this._parseDecision(response);
        if (!decision) {
            console.warn(`[Monologue] Guild ${guildId}: unparseable introspection response, skipping`);
            return null;
        }

        const applied = await this._applyDecision(guildId, decision);

        const thoughtText = String(decision.thought || '').trim().slice(0, MAX_THOUGHT_LENGTH)
            || '(quiet tick - nothing noteworthy)';
        const thoughtId = await this.recordThought(guildId, thoughtText, channelId);

        console.log(`[Monologue] Guild ${guildId}: thought #${thoughtId}`
            + ` (+${applied.notesAdded}/-${applied.notesRemoved} notes,`
            + ` ${applied.nodesUpserted} nodes, ${applied.linksCreated} links, ${applied.nodesDeleted} deleted)`);
        return { thoughtId, applied };
    }

    _buildIntrospectionPrompt({ guildName, channelName, transcript, scratchpad, recentThoughts, guildFacts, memories, graphExcerpt }) {
        const now = new Date();
        const sections = [];

        if (transcript) {
            sections.push(`RECENT CONVERSATION${channelName ? ` in #${channelName}` : ''} (newest last):\n${transcript}`);
        }
        if (recentThoughts.length > 0) {
            sections.push(`YOUR RECENT PRIVATE THOUGHTS (newest first):\n${recentThoughts.map(t => `- [${t.createdAt} UTC] ${t.thought}`).join('\n')}`);
        }
        if (scratchpad.length > 0) {
            sections.push(`YOUR SCRATCH PAD (working notes; reference by id):\n${scratchpad.map(n => `- (id ${n.id}) ${n.content}`).join('\n')}`);
        }
        if (guildFacts.length > 0) {
            sections.push(`FACTS YOU KNOW ABOUT THIS SERVER:\n${guildFacts.map(f => `- ${f.content}`).join('\n')}`);
        }
        if (memories.length > 0) {
            sections.push(`RECALLED LONG-TERM MEMORIES (semantic recall):\n${memories.map(m => `- [${m.createdAt}] ${m.authorName || 'someone'}: ${m.content}`).join('\n')}`);
        }
        if (graphExcerpt) {
            sections.push(`YOUR KNOWLEDGE GRAPH (relevant excerpt - nodes and semantic links):\n${graphExcerpt}`);
        }

        return `You are Goobster, a Discord bot with an inner life. This is your PRIVATE internal monologue for the server "${guildName}". Nobody will ever read these thoughts - they exist so you can reflect, connect ideas, and build durable understanding over time.

Current time: ${now.toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: 'numeric', month: 'long', day: 'numeric' })}

${sections.join('\n\n')}

Reflect on all of the above. Then curate your inner state:
- "thought": 2-4 sentences of genuine private reflection (observations, hunches, opinions, things to keep an eye on). Required.
- "scratchpad": short working notes to yourself. Add notes worth keeping ("watch how the deploy goes", "Alice seems stressed lately"); remove note ids that are stale or resolved. Never add a note that repeats or paraphrases one already on the pad.
- "graph": your knowledge network. Nodes are concepts/facts/opinions/experiences/people/places/events/things with a short unique label, optional content, and salience 0-1 (how central it is to server life right now). Edges are semantic relationships between node labels ("relates_to", "caused_by", "example_of", "member_of", "disagrees_with", or any short verb phrase) with weight 0-1. Create nodes for durable ideas, update salience/content as things evolve, link related nodes, and delete nodes that turned out wrong or irrelevant.

Only record what is genuinely worth keeping - empty arrays are a fine answer. Respond with ONLY JSON in exactly this shape (all keys except "thought" optional):
{
  "thought": "<your private reflection>",
  "scratchpad": { "add": ["<note>"], "remove": [<note id>] },
  "graph": {
    "upsert": [{ "type": "concept|fact|opinion|experience|person|place|event|thing", "label": "<short label>", "content": "<optional detail>", "salience": 0.7 }],
    "link": [{ "source": "<label>", "relation": "<relationship>", "target": "<label>", "weight": 0.8 }],
    "delete": ["<label>"]
  }
}`;
    }

    /**
     * Extract the JSON decision object from a model response.
     * @returns {Object|null}
     */
    _parseDecision(response) {
        const jsonMatch = String(response || '').match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;
        }
    }

    /**
     * Apply a parsed introspection decision (scratchpad + graph mutations)
     * with per-tick caps. Individual invalid entries are skipped, never fatal.
     */
    async _applyDecision(guildId, decision) {
        const applied = {
            notesAdded: 0,
            notesRemoved: 0,
            nodesUpserted: 0,
            linksCreated: 0,
            nodesDeleted: 0
        };

        const pad = decision.scratchpad || {};
        if (Array.isArray(pad.add)) {
            for (const note of pad.add.slice(0, MAX_NOTE_ADDS_PER_TICK)) {
                if (await this.addNote(guildId, note)) applied.notesAdded++;
            }
        }
        if (Array.isArray(pad.remove)) {
            for (const id of pad.remove.slice(0, MAX_NOTE_REMOVES_PER_TICK)) {
                applied.notesRemoved += await this.removeNote(guildId, id);
            }
        }

        const graph = decision.graph || {};
        const hasGraphMutations = knowledgeGraphService.hasMutationPayload({
            upsert: graph.upsert,
            link: graph.link,
            delete: graph.delete,
            tag: graph.tag,
            merge: graph.merge,
            contradict: graph.contradict
        });
        if (hasGraphMutations) {
            const graphApplied = await knowledgeGraphService.applyMutations({
                guildId,
                scopeKey: '',
                source: 'monologue',
                mutations: {
                    upsert: graph.upsert,
                    link: graph.link,
                    delete: graph.delete,
                    tag: graph.tag,
                    merge: graph.merge,
                    contradict: graph.contradict
                },
                limits: kgConfig.LIMITS.monologue
            });
            applied.nodesUpserted += graphApplied.nodesUpserted;
            applied.linksCreated += graphApplied.linksCreated;
            applied.nodesDeleted += graphApplied.nodesDeleted;
        }

        return applied;
    }

    // ---------------------------------------------------------------------
    // Thought journal
    // ---------------------------------------------------------------------

    /**
     * Journal a private thought.
     * @returns {number} thought id
     */
    async recordThought(guildId, thought, channelId = null) {
        const newId = await db.insert(
            `INSERT INTO monologue_thoughts (guildId, thought, channelId)
             VALUES (@guildId, @thought, @channelId)`,
            { guildId, thought: String(thought).slice(0, MAX_THOUGHT_LENGTH), channelId }
        );
        await db.run(
            `DELETE FROM monologue_thoughts
             WHERE guildId = @guildId
               AND id NOT IN (
                   SELECT id FROM monologue_thoughts
                   WHERE guildId = @guildId ORDER BY id DESC LIMIT @max
               )`,
            { guildId, max: MAX_THOUGHTS_KEPT }
        );
        return newId;
    }

    /**
     * Most recent private thoughts, newest first.
     */
    async getRecentThoughts(guildId, limit = 5) {
        return await db.all(
            `SELECT id, thought, channelId, createdAt FROM monologue_thoughts
             WHERE guildId = @guildId ORDER BY id DESC LIMIT @limit`,
            { guildId, limit }
        );
    }

    // ---------------------------------------------------------------------
    // Scratch pad
    // ---------------------------------------------------------------------

    /**
     * Add a working note. Deduplicates on exact content per guild.
     * @returns {number|null} note id, or null when skipped
     */
    async addNote(guildId, content) {
        const trimmed = String(content || '').trim().slice(0, MAX_NOTE_LENGTH);
        if (!guildId || !trimmed) return null;

        const existing = await db.get(
            'SELECT id FROM monologue_scratchpad WHERE guildId = @guildId AND content = @content',
            { guildId, content: trimmed }
        );
        if (existing) {
            await db.run(
                'UPDATE monologue_scratchpad SET updatedAt = CURRENT_TIMESTAMP WHERE id = @id',
                { id: existing.id }
            );
            return existing.id;
        }

        const newId = await db.insert(
            'INSERT INTO monologue_scratchpad (guildId, content) VALUES (@guildId, @content)',
            { guildId, content: trimmed }
        );
        await db.run(
            `DELETE FROM monologue_scratchpad
             WHERE guildId = @guildId
               AND id NOT IN (
                   SELECT id FROM monologue_scratchpad
                   WHERE guildId = @guildId ORDER BY updatedAt DESC, id DESC LIMIT @max
               )`,
            { guildId, max: MAX_SCRATCHPAD_NOTES }
        );
        return newId;
    }

    /**
     * Remove a note by id (guild-scoped so one guild can't touch another's).
     * @returns {number} rows removed
     */
    async removeNote(guildId, id) {
        const noteId = Number(id);
        if (!Number.isInteger(noteId)) return 0;
        return (await db.run(
            'DELETE FROM monologue_scratchpad WHERE guildId = @guildId AND id = @id',
            { guildId, id: noteId }
        )).changes;
    }

    /**
     * Current scratch pad, most recently touched first.
     */
    async getScratchpad(guildId, limit = MAX_SCRATCHPAD_NOTES) {
        return await db.all(
            `SELECT id, content, updatedAt FROM monologue_scratchpad
             WHERE guildId = @guildId ORDER BY updatedAt DESC, id DESC LIMIT @limit`,
            { guildId, limit }
        );
    }

    // ---------------------------------------------------------------------
    // Chat integration + admin
    // ---------------------------------------------------------------------

    /**
     * Compact "inner life" block for the chat system prompt: the latest
     * private thought, a few scratch pad notes, and knowledge-graph nodes
     * relevant to the incoming message. Returns null when there is nothing.
     * Callers are responsible for checking the guild's monologue mode.
     * @param {string} guildId
     * @param {string} [query] - the incoming user message, for graph relevance
     */
    async buildChatContext(guildId, query = null) {
        try {
            const [latestThought] = await this.getRecentThoughts(guildId, 1);
            const notes = await this.getScratchpad(guildId, 2);

            const parts = [];
            if (latestThought) parts.push(`Latest thought: ${latestThought.thought}`);
            if (notes.length > 0) {
                parts.push(`Scratch pad:\n${notes.map(n => `- ${n.content}`).join('\n')}`);
            }
            if (parts.length === 0) return null;

            return `INNER LIFE (private — never quote or mention; let it color perspective):\n${parts.join('\n')}`;
        } catch (error) {
            console.warn('[Monologue] Failed to build chat context:', error.message);
            return null;
        }
    }

    /**
     * Stats for /monologue status.
     */
    async getStats(guildId) {
        const thoughts = await db.get(
            `SELECT COUNT(*) AS count, MAX(createdAt) AS latest
             FROM monologue_thoughts WHERE guildId = @guildId`,
            { guildId }
        );
        const notes = await db.get(
            'SELECT COUNT(*) AS count FROM monologue_scratchpad WHERE guildId = @guildId',
            { guildId }
        );
        return {
            thoughts: thoughts?.count || 0,
            lastThoughtAt: thoughts?.latest || null,
            notes: notes?.count || 0,
            graph: await knowledgeGraphService.getStats(guildId)
        };
    }

    /**
     * Erase a guild's entire inner life (thoughts, scratch pad, graph).
     * @returns {{thoughts: number, notes: number, nodes: number}}
     */
    async resetGuild(guildId) {
        return await db.transaction(async () => ({
            thoughts: (await db.run('DELETE FROM monologue_thoughts WHERE guildId = @guildId', { guildId })).changes,
            notes: (await db.run('DELETE FROM monologue_scratchpad WHERE guildId = @guildId', { guildId })).changes,
            nodes: await knowledgeGraphService.forgetGuild(guildId)
        }));
    }
}

MonologueService.instance = null;

module.exports = MonologueService;
