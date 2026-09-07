/**
 * Observatory project setup contract — the ONE place that defines how
 * background jobs should use $GOOBSTER_PROJECT_DIR vs $GOOBSTER_RUN_DIR.
 *
 * Tool description prose, create-project replies, starter snippets, and
 * operator-facing docs MUST be generated from this module so they cannot
 * drift. New jobs only resume from the per-run checkpoint under
 * $GOOBSTER_RUN_DIR; the project-root file is a legacy fallback.
 */

'use strict';

const PROJECT_DIR_ENV = 'GOOBSTER_PROJECT_DIR';
const RUN_DIR_ENV = 'GOOBSTER_RUN_DIR';
const CHECKPOINT_FILE = 'checkpoint.json';
const FRAMES_DIR = 'frames';
const RUNS_DIR = 'runs';
const FRAME_EXAMPLE = 'frame_0001.png';

const checkpointPath = `$${RUN_DIR_ENV}/${CHECKPOINT_FILE}`;
const legacyCheckpointPath = `$${PROJECT_DIR_ENV}/${CHECKPOINT_FILE}`;
const framesPath = `$${RUN_DIR_ENV}/${FRAMES_DIR}/`;
const frameExamplePath = `$${RUN_DIR_ENV}/${FRAMES_DIR}/${FRAME_EXAMPLE}`;

/**
 * Long-job layout prose embedded in the observatory tool description.
 * @returns {string}
 */
function longJobConventionText() {
    return 'Long-job conventions: background code should load '
        + `${checkpointPath} when present (legacy: ${legacyCheckpointPath}) `
        + 'and rewrite it as it progresses - a segment '
        + 'killed at the sandbox time limit is automatically resumed from that checkpoint (bounded resume '
        + 'budget). Numbered frames saved to '
        + `${frameExamplePath} (and so on) are `
        + 'stitched into a video automatically when a background job completes. '
        + `$${PROJECT_DIR_ENV} is the shared project root (inputs and published artifacts).`;
}

/**
 * Reply after a successful create-project tool call.
 * @param {{ name: string, slug: string }} project
 * @returns {string}
 */
function createProjectResponse({ name, slug }) {
    return `🔭 Created project "${name}" (slug: ${slug}). `
        + `Shared workspace: $${PROJECT_DIR_ENV} — put source files, inputs, and published artifacts there. `
        + `Per-job run dir: $${RUN_DIR_ENV} — write ${CHECKPOINT_FILE} and ${FRAMES_DIR}/ there so `
        + 'background jobs can resume and stitch video. '
        + `Do not put ${CHECKPOINT_FILE} or ${FRAMES_DIR}/ under $${PROJECT_DIR_ENV}; `
        + `new jobs only resume from ${checkpointPath}.`;
}

/**
 * Compact starter snippets that obey the resume contract. Tests drive the
 * timeout→resume journey through these so guidance and runtime stay aligned.
 * @returns {{ python: string, bash: string }}
 */
function starterExamples() {
    const python = [
        'import json, os, time',
        `d = os.environ['${RUN_DIR_ENV}']`,
        `cp = os.path.join(d, '${CHECKPOINT_FILE}')`,
        "state = {'step': 0}",
        'if os.path.exists(cp):',
        '    state = json.load(open(cp))',
        "if state['step'] >= 2:",
        "    print('finished at step', state['step'])",
        '    raise SystemExit(0)',
        "state['step'] += 1",
        "json.dump(state, open(cp, 'w'))",
        'time.sleep(60)'
    ].join('\n');

    const bash = [
        `cp="$${RUN_DIR_ENV}/${CHECKPOINT_FILE}"`,
        'step=0',
        'if [ -f "$cp" ]; then step=$(cat "$cp"); fi',
        'if [ "$step" -ge 2 ]; then echo "finished at step $step"; exit 0; fi',
        'step=$((step + 1))',
        'echo "$step" > "$cp"',
        'sleep 60'
    ].join('\n');

    return { python, bash };
}

/**
 * Numbered steps for operator docs (projects.md). Keep wording short so the
 * living guide stays readable while still matching the tool contract.
 * @returns {string[]}
 */
function docsCheckpointSteps() {
    return [
        `Load ${checkpointPath} when it exists (legacy only: ${legacyCheckpointPath}).`,
        'Rewrite it as work progresses.',
        'A segment killed at the timeout wall resumes only if the checkpoint '
            + 'advanced — up to `maxResumes` times.',
        'Exit 0 completes; non-zero fails; timeout with no checkpoint progress '
            + 'is terminal.'
    ];
}

/** Short reminder for agent-prompt / timeout surfaces. */
function backgroundJobHint() {
    return `Prefer background jobs that load/rewrite ${checkpointPath} `
        + 'for anything long';
}

module.exports = {
    PROJECT_DIR_ENV,
    RUN_DIR_ENV,
    CHECKPOINT_FILE,
    FRAMES_DIR,
    RUNS_DIR,
    FRAME_EXAMPLE,
    checkpointPath,
    legacyCheckpointPath,
    framesPath,
    frameExamplePath,
    longJobConventionText,
    createProjectResponse,
    starterExamples,
    docsCheckpointSteps,
    backgroundJobHint
};
