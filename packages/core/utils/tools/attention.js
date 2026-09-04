/**
 * Chat tools: automations, follow-ups, and Attention.
 * Required by packages/core/utils/toolsRegistry.js — apps keep requiring the facade.
 */


module.exports = {
    manageAutomations: {
        definition: {
            name: 'manageAutomations',
            description: 'Create and manage durable recurring automations: scheduled prompts that run unattended on a cron schedule (with the full tool registry), survive bot restarts, and repeat until paused or cancelled. Use this for recurring WORK - anything that must check, fetch, generate, or act on each run ("check the lab feed every hour and post a status", "daily at 9am summarize the market") - recurring work must be an automation, never a chain of one-time follow-ups. (A reminder that merely reposts a fixed note on an interval can instead be scheduleFollowUp with repeat.) Actions: create, list (status: schedule, last/next run), pause, resume, cancel.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['create', 'list', 'pause', 'resume', 'cancel'],
                        description: 'What to do.'
                    },
                    name: { type: 'string', description: 'Automation name (required for create/pause/resume/cancel), e.g. "hourly lab check".' },
                    prompt: { type: 'string', description: 'create: the task to perform on each run, written as an instruction, e.g. "Check the lab sensor feed and post a status summary". Each run is a normal agent turn with tools.' },
                    cron: { type: 'string', description: 'create: 5-part cron schedule (minute hour day month weekday) in UTC, e.g. "0 * * * *" for every hour at :00. Runs may not be closer than 15 minutes apart.' }
                },
                required: ['action']
            }
        },
        /**
         * Durable recurring automations from chat. Scope + delivery follow
         * the conversation: a guild channel gets a guild automation posting
         * there; Discord DMs and the web portal get DM-scope rows delivered
         * to the user's Discord DM channel (the portal's Tasks-pane rules).
         * Ownership, caps, and cron validation live in
         * automationManagerService; execution is automationService's poll
         * loop - the same durable path as /automation and the portal.
         */
        execute: async ({ action, name, prompt, cron, interactionContext }) => {
            const automationManagerService = require('../../services/automationManagerService');
            const { dmScopeId } = require('../dmScope');

            const userId = interactionContext?.user?.id;
            if (!userId) return '❌ Automations need a known user in this context.';

            const guildId = interactionContext?.guildId || null;
            const scope = guildId || dmScopeId(userId);

            /** Where runs deliver: this channel, or the user's Discord DM for web chats. */
            const resolveChannelId = async () => {
                const channelId = interactionContext?.channel?.id || interactionContext?.channelId;
                const isWeb = typeof channelId === 'string' && channelId.startsWith('web:');
                if (!isWeb) return channelId || null;
                const { toGateway } = require('../../gateway');
                const gateway = toGateway(interactionContext?.gateway || interactionContext?.client);
                if (!gateway) return null;
                try {
                    return await gateway.resolveDmChannelId(userId);
                } catch {
                    return null;
                }
            };

            const describeRun = (row) => {
                const status = row.enabled === false ? '⏸️ paused' : '🟢 active';
                return `${status}, schedule \`${row.cron}\`, last run ${row.lastRun || 'never'}, next run ${row.nextRun || 'not scheduled'}`;
            };

            try {
                if (action === 'create') {
                    // An unattended automation run must never create MORE
                    // automations: a prompt phrased "check X every hour"
                    // would otherwise spawn a new sibling on every fire
                    // (variant names dodge the duplicate check) until the
                    // per-scope cap - a runaway multiplication of unattended
                    // model calls. The schedule already exists; just do the
                    // task.
                    if (interactionContext?.isAutomation === true) {
                        return '❌ This turn IS a scheduled automation run - it already recurs on its own schedule. '
                            + 'Do not create another automation; carry out the task itself now.';
                    }
                    const channelId = await resolveChannelId();
                    if (!channelId) {
                        return '❌ Could not resolve a delivery channel - web-created automations are delivered to your Discord DMs, which appear unreachable.';
                    }
                    const created = await automationManagerService.create({
                        userId, scope, channelId, name, prompt, cron
                    });
                    const where = guildId ? 'this channel' : 'your Discord DMs';
                    return `✅ Created automation "${created.name}" (schedule \`${created.cron}\`, next run ${created.nextRun.toISOString()} UTC). ` +
                        `It runs unattended in ${where} on that schedule, survives restarts, and repeats until cancelled.`;
                }

                if (action === 'list') {
                    const rows = await automationManagerService.list({ userId, scope });
                    if (rows.length === 0) return 'You have no automations here.';
                    return 'Your automations here:\n' + rows.map(row =>
                        `- "${row.name}": ${describeRun(row)} - ${row.prompt.slice(0, 120)}${row.prompt.length > 120 ? '…' : ''}`
                    ).join('\n');
                }

                if (action === 'pause' || action === 'resume') {
                    const updated = await automationManagerService.setEnabled({
                        userId, scope, name, enabled: action === 'resume'
                    });
                    return updated.enabled
                        ? `▶️ Automation "${updated.name}" resumed (next run ${updated.nextRun.toISOString()} UTC).`
                        : `⏸️ Automation "${updated.name}" paused. Resume it any time.`;
                }

                if (action === 'cancel') {
                    const removed = await automationManagerService.remove({ userId, scope, name });
                    return `🗑️ Automation "${removed.name}" cancelled.`;
                }

                return `❌ Unknown action "${action}". Use create, list, pause, resume, or cancel.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    scheduleFollowUp: {
        definition: {
            name: 'scheduleFollowUp',
            description: 'Schedule a follow-up reminder so you can circle back later, e.g. when a user mentions a deadline, plan, or event ("I\'ll deploy it tomorrow"). One-time by default; pass "repeat" for a simple recurring check-in reminder that reposts the note on that interval until cancelled, no re-scheduling needed. Reminders only post the note - they run no tools: for recurring WORK that must check, fetch, generate, or act each time ("check the lab feed every hour and post a status"), use manageAutomations instead. Never chain one-time follow-ups to fake recurrence.',
            parameters: {
                type: 'object',
                properties: {
                    note: { type: 'string', description: 'What to follow up about, e.g. "Ask Rob how the deploy went".' },
                    when: { type: 'string', description: 'When to follow up, in natural language, e.g. "tomorrow at 3pm" or "in 2 hours". Required for one-time follow-ups; for recurring ones it sets the first delivery (defaults to one interval from now).' },
                    repeat: { type: 'string', description: 'Optional recurrence, e.g. "every hour", "every 2 hours", "daily", "weekly" (minimum every 15 minutes). Omit for a one-time follow-up.' }
                },
                required: ['note']
            }
        },
        execute: async ({ note, when, repeat, interactionContext }) => {
            const followupService = require('../../services/followupService');
            const guildId = interactionContext?.guildId;
            const channelId = interactionContext?.channel?.id || interactionContext?.channelId;
            if (!guildId || !channelId) return '❌ Follow-ups can only be scheduled inside a server channel.';

            try {
                const { dueAt, recurrence } = await followupService.schedule({
                    guildId,
                    channelId,
                    userId: interactionContext.user?.id || null,
                    note,
                    whenDescription: when || null,
                    repeat: repeat || null
                });
                return recurrence
                    ? `⏰ Recurring follow-up scheduled (${recurrence}), first delivery ${dueAt} UTC: "${note}". It repeats until cancelled (Tasks pane in the web portal).`
                    : `⏰ Follow-up scheduled for ${dueAt} UTC: "${note}"`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    trackAttention: {
        definition: {
            name: 'trackAttention',
            description: 'Track, review, or close an OPEN LOOP in your attention ledger: something unfinished this person is carrying (a commitment they made, a deadline, something they are waiting on, an unresolved question, a concern). This is not a task list and not a reminder - it is your own note that something currently matters, which lets you notice later when it becomes urgent, goes stale, or gets resolved. Use "track" when they mention unfinished business worth remembering, "list" to see what you are already tracking, "resolve" when something is finished, and "drop" when it clearly stopped mattering. For a timed reminder use scheduleFollowUp; for recurring work use manageAutomations; to react when a specific condition occurs use watchFor. Requires the person to have enabled proactive attention (/attention enable).',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['track', 'list', 'resolve', 'drop'],
                        description: 'What to do.'
                    },
                    subject: { type: 'string', description: 'Short stable handle for the loop, e.g. "dbt demo". Reuse the exact existing subject to update a loop rather than duplicating it.' },
                    kind: {
                        type: 'string',
                        enum: ['goal', 'commitment', 'deadline', 'open_question', 'waiting_for', 'opportunity', 'concern'],
                        description: 'What sort of loop this is.'
                    },
                    goal: { type: 'string', description: 'track: what they are trying to reach, e.g. "give the dbt presentation Thursday".' },
                    unresolved: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'track: the specific things still open inside this loop, e.g. ["choose lineage example", "finish demo code"].'
                    },
                    deadline: { type: 'string', description: 'track: absolute UTC datetime "YYYY-MM-DD HH:MM:SS" when one genuinely applies. Omit if you are guessing.' },
                    importance: { type: 'number', description: 'track: 0-1, how much this matters to them.' },
                    confidence: { type: 'number', description: 'track: 0-1, how sure you are you understood correctly. Be honest - a low number keeps you quiet rather than wrong.' },
                    category: {
                        type: 'string',
                        enum: ['general', 'research', 'observatory', 'knowledge', 'schedule', 'github'],
                        description: 'track: which agency boundary applies.'
                    }
                },
                required: ['action']
            }
        },
        /**
         * The ledger from chat. Deliberately narrow: the model may record
         * that something matters and close it out, but nothing here decides
         * whether to interrupt anybody - that is attentionService's job,
         * behind the initiative policy and the contact budget.
         */
        execute: async ({
            action, subject, kind, goal, unresolved, deadline,
            importance, confidence, category, interactionContext
        }) => {
            const attentionLedgerService = require('../../services/attentionLedgerService');
            const attentionPolicyService = require('../../services/attentionPolicyService');
            const { dmScopeId } = require('../dmScope');

            const userId = interactionContext?.user?.id;
            if (!userId) return '❌ Open loops need a known user in this context.';
            const policy = await attentionPolicyService.get(userId);
            if (!policy?.enabled) {
                return '❌ This person has not enabled proactive attention. They can turn it on with `/attention enable`; '
                    + 'until then, do not track open loops for them.';
            }
            const scope = interactionContext?.guildId || dmScopeId(userId);
            const resolvedKind = kind || 'open_question';

            try {
                if (action === 'list') {
                    const items = await attentionLedgerService.listItems({ userId, limit: 20 });
                    if (items.length === 0) return 'You are not tracking any open loops for this person.';
                    return 'Open loops you are tracking:\n' + items.map(item =>
                        `- [${item.kind}] "${item.subject}" (${item.state}, confidence ${item.confidence.toFixed(2)})`
                        + `${item.goal ? `: ${item.goal}` : ''}`
                        + `${item.deadlineAt ? ` — due ${item.deadlineAt} UTC` : ''}`
                        + `${item.unresolved.length > 0 ? ` — open: ${item.unresolved.join('; ')}` : ''}`
                    ).join('\n');
                }

                if (action === 'track') {
                    const result = await attentionLedgerService.upsertItem({
                        guildId: scope,
                        userId,
                        kind: resolvedKind,
                        subject,
                        goal: goal || null,
                        unresolved: Array.isArray(unresolved) ? unresolved : null,
                        importance,
                        confidence,
                        category: category || null,
                        deadlineAt: deadline || null,
                        // The model saying so in conversation is direct
                        // evidence, so this counts as corroboration.
                        corroborate: true
                    });
                    if (!result) return '❌ A short subject is required to track a loop.';
                    await attentionLedgerService.addProvenance({
                        itemId: result.id,
                        sourceKind: 'tool',
                        sourceId: interactionContext?.channelId || null,
                        detail: 'Recorded during a conversation'
                    });
                    const item = await attentionLedgerService.getItem(result.id);
                    return `📌 ${result.created ? 'Now tracking' : 'Updated'} the ${resolvedKind} "${item.subject}" (state ${item.state}, confidence ${item.confidence.toFixed(2)}). `
                        + `${item.state === 'candidate' ? 'It stays an unconfirmed guess until something corroborates it, so it will not interrupt them.' : 'You may raise it proactively when it becomes relevant.'}`;
                }

                if (action === 'resolve' || action === 'drop') {
                    const existing = await attentionLedgerService.findItem({
                        guildId: scope, userId, kind: resolvedKind, subject
                    });
                    if (!existing) {
                        return `❌ No ${resolvedKind} loop called "${subject}" - use action "list" to see the exact subjects.`;
                    }
                    await attentionLedgerService.setState(existing.id, action === 'resolve' ? 'resolved' : 'abandoned');
                    return action === 'resolve'
                        ? `✅ Closed the loop "${existing.subject}".`
                        : `🗑️ Dropped the loop "${existing.subject}" - it stopped mattering.`;
                }

                return `❌ Unknown action "${action}". Use track, list, resolve, or drop.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    watchFor: {
        definition: {
            name: 'watchFor',
            description: 'Wait for a CONDITION rather than a time, then act on it. A watch arms itself against something that will happen (an Observatory job finishing, a reflection completing, a contradiction appearing) and when it does, you wake up and carry out an instruction once - inspecting the result and saying what you make of it. Use this instead of an automation whenever you care about an OUTCOME rather than a schedule: "run this overnight and see whether the bifurcation persists" is a watch on job completion, not a cron job that polls every six hours. Actions: arm, list, cancel. Requires the person to have enabled proactive attention (/attention enable).',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['arm', 'list', 'cancel'],
                        description: 'What to do.'
                    },
                    label: { type: 'string', description: 'Short handle for the watch (required for arm/cancel), e.g. "emergence run result".' },
                    condition: {
                        type: 'string',
                        description: 'arm: which condition to wait for. "observatory.job_completed" (a background run finished successfully), "observatory.job_failed" (it failed, timed out, or was interrupted), "observatory.*" (any of those), "reflection.completed", "knowledge.contradiction_detected".'
                    },
                    jobId: { type: 'number', description: 'arm: narrow an Observatory watch to one specific job id, so it fires for that run and nothing else.' },
                    prompt: { type: 'string', description: 'arm: what to do when it fires, e.g. "Read the run output, compare the bifurcation against the hypothesis that it persists above lambda=0.3, and tell me what actually happened." Runs as a full unattended turn with tools.' },
                    hours: { type: 'number', description: 'arm: how long to stay armed before giving up (default two weeks).' }
                },
                required: ['action']
            }
        },
        /**
         * Watches from chat. Firing runs a full unattended agent turn in the
         * bot process (attentionWatchService), on the same pipeline and with
         * the same guardrails as an automation run.
         */
        execute: async ({ action, label, condition, jobId, prompt, hours, interactionContext }) => {
            const attentionWatchService = require('../../services/attentionWatchService');
            const attentionPolicyService = require('../../services/attentionPolicyService');
            const { dmScopeId } = require('../dmScope');

            const userId = interactionContext?.user?.id;
            if (!userId) return '❌ Watches need a known user in this context.';
            const policy = await attentionPolicyService.get(userId);
            if (!policy?.enabled) {
                return '❌ This person has not enabled proactive attention. They can turn it on with `/attention enable`.';
            }

            try {
                if (action === 'list') {
                    const watches = await attentionWatchService.list({ userId });
                    if (watches.length === 0) return 'You have no armed watches for this person.';
                    return 'Armed watches:\n' + watches.map(watch =>
                        `- "${watch.label}" on \`${watch.topic}\`${watch.condition ? ` (${JSON.stringify(watch.condition)})` : ''}`
                        + ` — expires ${watch.expiresAt || 'never'}: ${watch.prompt.slice(0, 120)}`
                    ).join('\n');
                }

                if (action === 'cancel') {
                    const cancelled = await attentionWatchService.cancel({ userId, label });
                    return cancelled
                        ? `🗑️ Watch "${label}" disarmed.`
                        : `❌ No armed watch called "${label}".`;
                }

                if (action === 'arm') {
                    // Web chats have no Discord channel to deliver into, so
                    // the turn lands in the user's DMs (the automation rule).
                    const channelId = interactionContext?.channel?.id || interactionContext?.channelId;
                    const isWeb = typeof channelId === 'string' && channelId.startsWith('web:');
                    const watch = await attentionWatchService.register({
                        userId,
                        guildId: interactionContext?.guildId || dmScopeId(userId),
                        channelId: isWeb ? null : (channelId || null),
                        label,
                        topic: condition,
                        condition: jobId ? { jobId } : null,
                        prompt,
                        ttlHours: hours || null
                    });
                    return `🔔 Watching for \`${watch.topic}\`${jobId ? ` on job #${jobId}` : ''} as "${watch.label}". `
                        + `Nothing recurs and nothing polls - when it happens you will wake up once, do the work, and report back`
                        + `${isWeb ? ' in their Discord DMs' : ''}. It disarms itself ${watch.expiresAt ? `after ${watch.expiresAt} UTC` : 'eventually'} if the condition never occurs.`;
                }

                return `❌ Unknown action "${action}". Use arm, list, or cancel.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    }
};
