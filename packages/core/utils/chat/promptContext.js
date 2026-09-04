/**
 * Shared conversational context pack.
 *
 * Every chat-like AI surface (text, web, automations, voice) should assemble
 * the system prompt through this module so token spend and retrieval depth
 * stay consistent. Shared wording (identity fallback, mini-app bridge,
 * personality-directive labels) lives in promptFragments.js so parlor and
 * chat cannot drift. Background writers (monologue, consolidation) use
 * retrieveNotes() when they need the same ranking, not this prompt builder.
 *
 * Depth is heuristic, not a second model call:
 *   light  — greetings / acks: identity + clock, no embedding recall
 *   medium — ordinary turns: cheap graph keyword hits only
 *   rich   — questions that smell like personal/server history: graph + memories
 *
 * Anything the first pack missed is a `lookupNotes` tool round, not a bigger dump.
 */

const knowledgeGraphService = require('../../services/knowledgeGraphService');
const memoryService = require('../../services/memoryService');
const { isDmScopeId } = require('../dmScope');
const {
    FALLBACK_PERSONALITY,
    SLASH_PROTOCOL_BAN,
    richRenderingContract,
    personalityDirectiveBlock
} = require('./promptFragments');

const STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'our', 'this',
    'that', 'with', 'from', 'have', 'what', 'whats', "what's", 'when', 'where',
    'which', 'who', 'how', 'why', 'can', 'could', 'would', 'should', 'just',
    'about', 'like', 'yeah', 'okay'
]);

const LIGHT_PHRASES = new Set([
    'hi', 'hey', 'hello', 'yo', 'sup', 'gm', 'gn', 'good morning', 'good night',
    'thanks', 'thank you', 'ty', 'thx', 'np', 'ok', 'okay', 'k', 'lol', 'lmao',
    'haha', 'yes', 'yeah', 'yep', 'no', 'nah', 'cool', 'nice', 'same', 'wb',
    'brb', 'pong', 'morning', 'night', 'hey goobster', 'hi goobster'
]);

const RICH_CUES = /\b(remember|remind|last time|you know|you knew|we (said|decided|talked|planned)|did i|did we|my (project|homelab|setup|job)|our (server|plan|project)|what do you know|tell me about)\b/i;

const BUDGETS = {
    chat: {
        light: { graph: 0, memories: 0, maxChars: 0, innerLife: false, mood: false },
        medium: { graph: 4, memories: 0, maxChars: 900, innerLife: false, mood: true },
        rich: { graph: 8, memories: 5, maxChars: 2200, innerLife: true, mood: true }
    },
    voice: {
        light: { graph: 0, memories: 0, maxChars: 0, innerLife: false, mood: false },
        medium: { graph: 3, memories: 0, maxChars: 600, innerLife: false, mood: false },
        rich: { graph: 6, memories: 3, maxChars: 1100, innerLife: false, mood: false }
    }
};

/**
 * Classify how much retrieved context this turn is worth.
 * @param {string} query
 * @returns {'light'|'medium'|'rich'}
 */
function classifyDepth(query) {
    const text = String(query || '').trim();
    if (!text) return 'light';

    const normalized = text.toLowerCase().replace(/[!.,~]+$/g, '').trim();
    const wordCount = text.split(/\s+/).filter(Boolean).length;

    if (wordCount <= 5 && LIGHT_PHRASES.has(normalized) && !text.includes('?')) {
        return 'light';
    }

    if (RICH_CUES.test(text) || text.length > 160 || wordCount > 28) {
        return 'rich';
    }

    if (text.includes('?') || wordCount > 6) {
        return 'medium';
    }

    if (wordCount <= 4 && !text.includes('?')) return 'light';
    return 'medium';
}

function searchTerms(query) {
    return String(query || '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(t => t.length >= 3 && !STOPWORDS.has(t))
        .slice(0, 12);
}

function clip(text, maxChars) {
    const value = String(text || '').trim();
    if (value.length <= maxChars) return value;
    return `${value.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function formatClock(now = new Date()) {
    return `${now.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    })}, ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

/**
 * Ranked notes for a speaker (and optionally shared server graph).
 * @returns {Promise<{graph: string|null, memories: Array, chars: number}>}
 */
