/**
 * Run capability: report the result of the agent plan step this run is
 * carrying out (ADR 0019). Offered only to a run dispatched for a plan
 * step, where it replaces `finish`. It needs `plan.step.execute` on the
 * project.
 *
 * The report is a claim, not the result: the run service verifies the
 * named files against the run's own journal and the workspace before the
 * step is marked done (see ../planStepRun.js). Nothing the model writes
 * here reaches the project; the title and summary go to the person's own
 * update.
 */

const { clip, cleanPath, SUMMARY_CHARS } = require('./shared');

const MAX_ARTIFACTS = 12;
const MAX_CRITERIA = 12;

function list(value, max, clean) {
    const out = [];
    for (const item of Array.isArray(value) ? value : []) {
        const text = clean(item);
        if (text && !out.includes(text)) out.push(text);
        if (out.length >= max) break;
    }
    return out;
}

module.exports = {
    reportStepResult: {
        effect: 'read',
        // Ends the run: a resumed run records the report again from its journal.
        final: true,
        available: ({ planStep }) => Boolean(planStep),
        definition: {
            name: 'reportStepResult',
            description: 'Report the result of the plan step and end the task. outcome "done" = the step is finished and the files you name hold its result; "blocked" = you could not finish it. Name every file you wrote for this step. The result is checked against what you actually wrote. Call this exactly once, last.',
            parameters: {
                type: 'object',
                properties: {
                    outcome: { type: 'string', enum: ['done', 'blocked'] },
                    title: { type: 'string', description: 'One specific sentence: what the step produced, or what stopped it.' },
                    summary: { type: 'string', description: 'What you did, what you checked and the sources. Plain text. Only the person you work for sees this.' },
                    artifacts: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths of the files you wrote for this step.' },
                    criteria: { type: 'array', items: { type: 'string' }, description: 'Ids of the plan\'s success criteria this result bears on (for example "c1").' }
                },
                required: ['outcome', 'title']
            }
        },
        needs: (_args, ctx) => (ctx.planStep && ctx.project
            ? { operation: 'plan.step.execute', resource: { kind: 'project', id: String(ctx.project.id) } }
            : { refuse: 'NO_PLAN_STEP' }),
        async run(args, ctx) {
            ctx.stepReport = {
                outcome: args.outcome === 'done' ? 'done' : 'blocked',
                artifacts: list(args.artifacts, MAX_ARTIFACTS, cleanPath),
                criteria: list(args.criteria, MAX_CRITERIA, value => String(value ?? '').trim().slice(0, 24))
            };
            ctx.result = {
                outcome: 'DONE',
                title: clip(String(args.title || '').trim(), 200),
                summary: clip(String(args.summary || '').trim(), SUMMARY_CHARS)
            };
            return 'Recorded. Stop now.';
        }
    }
};
