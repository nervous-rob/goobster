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

/**
 * One-line layout reminder for inspect / create replies so every surface
 * restates the same contract.
 * @returns {string}
 */
function layoutReminder() {
    return `Layout: $${PROJECT_DIR_ENV} = inputs/published artifacts; `
        + `${checkpointPath} + ${framesPath} for resume/video `
        + `(legacy only: ${legacyCheckpointPath}).`;
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
        + `new jobs only resume from ${checkpointPath}. `
        + 'Orient with action "inspect"; audit existing projects with action "audit".';
}

/**
 * Detect snippets that write the live checkpoint under the project root
 * instead of the per-run dir. Heuristic — comments can false-positive at
 * info severity only when GOOBSTER_RUN_DIR is also referenced.
 * @param {string} source
 * @returns {{ usesRunDir: boolean, usesProjectCheckpoint: boolean }}
 */
function scanCheckpointUsage(source) {
    const text = String(source || '');
    const usesRunDir = new RegExp(
        `${RUN_DIR_ENV}[^\\n]{0,80}${CHECKPOINT_FILE}|os\\.environ\\[['"]${RUN_DIR_ENV}['"]\\][^\\n]{0,120}${CHECKPOINT_FILE}`
    ).test(text)
        || (text.includes(RUN_DIR_ENV) && text.includes(CHECKPOINT_FILE)
            && !new RegExp(`${PROJECT_DIR_ENV}[^\\n]{0,80}${CHECKPOINT_FILE}`).test(text));
    const usesProjectCheckpoint = new RegExp(
        `${PROJECT_DIR_ENV}[^\\n]{0,120}${CHECKPOINT_FILE}`
    ).test(text)
        || /(?:^|[\s"'`])checkpoint\.json(?:$|[\s"'`])/m.test(text)
            && text.includes(PROJECT_DIR_ENV)
            && !text.includes(RUN_DIR_ENV);
    return { usesRunDir, usesProjectCheckpoint };
}

/**
 * Pure setup-contract auditor. Recomputes findings from disk + job/asset
 * metadata — no durable finding rows.
 *
 * @param {{
 *   rootNames?: string[],
 *   hasRootCheckpoint?: boolean,
 *   hasRootFrames?: boolean,
 *   runCheckpointCount?: number,
 *   jobs?: Array<{ id?: number, legacyWorkspace?: number|boolean }>,
 *   scripts?: Array<{ slug: string, source?: string }>
 * }} input
 * @returns {{ ok: boolean, findings: Array<{ code: string, severity: string, message: string }> }}
 */
function auditProjectSetup(input = {}) {
    const findings = [];
    const rootNames = Array.isArray(input.rootNames) ? input.rootNames : [];
    const hasRootCheckpoint = input.hasRootCheckpoint != null
        ? Boolean(input.hasRootCheckpoint)
        : rootNames.includes(CHECKPOINT_FILE);
    const hasRootFrames = input.hasRootFrames != null
        ? Boolean(input.hasRootFrames)
        : rootNames.includes(FRAMES_DIR);
    const runCheckpointCount = Number(input.runCheckpointCount) || 0;
    const jobs = Array.isArray(input.jobs) ? input.jobs : [];
    const scripts = Array.isArray(input.scripts) ? input.scripts : [];
    const legacyJobs = jobs.filter(j => Number(j.legacyWorkspace));

    if (hasRootCheckpoint) {
        findings.push({
            code: 'legacy_root_checkpoint',
            severity: 'warn',
            message: `${CHECKPOINT_FILE} is at the project root. New jobs only resume from `
                + `${checkpointPath}; move/rewrite checkpoints under $${RUN_DIR_ENV}.`
        });
    }
    if (hasRootFrames) {
        findings.push({
            code: 'legacy_root_frames',
            severity: 'warn',
            message: `${FRAMES_DIR}/ is at the project root. Write numbered frames under `
                + `${framesPath} so background jobs stitch video correctly.`
        });
    }
    if (legacyJobs.length) {
        findings.push({
            code: 'legacy_workspace_jobs',
            severity: 'info',
            message: `${legacyJobs.length} job(s) still use the legacy workspace layout `
                + `(project-root checkpoint/frames). New runs use per-job $${RUN_DIR_ENV}.`
        });
    }
    if (!scripts.length) {
        findings.push({
            code: 'no_script_asset',
            severity: 'info',
            message: 'No script assets yet. Save a versioned script (save_script) so jobs and '
                + 'triggers have a stable entry point.'
        });
    }
    for (const script of scripts) {
        if (!script?.source) continue;
        const usage = scanCheckpointUsage(script.source);
        if (usage.usesProjectCheckpoint && !usage.usesRunDir) {
            findings.push({
                code: 'script_writes_project_checkpoint',
                severity: 'warn',
                message: `Script "${script.slug}" appears to write ${CHECKPOINT_FILE} under `
                    + `$${PROJECT_DIR_ENV}. Update it to load/rewrite ${checkpointPath}.`
            });
        }
    }
    if (runCheckpointCount > 0 && !hasRootCheckpoint) {
        findings.push({
            code: 'run_dir_checkpoints_ok',
            severity: 'ok',
            message: `Found ${runCheckpointCount} per-run ${CHECKPOINT_FILE} under ${RUNS_DIR}/.`
        });
    }
    if (findings.length === 0) {
        findings.push({
            code: 'setup_ok',
            severity: 'ok',
            message: `Setup looks aligned with the contract (${layoutReminder()}).`
        });
    }

    const ok = !findings.some(f => f.severity === 'warn' || f.severity === 'error');
    return { ok, findings };
}

/**
 * Compact text block for inspect / tool replies.
 * @param {{ ok: boolean, findings: Array<{ severity: string, message: string, code?: string }> }} audit
 * @returns {string}
 */
function formatSetupAuditText(audit) {
    const findings = audit?.findings || [];
    const warns = findings.filter(f => f.severity === 'warn' || f.severity === 'error').length;
    const head = audit?.ok
        ? `Setup: ok (${findings.length} check(s))`
        : `Setup: ${warns} finding(s) need attention`;
    const lines = findings
        .filter(f => f.severity !== 'ok' || !audit.ok)
        .slice(0, 8)
        .map(f => `  [${f.severity}] ${f.message}`);
    if (!lines.length && audit?.ok) {
        return `${head}\n  ${layoutReminder()}`;
    }
    return [head, ...lines].join('\n');
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
    backgroundJobHint,
    layoutReminder,
    scanCheckpointUsage,
    auditProjectSetup,
    formatSetupAuditText
};