async function retrieveNotes({
    guildId,
    userId = null,
    query,
    depth = 'medium',
    mode = 'chat',
    about = 'me',
    excludeContents = [],
    includeMemories = null
} = {}) {
    if (!guildId) return { graph: null, memories: [], chars: 0 };

    const resolvedDepth = ['light', 'medium', 'rich'].includes(depth) ? depth : classifyDepth(query);
    const budget = BUDGETS[mode]?.[resolvedDepth] || BUDGETS.chat.medium;
    const wantMemories = includeMemories == null ? budget.memories > 0 : includeMemories;
    const graphLimit = about === 'server' ? Math.max(budget.graph, 6) : budget.graph;

    let graph = null;
    let artifactBlock = null;
    if (graphLimit > 0 && searchTerms(query).length > 0) {
        const userScope = userId
            ? knowledgeGraphService.resolveScopeKey({ subjectType: 'USER', subjectId: userId })
            : '';
        const scopeKey = about === 'server'
            ? (userId ? 'GUILD' : '')
            : userScope;
        graph = await knowledgeGraphService.describeForPrompt({
            guildId,
            scopeKey: about === 'server' ? '' : scopeKey,
            query,
            limit: graphLimit
        });
        if (about === 'server' && !graph) {
            graph = await knowledgeGraphService.describeForPrompt({
                guildId,
                scopeKey: 'GUILD',
                query,
                limit: graphLimit
            });
        }
        const kgArtifactService = require('../../services/kgArtifactService');
        const artifactScope = about === 'server'
            ? (scopeKey === '' ? 'GUILD' : scopeKey)
            : userScope;
        const artifactRows = await kgArtifactService.searchArtifacts({
            guildId,
            scopeKey: artifactScope,
            query,
            limit: Math.min(4, graphLimit)
        });
        artifactBlock = kgArtifactService.formatArtifactLines(artifactRows, {
            maxChars: Math.floor((budget.maxChars || 2000) / 2)
        });
    } else if (graphLimit > 0 && about === 'me' && userId && resolvedDepth === 'rich') {
        const scopeKey = knowledgeGraphService.resolveScopeKey({
            subjectType: 'USER',
            subjectId: userId
        });
        graph = await knowledgeGraphService.describeForPrompt({
            guildId,
            scopeKey,
            query: null,
            limit: Math.min(4, graphLimit)
        });
    }

    let memories = [];
    if (wantMemories && query) {
        memories = await memoryService.recall({
            guildId,
            query,
            limit: budget.memories || 5,
            excludeContents,
            authorId: about === 'me' && userId && !isDmScopeId(guildId) ? userId : undefined
        });
    }

    const graphParts = [];
    if (graph) graphParts.push(graph);
    if (artifactBlock) graphParts.push(`ARTIFACTS:\n${artifactBlock}`);
    const graphText = graphParts.length > 0
        ? clip(graphParts.join('\n'), budget.maxChars || 2000)
        : null;
    let chars = graphText ? graphText.length : 0;
    const keptMemories = [];
    const memoryBudget = Math.max(0, (budget.maxChars || 2000) - chars);
    let used = 0;
    for (const row of memories) {
        const line = `${row.authorName || 'someone'}: ${row.content}`;
        if (used + line.length > memoryBudget && keptMemories.length > 0) break;
        keptMemories.push(row);
        used += line.length;
    }
    chars += used;

    return { graph: graphText, memories: keptMemories, chars, depth: resolvedDepth, about };
}

function formatRetrievedBlock({ graph, memories }, { heading = 'THINGS YOU ALREADY KNOW' } = {}) {
    const parts = [];
    if (graph) parts.push(graph);
    if (memories?.length) {
        parts.push(memories.map(m => {
            const when = m.createdAt ? String(m.createdAt).split(' ')[0] : '';
            const who = m.authorName || 'someone';
            return `- ${when ? `[${when}] ` : ''}${who}: ${m.content}`;
        }).join('\n'));
    }
    if (parts.length === 0) return null;
    return `${heading} (use naturally; never recite or say "according to my notes"):
${parts.join('\n')}`;
}

function conversationalContract({ mode, canLookup }) {
    const lookupLine = canLookup
        ? 'If you need a detail that is not here, call lookupNotes before guessing about this person or this server. Saved files (code, docs, PDFs) live as artifact nodes — lookupNotes can recall their contents.'
        : '';
    if (mode === 'voice') {
        return `HOW TO TALK:
You are in a live voice conversation. Replies are spoken aloud.
Keep them short (1–3 sentences unless they asked for detail). No markdown, emojis, lists, links, or code.
Answer the whole thought, not just the last sentence. Use tools when you need a fact or an action, then say the outcome in plain speech — never read raw results or URLs.
${lookupLine}`.trim();
    }
    return `HOW TO TALK:
Talk like a person in this conversation — warm, specific, and brief unless they asked for depth.
Do not recap what you know, list notes, or say "according to my memory." Use tools for actions and lookupNotes when a personal or server detail is missing. When someone shares a file worth keeping (code, docs, configs), save it with saveArtifact — ask first if you are not sure they want it stored. ${SLASH_PROTOCOL_BAN}
${lookupLine}`.trim();
}

