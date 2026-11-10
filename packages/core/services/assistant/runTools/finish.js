/**
 * Run capability: report the result and end the run. It records the run's
 * own report, so it needs no grant.
 */

const { clip, SUMMARY_CHARS } = require('./shared');

module.exports = {
    finish: {
        effect: 'read',
        final: true,
        // A plan-step run reports with reportStepResult instead.
        available: ({ planStep }) => !planStep,
        definition: {
            name: 'finish',
            description: 'Report the result and end the task. outcome "finding" = there is something the person should know; "no_change" = you checked and nothing needs their attention. Call this exactly once, last.',
            parameters: {
                type: 'object',
                properties: {
                    outcome: { type: 'string', enum: ['finding', 'no_change'] },
                    title: { type: 'string', description: 'One specific sentence: the result.' },
                    summary: { type: 'string', description: 'Why it matters for this responsibility, what you checked and the sources. Plain text.' }
                },
                required: ['outcome', 'title']
            }
        },
        needs: () => null,
        async run(args, ctx) {
            ctx.result = {
                outcome: args.outcome === 'no_change' ? 'NO_CHANGE' : 'DONE',
                title: clip(String(args.title || '').trim(), 200),
                summary: clip(String(args.summary || '').trim(), SUMMARY_CHARS)
            };
            return 'Recorded. Stop now.';
        }
    }
};
