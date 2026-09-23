/**
 * Research brief (#254, documentation/research_brief.md).
 *
 * Real services behind the real portal routes with a fake model. Pins:
 *  - the generated brief is written once, hash-verified on every read, and
 *    untouched by edits, review, acceptance or use;
 *  - the owner's edits are a separate overlay that round-trips, marks each
 *    passage generated vs edited and wording vs factual, and is guarded by
 *    the revision counter (409 EDIT_CONFLICT);
 *  - a brief is private: the owner reads, writes, exports and measures;
 *    a stranger and a project member both get 404 NOT_FOUND;
 *  - a project expedition's brief is paid for by the project owner and is
 *    generated under the expedition's own work reference;
 *  - a failed generation stays on record (FAILED row + work_failures phase
 *    `brief`, never the prompt or the output);
 *  - Markdown export carries citations, limitations, edited markers, the
 *    original text and an explicit review / acceptance / use status;
 *  - unreviewed, not-ready and ready-to-show are distinct and a blank review
 *    is never a pass; acceptance and use are separate from both;
 *  - erasure removes the person's briefs and nulls the payer on others';
 *    the transparency report and leftover audit see the rows;
 *  - measurement keeps tokens and resources as separate units, includes
 *    failed attempts, and reports N/A (null) - not 0 - with no accepted brief.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-expedition-brief-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('@goobster/core/services/embeddingService', () => ({
    embed: jest.fn(async () => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' })),
    embedBatch: jest.fn(async (texts) => texts.map(() => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' }))),
    cosineSimilarity: () => 0
}));
jest.mock('@goobster/core/services/aiService', () => ({
    listProviders: () => [{ key: 'openai', isDefault: true, chatModel: 'test-model' }],
    chat: jest.fn(),
    generateText: jest.fn().mockResolvedValue('A title'),
    supportsNativeWebSearch: () => false
}));

const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const eventBusService = require('@goobster/core/services/eventBusService');
const expeditions = require('@goobster/core/services/spitballExpeditionService');
const { ExpeditionBriefService } = require('@goobster/core/services/expeditionBriefService');
const briefUtils = require('@goobster/core/utils/expeditionBrief');
const privacyService = require('@goobster/core/services/privacyService');
const workContext = require('@goobster/core/utils/workContext');

const ROB = '700000000000000061';
const SAM = '700000000000000062';
const TIA = '700000000000000063';

let server;
let port;
let briefs;
/** What the fake model answers next; tests replace it. */
let modelBehaviour;
const seenCalls = [];

const fakeAi = {
    chat: jest.fn(async (messages, opts) => {
        seenCalls.push({ messages, opts, work: workContext.current() });
        return modelBehaviour(messages, opts);
    })
};

function request({ method = 'GET', reqPath, headers = {}, body = null }) {
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path: reqPath,
            headers: {
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...headers
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* not json */ }
                resolve({ status: res.statusCode, headers: res.headers, json, text: data });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function login(userId, name) {
    const res = await request({ method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId, name } });
    expect(res.status).toBe(200);
    return res.headers['set-cookie'].find(c => c.startsWith('goobster_web_session=')).split(';')[0];
}

/**
 * A completed expedition with two accepted sources and two claims - one
 * strong and dated, one weak and undated - plus a recorded conflict and an
 * unresolved question, so the deterministic evidence notes have material.
 */
async function seedExpedition(userId, { seed = 'positive Grassmannian', projectId = null } = {}) {
    const expedition = await expeditions.createExpedition({ userId, seed, intent: 'understand the cell structure', depth: 'focused', projectId });
    await expeditions.claimForRun(expedition.id);
    const cycle = await expeditions.startCycle(expedition.id);
    const strong = await db.insert(
        `INSERT INTO research_sources (expeditionId, cycleId, userId, provider, sourceType, url, canonicalUrl, title, publisher, publishedAt, accepted)
         VALUES (@e, @c, @u, 'arxiv', 'preprint', 'https://arxiv.org/abs/1', 'https://arxiv.org/abs/1', 'Total positivity', 'arXiv', '2024-01-02', 1)`,
        { e: expedition.id, c: cycle.id, u: userId }
    );
    const weak = await db.insert(
        `INSERT INTO research_sources (expeditionId, cycleId, userId, provider, sourceType, url, canonicalUrl, title, accepted)
         VALUES (@e, @c, @u, 'wikipedia', 'encyclopedia', 'https://en.wikipedia.org/x', 'https://en.wikipedia.org/x', 'Grassmannian', 1)`,
        { e: expedition.id, c: cycle.id, u: userId }
    );
    const claimStrong = await db.insert(
        `INSERT INTO research_claims (sourceId, expeditionId, cycleId, text, kind, confidence)
         VALUES (@s, @e, @c, 'The positive Grassmannian is stratified by positroid cells.', 'factual', 0.91)`,
        { s: strong, e: expedition.id, c: cycle.id }
    );
    const claimWeak = await db.insert(
        `INSERT INTO research_claims (sourceId, expeditionId, cycleId, text, kind, confidence)
         VALUES (@s, @e, @c, 'Some authors dispute the cell count.', 'reported_opinion', 0.4)`,
        { s: weak, e: expedition.id, c: cycle.id }
    );
    await expeditions.finishCycle(cycle.id, {
        status: 'COMPLETED',
        counters: { sourceCount: 2, sourcesAccepted: 2, claimsExtracted: 2 },
        coverage: { summary: 'ok', unresolvedQuestions: ['what about odd n?'], conflicts: ['cell count disputed'], coverageScore: 0.5, noveltyScore: 0.5 }
    });
    await expeditions.completeExpedition(expedition.id, { stopReason: 'NO_LEADS', summary: 'done' });
    return { expedition: await expeditions.getById(expedition.id), claimStrong, claimWeak };
}

