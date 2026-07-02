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
        this.lastActionAt = new Map(); // guildId -> epoch ms
        this.moods = new Map();        // guildId -> mood string
        this.ticking = false;
        HeartbeatService.instance = this; // singleton handle for prompt injection
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
{"action": "react", "targetMessageId": "<id from transcript>", "emoji": "<single standard emoji>"}
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

        if (decision.mood && typeof decision.mood === 'string') {
            this.moods.set(guild.id, decision.mood.slice(0, 60));
        }

        if (decision.action === 'send_message' && decision.message) {
            await channel.send({
                content: String(decision.message).slice(0, 1500),
                allowedMentions: { users: [], roles: [] }
            });
            this.lastActionAt.set(guild.id, Date.now());
            this._setPresence(`Hanging out in #${channel.name}`);
            console.log(`[Heartbeat] Chimed in: ${guild.name}#${channel.name}`);
        } else if (decision.action === 'react' && decision.targetMessageId && decision.emoji) {
            const target = fetched.get(decision.targetMessageId);
            if (target) {
                await target.react(decision.emoji).catch(() => {});
                this.lastActionAt.set(guild.id, Date.now());
                console.log(`[Heartbeat] Reacted ${decision.emoji} in ${guild.name}#${channel.name}`);
            }
        }
        // stay_silent: do nothing (the usual outcome by design)
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
