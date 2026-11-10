/**
 * Run capability: apply one typed repair to the failing process this run
 * was started for (DA-5c, ADR 0029). It needs `process.repair` on exactly
 * that process, and is offered only to a run proposed for a process
 * incident, to an owner who has the `repair` capability.
 *
 * The model chooses among the repairs the system found possible and gives
 * its diagnosis; that is all it supplies. Which process is repaired comes
 * from the attempt's origin, what a repair changes is computed by code
 * (assistantProcessRepairService), and whether it worked is decided
 * afterwards from the process's own typed observations, never from what
 * the model reports.
 *
 * The repair record carries this operation's identity, so a run that
 * resumes after a crash finds the repair it already applied instead of
 * applying another.
 */

const { clip } = require('./shared');

const OPERATION = 'process.repair';
const ORIGIN = 'process_incident';
const ACTIONS = ['rerun', 'follow_redirect'];

const repairs = () => require('../../assistantProcessRepairService');
const attemptKey = (ctx) => `assistant_run:${ctx.run.id}:${ctx.opId}`;

module.exports = {
    repairProcess: {
        effect: 'write',
        component: 'processes',
        available: ({ origin, grants, capabilities }) => origin?.kind === ORIGIN
            && Boolean(capabilities?.repair)
            && (grants || []).some(grant => grant?.operation === OPERATION),
        definition: {
            name: 'repairProcess',
            description: 'Apply one repair to the failing process this task is about. action "rerun" = run it once now with nothing about it changed (for a cause that may have passed); "follow_redirect" = point a followed source at the address its own server now redirects to. Use only an action listed as available for this process. You cannot change anything else about the process. The system checks afterwards whether the repair worked and undoes it if it did not; the result tells you what is known so far. Call it at most once.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ACTIONS },
                    diagnosis: { type: 'string', description: 'One or two sentences: what you think is wrong and why this repair fits. The person reads this.' }
                },
                required: ['action', 'diagnosis']
            }
        },
        needs: (_args, ctx) => (ctx.origin?.kind === ORIGIN && typeof ctx.origin.ref === 'string'
            ? { operation: OPERATION, resource: { kind: 'process', id: ctx.origin.ref } }
            : { refuse: 'NO_PROCESS' }),
        /** After a crash: a repair record carrying this operation's identity means it was applied. */
        async reconcile(_args, ctx) {
            const found = await repairs().applied({ attemptKey: attemptKey(ctx) });
            return found ? { state: 'done', result: found.text } : { state: 'absent' };
        },
        async run({ action, diagnosis }, ctx) {
            const outcome = await repairs().repair({
                owner: ctx.run.ownerUserId,
                ref: ctx.origin.ref,
                action: String(action || ''),
                note: clip(String(diagnosis || '').trim(), 400) || null,
                responsibilityId: ctx.run.responsibilityId,
                initiativeId: ctx.run.initiativeId,
                attemptKey: attemptKey(ctx)
            });
            return outcome.text;
        }
    }
};
