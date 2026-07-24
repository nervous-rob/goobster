const db = require('../db');
const aiService = require('./aiService');
const factsService = require('./factsService');
const followupService = require('./followupService');
const { resolveDisplayNames } = require('../utils/channelDigest');
const { getProactiveMode, PROACTIVE_MODE } = require('../utils/guildSettings');
const { ActivityType } = require('discord.js');

// How often the heartbeat considers acting (per process tick)
const TICK_INTERVAL_MS = 20 * 60 * 1000;
// Minimum gap between proactive actions in the same guild
const ACTION_COOLDOWN_MS = 45 * 60 * 1000;
// Follow-up delivery check cadence
const FOLLOWUP_INTERVAL_MS = 60 * 1000;
// A channel only qualifies when humans talked this recently
const ACTIVITY_WINDOW_MS = 60 * 60 * 1000;
// Minimum human messages in the window before Goobster may consider chiming in
const MIN_HUMAN_MESSAGES = 4;

const DISCORD_EPOCH = 1420070400000n;

function snowflakeToTimestamp(id) {
    try {
        return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
    } catch {
        return 0;
    }
}

/**
 * The heartbeat: a periodic agent tick that gives Goobster a life beyond
 * request/response. Each tick it reviews recent activity in opted-in guilds
 * plus its facts and pending follow-ups, then decides - via a cheap model
 * call - whether to chime in, react, update its mood, or stay silent.
 *
 * Guardrails: opt-in per guild (/proactive), a hard cooldown between actions,
 * a minimum-activity bar, and "stay silent" as the heavily-favored default.
 *
 * Also owns follow-up delivery (every minute) and a per-guild mood that
 * subtly colors normal chat replies.
 */
class HeartbeatService {
    constructor(client) {
        this.client = client;
        this.tickTimer = null;
        this.followupTimer = null;
        this.lastActionAt = new Map(); // guildId -> epoch ms (cache over heartbeat_state)
        this.moods = new Map();        // guildId -> mood string (cache over heartbeat_state)
        this.ticking = false;
        HeartbeatService.instance = this; // singleton handle for prompt injection
        this._loadState();
    }

    /**
     * Restore cooldowns and moods persisted from previous runs so a process
     * restart doesn't reset the action cooldown or forget the server vibe.
     */
    _loadState() {
        try {
            for (const row of db.all('SELECT guildId, mood, lastActionAt FROM heartbeat_state')) {
                if (row.mood) this.moods.set(row.guildId, row.mood);
                if (row.lastActionAt) this.lastActionAt.set(row.guildId, Number(row.lastActionAt));
            }
        } catch (error) {
            console.warn('[Heartbeat] Could not load persisted state:', error.message);
        }
    }

    _saveState(guildId) {
        try {
            db.run(
                `INSERT INTO heartbeat_state (guildId, mood, lastActionAt, updatedAt)
                 VALUES (@guildId, @mood, @lastActionAt, CURRENT_TIMESTAMP)
                 ON CONFLICT(guildId) DO UPDATE SET
                     mood = excluded.mood,
                     lastActionAt = excluded.lastActionAt,
                     updatedAt = CURRENT_TIMESTAMP`,
                {
                    guildId,
                    mood: this.moods.get(guildId) || null,
                    lastActionAt: this.lastActionAt.get(guildId) || null
                }
            );
        } catch (error) {
            console.warn('[Heartbeat] Could not persist state:', error.message);
        }
    }

    start() {
        if (this.tickTimer) return;
        this.tickTimer = setInterval(() => this.tick().catch(err =>
            console.error('[Heartbeat] Tick failed:', err.message)
        ), TICK_INTERVAL_MS);
        this.followupTimer = setInterval(() => this.deliverDueFollowups().catch(err =>
            console.error('[Heartbeat] Follow-up delivery failed:', err.message)
        ), FOLLOWUP_INTERVAL_MS);
        console.log('[Heartbeat] Started (tick every 20m, follow-ups every 60s)');
    }

    stop() {
        if (this.tickTimer) clearInterval(this.tickTimer);
        if (this.followupTimer) clearInterval(this.followupTimer);
        this.tickTimer = null;
        this.followupTimer = null;
    }

    /**
     * Current mood for a guild (injected into chat prompts), or null.
     */
    getMood(guildId) {
        return this.moods.get(guildId) || null;
    }

