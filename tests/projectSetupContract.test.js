/**
 * Project setup contract: tool description, create-project reply, and
 * starter examples must stay aligned with the per-run checkpoint layout.
 */
const {
    PROJECT_DIR_ENV,
    RUN_DIR_ENV,
    CHECKPOINT_FILE,
    FRAMES_DIR,
    checkpointPath,
    legacyCheckpointPath,
    frameExamplePath,
    longJobConventionText,
    createProjectResponse,
    starterExamples,
    docsCheckpointSteps,
    backgroundJobHint
} = require('@goobster/core/utils/projectSetupContract');

describe('projectSetupContract', () => {
    test('canonical paths put checkpoints and frames under the run dir', () => {
        expect(checkpointPath).toBe(`$${RUN_DIR_ENV}/${CHECKPOINT_FILE}`);
        expect(legacyCheckpointPath).toBe(`$${PROJECT_DIR_ENV}/${CHECKPOINT_FILE}`);
        expect(frameExamplePath).toBe(`$${RUN_DIR_ENV}/${FRAMES_DIR}/frame_0001.png`);
        expect(checkpointPath).not.toBe(legacyCheckpointPath);
    });

    test('tool description, create reply, docs, and starters agree on the layout', () => {
        const convention = longJobConventionText();
        const created = createProjectResponse({ name: 'Sim Lab', slug: 'sim-lab' });
        const docs = docsCheckpointSteps().join('\n');
        const hint = backgroundJobHint();
        const { python, bash } = starterExamples();

        for (const surface of [convention, created, docs, hint, python, bash]) {
            expect(surface).toContain(RUN_DIR_ENV);
            expect(surface).toContain(CHECKPOINT_FILE);
        }

        expect(convention).toContain(checkpointPath);
        expect(convention).toContain(legacyCheckpointPath);
        expect(convention).toContain(frameExamplePath);
        expect(convention).toContain(PROJECT_DIR_ENV);

        expect(created).toContain('sim-lab');
        expect(created).toContain(`$${PROJECT_DIR_ENV}`);
        expect(created).toContain(`$${RUN_DIR_ENV}`);
        expect(created).toMatch(new RegExp(`Do not put ${CHECKPOINT_FILE}`));
        // Never tell operators to park the live checkpoint under the project root.
        expect(created).not.toMatch(
            new RegExp(`put source files, ${CHECKPOINT_FILE}`)
        );
        expect(created).not.toMatch(
            new RegExp(`via \\$${PROJECT_DIR_ENV} - put source files, ${CHECKPOINT_FILE}`)
        );

        expect(python).toContain(`os.environ['${RUN_DIR_ENV}']`);
        expect(python).not.toContain(`os.environ['${PROJECT_DIR_ENV}']`);
        expect(bash).toContain(`$${RUN_DIR_ENV}/${CHECKPOINT_FILE}`);
        expect(bash).not.toContain(`$${PROJECT_DIR_ENV}/${CHECKPOINT_FILE}`);
    });

    test('projects.md documents the run-dir checkpoint path from the contract', () => {
        const fs = require('node:fs');
        const path = require('node:path');
        const docs = fs.readFileSync(
            path.join(__dirname, '..', 'documentation', 'projects.md'), 'utf8'
        );
        expect(docs).toContain(checkpointPath);
        expect(docs).toContain('utils/projectSetupContract.js');
        expect(docs).toMatch(/Load `\$GOOBSTER_RUN_DIR\/checkpoint\.json`/);
        expect(docs).not.toMatch(
            /1\. Load `\$GOOBSTER_PROJECT_DIR\/checkpoint\.json` when it exists\./
        );
    });
});
