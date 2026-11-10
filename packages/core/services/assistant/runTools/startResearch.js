/**
 * Run capability: start one focused research expedition (needs `research`
 * on `web` and `kg.generated.add` on `knowledge`). The run pauses until the
 * expedition ends. Offered only with the expeditions and knowledge features.
 */

const db = require('../../../db');
const requireOptional = require('../../../utils/optionalModule').forModule(module);
const { clip } = require('./shared');

module.exports = {
    startResearch: {
        effect: 'write',
        component: 'research',
        available: ({ features }) => !(features.enforcedOff('expeditions') || features.enforcedOff('knowledge')),
        definition: {
            name: 'startResearch',
            description: 'Start one focused research expedition on a topic: it reads sources over several minutes and writes sourced, generated notes. Use it only when a few web searches are not enough. This task pauses until it finishes and then continues with its findings. At most one per task.',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: 'What to research (under 200 characters).' },
                    intent: { type: 'string', description: 'What the person needs to learn from it.' }
                },
                required: ['topic']
            }
        },
        // It searches and it writes notes: both must be delegated.
        needs: () => ({
            operation: 'research', resource: { kind: 'web' },
            also: [{ operation: 'kg.generated.add', resource: { kind: 'knowledge', id: 'personal' } }]
        }),
        _attempt: (ctx) => `assistant_run:${ctx.run.id}:${ctx.opId}`,
        async _find(attempt) {
            return db.get(
                'SELECT id, status, summary, stopReason FROM spitball_expeditions WHERE executionAttemptId = @attempt', { attempt }
            );
        },
        _describe(expedition) {
            if (expedition.status === 'COMPLETED') {
                return `Research expedition #${expedition.id} finished. ${clip(expedition.summary || 'It wrote its notes; use lookupNotes to read them.', 3000)}`;
            }
            if (expedition.status === 'FAILED' || expedition.status === 'CANCELLED') {
                return `Research expedition #${expedition.id} ${expedition.status.toLowerCase()} without a result.`;
            }
            return `Started research expedition #${expedition.id}. This task pauses until it finishes.`;
        },
        /** After a crash: an expedition carrying this attempt id means it was started. */
        async reconcile(_args, ctx) {
            const expedition = await this._find(this._attempt(ctx));
            if (!expedition) return { state: 'absent' };
            ctx.child = expedition;
            return { state: 'done', result: this._describe(expedition) };
        },
        /** On a resumed run: say how the expedition ended, not that it started. */
        async replay(prior, ctx) {
            const expedition = await this._find(`assistant_run:${ctx.run.id}:${prior.id}`);
            if (!expedition) return prior.resultText || '';
            ctx.child = expedition;
            return this._describe(expedition);
        },
        async run({ topic, intent }, ctx) {
            if (ctx.child) return 'Not started: this task already ran its one research expedition.';
            const expeditions = requireOptional('../../spitballExpeditionService', { feature: 'expeditions' });
            if (!expeditions) return 'Not started: research expeditions are not available on this installation.';
            const expedition = await expeditions.createExpedition({
                userId: ctx.actor, seed: String(topic || ''), intent: intent ? String(intent) : null,
                depth: 'focused', executionAttemptId: this._attempt(ctx)
            });
            ctx.child = { id: expedition.id, status: 'QUEUED' };
            return this._describe(ctx.child);
        }
    }
};
