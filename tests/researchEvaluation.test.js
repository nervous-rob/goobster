const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-evaluation-test-'));
process.env.GOOBSTER_DB_PATH = path.join(temp, 'test.sqlite');
const evaluation = require('../scripts/lib/researchEvaluation');
const corpus = require('./live/research-evaluation/questions.v1.json');
const db = require('@goobster/core/db');
const identity = require('@goobster/core/services/identityService');
const usage = require('@goobster/core/services/usageTracker');
const ai = require('@goobster/core/services/aiService');
const budgets = require('@goobster/core/services/usageBudgetService');
const context = require('@goobster/core/utils/workContext');
const item = corpus.cases[0];
const brief = { summary: 'Two retries follow the initial attempt [S1].',
    claims: [{ id: 'C1', text: 'Larch makes two retries after a timeout.', sourceIds: ['S1'] }], limitations: ['Only Larch 2.1.'] };
let actor;
const create = (provider = 'openai') => evaluation.createRun({ outputRoot: temp, corpus, cases: [item],
    provider, model: ai.defaultModelFor(provider) });
const execute = (run, extra = {}) => evaluation.runCase({ run, item, actor, provider: 'openai',
    model: ai.defaultModelFor('openai'), ...extra });
function providerMock(provider, response = brief, known = true) {
    const service = require(`@goobster/core/services/${provider}Service`);
    jest.spyOn(service, 'isConfigured').mockReturnValue(true);
    return jest.spyOn(service, 'chat').mockImplementation(async (_messages, opts) => {
        await usage.log({ provider, model: opts.model, operation: 'chat', userId: actor,
            inputTokens: 100, outputTokens: 20, usageKnown: known });
        return { content: typeof response === 'string' ? response : JSON.stringify(response), toolCalls: [] };
    });
}
beforeAll(async () => {
    actor = (await identity.createNativePrincipal({ displayName: 'Evaluation test' })).id;
    await identity.grantAccount({ principalId: actor, entitlement: 'bootstrap' });
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => { await db.closeConnection(); fs.rmSync(temp, { recursive: true, force: true }); });

test('versioned corpus has five distinct questions in each category', () => {
    expect(evaluation.validateCorpus(corpus)).toBe(corpus);
    for (const category of evaluation.CATEGORIES) expect(corpus.cases.filter(c => c.category === category)).toHaveLength(5);
    const changed = structuredClone(corpus); changed.cases[1].id = changed.cases[0].id;
    expect(() => evaluation.validateCorpus(changed)).toThrow(/duplicate/);
});
test('review answers and category labels never enter the model prompt', () => {
    for (const item of corpus.cases) {
        const messages = evaluation.buildMessages(item);
        expect(JSON.parse(messages[1].content)).toEqual({ question: item.question, sources: item.sources });
        for (const criterion of item.reviewCriteria) expect(JSON.stringify(messages)).not.toContain(criterion);
    }
});
test('opt-in and selected-provider key are both required; invalid/subset selections are explicit', () => {
    expect(evaluation.evaluationOptions({ OPENAI_API_KEY: 'present' }, corpus).reason).toMatch(/GOOBSTER_RESEARCH_EVAL/);
    expect(evaluation.evaluationOptions({ GOOBSTER_RESEARCH_EVAL: '1' }, corpus).reason).toMatch(/OPENAI_API_KEY/);
    expect(evaluation.evaluationOptions({ GOOBSTER_RESEARCH_EVAL: '1', GOOBSTER_RESEARCH_EVAL_PROVIDER: 'gemini', OPENAI_API_KEY: 'present' }, corpus).reason).toMatch(/GEMINI_API_KEY/);
    expect(() => evaluation.evaluationOptions({ GOOBSTER_RESEARCH_EVAL: '1', GOOBSTER_RESEARCH_EVAL_CASES: 'missing' }, corpus)).toThrow();
    expect(() => evaluation.evaluationOptions({ GOOBSTER_RESEARCH_EVAL: '1', GOOBSTER_RESEARCH_EVAL_PROVIDER: 'unknown' }, corpus)).toThrow();
    expect(evaluation.evaluationOptions({ GOOBSTER_RESEARCH_EVAL: '1', OPENAI_API_KEY: 'present', GOOBSTER_RESEARCH_EVAL_CASES: item.id }, corpus).cases).toEqual([item]);
});
test('live setup isolates an inherited production Postgres URL and DB path before imports', () => {
    const env = { GOOBSTER_DB_URL: 'postgres://production.example/private', GOOBSTER_DB_PATH: '/production.sqlite' };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'live/setup.js'), 'utf8'), { require, process: { env } });
    expect(env.GOOBSTER_DB_URL).toBe('');
    expect(env.GOOBSTER_DB_PATH).not.toBe('/production.sqlite');
    expect(fs.existsSync(path.dirname(env.GOOBSTER_DB_PATH))).toBe(true);
    fs.rmSync(path.dirname(env.GOOBSTER_DB_PATH), { recursive: true });
});
test.each(['openai', 'anthropic', 'gemini'])('%s uses normal admission and settled cost join, leaving quality undecided', async provider => {
    const call = providerMock(provider);
    const run = create(provider);
    const result = await context.run({ kind: 'job', id: 'parent-work', actor }, () => execute(run, { provider, model: ai.defaultModelFor(provider) }));
    expect(call).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ executionStatus: 'completed', qualityStatus: 'awaiting-owner-review', costStatus: 'settled', cost: { actualTokens: 120 } });
    expect(result.work).toMatchObject({ kind: 'chat', payer: actor });
    expect(result.work.id).not.toBe('parent-work');
    expect(result.reservations).toEqual([expect.objectContaining({ actualTokens: 120, status: 'settled', reconcile: 0 })]);
    const review = JSON.parse(fs.readFileSync(path.join(run.directory, `${item.id}.review.json`)));
    expect(review).toMatchObject({ readyToShow: null, acceptedAndUsed: null, editType: null, claims: [expect.objectContaining({ mark: null })] });
    expect(run.manifest.fullCorpusSelected).toBe(false);
    const reservations = await db.all('SELECT * FROM usage_reservations WHERE workId = @id', { id: result.work.id });
    expect(JSON.stringify(reservations)).not.toContain(item.question);
});
test('unknown usage remains provisional; an empty answer or invented citation is a format failure, not an automatic retry', async () => {
    const call = providerMock('openai', { ...brief, claims: [{ id: 'C1', text: 'Invented evidence.', sourceIds: ['S999'] }] }, false);
    const result = await execute(create());
    expect(result).toMatchObject({ executionStatus: 'failed', errorCode: 'EVAL_FORMAT_INVALID', costStatus: 'provisional' });
    expect(result.reservations[0].reconcile).toBe(1);
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.raw).toContain('S999');
    expect((await db.get('SELECT code FROM work_failures WHERE workId = @id', { id: result.work.id })).code).toBe('EVAL_FORMAT_INVALID');
});
test('provider failure preserves uncertain cost and does not copy sensitive error text', async () => {
    const call = providerMock('openai');
    call.mockRejectedValue(new Error('secret-provider-key-and-request-body'));
    const result = await execute(create());
    expect(result).toMatchObject({ executionStatus: 'failed', errorCode: 'EVAL_PROVIDER_FAILED', costStatus: 'provisional' });
    expect(JSON.stringify(result)).not.toContain('secret-provider-key');
    expect(call).toHaveBeenCalledTimes(1);
});
test('cancelled work never calls the provider', async () => {
    const call = providerMock('openai');
    const result = await execute(create(), { signal: AbortSignal.abort() });
    expect(result).toMatchObject({ errorCode: 'CANCELLED', costStatus: 'unavailable' });
    expect(call).not.toHaveBeenCalled();
});
test('budget refusal is recorded without buying a call', async () => {
    const call = providerMock('openai');
    await budgets.setPolicy({ dailyTokens: 1 });
    try {
        const result = await execute(create());
        expect(result.errorCode).toBe('BUDGET_EXCEEDED'); expect(call).not.toHaveBeenCalled();
    } finally { await budgets.setPolicy({ dailyTokens: null }); }
});
test('an existing attempt cannot be overwritten or charged twice; review edits leave generated output unchanged', async () => {
    const call = providerMock('openai'); const run = create();
    await execute(run);
    const output = path.join(run.directory, `${item.id}.json`);
    const original = fs.readFileSync(output, 'utf8');
    fs.writeFileSync(path.join(run.directory, `${item.id}.review.json`), JSON.stringify({ editType: 'factual' }));
    await expect(execute(run)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.readFileSync(output, 'utf8')).toBe(original); expect(call).toHaveBeenCalledTimes(1);
});
test('parser checks structure and citation identity but never marks unsupported factual content as correct', () => {
    expect(() => evaluation.parseBrief('', item)).toThrow();
    expect(() => evaluation.parseBrief(JSON.stringify({ ...brief, claims: [brief.claims[0], brief.claims[0]] }), item)).toThrow();
    const wrong = { ...brief, claims: [{ id: 'C1', text: 'There are 900 retries.', sourceIds: ['S1'] }] };
    const parsed = evaluation.parseBrief(JSON.stringify(wrong), item);
    expect(evaluation.reviewTemplate(item, parsed).claims[0].mark).toBeNull();
});

test('run summary never turns transport success or an incomplete run into a reviewed baseline', async () => {
    providerMock('openai');
    const run = create();
    await execute(run);
    const summary = evaluation.finishRun(run);
    expect(summary).toMatchObject({ completeCorpus: false, qualityStatus: 'awaiting-owner-review', accepted: null,
        costPerAccepted: null, settledTokens: 120, costProvisional: false });
    const incomplete = evaluation.createRun({ outputRoot: temp, corpus, cases: corpus.cases, provider: 'openai', model: 'fixture' });
    const unfinished = evaluation.finishRun(incomplete);
    expect(unfinished.completeCorpus).toBe(false);
    expect(unfinished.cases.every(c => c.executionStatus === 'not-completed')).toBe(true);
});

test('batch stops buying calls after a provider/cap failure, but preserves format failures and continues', async () => {
    const call = jest.fn()
        .mockResolvedValueOnce({ errorCode: 'EVAL_FORMAT_INVALID' })
        .mockResolvedValueOnce({ errorCode: 'EVAL_PROVIDER_FAILED' });
    const results = await evaluation.runCases({ cases: corpus.cases }, { runCase: call });
    expect(call).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
});
