/**
 * Chat tools: the Observatory (projects with code execution).
 * Required by packages/core/utils/toolsRegistry.js — apps keep requiring the facade.
 */

const path = require('node:path');
const sandboxService = require('../../services/sandboxService');
const observatoryService = require('../../services/observatoryService');
const observatoryConfig = require('../../config/observatoryConfig');
const projectAssetService = require('../../services/projectAssetService');
const projectTriggerService = require('../../services/projectTriggerService');
const projectMissionService = require('../../services/projectMissionService');
const sandboxRequestService = require('../../services/sandboxRequestService');
const {
    clipStream,
    windowLines,
    formatTextWindow,
    fenceLanguage
} = require('../toolResultWindow');
const {
    PROJECT_DIR_ENV,
    longJobConventionText,
    createProjectResponse,
    backgroundJobHint
} = require('../projectSetupContract');
const { OUTPUT_CONTRACT_FAILED } = require('../outputContract');

/** " (from asset #3, trigger #7)" for an event trigger's source filters. */
function describeTriggerFilters(trigger) {
    const parts = [];
    if (trigger?.sourceAssetId != null) parts.push(`asset #${trigger.sourceAssetId}`);
    if (trigger?.sourceTriggerId != null) parts.push(`trigger #${trigger.sourceTriggerId}`);
    return parts.length ? ` (from ${parts.join(', ')})` : '';
}

/**
 * Suffix for a job's status badge so FAILED can be read at a glance:
 * "[FAILED: output contract]" vs "[FAILED: exit 3]" vs "[TIMED_OUT]".
 */
function describeJobReason(job) {
    if (!job?.errorCode || job.status === 'COMPLETED') return '';
    if (job.errorCode === OUTPUT_CONTRACT_FAILED) return ': output contract';
    if (job.errorCode === 'EXIT_NONZERO') return job.exitCode != null ? `: exit ${job.exitCode}` : '';
    if (job.status === 'TIMED_OUT' || job.status === 'CANCELLED') return '';
    return `: ${job.errorCode.toLowerCase().replace(/_/g, ' ')}`;
}

/** Compact per-check summary of a stored contract result (status action). */
function describeContractResult(result) {
    if (!result || !Array.isArray(result.checks) || result.checks.length === 0) return null;
    const passed = result.checks.filter(c => c.ok).length;
    const head = result.ok
        ? `Output contract: ${passed}/${result.checks.length} required output(s) validated.`
        : `Output contract: ${passed}/${result.checks.length} passed.`;
    const failed = result.checks.filter(c => !c.ok).slice(0, 8)
        .map(c => `  ✗ ${c.path} — ${String(c.reason || 'failed').replace(/_/g, ' ')}`);
    return [head, ...failed].join('\n');
}

/** Why repositories are off, for the model. */
function describeReposOff(reason) {
    if (reason === 'GIT_MISSING') return 'Project repositories are off on this installation: git is not installed.';
    if (reason === 'GITHUB_OFF') return 'Project repositories need the GitHub feature, which is off on this installation.';
    return 'Project repositories are turned off on this installation.';
}

/** One line per clone for repo_list / repo_status. */
function describeRepo(entry) {
    const st = entry.status || {};
    const sync = st.error
        ? `status unavailable: ${st.error}`
        : `${st.branch || 'detached'}${st.upstream ? ` ↔ ${st.upstream}` : ''} · ${st.ahead || 0} ahead / ${st.behind || 0} behind`
            + ` · ${st.changed || 0} uncommitted · head ${st.head || '?'}`;
    return `- ${entry.name} → ${entry.repo} (${entry.path}) · ${sync}`
        + `${entry.lastPushAt ? ` · last push ${entry.lastPushAt}` : ''}`;
}

/** Detail block for one clone's status. */
function describeCi(ci) {
    if (!ci || ci.state === 'none') return 'no CI';
    return ci.state === 'success' ? `CI passing (${ci.passed})`
        : ci.state === 'pending' ? `CI running (${ci.pending.length} pending)`
            : `CI FAILING (${ci.failing.length} of ${ci.total})`;
}

function describeCompare(cmp) {
    if (cmp.identical) return `📦 ${cmp.head} and ${cmp.base} are identical on ${cmp.repo}.`;
    const lines = [
        `📦 ${cmp.head} vs ${cmp.base} on ${cmp.repo}: ${cmp.ahead ?? '?'} ahead / ${cmp.behind ?? '?'} behind · `
        + `${cmp.fileCount} file(s) +${cmp.additions} -${cmp.deletions}${cmp.sharedHistory ? '' : ' (no shared history visible: direct diff)'}`
    ];
    if (cmp.commits.length) lines.push('Commits:', ...cmp.commits.map(c => `  ${c.short} ${c.author}: ${c.message}`));
    lines.push('Files:', ...cmp.files.slice(0, 40).map(f => `  ${f.binary ? 'bin' : `+${f.additions} -${f.deletions}`}  ${f.path}`));
    if (cmp.patch) lines.push('', cmp.patch.slice(0, 6000) + (cmp.patch.length > 6000 || cmp.truncated ? '\n… (diff truncated; read the files for more)' : ''));
    return lines.join('\n');
}

const CARD_PATCH_CHARS = 8000;

/**
 * Structured cards for the portal (the orchestrator's `_card`): the text
 * stays the model's answer, the card is what the person can act on.
 * `owner` is passed through so a card's buttons reach the same project.
 */
const repoCards = {
    compare(cmp, owner) {
        return {
            kind: 'repo-compare', project: cmp.project, owner: owner || null, name: cmp.name, repo: cmp.repo,
            base: cmp.base, head: cmp.head, ahead: cmp.ahead, behind: cmp.behind, identical: cmp.identical,
            fileCount: cmp.fileCount, additions: cmp.additions, deletions: cmp.deletions,
            files: cmp.files.slice(0, 30), commits: cmp.commits.slice(0, 10),
            patch: (cmp.patch || '').slice(0, CARD_PATCH_CHARS),
            truncated: Boolean(cmp.truncated || (cmp.patch || '').length > CARD_PATCH_CHARS)
        };
    },
    ci(ci, owner) {
        return {
            kind: 'repo-ci', project: ci.project, owner: owner || null, name: ci.name, repo: ci.repo, ref: ci.ref,
            state: ci.state, total: ci.total, passed: ci.passed, notOnGitHub: Boolean(ci.notOnGitHub),
            failing: ci.failing.slice(0, 10), pending: ci.pending.slice(0, 10)
        };
    },
    integration(done, owner) {
        return {
            kind: 'repo-integration', project: done.project, owner: owner || null, name: done.name, repo: done.repo,
            operation: done.kind, base: done.base, branch: done.branch, result: done.result,
            conflicts: (done.conflicts || []).slice(0, 20), from: done.from || null, to: done.to || null
        };
    },
    pr(pr, owner) {
        return {
            kind: 'repo-pr', project: pr.project, owner: owner || null, name: pr.name, repo: pr.repo,
            number: pr.number, url: pr.url, title: pr.title, head: pr.head, base: pr.base, draft: pr.draft
        };
    }
};

/** One answer for repo_merge / repo_rebase / repo_continue. */
function describeIntegration(done) {
    const what = `${done.kind} of ${done.base} into ${done.repo} ${done.branch}`;
    if (done.result === 'conflicted') {
        return `⚠️ The ${what} stopped on conflicts in: ${done.conflicts.join(', ') || '(see repo_status)'}.\n`
            + 'Open each file (read, then edit or run), remove the <<<<<<< / ======= / >>>>>>> markers keeping the right content, '
            + 'then repo_continue; or repo_abort to put the branch back as it was.';
    }
    if (done.result === 'up-to-date') return `📦 ${done.repo} ${done.branch} already contains ${done.base}: nothing to ${done.kind}.`;
    return `📦 ${done.result[0].toUpperCase()}${done.result.slice(1)} ${done.base} ${done.kind === 'rebase' ? 'under' : 'into'} ${done.repo} ${done.branch}: `
        + `${done.from || '?'} → ${done.to}. repo_push to publish it.`;
}

function describeRepoStatus(st) {
    if (!st || st.error) return `Status unavailable${st?.error ? `: ${st.error}` : '.'}`;
    const lines = [
        `Branch ${st.branch || '(detached)'}${st.upstream ? ` tracking ${st.upstream}` : ''} · ${st.ahead} ahead / ${st.behind} behind · ${st.sizeMb} MB of history`
    ];
    if (st.operation) {
        lines.push(`A ${st.operation} is stopped on conflicts${st.conflicts?.length ? ` in: ${st.conflicts.join(', ')}` : ''} - `
            + 'fix the files, then repo_continue (or repo_abort).');
    }
    if (st.changed) {
        lines.push(`Uncommitted (${st.changed}): ${st.changes.map(c => `${c.code} ${c.path}`).join(', ')}${st.changed > st.changes.length ? ', …' : ''}`);
    } else {
        lines.push('Working tree clean.');
    }
    if (st.commits?.length) {
        lines.push('Recent commits:', ...st.commits.map(c => `  ${c.short} ${c.when} ${c.author}: ${c.message}`));
    }
    return lines.join('\n');
}

