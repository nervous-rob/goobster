/**
 * Chat tools for delegated work (DA-7b, ADR 0023): draft a responsibility,
 * say what is being worked on and why, and stop it.
 * Required by packages/core/utils/toolsRegistry.js (the `assistant` feature).
 *
 * What they can and cannot do is the contract:
 *
 *   proposeResponsibility   writes a DRAFT marked `proposedBy: 'model'`.
 *                           A draft grants nothing. Only the person turns
 *                           it on, with a confirmation receipt this module
 *                           cannot mint.
 *   describeDelegatedWork   reads the speaker's own responsibilities,
 *                           work, run records and open requests.
 *   controlDelegatedWork    cancels one piece of work, or pauses one
 *                           responsibility. Narrowing only.
 *   spokenBriefing          (DA-7c) says Home's overview aloud: its counts,
 *                           what is waiting on the person, up to three
 *                           findings. It acknowledges nothing.
 *
 * None of them activates, resumes, queues, edits or decides anything, and
 * the services refuse those inside any model tool call
 * (utils/modelCallScope.js), so this file could not do it by mistake.
 *
 * All of them answer only in the speaker's own private conversation: not in
 * a guild channel, not in a shared table, not in an unattended turn, not in
 * incognito, and not for an account outside the pilot (DA-12a). The
 * briefing also needs the turn to be a spoken one, in a voice session that
 * is the person's alone: never a voice channel other people can hear.
 *
 * Spec: documentation/delegated_conversation.md
 */

const crypto = require('node:crypto');
const { features } = require('../../features/featureState');
const { dmScopeId } = require('../dmScope');
const logger = require('../logger');
const { incognitoRefusal } = require('../toolPrivacy');

const FEATURE_ID = 'assistant';
const CAPABILITY = 'conversation';
/** Proposals waiting for an answer, per person. More than this is noise, not delegation. */
const MAX_PENDING_PROPOSALS = 10;
const OVERVIEW_LIMIT = 20;
const JOURNAL_LIMIT = 40;
const REQUEST_CARD_LIMIT = 5;
/** Work that has not ended (assistantInitiativeService). */
const OPEN_STATUSES = ['CANDIDATE', 'QUEUED', 'RUNNING', 'WAITING', 'REVIEW'];
/** A repeated proposal reuses its draft; once that draft was settled, a later one is new. */
const MAX_REPROPOSALS = 5;

const OPERATION_TEXT = {
    read: 'read',
    research: 'run research expeditions',
    'kg.generated.add': 'add generated notes',
    'kg.generated.amend': 'amend generated notes',
    'kg.saved.propose': 'suggest changes to notes you saved (you apply them)',
    'kg.saved.amend': 'amend notes you saved directly',
    'kg.edge': 'connect notes',
    'kg.archive': 'archive notes',
    'file.edit': 'edit files',
    'sandbox.run': 'run code in the sandbox',
    'process.repair': 'repair',
    'process.pause': 'pause',
    'process.archive': 'archive',
    'cleanup.exact': 'clean up',
    'repo.commit': 'commit',
    'repo.push': 'push',
    'pr.create': 'open pull requests',
    'external.write': 'write to an outside service'
};