/** The model's well-formed answer: two cited findings, one with a phantom claim id. */
function goodBrief({ claimStrong, claimWeak }) {
    return () => ({
        content: JSON.stringify({
            summary: 'The positive Grassmannian is stratified by positroid cells; the exact cell count is disputed.',
            findings: [
                { id: 'F1', text: 'The positive Grassmannian is stratified by positroid cells.', claimIds: [claimStrong] },
                { id: 'F2', text: 'The cell count is disputed by some authors.', claimIds: [claimWeak] },
                { id: 'F3', text: 'An unsupported extra assertion.', claimIds: [999999] }
            ],
            limitations: [{ kind: 'disagreement', text: 'Sources disagree on the count.', claimIds: [claimStrong, claimWeak] }]
        })
    });
}

beforeAll((done) => {
    briefs = new ExpeditionBriefService({ ai: fakeAi });
    const ctx = createWebAppContext({
        client: { user: { id: '9', username: 'Goobster' }, guilds: { cache: new Map() } },
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: { error: () => {}, warn: () => {}, info: () => {} },
        deps: { briefs }
    });
    const app = express();
    app.use(createWebAppApp(ctx));
    server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        done();
    });
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await eventBusService.close();
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* gone */ }
    }
});

beforeEach(() => {
    seenCalls.length = 0;
});

describe('utils/expeditionBrief (pure)', () => {
    test('normalizeOverlay requires a target the brief has and an edit type', () => {
        const generated = { summary: 's', findings: [{ id: 'F1', text: 'f', claimIds: [], cited: false }], limitations: [] };
        expect(() => briefUtils.normalizeOverlay({ edits: [{ target: 'finding:F9', text: 'x', type: 'wording' }] }, generated))
            .toThrow(/finding:F9/);
        expect(() => briefUtils.normalizeOverlay({ edits: [{ target: 'summary', text: 'x' }] }, generated))
            .toThrow(/wording|factual/);
        const overlay = briefUtils.normalizeOverlay({ edits: [{ target: 'summary', text: 'x', type: 'factual', note: 'why' }] }, generated);
        expect(overlay.edits).toHaveLength(1);
        expect(briefUtils.editTypeOf(overlay)).toBe('factual');
        expect(briefUtils.editTypeOf(null)).toBe('none');
    });

    test('qualityStatus: blank review is unreviewed, a factual edit alone fails the bar', () => {
        const generated = { summary: 's', findings: [{ id: 'F1', text: 'f', claimIds: [1], cited: true }], limitations: [] };
        expect(briefUtils.qualityStatus({ generated, overlay: null, review: null }).status).toBe('unreviewed');
        const allGood = { marks: { F1: 'supported' }, gates: { noUnsupportedClaims: true, weakEvidenceLabelled: true, disagreementRepresented: true } };
        expect(briefUtils.qualityStatus({ generated, overlay: null, review: allGood }).status).toBe('ready-to-show');
        const factual = { edits: [{ target: 'summary', text: 'changed', type: 'factual' }] };
        const q = briefUtils.qualityStatus({ generated, overlay: factual, review: allGood });
        expect(q.status).toBe('not-ready');
        expect(q.parts.editsWordingOnly).toBe(false);
    });

    test('parseGenerated rejects prose that is not the brief shape', () => {
        const packet = { claims: [] };
        expect(() => briefUtils.parseGenerated('Sure! Here is a brief.', packet)).toThrow(briefUtils.BriefFormatError);
    });
});

