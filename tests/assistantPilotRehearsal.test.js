/**
 * The pilot rehearsal (DA-6, documentation/delegated_pilot.md) against a
 * throwaway database: the integrated delegated-work flow the personal pilot
 * uses, end to end, with a scripted model and fixtures for everything
 * outside the installation (no provider, no network).
 *
 * The rehearsal is its own record of checks; this spec runs it once on the
 * engine under test and holds every journey to that record, so a change that
 * breaks the integrated flow fails here and names the check.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-pilot-rehearsal-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const runs = require('@goobster/core/services/assistantRunService');
const control = require('@goobster/core/services/assistantControlService');
const aiService = require('@goobster/core/services/aiService');
const projects = require('@goobster/core/services/projectService');
const { useState } = require('./helpers/featureFixtures');
const { JOURNEYS, rehearse, format } = require('../scripts/lib/assistantPilotRehearsal');

const chat = aiService.chat;
const writeWorkspaceFile = projects.writeWorkspaceFile;
let result;

beforeAll(async () => {
    useState();
    result = await rehearse();
}, 240_000);

afterAll(async () => {
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

describe('the pilot rehearsal', () => {
    test.each(JOURNEYS.map(journey => [journey.id, journey.title]))('journey %s: %s', (id) => {
        const journey = result.journeys.find(entry => entry.id === id);
        expect(journey).toBeDefined();
        expect(journey.checks.filter(check => !check.ok)).toEqual([]);
        expect(journey.checks.length).toBeGreaterThanOrEqual(7);
        expect(journey.ok).toBe(true);
    });

    test('covers every journey, skips nothing here, and passes as a whole', () => {
        expect(result.journeys.map(journey => journey.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
        // tests/helpers/fakeNotion.js is in this checkout, so the outside write is rehearsed too.
        expect(result.notCovered).toEqual([]);
        expect(result.checks.failed).toBe(0);
        expect(result.checks.total).toBeGreaterThanOrEqual(125);
        expect(result.ok).toBe(true);
        expect(result.prompt).toBe(runs.promptVersion().label);
    });

    test('ends with the outcome summary of the pilot\'s responsibilities, with no model paid for', () => {
        const { outcomes } = result;
        expect(outcomes.responsibilities.map(row => row.title)).toEqual(expect.arrayContaining([
            'Keep what I know about the crossing current', 'Carry the crossing plan forward', 'Keep my recurring work running'
        ]));
        expect(outcomes.totals.verified).toEqual({ planSteps: 1, repairs: 1, total: 2 });
        expect(outcomes.totals.cost.tokens).toBe(0);
        expect(outcomes.totals.tokensPerVerified).toBe(0);
        expect(outcomes.notMeasured).toEqual(['usefulness', 'unwanted_actions', 'foreground_responsiveness']);
        // What the person said in journey H is counted as their answers.
        expect(outcomes.totals.feedback).toMatchObject({ useful: 1, wrong: 1, lessOfThis: 1, wrongTime: 1, keptWording: 0, stopped: 0 });
        expect(outcomes.totals.notes.direct).toBe(0);
    });

    test('leaves the installation running and puts back everything it replaced', async () => {
        expect(await control.isPaused()).toBe(false);
        expect(aiService.chat).toBe(chat);
        expect(projects.writeWorkspaceFile).toBe(writeWorkspaceFile);
    });

    test('prints one line per check and the summary', () => {
        const text = format(result);
        expect(text).toContain('PASS  A. A source change improves knowledge and project state');
        expect(text).toContain('PASS  H. Feedback changes one thing and widens nothing');
        expect(text).toMatch(/Keep what I know about the crossing current: .*answers given 4, /);
        expect(text).toContain(`${result.checks.total} of ${result.checks.total} checks passed on prompt ${result.prompt}.`);
        expect(text).not.toContain('FAIL');
        const failed = format({
            ...result,
            journeys: [{ id: 'A', title: 'x', ok: false, checks: [{ name: 'it holds', ok: false, detail: 'it did not' }], notCovered: ['the outside write'] }],
            checks: { total: 1, failed: 1 }, outcomes: null
        });
        expect(failed).toContain('FAIL  A. x');
        expect(failed).toContain('it did not');
        expect(failed).toContain('skip  the outside write');
        expect(failed).toContain('0 of 1 checks passed');
    });

    test('refuses a database that already holds delegated responsibilities', async () => {
        await expect(rehearse()).rejects.toMatchObject({ code: 'NOT_EMPTY' });
        expect(aiService.chat).toBe(chat);
    });
});