module.exports = {
    observatory: {
        definition: {
            name: 'observatory',
            description:
                'The Observatory: persistent, long-running simulation projects layered on the code sandbox. '
                + `A project gives every run a durable workspace directory (exposed as $${PROJECT_DIR_ENV}) `
                + 'whose files SURVIVE indefinitely - unlike runCode, whose workspace only lasts for the conversation. '
                + 'Actions: "inspect" (ONE call for what\'s going on: mission, assets, triggers, recent jobs '
                + 'with tails, workspace, checkpoint, knowledge, members — prefer this before chaining '
                + 'status/files/list_assets/list_triggers/mission get), '
                + '"audit" (check one project — or omit project to audit all — against the setup contract: '
                + 'checkpoints/frames under $GOOBSTER_RUN_DIR, script entry points; use this to review legacy projects), '
                + '"needs-you" (cross-project review board: approvals, multiple-choice decisions, blocked missions, '
                + 'setup findings — filter with project=), '
                + '"create-project" (name), "list" (your projects), "run" (language+code inside a project; '
                + 'set background=true to detach a long job), "status" (one job by jobId, or recent jobs), '
                + '"resume" (an interrupted/timed-out job, from its checkpoint), "cancel" (a running job), '
                + '"files" (workspace listing), "search" (find text in the workspace\'s files: query=, optional path= to narrow '
                + 'it to a folder or file; case-insensitive, returns path:line hits and matching file names - use it to find where '
                + 'something is before reading files one by one), "read" (one workspace text file by path; optional '
                + '1-based offset + line limit — prefer this over cat/head/sed via run; pass rev=<snapshot> '
                + 'to read the file as it was in an earlier snapshot), '
                + '"timeline" (what happened on the project and who did it, newest first: snapshots, runs, clones/pushes/merges/'
                + 'pull requests, plan changes; optional limit=) - use it to answer "what changed / what happened since", '
                + '"history" (workspace snapshots, newest first — one is taken automatically after every run, '
                + 'job, portal write, fetch-data and restore; optional path= to see only snapshots touching a file), '
                + '"diff" (no rev: what changed in the workspace since the latest snapshot; rev: what that '
                + 'snapshot changed; rev + to: between two snapshots, to="workspace" for the current files; '
                + 'optional path=), "restore" (put path= — or the whole workspace when path is omitted — back '
                + 'as it was in snapshot rev=; the current state is snapshotted first so a restore is reversible), '
                + '"commit" (snapshot the workspace now with note= as the message), '
                + '"repo_clone" (clone a GitHub repository into repos/<name> with the USER\'S OWN connected GitHub '
                + 'account - repo=owner/name or URL, optional branch= and name=; shallow, one branch), "repo_list", '
                + '"repo_status" (branch, upstream, ahead/behind, uncommitted changes, recent commits of one clone), '
                + '"repo_pull" (fetch + fast-forward only; a diverged branch is reported, never merged), "repo_commit" '
                + '(stage everything in the clone and commit with note= as the message, authored as the user\'s GitHub '
                + 'identity), "repo_push" (push the current branch, or HEAD to branch=<name>; never forced; a rejected '
                + 'push says to pull first; pushing a new branch returns the compare URL for a pull request), '
                + '"repo_branch" (switch to branch=, creating it if it exists nowhere), '
                + '"repo_branches" (local and GitHub branches of a clone, which is active, ahead/behind the base), '
                + '"repo_compare" (what branch= - default the current one - has that base= - default the branch the clone started '
                + 'from - lacks: commits, files, counts and a capped diff), "repo_prs" (the repository\'s open pull requests with CI '
                + 'verdicts), "repo_pr" (open a pull request from branch= into base= with note= as the title and content= as the '
                + 'body; the branch must be pushed, or pass background=true to push it first; enabled=false for a draft), '
                + '"repo_ci" (check runs and statuses for branch= or the current branch: what passed, is pending or failed, with links), '
                + '"repo_watch" (watch CI on branch= - default the current branch - with the user\'s own GitHub connection: '
                + 'each new commit\'s settled result goes to their Inbox; mode="fix" also starts up to 2 unattended fix turns '
                + 'when it goes red), "repo_unwatch" (stop; branch= for one branch, else all), '
                + '"repo_merge" (merge origin/<branch> - '
                + 'default the branch the clone started from - into the current branch), "repo_rebase" (replay the current '
                + 'branch\'s local commits on origin/<branch>; refused once they are already on origin, since pushes are never '
                + 'forced - merge instead), "repo_continue" / "repo_abort" (a merge or rebase that hits conflicts is left '
                + 'in progress with the conflicted files listed: edit the conflict markers out of them like any workspace file, '
                + 'then repo_continue, or repo_abort to put the branch back), "repo_reset" (discard local commits '
                + 'and changes back to origin - a workspace snapshot is taken first), "repo_remove" (drop the clone; '
                + 'its files stay in workspace history). Edit a clone\'s files like any other workspace file '
                + '(run, read, portal); repos/<name> is plain files to the sandbox, which has no git and no network. '
                + '"render" (stitch frames into an mp4 at an optional fps), '
                + '"dashboard" (regenerate and attach the project\'s shareable HTML results dashboard - it is '
                + 'also refreshed automatically after every run and job), "fetch-data" (download a public '
                + 'https URL into the project workspace at data/<file> - sandbox runs themselves have NO '
                + 'network; allowlisted hosts download immediately, anything else asks a human approver by '
                + 'DM and you must report honestly that it is waiting), "save_app" / "save_script" / '
                + '"save_note" (store versioned source on the project: html/svg apps, python/javascript '
                + 'scripts, or markdown notes — identical source is a no-op), "list_assets", "get_asset" '
                + '(head, or version n; same line window as read), "rollback_asset" (move the head pointer back), "run_script" '
                + '(run a stored script asset, foreground or background, recording which version ran), '
                + '"set_trigger" / "list_triggers" / "delete_trigger" (project automations: cron or '
                + 'job_completed/job_failed/job_settled events that run a script, render, fetch an '
                + 'allowlisted URL, or fire an agent prompt. For multi-stage pipelines chain stages with '
                + 'FILTERED event triggers — sourceAsset=<upstream script slug> and/or sourceTrigger=<upstream '
                + 'trigger> — instead of staggered cron guesses, and declare requiredOutputs on run_script so a '
                + 'job that exits 0 without writing its handoff files settles FAILED (OUTPUT_CONTRACT_FAILED) '
                + 'and does not fire job_completed. A trigger\'s lastOutcome is the DISPATCH result — "started: '
                + 'job #N, awaiting settlement" means launched, not finished — and lastJobOutcome is how that '
                + 'stage actually settled), "list_deliveries" (per-event delivery records of one event trigger: '
                + 'which settled source job was DELIVERED as which child job, or is RETRYABLE because the project '
                + 'was busy, or FAILED/SKIPPED and why — use it when a downstream stage did not start), '
                + '"invite_user" / "list_members" / '
                + '"remove_member" (collaborators; only the owner invites or removes others), '
                + '"note_knowledge" (store a distilled note with optional tags/edges in the '
                + 'project knowledge graph), "recall_knowledge" (retrieve from that graph), '
                + '"mission" (draft / get / update / add_step / start_step / '
                + 'complete_step / add_evidence / review / cancel / link_code a Project Mission — '
                + 'one open outcome per project; propose a plan, a human approves, starts, and completes it '
                + 'in the portal, then steps can run), and '
                + '"delete-project". Pass owner=<userId> when a slug is ambiguous (you own one '
                + 'project and collaborate on another with the same name). '
                + longJobConventionText()
                + ' When a background job finishes, the user is notified in their Discord DMs.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['inspect', 'audit', 'needs-you', 'create-project', 'list', 'run', 'status', 'resume', 'cancel',
                            'files', 'search', 'read', 'history', 'timeline', 'diff', 'restore', 'commit', 'render', 'dashboard', 'fetch-data', 'delete-project',
                            'repo_clone', 'repo_list', 'repo_status', 'repo_pull', 'repo_commit', 'repo_push', 'repo_branch', 'repo_branches', 'repo_compare', 'repo_prs', 'repo_pr', 'repo_ci', 'repo_watch', 'repo_unwatch', 'repo_merge', 'repo_rebase', 'repo_continue', 'repo_abort', 'repo_reset', 'repo_remove',
                            'save_app', 'save_script', 'save_note', 'list_assets', 'get_asset',
                            'rollback_asset', 'run_script', 'set_trigger', 'list_triggers',
                            'list_deliveries', 'delete_trigger', 'invite_user', 'list_members', 'remove_member',
                            'note_knowledge', 'recall_knowledge', 'mission'],
                        description: 'What to do. Prefer "inspect" for overview; "audit" for setup-contract review; "needs-you" for the human decision board.'
                    },
                    project: { type: 'string', description: 'Project name or slug (required for inspect/run/files/read/history/diff/restore/commit/repo_*/render/fetch-data/delete-project/save_*/list_assets/get_asset/rollback_asset/run_script/set_trigger/list_triggers/list_deliveries/delete_trigger/invite_user/list_members/remove_member/note_knowledge/recall_knowledge/mission; optional for audit — omit to audit all projects)' },
                    path: { type: 'string', description: 'read / history / diff / restore: workspace-relative path (e.g. "src/main.py" or "data/notes.md")' },
                    offset: { type: 'integer', description: 'read / get_asset / diff: 1-based line to start at (default 1)' },
                    limit: { type: 'integer', description: 'read / get_asset / diff: max lines to return (default 400, max 800); history: max snapshots (default 30)' },
                    rev: { type: 'string', description: 'read / diff / restore: a snapshot hash from history (e.g. "3f2a1c9") or HEAD' },
                    to: { type: 'string', description: 'diff: the second snapshot to compare rev against, or "workspace" for the current files' },
                    repo: { type: 'string', description: 'repo_clone: the GitHub repository, owner/name or a github.com URL' },
                    branch: { type: 'string', description: 'repo_clone: branch to clone (default: the repository\'s default branch); repo_push: push HEAD to this branch on origin; repo_branch: the branch to switch to or create; repo_merge / repo_rebase: the branch to bring in (default: the branch the clone started from); repo_compare / repo_pr / repo_ci: the head branch or ref (default: the current branch)' },
                    mode: { type: 'string', enum: ['notify', 'fix'], description: 'repo_watch: notify only (default), or also try to fix a red build' },
                    base: { type: 'string', description: 'repo_compare / repo_pr / repo_merge-style comparisons: the base branch (default: the branch the clone started from)' },
                    label: { type: 'string', description: 'note_knowledge: title of the distilled note' },
                    content: { type: 'string', description: 'note_knowledge: body of the distilled note' },
                    tags: { type: 'string', description: 'note_knowledge: comma-separated tags' },
                    query: { type: 'string', description: 'recall_knowledge: what to look up in the project graph; search: the text to find in the workspace' },
                    related: { type: 'string', description: 'note_knowledge: optional related node label to link' },
                    relation: { type: 'string', description: 'note_knowledge: relation to the related node (default relates_to)' },
                    owner: { type: 'string', description: 'Owner user id qualifier when two accessible projects share a slug' },
                    inviteeId: { type: 'string', description: 'invite_user / remove_member: Discord user id of the collaborator' },
                    name: { type: 'string', description: 'New project name (create-project), asset name (save_*), trigger name (set_trigger / list_deliveries / delete_trigger), or clone name (repo_*: the repos/<name> folder; repo_clone derives it from the repository when omitted)' },
                    slug: { type: 'string', description: 'Asset slug (save_* / get_asset / rollback_asset / run_script). Derived from name when omitted.' },
                    language: { type: 'string', enum: ['python', 'javascript', 'bash', 'html', 'svg', 'markdown'], description: 'Language for run or save_*' },
                    code: { type: 'string', description: 'Source code for run or save_*' },
                    version: { type: 'integer', description: 'Asset version number (get_asset / rollback_asset)' },
                    note: { type: 'string', description: 'One-line note for save_* versions and commit snapshots; the commit message for repo_commit' },
                    kind: { type: 'string', enum: ['app', 'script', 'note', 'cron', 'event'], description: 'list_assets: optional kind filter; set_trigger: cron or event' },
                    stdin: { type: 'string', description: 'Optional stdin for foreground runs' },
                    background: { type: 'boolean', description: 'run / run_script: detach as a checkpointable background job (default false for run, true for trigger-fired run_script)' },
                    jobId: { type: 'integer', description: 'Job id (status/resume/cancel)' },
                    fps: { type: 'integer', description: 'render: framerate (defaults to the server setting)' },
                    url: { type: 'string', description: 'fetch-data / set_trigger fetch_data: the public https URL to download' },
                    saveAs: { type: 'string', description: 'fetch-data: filename inside the workspace data/ dir (defaults to the URL basename)' },
                    reason: { type: 'string', description: 'fetch-data: one line for the approver when the host is off the allowlist' },
                    triggerAction: { type: 'string', enum: ['run_script', 'render', 'fetch_data', 'agent_prompt'], description: 'set_trigger: what the trigger does' },
                    schedule: { type: 'string', description: 'set_trigger: 5-field cron in UTC (kind=cron)' },
                    eventTopic: { type: 'string', enum: ['job_completed', 'job_failed', 'job_settled'], description: 'set_trigger: event to watch (kind=event)' },
                    prompt: { type: 'string', description: 'set_trigger agent_prompt: the Observatory-command instructions' },
                    enabled: { type: 'boolean', description: 'set_trigger: whether the trigger is armed (default true)' },
                    allowSelfChain: { type: 'boolean', description: 'set_trigger: allow an event trigger to fire on a job it started (default false)' },
                    maxChainDepth: { type: 'integer', description: 'set_trigger: max event-trigger hops from one root job (default 3)' },
                    sourceAsset: { type: 'string', description: 'set_trigger (kind=event): only fire for jobs that ran this script asset (slug or id) — the upstream pipeline stage. Empty string clears the filter.' },
                    sourceTrigger: { type: 'string', description: 'set_trigger (kind=event): only fire for jobs started by this trigger (name or id). Empty string clears the filter.' },
                    requiredOutputs: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                path: { type: 'string', description: 'Workspace-relative file the job must leave behind; {utc_date} = YYYY-MM-DD of the fire date' },
                                type: { type: 'string', enum: ['file', 'json'], description: 'file = exists (default); json = must parse as JSON' },
                                minBytes: { type: 'integer', description: 'Optional minimum size in bytes' }
                            },
                            required: ['path']
                        },
                        description: 'set_trigger run_script: declared outputs the job must produce to count as COMPLETED (exit 0 alone is not enough). Empty array clears.'
                    },
                    missionAction: {
                        type: 'string',
                        enum: ['propose', 'get', 'update', 'add_step',
                            'start_step', 'complete_step', 'skip_step', 'add_evidence',
                            'review', 'cancel', 'resume', 'link_code'],
                        description: 'mission: what to do. propose drafts a plan (needs objective + successCriteria). Approval, start, and complete are human-only (portal). complete_step is for human steps. review records a proposed verdict. link_code ties stepId to a clone (repo=, the clone name or owner/name) and branch= so the step shows its pull request and CI; requireGreenCi=true makes completing the step wait for green CI; branch empty clears it.'
                    },
                    requireGreenCi: { type: 'boolean', description: 'mission link_code: the step cannot be marked done until the branch\'s CI is green' },
                    title: { type: 'string', description: 'mission propose/update: short title' },
                    objective: { type: 'string', description: 'mission propose/update: the outcome we are pursuing' },
                    successCriteria: { type: 'string', description: 'mission: measurable criteria, one per line or semicolon-separated' },
                    deadline: { type: 'string', description: 'mission: YYYY-MM-DD or UTC timestamp' },
                    stepKind: { type: 'string', enum: ['expedition', 'job', 'watch', 'human'], description: 'mission add_step: step type' },
                    stepTitle: { type: 'string', description: 'mission add_step: short step title' },
                    stepDescription: { type: 'string', description: 'mission add_step: what this step does' },
                    stepId: { type: 'integer', description: 'mission start_step / complete_step / skip_step' },
                    choices: { type: 'string', description: 'mission add_step human: multiple-choice options, semicolon-separated labels (at least two)' },
                    selectedId: { type: 'string', description: 'mission complete_step: id of the chosen option when the human step offered choices' },
                    seed: { type: 'string', description: 'mission add_step expedition: research seed' },
                    watchTopic: { type: 'string', description: 'mission add_step watch: domain event topic' },
                    criterionId: { type: 'string', description: 'mission add_evidence: success-criterion id (c1, c2, …)' },
                    evidenceKind: { type: 'string', enum: ['claim', 'note', 'job', 'artifact'], description: 'mission add_evidence' },
                    evidenceId: { type: 'integer', description: 'mission add_evidence: claim/note/job/asset id' },
                    polarity: { type: 'string', enum: ['for', 'against', 'neutral'], description: 'mission add_evidence: does this support the criterion?' },
                    verdict: { type: 'string', enum: ['met', 'unmet', 'mixed'], description: 'mission review: proposed verdict (a human completes)' },
                    reviewNotes: { type: 'string', description: 'mission review: comparison against the original criteria' }
                },
                required: ['action']
            }
        },
        /**
         * The Observatory tool. Deterministic legalization lives in
         * observatoryService (projects, quotas, job lifecycle) and below it
         * sandboxService (isolation + rlimits); this wrapper only enforces
         * the availability/scope gate, wires produced files back to the
         * user, and renders compact, model-readable results.
         * @returns {Promise<string>}
         */
        execute: async ({
            action, project, name, language, code, stdin, background, jobId, fps, url, saveAs, reason,
            slug, version, note, kind, triggerAction, schedule, eventTopic, prompt, enabled,
            allowSelfChain, maxChainDepth, sourceAsset, sourceTrigger, requiredOutputs,
            owner, inviteeId, label, content, tags, query, related,
            relation, path: workspacePath, offset, limit, rev, to, repo, branch, base, mode, requireGreenCi, missionAction, title, objective,
            successCriteria, deadline, stepKind, stepTitle, stepDescription, stepId, seed,
            watchTopic, criterionId, evidenceKind, evidenceId, polarity, verdict, reviewNotes,
            choices, selectedId,
            interactionContext
        }) => {
            if (!observatoryService.enabled) {
                return '❌ The Observatory is disabled on this server (it also requires the code sandbox to be enabled).';
            }
            // Automation turns count as a trusted surface (see getDefinitions).
            const trustedSurface = (typeof interactionContext?.channelId === 'string'
                && interactionContext.channelId.startsWith('web:'))
                || interactionContext?.isAutomation === true;
            if (observatoryConfig.scope === 'web' && !trustedSurface) {
                return '❌ The Observatory is only available in Goobster\'s web app, not here.';
            }
            const userId = interactionContext?.user?.id;
            if (!userId) {
                return '❌ The Observatory needs to know who you are - no user context available.';
            }

            /** Deliver local files to the chat and record them for the portal. */
            const sendFiles = async (paths) => {
                if (paths.length === 0 || !interactionContext?.channel?.send) return;
                try {
                    await interactionContext.channel.send({
                        files: paths.map(p => ({ attachment: p, name: path.basename(p) }))
                    });
                } catch { /* delivery is best effort; the summary still lists them */ }
                if (!Array.isArray(interactionContext.generatedFiles)) {
                    interactionContext.generatedFiles = [];
                }
                for (const p of paths) interactionContext.generatedFiles.push(p);
            };

            const jobLine = (job) => `#${job.id} [${job.status}${describeJobReason(job)}] ${job.project} · ${job.language} · `
                + `${job.segments} segment(s), ${job.resumeCount} resume(s)`
                + `${job.exitCode !== null && job.exitCode !== undefined ? ` · exit ${job.exitCode}` : ''}`
                + `${job.parentJobId ? ` · parent #${job.parentJobId}` : ''}`
                + `${job.renderPath ? ' · 🎬 video rendered' : ''}`
                + `${job.error ? ` · ${job.error}` : ''}`;

            try {
                switch (action) {
                    case 'create-project': {
                        const created = await observatoryService.createProject({ userId, name: name || project });
                        return createProjectResponse(created);
                    }
                    case 'inspect': {
                        if (!project && !name) {
                            return '❌ inspect needs a project name or slug.';
                        }
                        const inspected = await observatoryService.inspectProject({
                            userId, project: project || name, owner
                        });
                        return inspected.text;
                    }
                    case 'audit': {
                        if (project || name) {
                            const audited = await observatoryService.auditSetup({
                                userId, project: project || name, owner
                            });
                            return audited.text;
                        }
                        const all = await observatoryService.auditAllSetups({ userId });
                        return all.text;
                    }
                    case 'needs-you': {
                        const queue = await projectMissionService.listNeedsYou({
                            userId, project: project || name || null, owner
                        });
                        return queue.text;
                    }
                    case 'list': {
                        const projects = await observatoryService.listProjects(userId);
                        if (projects.length === 0) {
                            return '🔭 No projects yet - create one with action "create-project".';
                        }
                        return '🔭 Projects:\n' + projects.map(p =>
                            `- ${p.slug} ("${p.name}") · ${p.role || 'owner'}`
                            + `${p.role === 'collaborator' ? ` · owner ${p.ownerId}` : ''}`
                            + ` · ${p.sizeMb}/${p.quotaMb} MB · `
                            + `${p.runningJobs} running / ${p.totalJobs} total job(s) · updated ${p.updatedAt}`
                        ).join('\n');
                    }
                    case 'delete-project': {
                        const gone = await observatoryService.deleteProject({
                            userId, project, owner,
                            gateway: interactionContext?.gateway || interactionContext?.client || null
                        });
                        return `🗑️ Deleted project "${gone.slug}" and its whole workspace.`;
                    }
                    case 'invite_user': {
                        const invitee = String(inviteeId || '').replace(/^<@!?(\d+)>$/, '$1');
                        if (!invitee) return '❌ invite_user needs inviteeId (a Discord user id).';
                        const { dmSent, inviteeName } = await observatoryService.invite({
                            gateway: interactionContext?.gateway || interactionContext?.client || null,
                            userId,
                            ownerName: interactionContext?.user?.globalName
                                || interactionContext?.user?.username || null,
                            project,
                            owner,
                            inviteeId: invitee
                        });
                        const who = inviteeName || `user ${invitee}`;
                        return dmSent
                            ? `🔭 Invited ${who}. They got a Discord DM with Accept/Decline buttons.`
                            : `🔭 Invited ${who}. The DM could not be delivered; they can accept from the web app invitation list.`;
                    }
                    case 'list_members': {
                        const roster = await observatoryService.listMembers({ userId, project, owner });
                        const lines = [
                            `Owner: ${roster.ownerName || roster.ownerId}`,
                            ...roster.members.map(m =>
                                `- ${m.userName || m.userId} (${m.role})`),
                            ...roster.invites.map(i =>
                                `- ${i.inviteeName || i.inviteeId} (invited)`)
                        ];
                        return `🔭 ${roster.members.length}/${roster.maxMembers} collaborators:\n${lines.join('\n')}`;
                    }
                    case 'remove_member': {
                        const target = String(inviteeId || '').replace(/^<@!?(\d+)>$/, '$1');
                        if (!target) return '❌ remove_member needs inviteeId (the member to remove).';
                        const result = await observatoryService.removeMember({
                            userId, project, owner, memberId: target
                        });
                        return result.left
                            ? '🔭 You left the project.'
                            : `🔭 Removed ${target} from the project.`;
                    }
                    case 'files': {
                        const listing = await observatoryService.listFiles({ userId, project, owner });
                        if (listing.files.length === 0) {
                            return `🔭 ${listing.project}: the workspace is empty (${listing.sizeMb}/${listing.quotaMb} MB).`;
                        }
                        const lines = listing.files.map(f =>
                            `- ${f.path} (${(f.size / 1024).toFixed(1)} KB, ${f.modifiedAt})`);
                        return `🔭 ${listing.project} workspace (${listing.sizeMb}/${listing.quotaMb} MB, `
                            + `${listing.totalFiles} file(s)${listing.totalFiles > listing.files.length ? ', newest shown' : ''}):\n`
                            + lines.join('\n');
                    }
                    case 'timeline': {
                        const feed = await require('../../services/projectTimelineService').timeline({
                            userId, project, owner, limit: Math.min(Number(limit) || 30, 100)
                        });
                        if (feed.entries.length === 0) return `🕰️ Nothing has happened on "${feed.project}" yet.`;
                        return `🕰️ Timeline of "${feed.project}", newest first (UTC):\n`
                            + feed.entries.map(entry => `- ${entry.at} ${entry.kind} · ${entry.actor.name}: ${entry.title}${entry.detail ? ` (${entry.detail})` : ''}`).join('\n')
                            + (feed.nextBefore ? '\n… older entries exist.' : '');
                    }
                    case 'search': {
                        if (!query) return '❌ search needs query (the text to find) and optionally path (a folder or file).';
                        const found = await observatoryService.searchWorkspace({ userId, project, owner, query, path: workspacePath || '' });
                        if (found.hits.length === 0 && found.files.length === 0) {
                            return `🔎 Nothing in "${found.project}"${found.path ? ` under ${found.path}` : ''} matches "${found.query}" (${found.filesScanned} file(s) searched).`;
                        }
                        return `🔎 "${found.query}" in "${found.project}"${found.path ? ` under ${found.path}` : ''}: ${found.hits.length} line(s)`
                            + `${found.truncated ? ' (capped - narrow with path=)' : ''}, ${found.filesScanned} file(s) searched.\n`
                            + (found.files.length ? `Matching file names: ${found.files.join(', ')}\n` : '')
                            + found.hits.map(hit => `${hit.path}:${hit.line}: ${hit.text}`).join('\n');
                    }
                    case 'read': {
                        const rel = workspacePath || name || slug;
                        if (!rel) return '❌ read needs path (workspace-relative, e.g. "src/main.py").';
                        if (rev) {
                            const old = await observatoryService.history.showText({
                                userId, project, owner, rev, path: rel, offset, limit
                            });
                            return formatTextWindow({
                                label: `🕰️ ${old.relativePath} @ ${old.short}`,
                                size: old.size,
                                window: old,
                                fence: fenceLanguage(old.name)
                            });
                        }
                        const got = await observatoryService.readWorkspaceText({
                            userId, slug: project, relativePath: rel, offset, limit, owner
                        });
                        return formatTextWindow({
                            label: `🔭 ${got.relativePath}`,
                            size: got.size,
                            window: got,
                            fence: fenceLanguage(got.name)
                        });
                    }
                    case 'history': {
                        const log = await observatoryService.history.log({
                            userId, project, owner, path: workspacePath || null, limit
                        });
                        if (!log.enabled) {
                            return log.reason === 'GIT_MISSING'
                                ? '🕰️ Workspace history is off on this installation: git is not installed.'
                                : '🕰️ Workspace history is turned off on this installation.';
                        }
                        if (log.commits.length === 0) {
                            return `🕰️ ${log.project}: no snapshots yet${workspacePath ? ` touching ${workspacePath}` : ''}. `
                                + 'One is taken after every run, write, fetch and restore, or now with action "commit".';
                        }
                        const head = `🕰️ ${log.project} snapshots${workspacePath ? ` touching ${workspacePath}` : ''}`
                            + ` (${log.sizeMb}/${log.budgetMb} MB of history${log.paused ? ', PAUSED: the workspace is over the history budget' : ''}):`;
                        return head + '\n' + log.commits.map(c =>
                            `- ${c.short} · ${c.when} · ${c.author.name} (${c.author.role}) · ${c.message}`
                            + ` · ${c.fileCount} file(s)${c.fileCount <= 4 ? `: ${c.files.join(', ')}` : ''}`
                        ).join('\n')
                            + '\nUse diff rev=<hash>, read path= rev=<hash>, or restore rev=<hash> [path=].';
                    }
                    case 'diff': {
                        const changes = await observatoryService.history.diff({
                            userId, project, owner, rev: rev || null, to: to || null,
                            path: workspacePath || null, offset, limit
                        });
                        if (changes.empty) {
                            return `🕰️ ${changes.label}${changes.path ? ` (${changes.path})` : ''}: no differences.`;
                        }
                        return formatTextWindow({
                            label: `🕰️ ${changes.label}${changes.path ? ` (${changes.path})` : ''}`,
                            size: changes.size,
                            window: changes,
                            fence: 'diff'
                        });
                    }
                    case 'restore': {
                        if (!rev) return '❌ restore needs rev (a snapshot hash from action "history").';
                        const restored = await observatoryService.history.restore({
                            userId, project, owner, rev, path: workspacePath || null
                        });
                        const what = restored.restored ? `"${restored.restored}"` : 'the whole workspace';
                        return `↩️ Restored ${what} in "${restored.project}" from snapshot ${restored.short}. `
                            + (restored.changed
                                ? `The state before the restore is snapshot ${restored.before.slice(0, 7)}, so this can be undone.`
                                : 'Nothing differed, so the workspace is unchanged.');
                    }
                    case 'commit': {
                        const snap = await observatoryService.history.commit({
                            userId, project, owner, message: note || name || 'snapshot'
                        });
                        if (snap.committed) {
                            return `🕰️ Snapshot ${snap.short} of "${project}" taken.`
                                + (snap.squashed ? ' Older snapshots were squashed to stay within the history budget.' : '');
                        }
                        if (snap.reason === 'NO_CHANGES') return `🕰️ Nothing changed in "${project}" since the latest snapshot.`;
                        if (snap.reason === 'PAUSED') return `🕰️ Snapshots are paused for "${project}": the workspace is over the history budget. Delete large files to resume.`;
                        if (snap.reason === 'GIT_MISSING') return '🕰️ Workspace history is off on this installation: git is not installed.';
                        return '🕰️ Workspace history is turned off on this installation.';
                    }
                    case 'run': {
                        const outcome = await observatoryService.run({
                            userId, project, owner, language, code, stdin,
                            background: background === true,
                            client: interactionContext?.gateway || interactionContext?.client || null,
                            // Foreground runs die with the turn (Stop button /
                            // watchdog); background jobs deliberately detach.
                            signal: interactionContext?.abortSignal || null
                        });
                        if (outcome.mode === 'background') {
                            return `🔭 Job #${outcome.jobId} is running in the background in "${outcome.project}" `
                                + `(up to ${outcome.maxResumes} checkpoint resumes). I'll DM the user when it finishes; `
                                + 'check on it with action "status".';
                        }
                        // Foreground: same delivery + summary contract as runCode.
                        const result = outcome.result;
                        await sendFiles(result.files.map(f => f.path));
                        const runHint = `truncated — write long output to $${PROJECT_DIR_ENV} and use action "read"`;
                        const lines = [];
                        if (result.timedOut) {
                            lines.push(`⏱️ The code hit the time limit and was stopped after ~${Math.round(result.durationMs / 1000)}s. `
                                + `For long work, rerun with background=true. ${backgroundJobHint()}.`);
                        } else if (result.ok) {
                            lines.push(`✅ Ran ${result.language} in project "${outcome.project}" (${result.durationMs} ms).`);
                        } else {
                            lines.push(`⚠️ ${result.language} exited with code ${result.exitCode}`
                                + `${result.signal ? ` (signal ${result.signal})` : ''} after ${result.durationMs} ms.`);
                        }
                        const stdout = clipStream(result.stdout, { hint: runHint });
                        const stderr = clipStream(result.stderr, { hint: runHint });
                        if (stdout.trim()) lines.push(`\nstdout:\n\`\`\`\n${stdout}\n\`\`\``);
                        if (stderr.trim()) lines.push(`\nstderr:\n\`\`\`\n${stderr}\n\`\`\``);
                        if (result.language === 'python' && /ModuleNotFoundError|ImportError/.test(result.stderr)) {
                            lines.push(`\n💡 ${await sandboxService.pythonEnvironmentNote()}`);
                        }
                        if (result.files.length > 0) {
                            lines.push(`\nFiles produced: ${result.files
                                .map(f => `${f.name} (${(f.size / 1024).toFixed(1)} KB) [attached above]`).join(', ')}`);
                        }
                        lines.push(`\n(Persistent files belong in $${PROJECT_DIR_ENV}; use action "files" to browse them `
                            + 'and action "read" to open one. '
                            + 'The project\'s shareable results dashboard was refreshed - action "dashboard" attaches it.)');
                        return lines.join('\n');
                    }
                    case 'status': {
                        if (jobId !== undefined && jobId !== null) {
                            const job = await observatoryService.getJob({ userId, jobId });
                            const parts = [
                                `🔭 ${jobLine(job)}`,
                                `Started ${job.createdAt}${job.finishedAt ? `, finished ${job.finishedAt}` : `, last heartbeat ${job.lastHeartbeatAt}`}.`
                            ];
                            if (job.checkpointAt) parts.push(`Latest checkpoint: ${job.checkpointAt}.`);
                            const contractLine = describeContractResult(job.outputContractResult);
                            if (contractLine) parts.push(contractLine);
                            if (job.status === 'RUNNING') {
                                // What it is printing right now (live tails, updated every few seconds).
                                const live = await observatoryService.jobLive({ userId, jobId: job.id });
                                if (live.streaming) {
                                    const lastLines = (text) => text.split('\n').slice(-30).join('\n').trim();
                                    if (live.stdout.trim()) parts.push(`live stdout (last 30 lines, as of ${live.at} UTC):\n\`\`\`\n${lastLines(live.stdout)}\n\`\`\``);
                                    if (live.stderr.trim()) parts.push(`live stderr (last 30 lines):\n\`\`\`\n${lastLines(live.stderr)}\n\`\`\``);
                                    if (!live.stdout.trim() && !live.stderr.trim()) parts.push('No output yet from the running segment.');
                                } else if (!live.liveSupported) {
                                    parts.push('Live output is not available with a remote sandbox runner; tails arrive when the segment ends.');
                                }
                            }
                            if (job.stdoutTail?.trim()) parts.push(`stdout tail:\n\`\`\`\n${job.stdoutTail}\n\`\`\``);
                            if (job.stderrTail?.trim() && job.status !== 'COMPLETED') {
                                parts.push(`stderr tail:\n\`\`\`\n${job.stderrTail}\n\`\`\``);
                            }
                            if (job.language === 'python'
                                && /ModuleNotFoundError|ImportError/.test(job.stderrTail || '')) {
                                parts.push(`💡 ${await sandboxService.pythonEnvironmentNote()}`);
                            }
                            return parts.join('\n');
                        }
                        const jobs = await observatoryService.listJobs({
                            userId, project: project || null, owner: project ? owner : null
                        });
                        if (jobs.length === 0) return '🔭 No jobs yet - start one with action "run" and background=true.';
                        return '🔭 Jobs (newest first):\n' + jobs.map(jobLine).join('\n');
                    }
                    case 'resume': {
                        const resumed = await observatoryService.resume({
                            userId, jobId, client: interactionContext?.gateway || interactionContext?.client || null
                        });
                        return `▶️ Job #${resumed.jobId} resumed from its checkpoint.`;
                    }
                    case 'cancel': {
                        const cancelled = await observatoryService.cancel({ userId, jobId });
                        return `⏹️ Job #${cancelled.jobId} cancelled.`;
                    }
                    case 'render': {
                        const render = await observatoryService.render({ userId, project, fps, owner });
                        await sendFiles([render.path]);
                        return `🎬 Stitched ${render.frames} frame(s) at ${render.fps} fps into `
                            + `${render.relPath} (${(render.sizeBytes / (1024 * 1024)).toFixed(1)} MB) [attached above].`;
                    }
                    case 'repo_list': {
                        const listing = await observatoryService.repos.list({ userId, project, owner });
                        if (!listing.enabled) return `📦 ${describeReposOff(listing.reason)}`;
                        if (listing.repos.length === 0) {
                            return `📦 No repositories in "${listing.project}" yet (up to ${listing.maxRepos}). `
                                + 'Clone one with repo_clone repo=owner/name - it uses the user\'s own connected GitHub account.';
                        }
                        return `📦 Repositories in "${listing.project}" (${listing.repos.length}/${listing.maxRepos}):\n`
                            + listing.repos.map(describeRepo).join('\n');
                    }
                    case 'repo_status': {
                        if (!name) return '❌ repo_status needs name (the clone, from repo_list).';
                        const one = await observatoryService.repos.status({ userId, project, owner, name });
                        return `📦 ${describeRepo(one)}\n${describeRepoStatus(one.status)}`;
                    }
                    case 'repo_clone': {
                        if (!repo) return '❌ repo_clone needs repo (owner/name or a github.com URL).';
                        const cloned = await observatoryService.repos.clone({ userId, project, owner, repo, branch, name });
                        return `📦 Cloned ${cloned.repo} (${cloned.clonedBranch}) into "${cloned.project}" at ${cloned.path} `
                            + `· head ${cloned.status?.head || '?'} · ${cloned.status?.sizeMb ?? '?'} MB of history. `
                            + `Runs see it at $${PROJECT_DIR_ENV}/${cloned.path}; edit, run and read its files like any other workspace file, `
                            + 'then repo_commit and repo_push.';
                    }
                    case 'repo_pull': {
                        if (!name) return '❌ repo_pull needs name (the clone, from repo_list).';
                        const pulled = await observatoryService.repos.pull({ userId, project, owner, name });
                        return pulled.updated
                            ? `📦 Pulled ${pulled.repo} ${pulled.status.branch}: ${pulled.from || '?'} → ${pulled.to}.\n${describeRepoStatus(pulled.status)}`
                            : `📦 ${pulled.repo} ${pulled.status.branch} is already up to date at ${pulled.to}.`;
                    }
                    case 'repo_commit': {
                        if (!name) return '❌ repo_commit needs name (the clone) and note (the commit message).';
                        const committed = await observatoryService.repos.commit({ userId, project, owner, name, message: note || title });
                        if (!committed.committed) return `📦 Nothing to commit in ${committed.repo}: the clone has no uncommitted changes.`;
                        return `📦 Committed ${committed.short} to ${committed.repo} as ${committed.author} `
                            + `(${committed.status.branch}, ${committed.status.ahead} ahead of origin). Push it with repo_push.`;
                    }
                    case 'repo_push': {
                        if (!name) return '❌ repo_push needs name (the clone, from repo_list).';
                        const pushed = await observatoryService.repos.push({ userId, project, owner, name, branch });
                        return `📦 Pushed ${pushed.head} to ${pushed.repo} ${pushed.branch}: ${pushed.url}`
                            + (pushed.compareUrl ? `\nOpen a pull request: ${pushed.compareUrl}` : '')
                            + (pushed.status.changed ? `\n(${pushed.status.changed} uncommitted change(s) were not pushed - repo_commit them first.)` : '');
                    }
                    case 'repo_branch': {
                        if (!name || !branch) return '❌ repo_branch needs name (the clone) and branch.';
                        const switched = await observatoryService.repos.checkout({ userId, project, owner, name, branch });
                        return `📦 ${switched.repo} is now on ${switched.branch}${switched.created ? ' (new branch)' : ''}.\n${describeRepoStatus(switched.status)}`;
                    }
                    case 'repo_branches': {
                        if (!name) return '❌ repo_branches needs name (the clone, from repo_list).';
                        const listing = await observatoryService.repos.branches({ userId, project, owner, name });
                        return `📦 Branches of ${listing.repo} (active: ${listing.current || 'none'}, base: ${listing.base}):\n`
                            + listing.branches.map(b => `- ${b.current ? '▶ ' : ''}${b.name}${b.isBase ? ' (base)' : ''}`
                                + `${b.local ? '' : ' · remote only'}${b.local && !b.remote ? ' · local only' : ''}${b.protected ? ' · protected' : ''}`
                                + `${b.aheadOfBase != null ? ` · ${b.aheadOfBase} ahead / ${b.behindBase} behind ${listing.base}` : ''}`).join('\n')
                            + (listing.remoteError ? `\n(GitHub's branch list is unavailable: ${listing.remoteError})` : '');
                    }
                    case 'repo_compare': {
                        if (!name) return '❌ repo_compare needs name (the clone, from repo_list).';
                        const cmp = await observatoryService.repos.compare({ userId, project, owner, name, base, head: branch });
                        return { _display: describeCompare(cmp), _card: repoCards.compare(cmp, owner) };
                    }
                    case 'repo_prs': {
                        if (!name) return '❌ repo_prs needs name (the clone, from repo_list).';
                        const prs = await observatoryService.repos.pullRequests({ userId, project, owner, name });
                        if (prs.pulls.length === 0) return `📦 ${prs.repo} has no open pull requests.`;
                        return `📦 Open pull requests on ${prs.repo}:\n` + prs.pulls.map(pr =>
                            `- #${pr.number} ${pr.title} (${pr.head} → ${pr.base}${pr.draft ? ', draft' : ''}) ${describeCi(pr.ci)} ${pr.url}`).join('\n');
                    }
                    case 'repo_pr': {
                        if (!name) return '❌ repo_pr needs name (the clone), note (the title) and optionally content (the body).';
                        const pr = await observatoryService.repos.createPullRequest({
                            userId, project, owner, name, title: note || title, body: content || '',
                            head: branch, base, draft: enabled === false, push: background === true
                        });
                        return {
                            _display: `📦 Opened pull request #${pr.number} on ${pr.repo} (${pr.head} → ${pr.base}${pr.draft ? ', draft' : ''}): ${pr.url}`,
                            _card: repoCards.pr(pr, owner)
                        };
                    }
                    case 'repo_ci': {
                        if (!name) return '❌ repo_ci needs name (the clone, from repo_list).';
                        const ci = await observatoryService.repos.ci({ userId, project, owner, name, ref: branch });
                        return {
                            _display: `📦 CI for ${ci.repo} ${ci.ref}: ${describeCi(ci)}`
                                + (ci.failing.length ? '\n' + ci.failing.map(f => `  ✗ ${f.name} (${f.conclusion})${f.summary ? `: ${f.summary}` : ''}${f.url ? ` ${f.url}` : ''}`).join('\n') : '')
                                + (ci.pending.length ? `\n  … still running: ${ci.pending.join(', ')}` : ''),
                            _card: repoCards.ci(ci, owner)
                        };
                    }
                    case 'repo_watch': {
                        if (!name) return '❌ repo_watch needs name (the clone, from repo_list).';
                        const watched = await require('../../services/projectCiWatchService').watch({
                            userId, project, owner, name, branch, mode: mode === 'fix' ? 'fix' : 'notify'
                        });
                        return `👀 Watching CI on ${watched.repo} ${watched.branch} for you: each new commit's result goes to your Inbox`
                            + (watched.mode === 'fix' ? `, and a red build starts up to ${watched.maxFixes} fix attempt(s) until it is green again.` : '.')
                            + ' Stop with repo_unwatch.';
                    }
                    case 'repo_unwatch': {
                        if (!name) return '❌ repo_unwatch needs name (the clone, from repo_list).';
                        const unwatched = await require('../../services/projectCiWatchService').unwatch({ userId, project, owner, name, branch });
                        return unwatched.removed
                            ? `👀 Stopped ${unwatched.removed} CI watch(es) on ${unwatched.repo}.`
                            : `👀 You had no CI watch on ${unwatched.repo}${branch ? ` ${branch}` : ''}.`;
                    }
                    case 'repo_merge':
                    case 'repo_rebase': {
                        if (!name) return `❌ ${action} needs name (the clone, from repo_list).`;
                        const verb = action === 'repo_merge' ? 'merge' : 'rebase';
                        const done = await observatoryService.repos[verb]({ userId, project, owner, name, branch });
                        return { _display: describeIntegration(done), _card: repoCards.integration(done, owner) };
                    }
                    case 'repo_continue': {
                        if (!name) return '❌ repo_continue needs name (the clone, from repo_list).';
                        const done = await observatoryService.repos.continue({ userId, project, owner, name });
                        return { _display: describeIntegration(done), _card: repoCards.integration(done, owner) };
                    }
                    case 'repo_abort': {
                        if (!name) return '❌ repo_abort needs name (the clone, from repo_list).';
                        const aborted = await observatoryService.repos.abort({ userId, project, owner, name });
                        return `📦 Aborted the ${aborted.aborted} in ${aborted.repo}; the branch is back as it was.\n${describeRepoStatus(aborted.status)}`;
                    }
                    case 'repo_reset': {
                        if (!name) return '❌ repo_reset needs name (the clone, from repo_list).';
                        const reset = await observatoryService.repos.reset({ userId, project, owner, name });
                        return `📦 Reset ${reset.repo} to origin/${reset.branch} (${reset.status.head}); local commits and changes are gone from the clone`
                            + (reset.snapshot ? `, but workspace snapshot ${reset.snapshot.slice(0, 7)} still has them (restore rev=${reset.snapshot.slice(0, 7)} path=repos/${reset.name}).` : '.');
                    }
                    case 'repo_remove': {
                        if (!name) return '❌ repo_remove needs name (the clone, from repo_list).';
                        const removed = await observatoryService.repos.remove({ userId, project, owner, name });
                        return `🗑️ Removed the clone of ${removed.repo} (repos/${removed.name}). Its files stay in workspace history.`;
                    }
                    case 'fetch-data': {
                        // Legalization (https-only, DNS pinning, allowlist vs
                        // approval, byte caps, quota) lives in
                        // sandboxRequestService + utils/safeFetch.
                        return await sandboxRequestService.requestFetch({
                            userId, project, owner, url, saveAs, reason,
                            client: interactionContext?.gateway || interactionContext?.client || null
                        });
                    }
                    case 'dashboard': {
                        const dashboard = await observatoryService.generateDashboard({ userId, project, owner });
                        await sendFiles([dashboard.path]);
                        return `📊 Regenerated the project dashboard (${(dashboard.sizeBytes / 1024).toFixed(1)} KB) `
                            + '[attached above] - a self-contained HTML snapshot of jobs, renders, gallery, and files. '
                            + 'The user can also open it live (with control buttons) from the portal\'s Observatory '
                            + 'pane, and create a public share link there.';
                    }
                    case 'save_app':
                    case 'save_script':
                    case 'save_note': {
                        const saveKind = action === 'save_app' ? 'app'
                            : action === 'save_script' ? 'script' : 'note';
                        const saved = await projectAssetService.save({
                            userId,
                            project,
                            owner,
                            slug: slug || name,
                            name: name || slug,
                            kind: saveKind,
                            language,
                            source: code,
                            note,
                            origin: 'agent'
                        });
                        if (saved.deduped) {
                            return `📦 "${saved.name}" (${saved.slug}) in "${saved.project}" is already at `
                                + `v${saved.version} — identical source, no new version.`;
                        }
                        return `📦 Saved ${saved.kind} "${saved.name}" (${saved.slug}) in "${saved.project}" `
                            + `as v${saved.version} (${saved.language}, ${saved.source.length} chars).`;
                    }
                    case 'list_assets': {
                        const assets = await projectAssetService.list({
                            userId, project, owner, kind: kind || null
                        });
                        if (assets.length === 0) {
                            return `📦 No assets in "${project}" yet — save one with save_app / save_script / save_note.`;
                        }
                        return `📦 Assets in "${project}":\n` + assets.map(a =>
                            `- ${a.slug} ("${a.name}") · ${a.kind}`
                            + `${a.currentVersion ? ` · v${a.currentVersion}` : ''}`
                            + `${a.language ? ` · ${a.language}` : ''}`
                            + `${a.note ? ` · ${a.note}` : ''}`
                        ).join('\n');
                    }
                    case 'get_asset': {
                        const got = await projectAssetService.get({
                            userId, project, owner, asset: slug || name, version
                        });
                        const headNote = got.version === got.currentVersion
                            ? ' (head)'
                            : ` (head is v${got.currentVersion})`;
                        const win = windowLines(got.source, { offset, limit });
                        const body = formatTextWindow({
                            label: `📦 ${got.kind} "${got.name}" (${got.slug}) v${got.version}${headNote}`
                                + ` · ${got.language}`
                                + `${got.note ? ` · ${got.note}` : ''}`
                                + ` · ${got.origin}`,
                            size: got.source.length,
                            window: win,
                            fence: got.language || fenceLanguage(got.slug)
                        });
                        return body;
                    }
                    case 'rollback_asset': {
                        const rolled = await projectAssetService.rollback({
                            userId, project, owner, asset: slug || name, version
                        });
                        return `↩️ Rolled "${rolled.name}" (${rolled.slug}) in "${rolled.project}" `
                            + `back to v${rolled.version}.`;
                    }
                    case 'run_script': {
                        const script = await projectAssetService.get({
                            userId, project, owner, asset: slug || name
                        });
                        if (script.kind !== 'script') {
                            return `❌ "${script.slug}" is a ${script.kind}, not a script.`;
                        }
                        const outcome = await observatoryService.run({
                            userId,
                            project,
                            owner,
                            language: script.language,
                            code: script.source,
                            background: background === true,
                            client: interactionContext?.gateway || interactionContext?.client || null,
                            signal: background === true
                                ? null
                                : (interactionContext?.abortSignal || null),
                            assetVersionId: script.versionId,
                            startedBy: interactionContext?.isAutomation ? 'trigger' : 'chat'
                        });
                        if (outcome.mode === 'background') {
                            return `🔭 Job #${outcome.jobId} is running "${script.slug}" v${script.version} `
                                + `in "${outcome.project}" (up to ${outcome.maxResumes} checkpoint resumes).`;
                        }
                        const result = outcome.result;
                        await sendFiles(result.files.map(f => f.path));
                        const runHint = `truncated — write long output to $${PROJECT_DIR_ENV} and use action "read"`;
                        const lines = [];
                        if (result.timedOut) {
                            lines.push(`⏱️ "${script.slug}" v${script.version} hit the time limit after ~${Math.round(result.durationMs / 1000)}s. `
                                + `For long work, rerun with background=true. ${backgroundJobHint()}.`);
                        } else if (result.ok) {
                            lines.push(`✅ Ran "${script.slug}" v${script.version} (${script.language}) in "${outcome.project}" (${result.durationMs} ms).`);
                        } else if (result.errorCode === OUTPUT_CONTRACT_FAILED) {
                            lines.push(`⚠️ "${script.slug}" v${script.version} exited 0 but failed its output contract: `
                                + `${describeContractResult(result.outputContract) || 'declared outputs missing'}`);
                        } else {
                            lines.push(`⚠️ "${script.slug}" v${script.version} exited with code ${result.exitCode}`
                                + `${result.signal ? ` (signal ${result.signal})` : ''} after ${result.durationMs} ms.`);
                        }
                        const stdout = clipStream(result.stdout, { hint: runHint });
                        const stderr = clipStream(result.stderr, { hint: runHint });
                        if (stdout.trim()) lines.push(`\nstdout:\n\`\`\`\n${stdout}\n\`\`\``);
                        if (stderr.trim()) lines.push(`\nstderr:\n\`\`\`\n${stderr}\n\`\`\``);
                        return lines.join('\n');
                    }
                    case 'set_trigger': {
                        const triggerKind = kind === 'cron' || kind === 'event' ? kind : null;
                        const actionParams = {};
                        if (background !== undefined) actionParams.background = background;
                        if (fps !== undefined) actionParams.fps = fps;
                        if (url !== undefined) actionParams.url = url;
                        if (saveAs !== undefined) actionParams.filename = saveAs;
                        if (prompt !== undefined) actionParams.prompt = prompt;
                        if (allowSelfChain !== undefined) actionParams.allowSelfChain = allowSelfChain;
                        if (maxChainDepth !== undefined) actionParams.maxChainDepth = maxChainDepth;
                        if (requiredOutputs !== undefined) {
                            // An empty array clears; the service normalizes the shape.
                            actionParams.requiredOutputs = Array.isArray(requiredOutputs) && requiredOutputs.length === 0
                                ? null
                                : requiredOutputs;
                        }
                        const saved = await projectTriggerService.set({
                            userId,
                            project,
                            owner,
                            name,
                            kind: triggerKind || undefined,
                            schedule,
                            eventTopic,
                            sourceAsset,
                            sourceTrigger,
                            action: triggerAction,
                            actionAsset: slug || undefined,
                            actionParams,
                            isEnabled: enabled
                        });
                        const when = saved.kind === 'cron'
                            ? `cron \`${saved.schedule}\` (next ${saved.nextRun} UTC)`
                            : `on ${saved.eventTopic}${describeTriggerFilters(saved)}`;
                        const contract = saved.actionParams?.requiredOutputs?.length
                            ? ` · requires ${saved.actionParams.requiredOutputs.map(o => o.path).join(', ')}`
                            : '';
                        return `⏰ ${saved.isEnabled ? 'Armed' : 'Saved (paused)'} trigger "${saved.name}" in "${saved.project}": `
                            + `${when} → ${saved.action}`
                            + `${saved.actionAssetId ? ` (asset #${saved.actionAssetId})` : ''}${contract}.`;
                    }
                    case 'list_triggers': {
                        const triggers = await projectTriggerService.list({ userId, project, owner });
                        if (triggers.length === 0) {
                            return `⏰ No triggers in "${project}" yet — set one with set_trigger.`;
                        }
                        return `⏰ Triggers in "${project}":\n` + triggers.map(t =>
                            `- ${t.isEnabled ? '🟢' : '⏸️'} "${t.name}" · ${t.kind === 'cron' ? `cron ${t.schedule}` : `${t.eventTopic}${describeTriggerFilters(t)}`}`
                            + ` → ${t.action}`
                            + `${t.actionParams?.requiredOutputs?.length ? ` · ${t.actionParams.requiredOutputs.length} required output(s)` : ''}`
                            + `${t.lastRun ? ` · last ${t.lastRun}` : ''}`
                            + `${t.lastOutcome ? ` · dispatch ${t.lastOutcome}` : ''}`
                            + `${t.lastJobOutcome ? ` · stage ${t.lastJobOutcome}` : ''}`
                        ).join('\n');
                    }
                    case 'list_deliveries': {
                        const deliveries = await projectTriggerService.listDeliveries({
                            userId, project, owner, trigger: name || slug, limit: 15
                        });
                        if (deliveries.length === 0) {
                            return `📬 No event deliveries for trigger "${name || slug}" yet — nothing matching has settled.`;
                        }
                        return `📬 Event deliveries for trigger "${name || slug}" (newest first):\n` + deliveries.map(d =>
                            `- source job #${d.sourceJobId}${d.sourceStatus ? ` (${d.sourceStatus})` : ''} → ${d.status}`
                            + `${d.childJobId ? ` child job #${d.childJobId}${d.childStatus ? ` ${d.childStatus}` : ''}${d.childErrorCode ? ` (${d.childErrorCode})` : ''}` : ''}`
                            + ` · ${d.attempts} attempt(s)`
                            + `${d.nextAttemptAt ? ` · next ${d.nextAttemptAt}` : ''}`
                            + `${d.detail ? ` · ${d.detail}` : ''}`
                        ).join('\n');
                    }
                    case 'delete_trigger': {
                        const gone = await projectTriggerService.delete({
                            userId, project, owner, trigger: name || slug
                        });
                        return `🗑️ Deleted trigger "${gone.name}".`;
                    }
                    case 'note_knowledge': {
                        const title = label || name;
                        const body = content || note;
                        const applied = await observatoryService.noteKnowledge({
                            userId, project, owner,
                            label: title,
                            content: body,
                            tags,
                            edges: related
                                ? [{ source: title, target: related, relation: relation || 'relates_to' }]
                                : []
                        });
                        return applied.nodesUpserted
                            ? `🧠 Noted "${title}" in the project knowledge`
                                + (applied.linksCreated ? ` (${applied.linksCreated} link${applied.linksCreated === 1 ? '' : 's'})` : '')
                                + '.'
                            : '❌ Could not store that note.';
                    }
                    case 'recall_knowledge': {
                        const text = await observatoryService.recallKnowledge({
                            userId, project, owner, query: query || name || note
                        });
                        return text
                            ? `🔭 Project knowledge:\n${text}`
                            : '🔭 Nothing in this project\'s knowledge yet.';
                    }
                    case 'mission': {
                        const verb = String(missionAction || 'get').trim().toLowerCase();
                        const fmt = (mission) => {
                            const criteria = (mission.successCriteria || [])
                                .map(c => `  - [${c.id}] ${c.text}`).join('\n');
                            const steps = (mission.steps || []).length
                                ? mission.steps.map(s => {
                                    const choiceHint = Array.isArray(s.actionParams?.choices) && s.actionParams.choices.length
                                        ? ` · choices: ${s.actionParams.choices.map(c => c.id).join('|')}`
                                        : '';
                                    const codeHint = s.code
                                        ? ` · code ${s.code.repo}:${s.code.branch}${s.code.requireGreenCi ? ' (needs green CI)' : ''}`
                                        : '';
                                    return `  - #${s.id} [${s.status}] ${s.kind}: ${s.title}${choiceHint}${codeHint}`;
                                }).join('\n')
                                : '  (none yet)';
                            const evalLine = mission.evaluation
                                ? `Assessment: ${mission.evaluation.overall} `
                                  + `(${mission.evaluation.supported} supported / ${mission.evaluation.contested} contested / ${mission.evaluation.unassessed} unassessed)`
                                : '';
                            return `🎯 Mission “${mission.title}” [${mission.status}]\n`
                                + `Objective: ${mission.objective}\n`
                                + (mission.deadline ? `Deadline: ${mission.deadline} UTC\n` : '')
                                + `Success criteria:\n${criteria || '  (none)'}\n`
                                + `Steps:\n${steps}\n`
                                + evalLine
                                + (mission.status === 'DRAFT'
                                    ? '\nWaiting for human approval in the portal — you cannot approve or start a mission.'
                                    : '');
                        };
                        switch (verb) {
                            case 'propose': {
                                const created = await projectMissionService.create({
                                    userId, project, owner,
                                    title: title || name,
                                    objective: objective || content || note,
                                    successCriteria,
                                    deadline,
                                    steps: stepKind && (stepTitle || title)
                                        ? [{
                                            kind: stepKind,
                                            title: stepTitle || title,
                                            description: stepDescription,
                                            actionParams: {
                                                seed,
                                                asset: slug,
                                                topic: watchTopic
                                            }
                                        }]
                                        : []
                                });
                                return `Drafted a mission. Approve it before anything runs.\n\n${fmt(created)}`;
                            }
                            case 'get': {
                                const open = await projectMissionService.getOpen({ userId, project, owner });
                                return open
                                    ? fmt(open)
                                    : '🎯 No open mission on this project. Propose one with missionAction=propose (objective + successCriteria).';
                            }
                            case 'update': {
                                const updated = await projectMissionService.updateDraft({
                                    userId, project, owner,
                                    title: title || name,
                                    objective,
                                    successCriteria,
                                    deadline
                                });
                                return `Updated the draft.\n\n${fmt(updated)}`;
                            }
                            case 'approve':
                            case 'start':
                            case 'complete':
                                return '❌ Approval, start, and completion are human-only. Ask the owner to confirm this mission in the Observatory portal.';
                            case 'add_step': {
                                const choiceList = choices
                                    ? String(choices).split(/;|\n/).map(s => s.trim()).filter(Boolean)
                                    : [];
                                const updated = await projectMissionService.addStep({
                                    userId, project, owner,
                                    kind: stepKind,
                                    title: stepTitle || title || name,
                                    description: stepDescription || content,
                                    actionParams: {
                                        seed,
                                        asset: slug,
                                        topic: watchTopic,
                                        prompt: reviewNotes || prompt || stepDescription,
                                        choices: choiceList.length
                                            ? choiceList.map(label => ({ label }))
                                            : undefined
                                    }
                                });
                                return `Added a ${stepKind || 'step'}.\n\n${fmt(updated)}`;
                            }
                            case 'start_step': {
                                if (!stepId) return '❌ start_step needs stepId.';
                                const updated = await projectMissionService.startStep({
                                    userId, project, owner, stepId
                                });
                                return `Started step #${stepId}.\n\n${fmt(updated)}`;
                            }
                            case 'complete_step': {
                                if (!stepId) return '❌ complete_step needs stepId.';
                                const updated = await projectMissionService.completeStep({
                                    userId, project, owner, stepId,
                                    note: reviewNotes || note,
                                    selectedId
                                });
                                return `Marked step #${stepId} done.\n\n${fmt(updated)}`;
                            }
                            case 'skip_step': {
                                if (!stepId) return '❌ skip_step needs stepId.';
                                const updated = await projectMissionService.skipStep({
                                    userId, project, owner, stepId, reason: reviewNotes || note
                                });
                                return `Skipped step #${stepId}.\n\n${fmt(updated)}`;
                            }
                            case 'add_evidence': {
                                if (!evidenceKind || !evidenceId) {
                                    return '❌ add_evidence needs evidenceKind and evidenceId.';
                                }
                                const updated = await projectMissionService.addEvidence({
                                    userId, project, owner,
                                    kind: evidenceKind,
                                    refId: evidenceId,
                                    criterionId,
                                    polarity,
                                    label: title || name || label
                                });
                                return `Linked evidence.\n\n${fmt(updated)}`;
                            }
                            case 'review': {
                                const updated = await projectMissionService.submitReview({
                                    userId, project, owner,
                                    notes: reviewNotes || content || note,
                                    verdict
                                });
                                return `Review recorded. A human completes the mission in the portal.\n\n${fmt(updated)}`;
                            }
                            case 'cancel': {
                                const updated = await projectMissionService.cancel({ userId, project, owner });
                                return `Cancelled the mission.\n\n${fmt(updated)}`;
                            }
                            case 'resume': {
                                const updated = await projectMissionService.resume({ userId, project, owner });
                                return `Resumed the mission.\n\n${fmt(updated)}`;
                            }
                            case 'link_code': {
                                if (!stepId) return '❌ link_code needs stepId, branch= and (with several clones) repo=.';
                                const updated = await projectMissionService.linkStepCode({
                                    userId, project, owner, stepId, repoName: repo || null, branch: branch || null,
                                    requireGreenCi: requireGreenCi === true
                                });
                                return `${branch ? `Linked step #${stepId} to ${branch}` : `Cleared step #${stepId}'s code link`}.\n\n${fmt(updated)}`;
                            }
                            default:
                                return `❌ Unknown missionAction "${verb}". Use propose, get, update, add_step, start_step, complete_step, add_evidence, review, cancel, resume, or link_code.`;
                        }
                    }
                    default:
                        return `❌ Unknown observatory action "${action}".`;
                }
            } catch (error) {
                // ObservatoryError carries a user-presentable message; surface
                // it as a recoverable observation the agent loop can react to.
                return `❌ ${error.message}`;
            }
        }
    }
};