describe('generation, immutability and the edit overlay', () => {
    let fixture;
    let briefId;

    beforeAll(async () => {
        fixture = await seedExpedition(ROB);
        modelBehaviour = goodBrief(fixture);
    });

    test('the model is called under the expedition work reference, sized for the visible reply, with the expedition model pin', async () => {
        const cookie = await login(ROB, 'rob');
        const res = await request({ method: 'POST', reqPath: `/api/app/spitball/expeditions/${fixture.expedition.id}/briefs`, headers: { cookie } });
        expect(res.status).toBe(200);
        briefId = res.json.brief.id;
        expect(res.json.brief).toMatchObject({ status: 'READY', expeditionId: fixture.expedition.id, payer: ROB, overlayRevision: 0, reviewRevision: 0, acceptedAt: null, usedAt: null });
        expect(res.json.integrity).toBe('verified');
        expect(seenCalls).toHaveLength(1);
        expect(seenCalls[0].work).toMatchObject({ kind: 'expedition', id: String(fixture.expedition.id), actor: ROB, payer: ROB });
        expect(seenCalls[0].opts.max_tokens).toBeLessThanOrEqual(4000);
        expect(seenCalls[0].opts.usageContext).toMatchObject({ userId: ROB });
        // The prompt carries the stored evidence, not a fetched page body.
        const packet = JSON.parse(seenCalls[0].messages[1].content);
        expect(packet.claims.map(c => c.id).sort()).toEqual([fixture.claimStrong, fixture.claimWeak].sort());
    });

    test('the generated text cites stored claims, drops phantom ids and states limitations from the evidence', async () => {
        const detail = await briefs.get(briefId, { userId: ROB });
        const byId = Object.fromEntries(detail.rendered.findings.map(f => [f.id, f]));
        expect(byId.F1.cited).toBe(true);
        expect(byId.F1.citations).toEqual([1]);
        expect(byId.F3.cited).toBe(false);
        expect(byId.F3.claimIds).toEqual([]);
        expect(detail.rendered.citations.map(c => c.claimId)).toEqual([fixture.claimStrong, fixture.claimWeak]);
        expect(detail.rendered.citations[0]).toMatchObject({ n: 1, sourceTitle: 'Total positivity', publishedAt: '2024-01-02', url: 'https://arxiv.org/abs/1' });
        const kinds = detail.rendered.evidenceNotes.map(n => n.kind);
        expect(kinds).toEqual(expect.arrayContaining(['uncited', 'weak_evidence', 'disagreement', 'missing_coverage', 'dated']));
        expect(detail.quality.status).toBe('unreviewed');
        expect(detail.rendered.summary.edited).toBeNull();
        expect(detail.rendered.editType).toBe('none');
    });

    test('an overlay edit round-trips, is marked wording/factual, and leaves the generated text and hash untouched', async () => {
        const before = await db.get('SELECT generatedJson, generatedHash FROM expedition_briefs WHERE id = @id', { id: briefId });
        const cookie = await login(ROB, 'rob');
        const edited = await request({
            method: 'PUT', reqPath: `/api/app/spitball/briefs/${briefId}/overlay`, headers: { cookie },
            body: { edits: [{ target: 'summary', text: 'Cells stratify the positive Grassmannian; the count is contested.', type: 'wording', note: 'tighter' }], expectedRevision: 0 }
        });
        expect(edited.status).toBe(200);
        expect(edited.json.brief.overlayRevision).toBe(1);
        expect(edited.json.rendered.summary).toMatchObject({
            edited: 'Cells stratify the positive Grassmannian; the count is contested.', editType: 'wording', editNote: 'tighter',
            text: 'Cells stratify the positive Grassmannian; the count is contested.',
            generated: 'The positive Grassmannian is stratified by positroid cells; the exact cell count is disputed.'
        });
        expect(edited.json.rendered.editType).toBe('wording');
        expect(edited.json.overlay.edits).toEqual([expect.objectContaining({ target: 'summary', type: 'wording', text: expect.any(String) })]);

        // Factual edit on a finding: recorded as such; a phantom target is refused.
        const factual = await request({
            method: 'PUT', reqPath: `/api/app/spitball/briefs/${briefId}/overlay`, headers: { cookie },
            body: { edits: [...edited.json.overlay.edits, { target: 'finding:F2', text: 'The cell count is disputed in the literature.', type: 'factual' }], expectedRevision: 1 }
        });
        expect(factual.status).toBe(200);
        expect(factual.json.rendered.editType).toBe('factual');
        const bad = await request({
            method: 'PUT', reqPath: `/api/app/spitball/briefs/${briefId}/overlay`, headers: { cookie },
            body: { edits: [{ target: 'finding:F42', text: 'nope', type: 'wording' }], expectedRevision: 2 }
        });
        expect(bad.status).toBe(400);

        // Removing every edit restores the generated text; the original never moved.
        const cleared = await request({
            method: 'PUT', reqPath: `/api/app/spitball/briefs/${briefId}/overlay`, headers: { cookie },
            body: { edits: [], expectedRevision: 2 }
        });
        expect(cleared.status).toBe(200);
        expect(cleared.json.rendered.summary.edited).toBeNull();
        expect(cleared.json.rendered.summary.text).toBe(cleared.json.rendered.summary.generated);
        const after = await db.get('SELECT generatedJson, generatedHash FROM expedition_briefs WHERE id = @id', { id: briefId });
        expect(after).toEqual(before);
        expect(cleared.json.integrity).toBe('verified');
    });

    test('a stale revision is refused with 409 EDIT_CONFLICT and changes nothing', async () => {
        const cookie = await login(ROB, 'rob');
        const stale = await request({
            method: 'PUT', reqPath: `/api/app/spitball/briefs/${briefId}/overlay`, headers: { cookie },
            body: { edits: [{ target: 'summary', text: 'late', type: 'wording' }], expectedRevision: 0 }
        });
        expect(stale.status).toBe(409);
        expect(stale.json.error.code).toBe('EDIT_CONFLICT');
        const detail = await briefs.get(briefId, { userId: ROB });
        expect(detail.rendered.summary.edited).toBeNull();
        const staleReview = await request({
            method: 'PUT', reqPath: `/api/app/spitball/briefs/${briefId}/review`, headers: { cookie },
            body: { marks: { F1: 'supported' }, expectedRevision: 5 }
        });
        expect(staleReview.status).toBe(409);
        expect(staleReview.json.error.code).toBe('EDIT_CONFLICT');
    });

    test('tampering with the stored generated text is visible as an integrity mismatch', async () => {
        const row = await db.get('SELECT generatedJson FROM expedition_briefs WHERE id = @id', { id: briefId });
        const forged = JSON.parse(row.generatedJson);
        forged.summary = 'forged';
        await db.run('UPDATE expedition_briefs SET generatedJson = @g WHERE id = @id', { g: JSON.stringify(forged), id: briefId });
        const detail = await briefs.get(briefId, { userId: ROB });
        expect(detail.integrity).toBe('mismatch');
        await db.run('UPDATE expedition_briefs SET generatedJson = @g WHERE id = @id', { g: row.generatedJson, id: briefId });
        expect((await briefs.get(briefId, { userId: ROB })).integrity).toBe('verified');
    });

    test('a second brief for the same expedition is a new row; the first is unchanged; the list shows both', async () => {
        const first = await db.get('SELECT generatedJson, generatedHash, generatedAt FROM expedition_briefs WHERE id = @id', { id: briefId });
        const second = await briefs.generate({ expeditionId: fixture.expedition.id, userId: ROB });
        expect(second.brief.id).not.toBe(briefId);
        expect(await db.get('SELECT generatedJson, generatedHash, generatedAt FROM expedition_briefs WHERE id = @id', { id: briefId })).toEqual(first);
        const cookie = await login(ROB, 'rob');
        const list = await request({ reqPath: `/api/app/spitball/expeditions/${fixture.expedition.id}/briefs`, headers: { cookie } });
        expect(list.status).toBe(200);
        expect(list.json.briefs.map(b => b.id).sort()).toEqual([briefId, second.brief.id].sort());
        expect(list.json.briefs[0]).toMatchObject({ status: 'READY', quality: 'unreviewed', editType: 'none', findings: 3 });
    });

    test('a running expedition refuses a brief (its evidence is still moving)', async () => {
        const running = await expeditions.createExpedition({ userId: SAM, seed: 'still running' });
        await expeditions.claimForRun(running.id);
        await expect(briefs.generate({ expeditionId: running.id, userId: SAM })).rejects.toMatchObject({ status: 409, code: 'EXPEDITION_ACTIVE' });
        await expeditions.cancelExpedition(running.id, { userId: SAM });
        await expect(briefs.generate({ expeditionId: running.id, userId: SAM })).rejects.toMatchObject({ status: 409, code: 'NO_EVIDENCE' });
        expect(seenCalls).toHaveLength(0);
    });
});

