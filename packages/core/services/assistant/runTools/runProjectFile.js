/**
 * Run capability: run one file of the linked project in the sandbox (needs
 * `sandbox.run` on that `project`; counts against the daily compute budget).
 * Offered only with a linked project and the sandbox feature.
 */

const db = require('../../../db');
const requireOptional = require('../../../utils/optionalModule').forModule(module);
const { clip, RESULT_CHARS } = require('./shared');

module.exports = {
    runProjectFile: {
        effect: 'write',
        budget: 'computeSeconds',
        component: 'projects',
        publishes: 'project',
        available: ({ project, features }) => Boolean(project) && !features.enforcedOff('sandbox'),
        definition: {
            name: 'runProjectFile',
            description: 'Run one .py, .js or .sh file from the linked project in the sandbox (no network) and return its output. Each run counts against a small daily compute budget.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Workspace-relative file to run.' },
                    args: { type: 'array', items: { type: 'string' } }
                },
                required: ['path']
            }
        },
        needs: ({ path }, ctx) => (ctx.project
            ? { operation: 'sandbox.run', resource: { kind: 'project', id: String(ctx.project.id), path: String(path || '') } }
            : { refuse: 'NO_PROJECT' }),
        _attempt: (ctx) => `assistant_run:${ctx.run.id}:${ctx.opId}`,
        /** After a crash: the job row with this attempt id says whether it ran. */
        async reconcile(_args, ctx) {
            const job = await db.get(
                'SELECT id, status, exitCode FROM observatory_jobs WHERE executionAttemptId = @attempt', { attempt: this._attempt(ctx) }
            );
            if (!job) return { state: 'absent' };
            if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) {
                return { state: 'done', result: `Ran as job #${job.id}: ${String(job.status).toLowerCase()} (exit ${job.exitCode ?? '?'}). Its output is in the project's Runs.` };
            }
            return { state: 'unknown' };
        },
        async run({ path, args }, ctx) {
            const projects = requireOptional('../../projectService', { feature: 'projects' });
            if (!projects) return 'Not run: projects are not available on this installation.';
            const started = Date.now();
            try {
                const outcome = await projects.runFile({
                    userId: ctx.actor, project: ctx.project.slug, owner: ctx.project.ownerId, path: String(path || ''),
                    args: Array.isArray(args) ? args.map(String) : [], background: false,
                    startedBy: 'assistant', executionAttemptId: this._attempt(ctx)
                });
                const result = outcome.result || {};
                return clip(
                    `Ran ${String(path)} as job #${outcome.jobId ?? '?'}: ${result.ok ? 'ok' : 'failed'} (exit ${result.exitCode ?? '?'}).\n`
                    + `stdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`, RESULT_CHARS
                );
            } finally {
                ctx.compute += Math.max(1, Math.round((Date.now() - started) / 1000));
            }
        }
    }
};
