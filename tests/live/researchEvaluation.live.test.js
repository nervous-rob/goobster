const path = require('node:path');
const { execFileSync } = require('node:child_process');
const evaluation = require('../../scripts/lib/researchEvaluation');
const corpus = evaluation.validateCorpus(require('./research-evaluation/questions.v1.json'));
const options = evaluation.evaluationOptions(process.env, corpus);

(options.reason ? describe.skip : describe)(`research evaluation${options.reason ? ` — skipped (${options.reason})` : ''}`, () => {
    let run, actor, model;
    beforeAll(async () => {
        const identity = require('@goobster/core/services/identityService');
        const ai = require('@goobster/core/services/aiService');
        actor = (await identity.createNativePrincipal({ displayName: 'Research evaluation fixture' })).id;
        await identity.grantAccount({ principalId: actor, entitlement: 'bootstrap' });
        model = ai.defaultModelFor(options.provider);
        let commit = null;
        try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* archive checkout */ }
        run = evaluation.createRun({ outputRoot: path.join(__dirname, '../../test-results/research-evaluation'),
            corpus, cases: options.cases, provider: options.provider, model, commit });
        console.log(`Research evaluation artifacts: ${run.directory}. Owner review required.`);
    });
    afterAll(async () => {
        try { if (run) evaluation.finishRun(run); }
        finally { await require('@goobster/core/db').closeConnection(); }
    });
    test('generates owner-review artifacts (not a quality assertion)', async () => {
        const results = await evaluation.runCases({ run, cases: options.cases, actor, provider: options.provider, model });
        const failures = results.filter(r => r.executionStatus !== 'completed').map(r => `${r.caseId}: ${r.errorCode}`);
        expect(failures).toEqual([]);
    }, Math.max(90000, options.cases.length * 65000));
});