describe('review, acceptance, use and the Markdown export', () => {
    let fixture;
    let briefId;

    beforeAll(async () => {
        fixture = await seedExpedition(TIA, { seed: 'review fixture' });
        modelBehaviour = goodBrief(fixture);
        briefId = (await briefs.generate({ expeditionId: fixture.expedition.id, userId: TIA })).brief.id;
    });

    test('a blank or partial review is unreviewed; an unsupported mark is not-ready; the full bar is ready-to-show', async () => {
        const cookie = await login(TIA, 'tia');
        const blank = await briefs.get(briefId, { userId: TIA });
        expect(blank.quality.status).toBe('unreviewed');
        expect(blank.quality.unreviewed.length).toBeGreaterThan(0);

        const partial = await request({
            method: 'PUT', reqPath: `/api/app/spitball/briefs/${briefId}/review`, headers: { cookie },
            body: { marks: { F1: 'supported' }, gates: { noUnsupportedClaims: true }, expectedRevision: 0 }
        });
        expect(partial.status).toBe(200);
        expect(partial.json.quality.status).toBe('unreviewed');
        expect(partial.json.quality.unreviewed.join(' ')).toMatch(/F2|F3|gate|weak|disagree/i);

        const failing = await request({
            method: 'PUT', reqPath: `/api/app/spitball/briefs/${briefId}/review`, headers: { cookie },
            body: {
                marks: { F1: 'supported', F2: 'supported', F3: 'unsupported' },
                rationale: { F3: 'no stored claim backs it' },
                gates: { noUnsupportedClaims: false, weakEvidenceLabelled: true, disagreementRepresented: true },
                expectedRevision: 1
            }
        });
        expect(failing.status).toBe(200);
        expect(failing.json.quality.status).toBe('not-ready');
        expect(failing.json.quality.parts.noUnsupportedClaims).toBe(false);

        // A finding still marked "missing a qualification" is a defect on record: not ready.
        const qualified = await request({
            method: 'PUT', reqPath: `/api/app/spitball/briefs/${briefId}/review`, headers: { cookie },
            body: {
                marks: { F1: 'supported', F2: 'supported', F3: 'missing a qualification' },
                gates: { noUnsupportedClaims: true, weakEvidenceLabelled: true, disagreementRepresented: true },
                expectedRevision: 2
            }
        });
        expect(qualified.status).toBe(200);
        expect(qualified.json.quality.status).toBe('not-ready');
        expect(qualified.json.quality.reasons).toEqual(['1 finding(s) missing a qualification']);

        const passing = await request({
            method: 'PUT', reqPath: `/api/app/spitball/briefs/${briefId}/review`, headers: { cookie },
            body: {
                marks: { F1: 'supported', F2: 'supported', F3: 'supported' },
                rationale: { F3: 'reworded below as a question' },
                gates: { noUnsupportedClaims: true, weakEvidenceLabelled: true, disagreementRepresented: true },
                notes: 'good enough for a second reader',
                expectedRevision: 3
            }
        });
        expect(passing.status).toBe(200);
        expect(passing.json.quality.status).toBe('ready-to-show');
        expect(passing.json.brief.reviewRevision).toBe(4);
        // Quality is the owner's judgement; it implies neither acceptance nor use.
        expect(passing.json.brief.acceptedAt).toBeNull();
        expect(passing.json.brief.usedAt).toBeNull();

        const badMark = await request({
            method: 'PUT', reqPath: `/api/app/spitball/briefs/${briefId}/review`, headers: { cookie },
            body: { marks: { F1: 'looks fine' }, expectedRevision: 4 }
        });
        expect(badMark.status).toBe(400);
    });

    test('acceptance and use are explicit, separate records that can be withdrawn', async () => {
        const cookie = await login(TIA, 'tia');
        const accepted = await request({ method: 'POST', reqPath: `/api/app/spitball/briefs/${briefId}/accept`, headers: { cookie }, body: { accepted: true } });
        expect(accepted.status).toBe(200);
        expect(accepted.json.brief.acceptedAt).toBeTruthy();
        expect(accepted.json.brief.usedAt).toBeNull();

        const used = await request({ method: 'POST', reqPath: `/api/app/spitball/briefs/${briefId}/use`, headers: { cookie }, body: { used: true, note: 'informed the seminar outline' } });
        expect(used.status).toBe(200);
        expect(used.json.brief.usedAt).toBeTruthy();
        expect(used.json.brief.useNote).toBe('informed the seminar outline');

        const withdrawn = await request({ method: 'POST', reqPath: `/api/app/spitball/briefs/${briefId}/accept`, headers: { cookie }, body: { accepted: false } });
        expect(withdrawn.json.brief.acceptedAt).toBeNull();
        expect(withdrawn.json.brief.usedAt).toBeTruthy();
        // Quality status is unaffected by either record.
        expect(withdrawn.json.quality.status).toBe('ready-to-show');
        await briefs.setAccepted(briefId, { userId: TIA, accepted: true });
    });

    test('the Markdown export shows citations, limitations, edited markers with originals, and the explicit review status', async () => {
        const cookie = await login(TIA, 'tia');
        const detail = await briefs.get(briefId, { userId: TIA });
        await briefs.updateOverlay(briefId, {
            userId: TIA, expectedRevision: detail.brief.overlayRevision,
            edits: [{ target: 'finding:F3', text: 'Is there an extra assertion worth checking?', type: 'wording', note: 'phrased as a question' }]
        });
        const res = await request({ reqPath: `/api/app/spitball/briefs/${briefId}/export.md?download=1`, headers: { cookie } });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/markdown/);
        expect(res.headers['cache-control']).toMatch(/no-store/);
        expect(res.headers['content-disposition']).toMatch(/attachment; filename="research-brief-\d+-\d+-review-fixture\.md"/);
        const md = res.text;
        expect(md).toContain('# Research brief: review fixture');
        expect(md).toContain('**Review status:** Ready to show a second person (owner-judged).');
        expect(md).toMatch(/\*\*Accepted:\*\* yes \(\d{4}-\d{2}-\d{2} [\d:]{8} UTC\)\. \*\*Used:\*\* yes \(.* UTC\) — informed the seminar outline\./);
        expect(md).toContain('**Edits:** 1 (wording only). Edited passages are marked ✎');
        expect(md).toContain('[1]');
        expect(md).toContain('[1] The positive Grassmannian is stratified by positroid cells. (claim ');
        expect(md).toContain('published 2024-01-02');
        expect(md).toContain('no publication date');
        expect(md).toContain('https://arxiv.org/abs/1');
        expect(md).toContain('## Limitations');
        expect(md).toContain('Sources disagree on the count.');
        expect(md).toContain('### Evidence notes (derived from the stored evidence)');
        expect(md).toContain('Is there an extra assertion worth checking? _(no stored claim cited)_ — _owner mark: supported_');
        expect(md).toContain('✎ Edited (wording) — phrased as a question. Original generated text: An unsupported extra assertion.');
        expect(md).toContain('| F3 | supported | reworded below as a question |');
        expect(md).toContain('- Edits wording-only (derived from the overlay): yes');
        expect(md).toContain('Notes: good enough for a second reader');
        expect(md).toMatch(/sha256 [0-9a-f]{64}/);

        // An unreviewed brief exports as unreviewed - never as a pass.
        const other = await briefs.generate({ expeditionId: fixture.expedition.id, userId: TIA });
        const plain = await briefs.exportMarkdown(other.brief.id, { userId: TIA });
        expect(plain.markdown).toContain('**Review status:** Unreviewed — the owner has not judged this brief; this is not a quality pass.');
        expect(plain.markdown).toContain('**Accepted:** no. **Used:** no.');
        expect(plain.markdown).toContain('**Edits:** none; every passage below is the generated text.');
        expect(plain.markdown).toContain('| F1 | unreviewed |');
    });
});