const clip = (value, max) => {
    const text = value == null ? '' : String(value).trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function portalUrl(path) {
    try {
        const publicUrl = require('../../config/configJson').load().webapp?.publicUrl;
        if (typeof publicUrl === 'string' && publicUrl) return `${publicUrl.replace(/\/+$/, '')}/app${path}`;
    } catch { /* no config: describe the page instead of linking it */ }
    return null;
}

function responsibilitiesPage() {
    const url = portalUrl('/assistant');
    return url ? `the Responsibilities page of the portal (${url})` : 'the Responsibilities page of the portal';
}

function isWebChat(context, userId) {
    const channelId = context?.channel?.id || context?.channelId;
    return typeof channelId === 'string' && channelId.startsWith(`web:${userId}:`);
}

/**
 * Whether this turn may use the delegation tools at all, and as whom.
 * Every tool calls it first; `toolsRegistry` also uses it to decide whether
 * to offer them. The checks do not depend on what the tool was asked.
 * @returns {Promise<{ userId: string } | { refusal: string, code: string }>}
 */
async function entry(context) {
    const userId = context?.user?.id ? String(context.user.id) : null;
    if (!userId) return { code: 'NO_USER', refusal: '❌ Delegated work needs a known person in this conversation.' };
    if (features.enforcedOff(FEATURE_ID)) {
        return { code: 'FEATURE_UNAVAILABLE', refusal: '❌ Delegated work is not available on this installation.' };
    }
    if (context?.isAutomation === true) {
        return {
            code: 'UNATTENDED',
            refusal: '❌ This is an unattended turn. It cannot draft, read or steer delegated work: that happens only in a conversation with the person. Carry on with the task itself.'
        };
    }
    if (context?.skipHistory === true) return { code: 'INCOGNITO', refusal: incognitoRefusal('describeDelegatedWork') };
    const guildId = context?.guildId || context?.guild?.id || null;
    const channelId = context?.channel?.id || context?.channelId || '';
    const shared = (guildId && guildId !== dmScopeId(userId))
        || (typeof channelId === 'string' && channelId.startsWith('web:') && !channelId.startsWith(`web:${userId}:`));
    if (shared) {
        return {
            code: 'NOT_PRIVATE',
            refusal: `Delegation is managed privately, not in a shared conversation. Tell the person to open ${responsibilitiesPage()}, or to ask you in a direct chat. Say nothing here about their delegated work.`
        };
    }
    const access = require('../../services/assistantAccessService');
    if (!(await access.allows(userId, CAPABILITY))) {
        return {
            code: access.REFUSAL_CODE,
            refusal: `❌ Delegating and steering work by conversation is limited to this installation's owner for now (${access.REFUSAL_CODE}). The person can still manage responsibilities on ${responsibilitiesPage()}.`
        };
    }
    return { userId };
}

/**
 * Whether to show the model these tools this turn. A shared conversation
 * still gets them, so it can answer that delegation is private; a person
 * who could only be refused does not.
 */
async function offered(context) {
    const userId = context?.user?.id ? String(context.user.id) : null;
    if (!userId || features.enforcedOff(FEATURE_ID)) return false;
    if (context?.isAutomation === true || context?.skipHistory === true) return false;
    return require('../../services/assistantAccessService').allows(userId, CAPABILITY);
}

/** A turn whose reply is spoken: the portal's voice chat, or a Discord voice session. */
const isVoiceTurn = (context) => context?.spoken === true || context?.isVoiceInteraction === true;

/**
 * `entry` for the spoken briefing. The same checks, in the same order, and
 * then: the turn is spoken. A Discord voice channel is a guild's, so it is
 * refused as shared before anything is read, whoever is in it right now.
 * @returns {Promise<{ userId: string } | { refusal: string, code: string }>}
 */
async function voiceEntry(context) {
    const who = await entry(context);
    if (who.code === 'NOT_PRIVATE') {
        return {
            code: who.code,
            refusal: 'A briefing is private. It is never read out where other people can hear it, and this is a shared conversation. '
                + 'Tell the person to ask in their own voice chat in the portal (the Voice chat button in their chat there), or to open Home in the portal. '
                + 'Say nothing here about their delegated work, not even whether there is any.'
        };
    }
    if (who.refusal) return who;
    if (!isVoiceTurn(context)) {
        return {
            code: 'NOT_SPOKEN',
            refusal: '❌ The briefing is for a voice conversation, and this turn is written. Answer from describeDelegatedWork instead (what: "overview" or "requests").'
        };
    }
    return who;
}

/**
 * The briefing is shown to the model only on a spoken turn of a person who
 * could hear it. A check that cannot be made hides it: a voice turn goes on
 * without the briefing rather than failing.
 */
async function offeredInVoice(context) {
    if (!isVoiceTurn(context)) return false;
    try {
        return await offered(context);
    } catch (error) {
        logger.warn?.(`[assistant tools] spoken briefing not offered: ${error.message}`);
        return false;
    }
}

/** "read, research: the web" - the normalized grant in plain words, one line per resource. */
function describeOperations(operations) {
    const byResource = new Map();
    for (const entry of operations || []) {
        const resource = entry.resource || {};
        let where;
        switch (resource.kind) {
        case 'knowledge': where = 'your knowledge'; break;
        case 'web': where = 'the web'; break;
        case 'project':
            where = `project ${(resource.ids || []).map(id => `#${id}`).join(', ')}`
                + (resource.paths?.length ? ` (only ${resource.paths.join(', ')})` : '');
            break;
        case 'repository':
            where = `${(resource.ids || []).join(', ')}${resource.branches?.length ? ` on ${resource.branches.join(', ')}` : ''}`;
            break;
        default:
            where = (resource.ids || []).join(', ') || resource.kind || 'unknown';
        }
        byResource.set(where, [...(byResource.get(where) || []), OPERATION_TEXT[entry.operation] || entry.operation]);
    }
    return [...byResource.entries()].map(([where, verbs]) => `${verbs.join(', ')}: ${where}`);
}

function describeResponsibility(item) {
    const grants = describeOperations(item.operations);
    return `#${item.id} "${clip(item.title, 120)}" - ${item.status.toLowerCase().replace('_', ' ')}`
        + (item.proposedBy === 'model' ? ' (proposed in a conversation)' : '')
        + (grants.length ? `; may ${grants.join('; ')}` : '; grants nothing yet')
        + (item.expiresAt ? `; ends ${item.expiresAt} UTC` : '');
}

function describeInitiative(item, run = null) {
    const parts = [`#${item.id} "${clip(item.title, 120)}" - ${item.status.toLowerCase()}`];
    if (item.waitReason) parts.push(`waiting on ${item.waitReason.replace('_', ' ')}`);
    if (item.outcome) parts.push(`outcome ${item.outcome}`);
    if (item.stopCode) parts.push(`stop code ${item.stopCode}`);
    if (run?.resultTitle) parts.push(`result "${clip(run.resultTitle, 120)}"`);
    parts.push(`under responsibility #${item.responsibilityId}`);
    return parts.join('; ');
}

function describeJournal(operations) {
    if (!operations?.length) return ['(no steps recorded)'];
    const shown = operations.slice(-JOURNAL_LIMIT);
    const lines = shown.map((op) => {
        const what = [op.tool, op.operation ? `(${op.operation}${op.resourceKind ? ` on ${op.resourceKind}` : ''})` : '']
            .filter(Boolean).join(' ');
        return `- ${what}: ${op.status.toLowerCase()}${op.refusalCode ? ` - refused: ${op.refusalCode}` : ''}`;
    });
    if (operations.length > shown.length) lines.unshift(`(${operations.length - shown.length} earlier steps not shown)`);
    return lines;
}

/** The writes a run finished before it was stopped: what "already changed". */
function completedWrites(run) {
    return (run?.operations || []).filter(op => op.status === 'SUCCEEDED' && op.operation && op.operation !== 'read');
}

const failure = (error) => `❌ ${error?.message || 'That did not work.'}${error?.code ? ` (${error.code})` : ''}`;

module.exports = {
    proposeResponsibility: {
        offered,
        definition: {
            name: 'proposeResponsibility',
            description: 'Draft a responsibility: a standing, bounded piece of work the person wants you to carry out on their behalf ("keep my notes on X current", "look after the docs of project 12"). Use it when the person asks you to take something on going forward, in their own private chat. It creates a DRAFT only. A draft grants nothing and nothing runs: the person reviews exactly what it would allow and turns it on themselves, on the card shown with your reply or on the Responsibilities page. You cannot activate, resume, edit or widen a responsibility, and no later tool call can; never say one is active because you proposed it. Ask for the narrowest grant that achieves the outcome: only the operations it needs, on the named resources. If you are unsure what they want covered, ask before proposing.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Short name of the responsibility, e.g. "Keep my notes on fusion current".' },
                    outcome: { type: 'string', description: 'What success looks like, in the person\'s terms.' },
                    operations: {
                        type: 'array',
                        description: 'The grant: each entry is one operation on one resource. Keep it as narrow as the outcome allows. There are no wildcards; a project, process or repository must be named by id.',
                        items: {
                            type: 'object',
                            properties: {
                                operation: {
                                    type: 'string',
                                    enum: Object.keys(OPERATION_TEXT),
                                    description: 'What may be done.'
                                },
                                resource: {
                                    type: 'object',
                                    description: 'Where. kind "knowledge" (the person\'s own notes), "web", "project" (ids: project ids; optional paths: workspace-relative prefixes), "process" (ids like "automation:12"), "repository" (ids: "owner/name", projectId, branches).',
                                    properties: {
                                        kind: { type: 'string', enum: ['knowledge', 'web', 'project', 'process', 'repository', 'external'] },
                                        ids: { type: 'array', items: { type: 'string' } },
                                        paths: { type: 'array', items: { type: 'string' } },
                                        projectId: { type: 'string' },
                                        branches: { type: 'array', items: { type: 'string' } }
                                    },
                                    required: ['kind']
                                }
                            },
                            required: ['operation', 'resource']
                        }
                    },
                    projectId: { type: 'number', description: 'The project this is about, when it is about one (its numeric id).' },
                    attentionItemId: { type: 'number', description: 'The tracked attention item (goal) this serves, when there is one.' },
                    expiresAt: { type: 'string', description: 'Optional end of the grant, an ISO timestamp (UTC). Suggest one when the work is time-bound.' },
                    stopCondition: { type: 'string', description: 'Optional: when the work should stop on its own, in words.' }
                },
                required: ['title', 'operations']
            }
        },
        execute: async ({ title, outcome, operations, projectId, attentionItemId, expiresAt, stopCondition, interactionContext }) => {
            const who = await entry(interactionContext);
            if (who.refusal) return who.refusal;
            const responsibilities = require('../../services/assistantResponsibilityService');
            const db = require('../../db');
            try {
                const pending = await db.get(
                    `SELECT COUNT(*) AS n FROM assistant_responsibilities
                     WHERE ownerUserId = @userId AND proposedBy = 'model' AND status = 'DRAFT' AND proposalKeptAt IS NULL`,
                    { userId: who.userId }
                );
                if (Number(pending?.n || 0) >= MAX_PENDING_PROPOSALS) {
                    return `❌ ${pending.n} proposals are already waiting for the person's answer. Ask them to confirm or discard those on ${responsibilitiesPage()} before proposing another.`;
                }
                const body = { title, operations };
                if (outcome != null && outcome !== '') body.outcome = outcome;
                if (projectId != null && projectId !== '') body.projectId = projectId;
                if (attentionItemId != null && attentionItemId !== '') body.attentionItemId = attentionItemId;
                if (expiresAt != null && expiresAt !== '') body.expiresAt = expiresAt;
                // Starting work without asking is the person's own switch; a proposal never sets it.
                if (stopCondition != null && stopCondition !== '') body.rules = { stopCondition };
                const conversation = interactionContext?.channel?.id || interactionContext?.channelId || null;
                // The same proposal in the same conversation is the same draft, not a second one.
                const key = `chat:${crypto.createHash('sha256')
                    .update(JSON.stringify([conversation, body])).digest('hex').slice(0, 48)}`;
                let responsibility;
                let created = false;
                for (let attempt = 0; attempt < MAX_REPROPOSALS; attempt += 1) {
                    ({ responsibility, created } = await responsibilities.propose({
                        userId: who.userId, body, conversation, idempotencyKey: attempt ? `${key}:${attempt}` : key
                    }));
                    if (created || responsibility.status === 'DRAFT') break;
                }
                const grants = describeOperations(responsibility.operations);
                const web = isWebChat(interactionContext, who.userId);
                if (!created && responsibility.status !== 'DRAFT') {
                    return `This was already proposed and is now ${responsibility.status.toLowerCase().replace('_', ' ')} (responsibility #${responsibility.id}). Nothing new was drafted.`;
                }
                const text = [
                    `${created ? 'Drafted' : 'Already drafted'} responsibility #${responsibility.id} "${responsibility.title}". It is a DRAFT: it grants nothing and nothing is running.`,
                    grants.length
                        ? `As recorded, it would allow: ${grants.join('; ')}.`
                        : 'As recorded, it would allow nothing yet (no operations).',
                    responsibility.expiresAt ? `It would end ${responsibility.expiresAt} UTC.` : 'It has no end date.',
                    web
                        ? 'A confirmation card is shown to the person with your reply. Only they can turn it on, keep it as a draft or discard it, by pressing it themselves.'
                        : `Only the person can turn it on, on ${responsibilitiesPage()}. It cannot be confirmed here.`,
                    'Tell them what it would allow and that it is waiting for their confirmation. Do not say it is active.'
                ].join(' ');
                return web
                    ? { _display: text, _card: { kind: 'assistant-proposal', id: responsibility.id } }
                    : text;
            } catch (error) {
                return failure(error);
            }
        }
    },

    describeDelegatedWork: {
        offered,
        definition: {
            name: 'describeDelegatedWork',
            description: 'Read the person\'s own delegated work, from the records: their responsibilities and what each allows, the work that is open or recently finished, why a piece of work was proposed and exactly what a run did (each step, its status, and any refusal code), and the requests waiting on them. Use it for "what are you working on?", "why did you do that?", "why did that stop?", "what needs me?". Answer from what it returns, including refusals and failures; never from memory or guesswork. what: "overview" (default), "responsibility" (id: a responsibility id), "work" (id: an initiative id; includes the run\'s step-by-step record), or "requests" (what is waiting on the person; in the portal their decision cards are shown with your reply). Read-only.',
            parameters: {
                type: 'object',
                properties: {
                    what: { type: 'string', enum: ['overview', 'responsibility', 'work', 'requests'], description: 'What to read. Default "overview".' },
                    id: { type: 'number', description: 'responsibility: its id. work: the initiative id.' }
                },
                required: []
            }
        },
        execute: async ({ what = 'overview', id, interactionContext }) => {
            const who = await entry(interactionContext);
            if (who.refusal) return who.refusal;
            const userId = who.userId;
            const responsibilities = require('../../services/assistantResponsibilityService');
            const initiatives = require('../../services/assistantInitiativeService');
            const runs = require('../../services/assistantRunService');
            try {
                if (what === 'responsibility') {
                    if (id == null) return '❌ Name the responsibility by its id (see the overview).';
                    const item = await responsibilities.get({ userId, id });
                    const listed = await initiatives.list({ userId, responsibilityId: item.id, limit: OVERVIEW_LIMIT });
                    const summaries = await runs.summaries({ userId, initiativeIds: listed.initiatives.map(entry => entry.id) });
                    return [
                        `Responsibility ${describeResponsibility(item)}.`,
                        item.outcome ? `Outcome wanted: ${clip(item.outcome, 400)}` : null,
                        `Revision ${item.revision}. ${item.rules?.autoStart ? 'Proposed work starts on its own.' : 'Each piece of work waits for the person to start it.'}`,
                        listed.initiatives.length
                            ? `Its work:\n${listed.initiatives.map(entry => `- ${describeInitiative(entry, summaries.get(entry.id))}`).join('\n')}`
                            : 'It has no work yet.'
                    ].filter(Boolean).join('\n');
                }

                if (what === 'work') {
                    if (id == null) return '❌ Name the work by its id (see the overview).';
                    const item = await initiatives.get({ userId, id });
                    const run = await runs.forInitiative({ userId, initiativeId: item.id });
                    const lines = [
                        `Work ${describeInitiative(item, run)}.`,
                        `Why it exists: ${item.reason ? clip(item.reason, 300) : 'no reason recorded'} (source: ${item.source.kind} ${item.source.id}, attempt ${item.attempt}).`
                    ];
                    if (!run) {
                        lines.push('It has not run: there is no run record.');
                    } else {
                        lines.push(`Run: ${run.status.toLowerCase()}${run.stopCode ? `, stop code ${run.stopCode}` : ''}${run.outcome ? `, outcome ${run.outcome}` : ''}; `
                            + `${run.rounds} round(s), ${run.tokensUsed} tokens, ${run.searches} search(es).`);
                        if (run.resultSummary) lines.push(`What it concluded: ${clip(run.resultSummary, 600)}`);
                        lines.push('Steps, in order:', ...describeJournal(run.operations));
                    }
                    return lines.join('\n');
                }

                if (what === 'requests') {
                    const inbox = require('../../services/inboxService');
                    const page = await inbox.list({ userId, view: 'needs_you', limit: OVERVIEW_LIMIT });
                    const items = page.items || [];
                    if (!items.length) return 'Nothing is waiting on the person right now.';
                    const refs = items.map(item => item.decision?.ref).filter(Boolean).slice(0, REQUEST_CARD_LIMIT);
                    const text = [
                        `${items.length} request(s) waiting on the person:`,
                        ...items.map(item => `- ${clip(item.title, 160)}${item.decision ? ` (can be decided on its card: ${item.decision.options.map(option => option.label).join(' / ')})` : ' (open it to answer)'}`),
                        isWebChat(interactionContext, userId) && refs.length
                            ? 'Their decision cards are shown to the person with your reply. Only they can decide, by pressing a card; you cannot decide for them.'
                            : 'They decide these on Home or in the Inbox. You cannot decide for them.'
                    ].join('\n');
                    return isWebChat(interactionContext, userId) && refs.length
                        ? { _display: text, _card: { kind: 'assistant-requests', refs } }
                        : text;
                }

                if (what !== 'overview') return '❌ what must be overview, responsibility, work or requests.';
                const all = (await responsibilities.list({ userId })).responsibilities.filter(item => item.status !== 'ARCHIVED');
                const listed = (await initiatives.list({ userId, limit: 100 })).initiatives;
                const open = listed.filter(item => OPEN_STATUSES.includes(item.status)).slice(0, OVERVIEW_LIMIT);
                const finished = listed.filter(item => !OPEN_STATUSES.includes(item.status)).slice(0, 5);
                const summaries = await runs.summaries({ userId, initiativeIds: [...open, ...finished].map(item => item.id) });
                if (!all.length) return 'The person has no responsibilities. Nothing is delegated and nothing is running.';
                return [
                    `Responsibilities (${all.length}):`,
                    ...all.slice(0, OVERVIEW_LIMIT).map(item => `- ${describeResponsibility(item)}`),
                    open.length ? `Open work (${open.length}):` : 'No work is open.',
                    ...open.map(item => `- ${describeInitiative(item, summaries.get(item.id))}`),
                    finished.length ? 'Recently finished:' : null,
                    ...finished.map(item => `- ${describeInitiative(item, summaries.get(item.id))}`),
                    'For why a piece of work exists and what its run did step by step, read it with what="work" and its id.'
                ].filter(Boolean).join('\n');
            } catch (error) {
                return failure(error);
            }
        }
    },

    controlDelegatedWork: {
        offered,
        definition: {
            name: 'controlDelegatedWork',
            description: 'Stop the person\'s delegated work when they ask ("stop that", "pause the notes one"). action "cancel" cancels one piece of work (id: the initiative id) and reports what its run had already changed, which is not undone. action "pause" pauses one responsibility (id: the responsibility id): nothing new starts under it until the person resumes it. This tool only narrows. It cannot start, queue, retry, resume, activate, edit or widen anything; the person does those in the portal. If it is not clear which work they mean, read describeDelegatedWork first and ask.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['cancel', 'pause'], description: 'cancel one piece of work, or pause one responsibility.' },
                    id: { type: 'number', description: 'cancel: the initiative id. pause: the responsibility id.' }
                },
                required: ['action', 'id']
            }
        },
        execute: async ({ action, id, interactionContext }) => {
            const who = await entry(interactionContext);
            if (who.refusal) return who.refusal;
            const userId = who.userId;
            const responsibilities = require('../../services/assistantResponsibilityService');
            const initiatives = require('../../services/assistantInitiativeService');
            const runs = require('../../services/assistantRunService');
            try {
                if (action === 'cancel') {
                    const item = await initiatives.get({ userId, id });
                    if (!OPEN_STATUSES.includes(item.status)) {
                        return `Work #${item.id} "${clip(item.title, 120)}" is already ${item.status.toLowerCase()}; there is nothing to cancel.`;
                    }
                    const { initiative } = await initiatives.act({ userId, id: item.id, action: 'cancel', expectedRevision: item.revision });
                    const run = await runs.forInitiative({ userId, initiativeId: item.id });
                    const writes = completedWrites(run);
                    const changed = !run
                        ? 'It had not started, so nothing was changed.'
                        : writes.length
                            ? `Before it stopped, its run had already made ${writes.length} change(s), which stay as they are:\n${writes.map(op => `- ${op.tool} (${op.operation}${op.resourceKind ? ` on ${op.resourceKind}` : ''})`).join('\n')}`
                            : 'Its run had made no changes before it stopped.';
                    return `Cancelled work #${initiative.id} "${clip(initiative.title, 120)}" (it was ${item.status.toLowerCase()}). ${changed}`;
                }
                if (action === 'pause') {
                    const item = await responsibilities.get({ userId, id });
                    if (item.status !== 'ACTIVE') {
                        return `Responsibility #${item.id} "${clip(item.title, 120)}" is ${item.status.toLowerCase().replace('_', ' ')}, not active; there is nothing to pause.`;
                    }
                    const { responsibility } = await responsibilities.act({ userId, id: item.id, action: 'pause', expectedRevision: item.revision });
                    return `Paused responsibility #${responsibility.id} "${clip(responsibility.title, 120)}". Nothing new starts under it and its open work waits. `
                        + `Only the person can resume it, on ${responsibilitiesPage()}.`;
                }
                return '❌ action must be cancel or pause. Starting, resuming and editing are the person\'s own, in the portal.';
            } catch (error) {
                return failure(error);
            }
        }
    },

    spokenBriefing: {
        offered: offeredInVoice,
        definition: {
            name: 'spokenBriefing',
            description: 'Brief the person aloud on their delegated work when they ask for it by voice ("brief me", "what needs me?", "what changed?", "catch me up"). It returns the briefing to say: the same counts their Home page shows, the titles of what is waiting on them, and up to three new findings. Say it as given, keeping every number and title, and add nothing of your own. Read-only: hearing it marks nothing as seen and decides nothing, and you cannot do either for them. It answers only in the person\'s own voice chat, never in a voice channel other people can hear.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        execute: async ({ interactionContext } = {}) => {
            const who = await voiceEntry(interactionContext);
            if (who.refusal) return who.refusal;
            try {
                const briefing = await require('../../services/assistant/spokenBriefing').brief({ userId: who.userId });
                return [
                    'Say this briefing to the person now, in these words or close to them. It is the whole reply: keep every number and every title exactly, and add no item, count or guess of your own.',
                    '',
                    briefing.text,
                    '',
                    'Saying it marked nothing as seen and decided nothing. Everything stays on Home and in the Inbox until the person reviews or decides it there themselves; you cannot do that for them.'
                ].join('\n');
            } catch (error) {
                return failure(error);
            }
        }
    }
};

// Helpers ride along without being enumerable: the registry spreads this
// module into its catalog, and only tools belong there.
for (const [name, value] of Object.entries({
    entry,
    voiceEntry,
    offered,
    describeOperations,
    TOOL_NAMES: ['proposeResponsibility', 'describeDelegatedWork', 'controlDelegatedWork', 'spokenBriefing'],
    MAX_PENDING_PROPOSALS
})) {
    Object.defineProperty(module.exports, name, { value, enumerable: false });
}
