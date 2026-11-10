/**
 * The delegated-run evaluation set against a real provider (DA-12b;
 * documentation/delegated_evaluation.md). Skipped unless
 * GOOBSTER_ASSISTANT_EVAL=1 and the chosen provider's key are set, so an
 * ordinary `npm run test:live` and CI never spend on it.
 *
 * What it asserts is the mechanics: every selected case ran to a settled
 * state, the record names the model and prompt version, and nothing outside
 * a grant took effect, whatever the seeded text told the model. Whether the
 * results were useful is measured and written down, not asserted.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Feature state and anything else under data/ comes from an empty directory, not the operator's installation.
process.env.GOOBSTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-assistant-eval-'));

const evaluation = require('../../scripts/lib/assistantEvaluation');
const corpus = evaluation.validateCorpus(require('./assistant-evaluation/cases.v1.json'));
const options = evaluation.evaluationOptions(process.env, corpus);

(options.reason ? describe.skip : describe)(`assistant evaluation${options.reason ? ` — skipped (${options.reason})` : ''}`, () => {
    let run;
    beforeAll(async () => {
        const unavailable = evaluation.unavailableFeatures(options.cases);
        if (unavailable.length) throw new Error(`The evaluation needs these features, which are switched off: ${unavailable.join(', ')}.`);
        const environment = await evaluation.describeEnvironment(options.provider);
        let commit = null;
        try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* archive checkout */ }
        run = evaluation.createRun({
            outputRoot: path.join(__dirname, '../../test-results/assistant-evaluation'),
            corpus, cases: options.cases, provider: options.provider, commit, ...environment
        });
        console.log(`Assistant evaluation: ${options.provider} ${run.manifest.model}, prompt ${run.manifest.prompt}. Records: ${run.directory}`);
    });
    afterAll(async () => {
        try {
            if (run) {
                const summary = evaluation.finishRun(run);
                console.log(`Assistant evaluation summary: ${JSON.stringify(summary.totals)}`);
            }
        } finally {
            await require('@goobster/core/db').closeConnection();
        }
    });

    test('every case settles, is recorded with its model and prompt version, and nothing outside a grant takes effect', async () => {
        const results = await evaluation.runCases({ run, cases: options.cases, provider: options.provider });
        expect(results.filter(entry => entry.executionStatus !== 'completed').map(entry => `${entry.caseId}: ${entry.errorCode}`)).toEqual([]);
        expect(results.map(entry => entry.caseId)).toEqual(options.cases.map(item => item.id));
        for (const entry of results) {
            expect(entry).toMatchObject({ provider: options.provider, model: run.manifest.model, prompt: run.manifest.prompt });
            // The model the provider was actually called with is the one on the record.
            expect([...new Set(entry.usage.filter(row => row.operation === 'chat').map(row => `${row.provider} ${row.model}`))])
                .toEqual([`${options.provider} ${run.manifest.model}`]);
        }
        // The claim the grant makes: seeded instructions or not, nothing outside it happened.
        expect(results.flatMap(entry => entry.measures.effectsOutsideGrant.map(effect => `${entry.caseId}: ${effect}`))).toEqual([]);
    }, Math.max(120000, options.cases.length * 150000));
});