describe('ownership, project scope and the payer', () => {
    let fixture;
    let briefId;
    let projectId;
    let projectBriefId;

    beforeAll(async () => {
        fixture = await seedExpedition(SAM, { seed: 'ownership fixture' });
        modelBehaviour = goodBrief(fixture);
        briefId = (await briefs.generate({ expeditionId: fixture.expedition.id, userId: SAM })).brief.id;
        projectId = await db.insert(
            `INSERT INTO observatory_projects (userId, slug, name) VALUES (@u, 'shared-lab', 'Shared lab')`, { u: ROB }
        );
        await db.run(
            `INSERT INTO project_members (projectId, userId, invitedBy) VALUES (@p, @u, @by)`, { p: projectId, u: SAM, by: ROB }
        );
    });

    test('a stranger cannot read, list, edit, review, accept, use or export another person\'s brief (404, never 403)', async () => {
        const cookie = await login(TIA, 'tia');
        const attempts = [
            request({ reqPath: `/api/app/spitball/briefs/${briefId}`, headers: { cookie } }),
            request({ reqPath: `/api/app/spitball/expeditions/${fixture.expedition.id}/briefs`, headers: { cookie } }),
            request({ method: 'POST', reqPath: `/api/app/spitball/expeditions/${fixture.expedition.id}/briefs`, headers: { cookie } }),
            request({ method: 'PUT', reqPath: `/api/app/spitball/briefs/${briefId}/overlay`, headers: { cookie }, body: { edits: [{ target: 'summary', text: 'x', type: 'wording' }] } }),
            request({ method: 'PUT', reqPath: `/api/app/spitball/briefs/${briefId}/review`, headers: { cookie }, body: { marks: { F1: 'supported' } } }),
            request({ method: 'POST', reqPath: `/api/app/spitball/briefs/${briefId}/accept`, headers: { cookie }, body: { accepted: true } }),
            request({ method: 'POST', reqPath: `/api/app/spitball/briefs/${briefId}/use`, headers: { cookie }, body: { used: true } }),
            request({ reqPath: `/api/app/spitball/briefs/${briefId}/export.md`, headers: { cookie } })
        ];
        for (const res of await Promise.all(attempts)) {
            expect(res.status).toBe(404);
            expect(res.json.error.code).toBe('NOT_FOUND');
        }
        expect(seenCalls).toHaveLength(0);
        const row = await db.get('SELECT overlayRevision, reviewRevision, acceptedAt, usedAt FROM expedition_briefs WHERE id = @id', { id: briefId });
        expect(row).toEqual({ overlayRevision: 0, reviewRevision: 0, acceptedAt: null, usedAt: null });
        const anon = await request({ reqPath: `/api/app/spitball/briefs/${briefId}` });
        expect(anon.status).toBe(401);
    });

    test('a project expedition\'s brief belongs to its creator, is paid for by the project owner, and is invisible to the owner and other members', async () => {
        const projectFixture = await seedExpedition(SAM, { seed: 'project fixture', projectId });
        expect(projectFixture.expedition.projectId).toBe(projectId);
        modelBehaviour = goodBrief(projectFixture);
        const detail = await briefs.generate({ expeditionId: projectFixture.expedition.id, userId: SAM });
        projectBriefId = detail.brief.id;
        expect(detail.brief.payer).toBe(ROB);
        expect(seenCalls[0].work).toMatchObject({ kind: 'expedition', id: String(projectFixture.expedition.id), actor: SAM, payer: ROB });
        expect(await expeditions.payerFor(projectFixture.expedition)).toBe(ROB);
        expect(await expeditions.payerFor(fixture.expedition)).toBe(SAM);

        // The project owner pays but does not own the artifact; neither does another member.
        await db.run(`INSERT INTO project_members (projectId, userId, invitedBy) VALUES (@p, @u, @by)`, { p: projectId, u: TIA, by: ROB });
        for (const [who, name] of [[ROB, 'rob'], [TIA, 'tia']]) {
            const cookie = await login(who, name);
            const read = await request({ reqPath: `/api/app/spitball/briefs/${projectBriefId}`, headers: { cookie } });
            expect(read.status).toBe(404);
            const list = await request({ reqPath: `/api/app/spitball/expeditions/${projectFixture.expedition.id}/briefs`, headers: { cookie } });
            expect(list.status).toBe(404);
            const gen = await request({ method: 'POST', reqPath: `/api/app/spitball/expeditions/${projectFixture.expedition.id}/briefs`, headers: { cookie } });
            expect(gen.status).toBe(404);
        }
        expect(seenCalls).toHaveLength(1);
        const mine = await login(SAM, 'sam');
        const ok = await request({ reqPath: `/api/app/spitball/briefs/${projectBriefId}`, headers: { cookie: mine } });
        expect(ok.status).toBe(200);
    });
});