/**
 * Assemble the system prompt for a conversational turn.
 * @returns {Promise<{prompt: string, depth: string, retrievedChars: number}>}
 */
async function buildConversationalPrompt({
    mode = 'chat',
    basePrompt,
    query,
    guildId,
    userId,
    userName,
    botName,
    isGuild = false,
    guildName = null,
    voiceChannelName = null,
    isWeb = false,
    sourceDescription = null,
    skipHistory = false,
    personalityDirective = null,
    userInstructions = null,
    mood = null,
    innerLife = null,
    attentionContext = null,
    priorToolContext = null,
    screenLine = null,
    incomingAttachments = null,
    excludeContents = [],
    hasTextChannel = false,
    canLookup = true
} = {}) {
    const depth = classifyDepth(query);
    const budget = BUDGETS[mode]?.[depth] || BUDGETS.chat.medium;
    const now = formatClock();

    const location = isGuild
        ? (voiceChannelName
            ? `Voice channel "${voiceChannelName}" in "${guildName || 'this server'}".`
            : `Discord server "${guildName || 'this server'}".`)
        : (userName
            ? `Private one-on-one with ${userName}.`
            : 'A private one-on-one conversation.');

    const parts = [String(basePrompt || FALLBACK_PERSONALITY).trim()];

    parts.push(`NOW: ${now}
WHERE: ${location}
NAMES: You are "${botName || 'Goobster'}". The person you are talking to is "${userName || 'this user'}".`);

    // Why this turn is happening at all. Unattended surfaces set it (a
    // scheduled task, a watch that woke up on a condition, the web portal),
    // and for a watch it carries the evidence the turn exists to reason
    // about - so it belongs before the behavioural contract, not after.
    if (sourceDescription) {
        parts.push(`SITUATION:\n${String(sourceDescription).trim()}`);
    }

    parts.push(conversationalContract({ mode, canLookup }));

    if (mode === 'voice' && hasTextChannel) {
        parts.push('You can also generate images, schedule follow-ups, and manage automations; those land in the linked text channel.');
    }

    if (isWeb && mode === 'chat') {
        parts.push(richRenderingContract({ surface: 'portal' }));
    }

    if (skipHistory) {
        parts.push('INCOGNITO: Nothing in this conversation is stored. Do not promise to remember it later.');
    }

    if (userInstructions) {
        parts.push(userInstructions);
    }

    const directiveBlock = personalityDirectiveBlock({ isGuild, directive: personalityDirective });
    if (directiveBlock) {
        parts.push(directiveBlock);
    }

    const { describeIncomingAttachments } = require('../incomingAttachments');
    const attachmentHint = describeIncomingAttachments(incomingAttachments);
    if (attachmentHint) parts.push(attachmentHint);

    let retrieved = { graph: null, memories: [], chars: 0 };
    if (budget.maxChars > 0) {
        retrieved = await retrieveNotes({
            guildId,
            userId,
            query,
            depth,
            mode,
            about: 'me',
            excludeContents
        });
        const retrievedBlock = formatRetrievedBlock(retrieved);
        if (retrievedBlock) parts.push(retrievedBlock);
    }

    if (budget.mood && mood) {
        parts.push(`MOOD: ${mood} — let this color tone; do not mention it.`);
    }

    if (budget.innerLife && innerLife) {
        parts.push(innerLife);
    }

    // Attention notices ride every non-light turn (not just rich ones): the
    // whole point of a "mention" disposition is that it waits for an opening,
    // and waiting for a rich turn could be a very long wait.
    if (attentionContext) {
        parts.push(attentionContext);
    }

    if (priorToolContext) {
        parts.push(priorToolContext);
    }

    if (screenLine) {
        parts.push(`LIVE SCREEN: ${screenLine}`);
    }

    return {
        prompt: parts.filter(Boolean).join('\n\n'),
        depth,
        retrievedChars: retrieved.chars || 0
    };
}

module.exports = {
    BUDGETS,
    classifyDepth,
    searchTerms,
    retrieveNotes,
    formatRetrievedBlock,
    conversationalContract,
    buildConversationalPrompt
};
