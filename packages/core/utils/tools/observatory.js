/**
 * Chat tools: sandbox and Observatory.
 * Required by packages/core/utils/toolsRegistry.js — apps keep requiring the facade.
 */

const path = require('node:path');
const sandboxService = require('../../services/sandboxService');
const sandboxConfig = require('../../config/sandboxConfig');
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

module.exports = {
    runCode: {
        definition: {
            name: 'runCode',
            description:
                'Run a short, resource-limited snippet of code in a locked-down sandbox and get back its output '
                + 'plus any files it wrote (every produced file - images, documents, data - is attached in the chat '
                + 'automatically). Use this to compute things, '
                + 'transform data, or - the headline use case - GENERATE DIAGRAMS/CHARTS. For a plot, write Python '
                + 'that uses matplotlib with the "Agg" backend and saves to a file (e.g. plt.savefig("chart.png")) '
                + 'instead of calling plt.show(); the saved image is returned to the user. The sandbox has no network '
                + 'access, a hard CPU/memory/time limit, and a throwaway working directory that is wiped after a day. '
                + 'Do not attempt long-running servers, installs, or anything that needs the internet.',
            parameters: {
                type: 'object',
                properties: {
                    language: {
                        type: 'string',
                        enum: ['python', 'javascript', 'bash'],
                        description: 'Language of the snippet.'
                    },
                    code: {
                        type: 'string',
                        description: 'The full source to run. Save any diagram/chart to a file rather than displaying it.'
                    },
                    stdin: {
                        type: 'string',
                        description: 'Optional text piped to the program on standard input.'
                    }
                },
                required: ['language', 'code']
            }
        },
        /**
         * Run code in the gated sandbox. Deterministic legalization lives in
         * sandboxService (isolation ladder + rlimits + scrubbed env); this
         * wrapper only enforces the availability/scope gate, wires generated
         * images back to the user, and renders a compact, model-readable
         * result string.
         * @param {{language:string, code:string, stdin?:string, interactionContext?:object}} args
         * @returns {Promise<string>}
         */
        execute: async ({ language, code, stdin, interactionContext }) => {
            if (!sandboxService.enabled) {
                return '❌ The code sandbox is disabled on this server.';
            }
            // Automation turns count as a trusted surface (see getDefinitions).
            const trustedSurface = (typeof interactionContext?.channelId === 'string'
                && interactionContext.channelId.startsWith('web:'))
                || interactionContext?.isAutomation === true;
            if (sandboxConfig.scope === 'web' && !trustedSurface) {
                return '❌ The code sandbox is only available in Goobster\'s web app, not here.';
            }

            let result;
            try {
                result = await sandboxService.run({
                    language,
                    code,
                    stdin,
                    userId: interactionContext?.user?.id || null,
                    // Stop button / turn watchdog: kill the run instead of
                    // holding the turn until the sandbox wall clock.
                    signal: interactionContext?.abortSignal || null
                });
            } catch (error) {
                // SandboxError carries a user-presentable message; surface it
                // as a recoverable observation the agent loop can react to.
                return `❌ ${error.message}`;
            }

            // Send every produced file to the user right away (images render
            // inline; documents/data arrive as downloadable attachments), and
            // record them on the interaction so the web portal can
            // persist/re-serve them (same pattern as generateImage).
            if (result.files.length > 0 && interactionContext?.channel?.send) {
                try {
                    await interactionContext.channel.send({
                        files: result.files.map(f => ({ attachment: f.path, name: path.basename(f.path) }))
                    });
                } catch { /* delivery is best effort; the summary still lists them */ }
                if (!Array.isArray(interactionContext.generatedFiles)) {
                    interactionContext.generatedFiles = [];
                }
                for (const file of result.files) interactionContext.generatedFiles.push(file.path);
            }

            // Compact result for the model: status, output, files. Each
            // stream shares the tool-result budget (see toolResultWindow);
            // the sandbox already byte-caps the raw pipes.
            const lines = [];
            if (result.timedOut) {
                lines.push(`⏱️ The code hit the time limit and was stopped after ~${Math.round(result.durationMs / 1000)}s.`);
            } else if (result.ok) {
                lines.push(`✅ Ran ${result.language} successfully (${result.durationMs} ms, isolation: ${result.isolation}).`);
            } else {
                lines.push(`⚠️ ${result.language} exited with code ${result.exitCode}`
                    + `${result.signal ? ` (signal ${result.signal})` : ''} after ${result.durationMs} ms.`);
            }
            const stdout = clipStream(result.stdout);
            const stderr = clipStream(result.stderr);
            if (stdout.trim()) lines.push(`\nstdout:\n\`\`\`\n${stdout}\n\`\`\``);
            if (stderr.trim()) lines.push(`\nstderr:\n\`\`\`\n${stderr}\n\`\`\``);
            // A missing import is the most common recoverable failure: tell
            // the model what IS importable so its retry can succeed.
            if (result.language === 'python' && /ModuleNotFoundError|ImportError/.test(result.stderr)) {
                lines.push(`\n💡 ${await sandboxService.pythonEnvironmentNote()}`);
            }
            if (result.files.length > 0) {
                const list = result.files
                    .map(f => `${f.name} (${(f.size / 1024).toFixed(1)} KB) [attached above]`)
                    .join(', ');
                lines.push(`\nFiles produced: ${list}`);
            }
            if (!stdout.trim() && !stderr.trim() && result.files.length === 0 && result.ok) {
                lines.push('\n(No output and no files were produced.)');
            }
            return lines.join('\n');
        }
    },
    observatory: {
        definition: {
            name: 'observatory',
            description:
                'The Observatory: persistent, long-running simulation projects layered on the code sandbox. '
                + 'A project gives every run a durable workspace directory (exposed as $GOOBSTER_PROJECT_DIR) '
                + 'whose files SURVIVE between runs - unlike runCode, whose working directory is wiped. '
                + 'Actions: "create-project" (name), "list" (your projects), "run" (language+code inside a project; '
                + 'set background=true to detach a long job), "status" (one job by jobId, or recent jobs), '
                + '"resume" (an interrupted/timed-out job, from its checkpoint), "cancel" (a running job), '
                + '"files" (workspace listing), "read" (one workspace text file by path; optional '
                + '1-based offset + line limit — prefer this over cat/head/sed via run), '
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
                + 'allowlisted URL, or fire an agent prompt), "invite_user" / "list_members" / '
                + '"remove_member" (collaborators; only the owner invites or removes others), '
                + '"note_knowledge" (store a distilled note with optional tags/edges in the '
                + 'project knowledge graph), "recall_knowledge" (retrieve from that graph), '
                + '"mission" (draft / get / update / approve / start / add_step / start_step / '
                + 'complete_step / add_evidence / review / complete / cancel a Project Mission — '
                + 'one open outcome per project; propose a plan, wait for approval, then execute), and '
                + '"delete-project". Pass owner=<userId> when a slug is ambiguous (you own one '
                + 'project and collaborate on another with the same name). '
                + 'Long-job conventions: background code should load '
                + '$GOOBSTER_PROJECT_DIR/checkpoint.json when present and rewrite it as it progresses - a segment '
                + 'killed at the sandbox time limit is automatically resumed from that checkpoint (bounded resume '
                + 'budget). Numbered frames saved to $GOOBSTER_PROJECT_DIR/frames/frame_0001.png (and so on) are '
                + 'stitched into a video automatically when a background job completes. When a background job '
                + 'finishes, the user is notified in their Discord DMs.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['create-project', 'list', 'run', 'status', 'resume', 'cancel',
                            'files', 'read', 'render', 'dashboard', 'fetch-data', 'delete-project',
                            'save_app', 'save_script', 'save_note', 'list_assets', 'get_asset',
                            'rollback_asset', 'run_script', 'set_trigger', 'list_triggers',
                            'delete_trigger', 'invite_user', 'list_members', 'remove_member',
                            'note_knowledge', 'recall_knowledge', 'mission'],
                        description: 'What to do'
                    },
                    project: { type: 'string', description: 'Project name or slug (required for run/files/read/render/fetch-data/delete-project/save_*/list_assets/get_asset/rollback_asset/run_script/set_trigger/list_triggers/delete_trigger/invite_user/list_members/remove_member/note_knowledge/recall_knowledge/mission)' },
                    path: { type: 'string', description: 'read: workspace-relative path (e.g. "src/main.py" or "data/notes.md")' },
                    offset: { type: 'integer', description: 'read / get_asset: 1-based line to start at (default 1)' },
                    limit: { type: 'integer', description: 'read / get_asset: max lines to return (default 400, max 800)' },
                    label: { type: 'string', description: 'note_knowledge: title of the distilled note' },
                    content: { type: 'string', description: 'note_knowledge: body of the distilled note' },
                    tags: { type: 'string', description: 'note_knowledge: comma-separated tags' },
                    query: { type: 'string', description: 'recall_knowledge: what to look up in the project graph' },
                    related: { type: 'string', description: 'note_knowledge: optional related node label to link' },
                    relation: { type: 'string', description: 'note_knowledge: relation to the related node (default relates_to)' },
                    owner: { type: 'string', description: 'Owner user id qualifier when two accessible projects share a slug' },
                    inviteeId: { type: 'string', description: 'invite_user / remove_member: Discord user id of the collaborator' },
                    name: { type: 'string', description: 'New project name (create-project), asset name (save_*), or trigger name (set_trigger / delete_trigger)' },
                    slug: { type: 'string', description: 'Asset slug (save_* / get_asset / rollback_asset / run_script). Derived from name when omitted.' },
                    language: { type: 'string', enum: ['python', 'javascript', 'bash', 'html', 'svg', 'markdown'], description: 'Language for run or save_*' },
                    code: { type: 'string', description: 'Source code for run or save_*' },
                    version: { type: 'integer', description: 'Asset version number (get_asset / rollback_asset)' },
                    note: { type: 'string', description: 'One-line commit note for save_*' },
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
                    missionAction: {
                        type: 'string',
                        enum: ['propose', 'get', 'update', 'approve', 'start', 'add_step',
                            'start_step', 'complete_step', 'skip_step', 'add_evidence',
                            'review', 'complete', 'cancel', 'resume'],
                        description: 'mission: what to do. propose drafts a plan (needs objective + successCriteria). approve must happen before start. complete_step is for human steps.'
                    },
                    title: { type: 'string', description: 'mission propose/update: short title' },
                    objective: { type: 'string', description: 'mission propose/update: the outcome we are pursuing' },
                    successCriteria: { type: 'string', description: 'mission: measurable criteria, one per line or semicolon-separated' },
                    deadline: { type: 'string', description: 'mission: YYYY-MM-DD or UTC timestamp' },
                    stepKind: { type: 'string', enum: ['expedition', 'job', 'watch', 'human'], description: 'mission add_step: step type' },
                    stepTitle: { type: 'string', description: 'mission add_step: short step title' },
                    stepDescription: { type: 'string', description: 'mission add_step: what this step does' },
                    stepId: { type: 'integer', description: 'mission start_step / complete_step / skip_step' },
                    seed: { type: 'string', description: 'mission add_step expedition: research seed' },
                    watchTopic: { type: 'string', description: 'mission add_step watch: domain event topic' },
                    criterionId: { type: 'string', description: 'mission add_evidence: success-criterion id (c1, c2, …)' },
                    evidenceKind: { type: 'string', enum: ['claim', 'note', 'job', 'artifact'], description: 'mission add_evidence' },
                    evidenceId: { type: 'integer', description: 'mission add_evidence: claim/note/job/asset id' },
                    polarity: { type: 'string', enum: ['for', 'against', 'neutral'], description: 'mission add_evidence: does this support the criterion?' },
                    verdict: { type: 'string', enum: ['met', 'unmet', 'mixed'], description: 'mission review/complete' },
                    reviewNotes: { type: 'string', description: 'mission review/complete: comparison against the original criteria' }
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
            allowSelfChain, maxChainDepth, owner, inviteeId, label, content, tags, query, related,
            relation, path: workspacePath, offset, limit, missionAction, title, objective,
            successCriteria, deadline, stepKind, stepTitle, stepDescription, stepId, seed,
            watchTopic, criterionId, evidenceKind, evidenceId, polarity, verdict, reviewNotes,
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

            const jobLine = (job) => `#${job.id} [${job.status}] ${job.project} · ${job.language} · `
                + `${job.segments} segment(s), ${job.resumeCount} resume(s)`
                + `${job.exitCode !== null && job.exitCode !== undefined ? ` · exit ${job.exitCode}` : ''}`
                + `${job.renderPath ? ' · 🎬 video rendered' : ''}`
                + `${job.error ? ` · ${job.error}` : ''}`;

            try {
                switch (action) {
                    case 'create-project': {
                        const created = await observatoryService.createProject({ userId, name: name || project });
                        return `🔭 Created project "${created.name}" (slug: ${created.slug}). Runs in it see a `
                            + 'persistent workspace via $GOOBSTER_PROJECT_DIR - put source files, checkpoint.json, '
                            + 'and frames/ there.';
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
                    case 'read': {
                        const rel = workspacePath || name || slug;
                        if (!rel) return '❌ read needs path (workspace-relative, e.g. "src/main.py").';
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
                        const runHint = 'truncated — write long output to $GOOBSTER_PROJECT_DIR and use action "read"';
                        const lines = [];
                        if (result.timedOut) {
                            lines.push(`⏱️ The code hit the time limit and was stopped after ~${Math.round(result.durationMs / 1000)}s. `
                                + 'For long work, rerun with background=true and the checkpoint.json convention.');
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
                        lines.push('\n(Persistent files belong in $GOOBSTER_PROJECT_DIR; use action "files" to browse them '
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
                        const runHint = 'truncated — write long output to $GOOBSTER_PROJECT_DIR and use action "read"';
                        const lines = [];
                        if (result.timedOut) {
                            lines.push(`⏱️ "${script.slug}" v${script.version} hit the time limit after ~${Math.round(result.durationMs / 1000)}s.`);
                        } else if (result.ok) {
                            lines.push(`✅ Ran "${script.slug}" v${script.version} (${script.language}) in "${outcome.project}" (${result.durationMs} ms).`);
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
                        const saved = await projectTriggerService.set({
                            userId,
                            project,
                            owner,
                            name,
                            kind: triggerKind || undefined,
                            schedule,
                            eventTopic,
                            action: triggerAction,
                            actionAsset: slug || undefined,
                            actionParams,
                            isEnabled: enabled
                        });
                        const when = saved.kind === 'cron'
                            ? `cron \`${saved.schedule}\` (next ${saved.nextRun} UTC)`
                            : `on ${saved.eventTopic}`;
                        return `⏰ ${saved.isEnabled ? 'Armed' : 'Saved (paused)'} trigger "${saved.name}" in "${saved.project}": `
                            + `${when} → ${saved.action}`
                            + `${saved.actionAssetId ? ` (asset #${saved.actionAssetId})` : ''}.`;
                    }
                    case 'list_triggers': {
                        const triggers = await projectTriggerService.list({ userId, project, owner });
                        if (triggers.length === 0) {
                            return `⏰ No triggers in "${project}" yet — set one with set_trigger.`;
                        }
                        return `⏰ Triggers in "${project}":\n` + triggers.map(t =>
                            `- ${t.isEnabled ? '🟢' : '⏸️'} "${t.name}" · ${t.kind === 'cron' ? `cron ${t.schedule}` : t.eventTopic}`
                            + ` → ${t.action}`
                            + `${t.lastRun ? ` · last ${t.lastRun}` : ''}`
                            + `${t.lastOutcome ? ` · ${t.lastOutcome}` : ''}`
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
                                ? mission.steps.map(s =>
                                    `  - #${s.id} [${s.status}] ${s.kind}: ${s.title}`).join('\n')
                                : '  (none yet)';
                            const evalLine = mission.evaluation
                                ? `Evaluation: ${mission.evaluation.overall} `
                                  + `(${mission.evaluation.met} met / ${mission.evaluation.unmet} unmet / ${mission.evaluation.open} open)`
                                : '';
                            return `🎯 Mission “${mission.title}” [${mission.status}]\n`
                                + `Objective: ${mission.objective}\n`
                                + (mission.deadline ? `Deadline: ${mission.deadline} UTC\n` : '')
                                + `Success criteria:\n${criteria || '  (none)'}\n`
                                + `Steps:\n${steps}\n`
                                + evalLine
                                + (mission.status === 'DRAFT'
                                    ? '\nWaiting for human approval — call missionAction=approve, then start.'
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
                            case 'approve': {
                                const approved = await projectMissionService.approve({ userId, project, owner });
                                return `Approved. Call missionAction=start to begin.\n\n${fmt(approved)}`;
                            }
                            case 'start': {
                                const started = await projectMissionService.start({ userId, project, owner });
                                return `Mission is ${started.status}. Ready steps can be started with start_step.\n\n${fmt(started)}`;
                            }
                            case 'add_step': {
                                const updated = await projectMissionService.addStep({
                                    userId, project, owner,
                                    kind: stepKind,
                                    title: stepTitle || title || name,
                                    description: stepDescription || content,
                                    actionParams: {
                                        seed,
                                        asset: slug,
                                        topic: watchTopic,
                                        prompt: reviewNotes || prompt
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
                                    userId, project, owner, stepId, note: reviewNotes || note
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
                                return `Review recorded. Complete the mission when you accept the verdict.\n\n${fmt(updated)}`;
                            }
                            case 'complete': {
                                const updated = await projectMissionService.complete({
                                    userId, project, owner,
                                    notes: reviewNotes || content || note,
                                    verdict
                                });
                                return `Mission completed (${updated.review?.verdict || updated.status}).\n\n${fmt(updated)}`;
                            }
                            case 'cancel': {
                                const updated = await projectMissionService.cancel({ userId, project, owner });
                                return `Cancelled the mission.\n\n${fmt(updated)}`;
                            }
                            case 'resume': {
                                const updated = await projectMissionService.resume({ userId, project, owner });
                                return `Resumed the mission.\n\n${fmt(updated)}`;
                            }
                            default:
                                return `❌ Unknown missionAction "${verb}". Use propose, get, approve, start, add_step, start_step, complete_step, add_evidence, review, complete, or cancel.`;
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
    },
    requestPythonPackages: {
        definition: {
            name: 'requestPythonPackages',
            description:
                'Request additional Python packages for the sandbox/Observatory toolkit. You cannot '
                + 'install anything yourself: this tool resolves the exact pinned, hash-locked set of '
                + 'wheels the request would install (nothing runs or downloads yet) and asks a human '
                + 'approver by DM; only their approval installs it. Use it when a needed import is not '
                + 'in the advertised toolkit, or when the user asks for a package - never guess-import '
                + 'first. Packages: plain PyPI names, optionally pinned ("numpy==2.1.0") and/or with '
                + 'the import name when it differs ("pyyaml:yaml"). Give a one-line reason the '
                + 'approver will read. The result tells you whether the request is waiting for '
                + 'approval - report that to the user honestly; the approval may take a while, so '
                + 'never claim the package is available until a run proves it.',
            parameters: {
                type: 'object',
                properties: {
                    packages: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'PyPI packages: "name", "name==1.2.3", or "name:import_name" (max 8)'
                    },
                    reason: { type: 'string', description: 'One line for the approver: why these packages' }
                },
                required: ['packages']
            }
        },
        /**
         * Propose a toolkit package install. Deterministic legalization
         * (name/version validation, wheels-only dry-run resolution, budget)
         * lives in sandboxRequestService; a configured approver confirms by
         * DM button. This wrapper only enforces the same availability/scope
         * gate as runCode.
         * @returns {Promise<string>}
         */
        execute: async ({ packages, reason, interactionContext }) => {
            if (!sandboxService.enabled) {
                return '❌ The code sandbox is disabled on this server.';
            }
            const trustedSurface = (typeof interactionContext?.channelId === 'string'
                && interactionContext.channelId.startsWith('web:'))
                || interactionContext?.isAutomation === true;
            if (sandboxConfig.scope === 'web' && !trustedSurface) {
                return '❌ The code sandbox is only available in Goobster\'s web app, not here.';
            }
            const userId = interactionContext?.user?.id;
            if (!userId) {
                return '❌ Package requests need to know who is asking - no user context available.';
            }
            try {
                return await sandboxRequestService.requestPackages({
                    userId,
                    packages,
                    reason,
                    client: interactionContext?.gateway || interactionContext?.client || null
                });
            } catch (error) {
                // SandboxRequestError carries a user-presentable message;
                // surface it as a recoverable observation.
                return `❌ ${error.message}`;
            }
        }
    }
};