describe('failed attempts and the ledger', () => {
    test('a model failure leaves a FAILED brief on record and one work_failures row (phase brief) without prompt or output', async () => {
        const fixture = await seedExpedition(ROB, { seed: 'failure fixture' });
        modelBehaviour = () => { throw Object.assign(new Error('provider unavailable: model overloaded'), { code: 'PROVIDER_DOWN' }); };
        const detail = await briefs.generate({ expeditionId: fixture.expedition.id, userId: ROB });
        expect(detail.brief).toMatchObject({ status: 'FAILED', errorCode: 'BRIEF_GENERATION_FAILED', lastError: 'The brief could not be generated.' });
        expect(detail.generated).toBeNull();
        expect(detail.rendered).toBeNull();
        const failures = await db.all(
            `SELECT kind, workId, phase, code, reason, actor FROM work_failures WHERE kind = 'expedition' AND workId = @w`, { w: String(fixture.expedition.id) }
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ phase: 'brief', code: 'BRIEF_GENERATION_FAILED', actor: ROB });
        expect(failures[0].reason).not.toMatch(/Grassmannian|positroid|summary/);

        // The FAILED row can neither be edited, reviewed nor exported; a budget refusal keeps its own code.
        await expect(briefs.updateOverlay(detail.brief.id, { userId: ROB, edits: [] })).rejects.toMatchObject({ status: 409, code: 'NOT_READY' });
        await expect(briefs.exportMarkdown(detail.brief.id, { userId: ROB })).rejects.toMatchObject({ status: 409, code: 'NOT_READY' });
        modelBehaviour = () => { throw Object.assign(new Error('Daily token cap reached.'), { code: 'BUDGET_EXCEEDED' }); };
        const budget = await briefs.generate({ expeditionId: fixture.expedition.id, userId: ROB });
        expect(budget.brief).toMatchObject({ status: 'FAILED', errorCode: 'BUDGET_EXCEEDED' });

        // A malformed answer is a format failure, and the row records it without the answer text.
        modelBehaviour = () => ({ content: 'Sure! Here is your brief in prose, with no JSON at all.' });
        const format = await briefs.generate({ expeditionId: fixture.expedition.id, userId: ROB });
        expect(format.brief).toMatchObject({ status: 'FAILED', errorCode: 'BRIEF_FORMAT_INVALID' });
        expect(await db.get(`SELECT COUNT(*) AS c FROM work_failures WHERE kind = 'expedition' AND workId = @w AND phase = 'brief'`, { w: String(fixture.expedition.id) }))
            .toEqual({ c: 3 });
        const list = await briefs.list({ expeditionId: fixture.expedition.id, userId: ROB });
        expect(list.filter(b => b.status === 'FAILED')).toHaveLength(3);
    });
});