    /**
     * One heartbeat pass over all opted-in guilds.
     */
    async tick() {
        if (this.ticking) return;
        this.ticking = true;
        try {
            for (const guild of this.client.guilds.cache.values()) {
                try {
                    const mode = await getProactiveMode(guild.id);
                    if (mode !== PROACTIVE_MODE.ENABLED) continue;

                    const last = this.lastActionAt.get(guild.id) || 0;
                    if (Date.now() - last < ACTION_COOLDOWN_MS) continue;

                    await this.considerGuild(guild);
                } catch (error) {
                    console.error(`[Heartbeat] Guild ${guild.id} failed:`, error.message);
                }
            }
        } finally {
            this.ticking = false;
        }
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
            if (!permissions?.has('SendMessages') || !permissions?.has('ReadMessageHistory')) continue;

            const lastTime = snowflakeToTimestamp(channel.lastMessageId);
            if (lastTime > bestTime) {
                bestTime = lastTime;
                best = channel;
            }
        }
        return bestTime > Date.now() - ACTIVITY_WINDOW_MS ? best : null;
    }

    /**
     * Review one guild and maybe act.
     */
    async considerGuild(guild) {
        const channel = this._findActiveChannel(guild);
        if (!channel) return;

        const fetched = await channel.messages.fetch({ limit: 25 });
        const cutoff = Date.now() - ACTIVITY_WINDOW_MS;
        const recent = [...fetched.values()]
            .filter(m => m.createdTimestamp > cutoff && m.content)
            .reverse();

        const humanMessages = recent.filter(m => !m.author.bot);
        if (humanMessages.length < MIN_HUMAN_MESSAGES) return;

        // Don't butt in if Goobster already spoke recently in this channel
        const lastBotMessage = recent.filter(m => m.author.id === this.client.user.id).pop();
        if (lastBotMessage && Date.now() - lastBotMessage.createdTimestamp < ACTION_COOLDOWN_MS) return;

        const names = await resolveDisplayNames(guild, recent);
        const transcript = recent
            .map(m => `[id:${m.id}] ${names.get(m.author.id)}${m.author.bot ? ' (bot)' : ''}: ${m.content.slice(0, 300)}`)
            .join('\n');

        const guildFacts = factsService.getGuildFacts(guild.id, 8).map(f => `- ${f.content}`).join('\n');
        const pending = followupService.getPending(guild.id, 5)
            .map(f => `- [due ${f.dueAt} UTC] ${f.note}`).join('\n');
        const now = new Date();

        // Agent proposals are only on the menu when the Cursor integration is
        // configured and this guild has allowlisted repos to point an agent at.
        const agentRepos = this._agentProposalRepos(guild.id);

        const prompt = `You are Goobster, a Discord bot with a life of your own. This is your periodic "heartbeat": you're quietly observing the server and deciding whether to do anything.

Current time: ${now.toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: 'numeric', month: 'long', day: 'numeric' })}
Server: "${guild.name}" | Channel being observed: #${channel.name}

RECENT CONVERSATION (newest last):
${transcript}

${guildFacts ? `THINGS YOU KNOW ABOUT THIS SERVER:\n${guildFacts}\n` : ''}${pending ? `YOUR PENDING FOLLOW-UPS (do not deliver these now; they are scheduled):\n${pending}\n` : ''}
Decide ONE action. THE BAR FOR SPEAKING IS HIGH: you were not summoned, so only speak if you can add genuine value (answer an unresolved question, correct clear misinformation, offer help nobody else gave) or if a light reaction fits perfectly. Never interrupt flowing conversation between people. When in doubt: stay_silent.

Respond with ONLY JSON:
{"action": "stay_silent"} OR
{"action": "send_message", "message": "<short, natural, no more than 2 sentences>"} OR
{"action": "react", "targetMessageId": "<id from transcript>", "emoji": "<single standard emoji>"}${agentRepos.length ? ` OR
{"action": "propose_agent", "repo": "<one of: ${agentRepos.join(', ')}>", "task": "<clear, specific instructions for a coding agent>", "reason": "<1 short sentence explaining why, addressed to the channel>"}
propose_agent rules: ONLY when the conversation contains a concrete, reproducible bug report or a clearly scoped feature request for that repo AND nobody is already handling it. It merely posts a confirmation button — a server manager still has to approve — but proposing frivolously is spammy. The bar is even higher than for speaking.` : ''}
Optionally include "mood": "<2-5 word mood reflecting the server vibe right now>".`;

        const response = await aiService.generateText(prompt, {
            temperature: 0.4,
            max_tokens: 200,
            usageContext: { guildId: guild.id }
        });

        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return;

        let decision;
        try {
            decision = JSON.parse(jsonMatch[0]);
        } catch {
            return;
        }

        let stateChanged = false;
        if (decision.mood && typeof decision.mood === 'string') {
            this.moods.set(guild.id, decision.mood.slice(0, 60));
            stateChanged = true;
        }

        if (decision.action === 'send_message' && decision.message) {
            await channel.send({
                content: String(decision.message).slice(0, 1500),
                allowedMentions: { users: [], roles: [] }
            });
            this.lastActionAt.set(guild.id, Date.now());
            stateChanged = true;
            this._setPresence(`Hanging out in #${channel.name}`);
            console.log(`[Heartbeat] Chimed in: ${guild.name}#${channel.name}`);
        } else if (decision.action === 'react' && decision.targetMessageId && decision.emoji) {
            const target = fetched.get(decision.targetMessageId);
            if (target) {
                await target.react(decision.emoji).catch(() => {});
                this.lastActionAt.set(guild.id, Date.now());
                stateChanged = true;
                console.log(`[Heartbeat] Reacted ${decision.emoji} in ${guild.name}#${channel.name}`);
            }
        } else if (decision.action === 'propose_agent') {
            if (await this._proposeAgent(guild, channel, decision)) {
                this.lastActionAt.set(guild.id, Date.now());
                stateChanged = true;
            }
        }
        // stay_silent: do nothing (the usual outcome by design)

        if (stateChanged) this._saveState(guild.id);
    }

    /**
     * Repos the heartbeat may propose agents for: the guild's watched repos,
     * and only when the Cursor integration is configured.
     */
    _agentProposalRepos(guildId) {
        try {
            const cursorAgentService = require('./cursorAgentService');
            if (!cursorAgentService.isConfigured()) return [];
            const repoWatchService = require('./repoWatchService');
            return repoWatchService.listWatches(guildId).map(watch => watch.repo);
        } catch {
            return [];
        }
    }

    /**
     * Execute a propose_agent decision: legalize it (repo must be
     * allowlisted, task non-empty, no proposal already pending in the guild)
     * and post the standard Confirm/Cancel launch proposal. Never launches
     * anything itself.
     * @returns {Promise<boolean>} whether a proposal was posted
     */
    async _proposeAgent(guild, channel, decision) {
        try {
            const repoWatchService = require('./repoWatchService');
            const integrationActionService = require('./integrationActionService');
            const integrationAudit = require('./integrationAudit');

            const repo = String(decision.repo || '').trim();
            const task = String(decision.task || '').trim();
            if (!repo || !task) return false;
            if (!this._agentProposalRepos(guild.id).length) return false;
            if (!repoWatchService.isRepoAllowed(guild.id, repo)) return false;

            // One open proposal per guild at a time - the heartbeat must
            // never stack confirmation buttons.
            const db = require('../db');
            const open = db.get(
                `SELECT 1 AS ok FROM pending_integration_actions
                 WHERE type = 'agent-launch' AND status = 'PENDING' AND guildId = @guildId`,
                { guildId: guild.id }
            );
            if (open) return false;

            const { message } = integrationActionService.createPending({
                type: 'agent-launch',
                guildId: guild.id,
                channelId: channel.id,
                requestedBy: null,
                payload: { repo, prompt: task, branch: null }
            });
            const reason = String(decision.reason || 'This looks like something I could put a coding agent on.').slice(0, 300);
            await channel.send({ content: `💡 ${reason}`, ...message, allowedMentions: { users: [], roles: [] } });
            integrationAudit.record({
                guildId: guild.id, userId: null,
                action: 'agent-launch.proposed', detail: { repo, via: 'heartbeat' }
            });
            console.log(`[Heartbeat] Proposed an agent launch in ${guild.name}#${channel.name} (${repo})`);
            return true;
        } catch (error) {
            console.error('[Heartbeat] Agent proposal failed:', error.message);
            return false;
        }
    }

    /**
     * Deliver follow-ups whose time has come, phrasing them naturally.
     */
    async deliverDueFollowups() {
        const due = followupService.getDue();
        for (const followup of due) {
            try {
                const channel = await this.client.channels.fetch(followup.channelId).catch(() => null);
                if (!channel || !channel.isTextBased()) {
                    followupService.cancel(followup.id);
                    continue;
                }

                const message = await aiService.generateText(
                    `You are Goobster, a friendly Discord bot. You previously promised to follow up on something, and now is the time. Write a short (1-2 sentence), casual follow-up message${followup.userId ? ` addressed to <@${followup.userId}>` : ''}.

Follow-up note: "${followup.note}"

Respond with ONLY the message text.`,
                    { temperature: 0.7, max_tokens: 120 }
                );

                await channel.send({
                    content: `⏰ ${message.trim()}`,
                    allowedMentions: followup.userId ? { users: [followup.userId] } : { users: [], roles: [] }
                });
                followupService.markDone(followup.id);
                console.log(`[Heartbeat] Delivered follow-up #${followup.id}: ${followup.note}`);
            } catch (error) {
                console.error(`[Heartbeat] Follow-up #${followup.id} failed:`, error.message);
                // Leave PENDING so the next pass retries; cancel if the channel vanished
            }
        }
    }

    _setPresence(text) {
        this.client.user.setPresence({
            activities: [{ type: ActivityType.Custom, name: text, state: text }],
            status: 'online'
        }).catch?.(() => {});
    }
}

HeartbeatService.instance = null;

module.exports = HeartbeatService;