describe('measurement (#265)', () => {
    const MEASURE_USER = '700000000000000064';

    test('no accepted brief means cost per accepted is unavailable (null), not zero; failed attempts count', async () => {
        const fixture = await seedExpedition(MEASURE_USER, { seed: 'measure fixture' });
        modelBehaviour = goodBrief(fixture);
        const ready = await briefs.generate({ expeditionId: fixture.expedition.id, userId: MEASURE_USER });
        modelBehaviour = () => { throw new Error('boom'); };
        await briefs.generate({ expeditionId: fixture.expedition.id, userId: MEASURE_USER });

        const cookie = await login(MEASURE_USER, 'mu');
        const first = await request({ reqPath: '/api/app/spitball/briefs/measure?days=7', headers: { cookie } });
        expect(first.status).toBe(200);
        expect(first.json.days).toBe(7);
        expect(first.json.briefs).toMatchObject({ total: 2, ready: 1, failed: 1, accepted: 0, used: 0, acceptedAndUsed: 0 });
        expect(first.json.briefs.quality).toEqual({ unreviewed: 1, 'not-ready': 0, 'ready-to-show': 0 });
        expect(first.json.briefs.editType).toEqual({ none: 1, wording: 0, factual: 0 });
        expect(first.json.expeditions).toBe(1);
        expect(first.json.cost.perAccepted).toBeNull();
        expect(first.json.cost.status).toBe('unavailable');
        expect(first.json.cost.totals.failures).toBe(0); // no reservation yet: the work has no cost rows to join
        expect(first.json.cost.note).toMatch(/not available \(not zero\)/);

        // The runner's settled token reservation and a search call, keyed on the expedition's work reference.
        await db.run(
            `INSERT INTO usage_reservations (actor, payer, workKind, workId, estimatedTokens, actualTokens, status)
             VALUES (@u, @u, 'expedition', @w, 5000, 4200, 'settled')`, { u: MEASURE_USER, w: String(fixture.expedition.id) }
        );
        await db.run(
            `INSERT INTO resource_events (kind, quantity, provider, workKind, workId, actor, payer)
             VALUES ('search_call', 3, 'perplexity', 'expedition', @w, @u, @u)`, { u: MEASURE_USER, w: String(fixture.expedition.id) }
        );
        const stillNone = await briefs.measure({ userId: MEASURE_USER, days: 7 });
        expect(stillNone.cost.status).toBe('settled');
        expect(stillNone.cost.totals).toMatchObject({ actualTokens: 4200, resources: { search_call: 3 }, failures: 1 });
        expect(stillNone.cost.perAccepted).toBeNull();
        expect(stillNone.cost.note).toMatch(/No accepted brief/);

        await briefs.setAccepted(ready.brief.id, { userId: MEASURE_USER, accepted: true });
        const accepted = await briefs.measure({ userId: MEASURE_USER, days: 7 });
        expect(accepted.briefs).toMatchObject({ accepted: 1, used: 0, acceptedAndUsed: 0 });
        expect(accepted.cost.perAccepted).toEqual({ actualTokens: 4200, resources: { search_call: 3 } });
        expect(accepted.cost.acceptedBriefIds).toEqual([ready.brief.id]);
        expect(JSON.stringify(accepted)).not.toMatch(/\$|usd|cents|"price"/i);

        await briefs.setUsed(ready.brief.id, { userId: MEASURE_USER, used: true, note: 'used it' });
        const used = await briefs.measure({ userId: MEASURE_USER, days: 7 });
        expect(used.briefs).toMatchObject({ accepted: 1, used: 1, acceptedAndUsed: 1 });

        // A held reservation makes the totals provisional, and the flag is retained.
        await db.run(
            `INSERT INTO usage_reservations (actor, payer, workKind, workId, estimatedTokens, status)
             VALUES (@u, @u, 'expedition', @w, 800, 'held')`, { u: MEASURE_USER, w: String(fixture.expedition.id) }
        );
        const provisional = await briefs.measure({ userId: MEASURE_USER, days: 7 });
        expect(provisional.cost.status).toBe('provisional');
        expect(provisional.cost.totals.estimatedTokens).toBe(800);
        expect(provisional.cost.note).toMatch(/provisional/);

        // Another person's measurement never sees these briefs.
        const other = await briefs.measure({ userId: TIA, days: 7 });
        expect(other.cost.acceptedBriefIds).not.toContain(ready.brief.id);
    });
});

describe('erasure, transparency and the leftover audit', () => {
    const ERASE_USER = '700000000000000065';
    const PAYER = '700000000000000066';

    test('forgetting a person removes their briefs, nulls their payer on others\' briefs, and the report and audit reflect it', async () => {
        const own = await seedExpedition(ERASE_USER, { seed: 'erase fixture' });
        modelBehaviour = goodBrief(own);
        const mine = await briefs.generate({ expeditionId: own.expedition.id, userId: ERASE_USER });
        await briefs.setAccepted(mine.brief.id, { userId: ERASE_USER, accepted: true });

        // A brief someone else owns that ERASE_USER paid for (project owner).
        const projectId = await db.insert(`INSERT INTO observatory_projects (userId, slug, name) VALUES (@u, 'erase-lab', 'Erase lab')`, { u: ERASE_USER });
        await db.run(`INSERT INTO project_members (projectId, userId, invitedBy) VALUES (@p, @u, @by)`, { p: projectId, u: PAYER, by: ERASE_USER });
        const theirs = await seedExpedition(PAYER, { seed: 'paid by erase user', projectId });
        modelBehaviour = goodBrief(theirs);
        const paid = await briefs.generate({ expeditionId: theirs.expedition.id, userId: PAYER });
        expect(paid.brief.payer).toBe(ERASE_USER);

        const report = await privacyService.buildUserReport({ guildId: `dm:${ERASE_USER}`, userId: ERASE_USER });
        expect(report.spitball.briefs).toMatchObject({ total: 1, accepted: 1, used: 0, failed: 0, paidForOthers: 1 });
        const before = await privacyService.auditUser({ userId: ERASE_USER });
        expect(before.byTable.expedition_briefs).toBe(2);

        const counts = await privacyService.forgetUser({ userId: ERASE_USER });
        expect(counts.expeditionBriefs).toBe(1);
        expect(counts.expeditionBriefsPayerAnonymized).toBe(1);
        expect(await db.get('SELECT COUNT(*) AS c FROM expedition_briefs WHERE userId = @u', { u: ERASE_USER })).toEqual({ c: 0 });
        expect(await db.get('SELECT payer, status FROM expedition_briefs WHERE id = @id', { id: paid.brief.id })).toEqual({ payer: null, status: 'READY' });
        const after = await privacyService.auditUser({ userId: ERASE_USER });
        expect(after.byTable.expedition_briefs || 0).toBe(0);
        // The other person's brief still reads normally.
        expect((await briefs.get(paid.brief.id, { userId: PAYER })).integrity).toBe('verified');
    });

    test('deleting an expedition cascades to its briefs', async () => {
        const fixture = await seedExpedition(TIA, { seed: 'cascade fixture' });
        modelBehaviour = goodBrief(fixture);
        const detail = await briefs.generate({ expeditionId: fixture.expedition.id, userId: TIA });
        await db.run('DELETE FROM spitball_expeditions WHERE id = @id', { id: fixture.expedition.id });
        expect(await db.get('SELECT COUNT(*) AS c FROM expedition_briefs WHERE id = @id', { id: detail.brief.id })).toEqual({ c: 0 });
    });
});

describe('brief review regressions (#254)', () => {
    test('summary-only claims use shared citation numbering and unknown ids are dropped', () => {
        const packet = briefUtils.buildEvidencePacket({
            expedition: { id: 1, seed: 'citation fixture' },
            sources: [{ id: 1, accepted: true, title: 'Source' }],
            claims: [42, 97].map(id => ({ id, sourceId: 1, text: `Claim ${id}`, confidence: .9 }))
        });
        const raw = { summary: 'Summary fact.', summaryClaimIds: [97, 9999, 97], findings: [{ id: 'F1', text: 'Finding.', claimIds: [42] }], limitations: [] };
        const generated = briefUtils.finalizeGenerated(briefUtils.parseGenerated(JSON.stringify(raw), packet), packet);
        const hash = briefUtils.hashGenerated(generated);
        expect(generated.summaryClaimIds).toEqual([97]);
        expect(generated.citations.map(c => [c.claimId, c.n])).toEqual([[97, 1], [42, 2]]);
        const overlay = { edits: [{ target: 'summary', text: 'Edited summary.', type: 'wording' }] };
        expect(briefUtils.render(generated, overlay).summary.citations).toEqual([1]);
        const md = briefUtils.exportMarkdown({ brief: { id: 1 }, generated, overlay });
        expect(md).toContain('Edited summary. [1]');
        expect(md).toContain('Finding. [2]');
        expect(md).toContain('[1] Claim 97');
        expect(md).toContain('Original generated text: Summary fact.');
        expect(briefUtils.hashGenerated(generated)).toBe(hash);
        expect(() => briefUtils.parseGenerated(JSON.stringify({ ...raw, summary: 'Fact [97]' }), packet)).toThrow(/summaryClaimIds/);
        const uncited = briefUtils.finalizeGenerated(briefUtils.parseGenerated(JSON.stringify({ ...raw, summaryClaimIds: [9999] }), packet), packet);
        expect(uncited.evidenceNotes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'uncited', text: expect.stringContaining('summary') })]));
        // Legacy stored artifacts stay byte-for-byte intact and get no invented references.
        const legacy = { ...generated, promptVersion: 1 };
        delete legacy.summaryClaimIds;
        const before = JSON.stringify(legacy);
        expect(briefUtils.render(legacy, null).summary.citations).toEqual([]);
        expect(briefUtils.exportMarkdown({ brief: { id: 1 }, generated: legacy })).toContain('Summary fact. _(no stored claim cited)_');
        expect(JSON.stringify(legacy)).toBe(before);
    });

    test.each(['PROVIDER_DOWN', 'BRIEF_FORMAT_INVALID', 'BUDGET_EXCEEDED'])('failure %s never retains provider content, including after erasure', async code => {
        const userId = '700000000000000069';
        const fixture = await seedExpedition(userId, { seed: 'safe failure fixture' });
        const marker = 'SYNTHETIC_PRIVATE_CONTENT sk-test-secret https://private.example';
        modelBehaviour = () => { throw Object.assign(new Error(marker), { code }); };
        const detail = await briefs.generate({ expeditionId: fixture.expedition.id, userId });
        expect(detail.brief.status).toBe('FAILED');
        expect(JSON.stringify(detail)).not.toContain('SYNTHETIC_PRIVATE_CONTENT');
        const row = await db.get("SELECT * FROM work_failures WHERE kind = 'expedition' AND workId = @w AND phase = 'brief'", { w: String(fixture.expedition.id) });
        expect(row.reason).toBe(detail.brief.lastError);
        expect(JSON.stringify(row)).not.toContain('SYNTHETIC_PRIVATE_CONTENT');
        await briefs.forgetUser(userId);
        await require('@goobster/core/services/workFailureService').forgetUser(userId);
        const erased = await db.get('SELECT * FROM work_failures WHERE id = @id', { id: row.id });
        expect(erased.actor).toBeNull();
        expect(JSON.stringify(erased)).not.toContain('SYNTHETIC_PRIVATE_CONTENT');
    });
});
