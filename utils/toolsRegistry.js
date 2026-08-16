// A lightweight registry that exposes internal capabilities as "functions" to OpenAI function-calling.
// Each entry includes an OpenAI-style definition and a runtime execute() helper.
// NOTE: Only minimal tools are wired for now – extend as needed.

const path = require('node:path');
const perplexityService = require('../services/perplexityService');
const imageDetectionHandler = require('./imageDetectionHandler');
const sandboxService = require('../services/sandboxService');
const sandboxConfig = require('../config/sandboxConfig');
const observatoryService = require('../services/observatoryService');
const observatoryConfig = require('../config/observatoryConfig');
// Discord command modules
const playTrackCmd = require('../commands/music/playtrack');
const nicknameCmd = require('../commands/settings/nickname');
const speakCmd = require('../commands/chat/speak');
const { PermissionFlagsBits } = require('discord.js');

/**
 * Resolve which wallet an economy/stock tool acts on. The model picks the
 * account explicitly via the tool's `owner` parameter:
 *   - 'user' (default): the human who triggered this turn.
 *   - 'bot': Goobster's own Discord account (interactionContext.client.user)
 *     - the SAME real account id that `/points admin grant` can fund, so the
 *     assistant's "my points" always means the shared economyService wallet
 *     keyed on (guildId, botUserId). Never a synthetic id.
 * @param {Object} interactionContext - Discord interaction (or pseudo-interaction)
 * @param {'user'|'bot'} [owner]
 * @returns {{guildId: string, userId: string, whose: string}|{error: string}}
 */
function resolveEconomyAccount(interactionContext, owner = 'user') {
    const guildId = interactionContext?.guildId;
    if (!guildId) return { error: '❌ The point economy only exists inside servers.' };
    if (owner === 'bot') {
        const botId = interactionContext?.client?.user?.id;
        if (!botId) return { error: '❌ I could not resolve my own bot account in this context.' };
        return { guildId, userId: botId, whose: "Goobster's own" };
    }
    const userId = interactionContext?.user?.id;
    if (!userId) return { error: '❌ I could not tell whose wallet to use.' };
    return { guildId, userId, whose: "the requesting user's" };
}

/**
 * Resolve which member of the guild an audit/inspection tool is asking about.
 * Accepts a mention (`<@123>`), a raw snowflake, a username, a display name,
 * or nothing at all (meaning the person Goobster is talking to).
 *
 * Read-only by design: this is how Goobster answers "how is The Data Daddy's
 * account doing" without needing the asker to paste an id. It only ever
 * resolves members of the guild the conversation is happening in.
 * @returns {Promise<{guildId, userId, label}|{error: string}>}
 */
async function resolveGuildMember(interactionContext, who = null) {
    const guildId = interactionContext?.guildId;
    if (!guildId) return { error: '❌ The exchange only exists inside servers.' };

    const selfId = interactionContext?.user?.id;
    const query = String(who || '').trim();
    if (!query) {
        if (!selfId) return { error: '❌ I could not tell whose account to look at.' };
        return { guildId, userId: selfId, label: interactionContext.user.username || 'you', isSelf: true };
    }

    const botId = interactionContext?.client?.user?.id;
    if (/^(me|myself|my account|i)$/i.test(query) && selfId) {
        return { guildId, userId: selfId, label: interactionContext.user.username || 'you', isSelf: true };
    }
    if (/^(you|yourself|goobster|your account)$/i.test(query) && botId) {
        return { guildId, userId: botId, label: 'Goobster', isBot: true };
    }

    const mentioned = query.match(/^<@!?(\d{5,25})>$/);
    const id = mentioned ? mentioned[1] : (/^\d{5,25}$/.test(query) ? query : null);
    const guild = interactionContext?.guild;

    try {
        if (id) {
            const member = guild?.members?.cache?.get(id) || await guild?.members?.fetch(id);
            return { guildId, userId: id, label: member?.displayName || member?.user?.username || `user ${id}` };
        }
        if (guild?.members?.fetch) {
            const matches = await guild.members.fetch({ query, limit: 5 });
            const member = matches?.first?.();
            if (member) return { guildId, userId: member.id, label: member.displayName || member.user.username };
        }
    } catch {
        // Fall through to the not-found message below
    }
    return { error: `❌ I couldn't find "${query}" in this server. Try mentioning them.` };
}

const tools = {
    performSearch: {
        definition: {
            name: 'performSearch',
            description: 'Run a web search and return a concise text summary of the results.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query to pass to the external search API.'
                    }
                },
                required: ['query']
            }
        },
        /**
         * @param {object} args – Function arguments from the LLM (query:string)
         * @returns {Promise<string>} Search summary text
         */
        execute: async ({ query }) => {
            if (!query) throw new Error('Missing search query');
            const result = await perplexityService.search(query);
            return result;
        }
    },
    generateImage: {
        definition: {
            name: 'generateImage',
            description: 'Generate an image with the bot\'s image service and return a CDN URL or local path.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'Detailed description of what to generate.' },
                    type: {
                        type: 'string',
                        enum: ['CHARACTER', 'SCENE', 'LOCATION', 'ITEM'],
                        description: 'Image category'
                    },
                    style: {
                        type: 'string',
                        description: 'Artistic style to apply (e.g. fantasy, realistic, anime)',
                        default: 'fantasy'
                    }
                },
                required: ['prompt']
            }
        },
        /**
         * Use the existing imageDetectionHandler.generateImage helper.
         * @param {{prompt:string,type?:string,style?:string}} args
         * @returns {Promise<string>} Relative path to generated image
         */
        execute: async ({ prompt, type = 'SCENE', style = 'fantasy', interactionContext }) => {
            const imagePath = await imageDetectionHandler.generateImage(prompt, type, style);

            // If we have an interaction context (original Discord interaction) send the attachment right away
            if (interactionContext && interactionContext.channel) {
                await interactionContext.channel.send({
                    files: [{ attachment: imagePath, name: path.basename(imagePath) }]
                });
                // Record the file on the interaction so the chat pipeline can
                // persist it with the reply (the web portal rebuilds message
                // history from SQLite, so unstored attachments would vanish).
                if (!Array.isArray(interactionContext.generatedFiles)) {
                    interactionContext.generatedFiles = [];
                }
                interactionContext.generatedFiles.push(imagePath);
                return '✨ I have generated and sent the image above.';
            }

            // Fallback: just return the local path (may not render in Discord)
            return imagePath;
        }
    },
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
            const isWeb = typeof interactionContext?.channelId === 'string'
                && interactionContext.channelId.startsWith('web:');
            if (sandboxConfig.scope === 'web' && !isWeb) {
                return '❌ The code sandbox is only available in Goobster\'s web app, not here.';
            }

            let result;
            try {
                result = await sandboxService.run({
                    language,
                    code,
                    stdin,
                    userId: interactionContext?.user?.id || null
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

            // Compact result for the model: status, output, files. Keep each
            // stream short - the raw stream is already byte-capped by the
            // service, but the model only needs enough to explain the result.
            const clip = (text, max = 4000) =>
                (text && text.length > max ? text.slice(0, max) + '\n… [truncated]' : (text || ''));
            const lines = [];
            if (result.timedOut) {
                lines.push(`⏱️ The code hit the time limit and was stopped after ~${Math.round(result.durationMs / 1000)}s.`);
            } else if (result.ok) {
                lines.push(`✅ Ran ${result.language} successfully (${result.durationMs} ms, isolation: ${result.isolation}).`);
            } else {
                lines.push(`⚠️ ${result.language} exited with code ${result.exitCode}`
                    + `${result.signal ? ` (signal ${result.signal})` : ''} after ${result.durationMs} ms.`);
            }
            const stdout = clip(result.stdout);
            const stderr = clip(result.stderr);
            if (stdout.trim()) lines.push(`\nstdout:\n\`\`\`\n${stdout}\n\`\`\``);
            if (stderr.trim()) lines.push(`\nstderr:\n\`\`\`\n${stderr}\n\`\`\``);
            // A missing import is the most common recoverable failure: tell
            // the model what IS importable so its retry can succeed.
            if (result.language === 'python' && /ModuleNotFoundError|ImportError/.test(result.stderr)) {
                lines.push(`\n💡 ${sandboxService.pythonEnvironmentNote()}`);
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
                + '"files" (workspace listing), "render" (stitch frames into an mp4 at an optional fps), '
                + 'and "delete-project". Long-job conventions: background code should load '
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
                            'files', 'render', 'delete-project'],
                        description: 'What to do'
                    },
                    project: { type: 'string', description: 'Project name or slug (required for run/files/render/delete-project)' },
                    name: { type: 'string', description: 'New project name (create-project)' },
                    language: { type: 'string', enum: ['python', 'javascript', 'bash'], description: 'Language for run' },
                    code: { type: 'string', description: 'Source code for run' },
                    stdin: { type: 'string', description: 'Optional stdin for foreground runs' },
                    background: { type: 'boolean', description: 'run: detach as a checkpointable background job (default false)' },
                    jobId: { type: 'integer', description: 'Job id (status/resume/cancel)' },
                    fps: { type: 'integer', description: 'render: framerate (defaults to the server setting)' }
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
        execute: async ({ action, project, name, language, code, stdin, background, jobId, fps, interactionContext }) => {
            if (!observatoryService.enabled) {
                return '❌ The Observatory is disabled on this server (it also requires the code sandbox to be enabled).';
            }
            const isWeb = typeof interactionContext?.channelId === 'string'
                && interactionContext.channelId.startsWith('web:');
            if (observatoryConfig.scope === 'web' && !isWeb) {
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
                        const created = observatoryService.createProject({ userId, name: name || project });
                        return `🔭 Created project "${created.name}" (slug: ${created.slug}). Runs in it see a `
                            + 'persistent workspace via $GOOBSTER_PROJECT_DIR - put source files, checkpoint.json, '
                            + 'and frames/ there.';
                    }
                    case 'list': {
                        const projects = observatoryService.listProjects(userId);
                        if (projects.length === 0) {
                            return '🔭 No projects yet - create one with action "create-project".';
                        }
                        return '🔭 Projects:\n' + projects.map(p =>
                            `- ${p.slug} ("${p.name}") · ${p.sizeMb}/${p.quotaMb} MB · `
                            + `${p.runningJobs} running / ${p.totalJobs} total job(s) · updated ${p.updatedAt}`
                        ).join('\n');
                    }
                    case 'delete-project': {
                        const gone = observatoryService.deleteProject({ userId, project });
                        return `🗑️ Deleted project "${gone.slug}" and its whole workspace.`;
                    }
                    case 'files': {
                        const listing = observatoryService.listFiles({ userId, project });
                        if (listing.files.length === 0) {
                            return `🔭 ${listing.project}: the workspace is empty (${listing.sizeMb}/${listing.quotaMb} MB).`;
                        }
                        const lines = listing.files.map(f =>
                            `- ${f.path} (${(f.size / 1024).toFixed(1)} KB, ${f.modifiedAt})`);
                        return `🔭 ${listing.project} workspace (${listing.sizeMb}/${listing.quotaMb} MB, `
                            + `${listing.totalFiles} file(s)${listing.totalFiles > listing.files.length ? ', newest shown' : ''}):\n`
                            + lines.join('\n');
                    }
                    case 'run': {
                        const outcome = await observatoryService.run({
                            userId, project, language, code, stdin,
                            background: background === true,
                            client: interactionContext?.client || null
                        });
                        if (outcome.mode === 'background') {
                            return `🔭 Job #${outcome.jobId} is running in the background in "${outcome.project}" `
                                + `(up to ${outcome.maxResumes} checkpoint resumes). I'll DM the user when it finishes; `
                                + 'check on it with action "status".';
                        }
                        // Foreground: same delivery + summary contract as runCode.
                        const result = outcome.result;
                        await sendFiles(result.files.map(f => f.path));
                        const clip = (text, max = 4000) =>
                            (text && text.length > max ? text.slice(0, max) + '\n… [truncated]' : (text || ''));
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
                        const stdout = clip(result.stdout);
                        const stderr = clip(result.stderr);
                        if (stdout.trim()) lines.push(`\nstdout:\n\`\`\`\n${stdout}\n\`\`\``);
                        if (stderr.trim()) lines.push(`\nstderr:\n\`\`\`\n${stderr}\n\`\`\``);
                        if (result.language === 'python' && /ModuleNotFoundError|ImportError/.test(result.stderr)) {
                            lines.push(`\n💡 ${sandboxService.pythonEnvironmentNote()}`);
                        }
                        if (result.files.length > 0) {
                            lines.push(`\nFiles produced: ${result.files
                                .map(f => `${f.name} (${(f.size / 1024).toFixed(1)} KB) [attached above]`).join(', ')}`);
                        }
                        lines.push('\n(Persistent files belong in $GOOBSTER_PROJECT_DIR; use action "files" to browse them.)');
                        return lines.join('\n');
                    }
                    case 'status': {
                        if (jobId !== undefined && jobId !== null) {
                            const job = observatoryService.getJob({ userId, jobId });
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
                                parts.push(`💡 ${sandboxService.pythonEnvironmentNote()}`);
                            }
                            return parts.join('\n');
                        }
                        const jobs = observatoryService.listJobs({ userId, project: project || null });
                        if (jobs.length === 0) return '🔭 No jobs yet - start one with action "run" and background=true.';
                        return '🔭 Jobs (newest first):\n' + jobs.map(jobLine).join('\n');
                    }
                    case 'resume': {
                        const resumed = observatoryService.resume({
                            userId, jobId, client: interactionContext?.client || null
                        });
                        return `▶️ Job #${resumed.jobId} resumed from its checkpoint.`;
                    }
                    case 'cancel': {
                        const cancelled = observatoryService.cancel({ userId, jobId });
                        return `⏹️ Job #${cancelled.jobId} cancelled.`;
                    }
                    case 'render': {
                        const render = observatoryService.render({ userId, project, fps });
                        await sendFiles([render.path]);
                        return `🎬 Stitched ${render.frames} frame(s) at ${render.fps} fps into `
                            + `${render.relPath} (${(render.sizeBytes / (1024 * 1024)).toFixed(1)} MB) [attached above].`;
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
    playTrack: {
        definition: {
            name: 'playTrack',
            description: 'Queue or play a music track in the user\'s current voice channel.',
            parameters: {
                type: 'object',
                properties: {
                    track: { type: 'string', description: 'Search query or track name (artist - title)' },
                    subcommand: { 
                        type: 'string', 
                        enum: ['play', 'list', 'queue', 'skip', 'pause', 'resume', 'stop', 'volume', 'playlist_create', 'playlist_add', 'playlist_play', 'playlist_list', 'playlist_delete', 'play_all', 'shuffle_all', 'playlist_create_from_search'],
                        description: 'Music command subcommand',
                        default: 'play'
                    },
                    volume: { 
                        type: 'integer', 
                        description: 'Volume level (0-100)',
                        minimum: 0,
                        maximum: 100
                    },
                    playlistName: { 
                        type: 'string', 
                        description: 'Name of the playlist for playlist operations'
                    },
                    searchQuery: {
                        type: 'string',
                        description: 'Search query for playlist creation'
                    }
                },
                required: ['track']
            }
        },
        execute: async ({ track, subcommand = 'play', volume, playlistName, searchQuery, interactionContext }) => {
            if (!interactionContext) return '❌ Cannot play music without an interaction context.';

            // Check if user is in a voice channel for relevant commands
            if (['play', 'pause', 'resume', 'skip', 'stop', 'volume'].includes(subcommand)) {
                const voiceChannel = interactionContext.member.voice.channel;
                if (!voiceChannel) {
                    return '❌ You need to be in a voice channel to use this command!';
                }

                // For commands other than 'play', check if user is in the same channel as the bot
                if (subcommand !== 'play' && !isUserInBotVoiceChannel(interactionContext)) {
                    return '❌ You need to be in the same voice channel as the bot to control music.';
                }

                // Check bot permissions
                const permissions = voiceChannel.permissionsFor(interactionContext.client.user);
                if (!permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
                    return '❌ I need permissions to join and speak in your voice channel.';
                }
            }

            // Build a faux options resolver for the command
            interactionContext.options = {
                getSubcommand: () => subcommand,
                getString: (name) => {
                    if (name === 'track') return track;
                    if (name === 'name' || name === 'playlist_name') return playlistName;
                    if (name === 'search_query') return searchQuery;
                    return null;
                },
                getInteger: (name) => {
                    if (name === 'level') return volume;
                    return null;
                }
            };

            try {
                await playTrackCmd.execute(interactionContext);
                return `🎵 ${getCommandResponse(subcommand, track, playlistName)}`;
            } catch (error) {
                console.error('PlayTrack command error:', error);
                return `❌ Error: ${error.message || 'An error occurred while processing your request.'}`;
            }
        }
    },
    setNickname: {
        definition: {
            name: 'setNickname',
            description: 'Set or clear a nickname (bot or user).',
            parameters: {
                type: 'object',
                properties: {
                    target: { type: 'string', enum: ['bot', 'user'], description: 'Whose nickname to change' },
                    nickname: { type: 'string', description: 'Nickname text (omit for clear)' }
                },
                required: ['target']
            }
        },
        execute: async ({ target, nickname, interactionContext }) => {
            if (!interactionContext) return '❌ Cannot change nickname without interaction context.';

            const action = nickname ? 'set' : 'clear';

            interactionContext.options = {
                getSubcommandGroup: () => target,
                getSubcommand: () => action,
                getString: (name) => (name === 'nickname' ? nickname : null)
            };

            await nicknameCmd.execute(interactionContext);
            return nickname ? `✅ ${target} nickname set to ${nickname}` : `✅ ${target} nickname cleared.`;
        }
    },
    speakMessage: {
        definition: {
            name: 'speakMessage',
            description: 'Convert text to speech in the user\'s voice channel.',
            parameters: {
                type: 'object',
                properties: {
                    message: { type: 'string', description: 'Text to speak' },
                    voice: { type: 'string', description: 'Voice style (optional)' },
                    style: { type: 'string', description: 'Speech effect style (optional)' }
                },
                required: ['message']
            }
        },
        execute: async ({ message, voice, style, interactionContext }) => {
            if (!interactionContext) return '❌ Cannot speak without interaction context.';

            interactionContext.options = {
                getString: (name) => {
                    if (name === 'message') return message;
                    if (name === 'voice') return voice || null;
                    if (name === 'style') return style || null;
                    return null;
                },
                getBoolean: () => false // default for other bool options
            };

            await speakCmd.execute(interactionContext);
            return `🔊 Speaking your message...`;
        }
    },
    echoMessage: {
        definition: {
            name: 'echoMessage',
            description: 'Echo back the provided text.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'Text to echo back' }
 
                },
                required: ['text']
            }
        },
        execute: async ({ text }) => text
    },
    rememberFact: {
        definition: {
            name: 'rememberFact',
            description: 'Save a durable fact to long-term memory, e.g. a user preference, ongoing project, or important server detail. Use when you learn something worth remembering beyond this conversation.',
            parameters: {
                type: 'object',
                properties: {
                    fact: { type: 'string', description: 'Short declarative statement, e.g. "Rob prefers concise answers".' },
                    about: {
                        type: 'string',
                        enum: ['user', 'server'],
                        description: 'Whether this fact is about the current user or the server as a whole.'
                    }
                },
                required: ['fact', 'about']
            }
        },
        execute: async ({ fact, about = 'user', interactionContext }) => {
            const factsService = require('../services/factsService');
            const { dmScopeId } = require('./dmScope');
            // Facts are keyed on the guild, or on the user's DM scope in DMs
            const guildId = interactionContext?.guildId
                || (interactionContext?.user?.id ? dmScopeId(interactionContext.user.id) : null);
            if (!guildId) return '❌ Facts can only be saved inside a conversation.';

            const isUser = about === 'user';
            const id = factsService.addFact({
                guildId,
                subjectType: isUser ? 'USER' : 'GUILD',
                subjectId: isUser ? interactionContext.user?.id : null,
                content: fact,
                source: 'model'
            });
            return id ? `🧠 Remembered: "${fact}"` : '❌ Could not save that fact.';
        }
    },
    forgetFact: {
        definition: {
            name: 'forgetFact',
            description: 'Delete facts from long-term memory that match a phrase. Use when a saved fact is wrong or outdated, or when a user asks you to forget something about them.',
            parameters: {
                type: 'object',
                properties: {
                    match: { type: 'string', description: 'Phrase to match against stored facts (substring match).' },
                    about: {
                        type: 'string',
                        enum: ['user', 'server', 'any'],
                        description: 'Scope: facts about the current user, the server, or both.'
                    }
                },
                required: ['match']
            }
        },
        execute: async ({ match, about = 'any', interactionContext }) => {
            const factsService = require('../services/factsService');
            const { dmScopeId } = require('./dmScope');
            // Same scoping as rememberFact: guild, or the user's DM scope
            const guildId = interactionContext?.guildId
                || (interactionContext?.user?.id ? dmScopeId(interactionContext.user.id) : null);
            if (!guildId) return '❌ Facts only exist inside a conversation.';

            const removed = factsService.removeFacts({
                guildId,
                subjectType: about === 'user' ? 'USER' : about === 'server' ? 'GUILD' : null,
                subjectId: about === 'user' ? interactionContext.user?.id : null,
                match
            });
            return removed > 0
                ? `🗑️ Forgot ${removed} fact${removed === 1 ? '' : 's'} matching "${match}".`
                : `I didn't have any facts matching "${match}".`;
        }
    },
    checkPoints: {
        definition: {
            name: 'checkPoints',
            description: 'Check a point-currency balance in this server (the currency may have a custom name like "Jimmy points"). Defaults to the requesting user\'s wallet; pass owner="bot" for your own (Goobster\'s) wallet, e.g. when someone asks about YOUR points.',
            parameters: {
                type: 'object',
                properties: {
                    owner: {
                        type: 'string',
                        enum: ['user', 'bot'],
                        description: 'Whose wallet: "user" (default) = the human you are talking to, "bot" = Goobster\'s own account.'
                    }
                }
            }
        },
        execute: async ({ owner = 'user', interactionContext }) => {
            const economyService = require('../services/economyService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const balance = economyService.getBalance(account.guildId, account.userId);
            const { currencyName } = economyService.getSettings(account.guildId);
            return `💰 Balance (${account.whose} wallet): ${balance.toLocaleString()} ${currencyName}.`;
        }
    },
    gamblePoints: {
        definition: {
            name: 'gamblePoints',
            description: 'Gamble points on a game: a coin flip (call heads or tails), a d20 roll against the bot, or a five-card poker showdown. All games pay even money. Always plays with the requesting user\'s wallet - you cannot gamble your own (bot) points.',
            parameters: {
                type: 'object',
                properties: {
                    game: { type: 'string', enum: ['coinflip', 'd20', 'poker'], description: 'Which game to play' },
                    bet: { type: 'integer', description: 'Points to wager (whole number, at least 1)' },
                    call: { type: 'string', enum: ['heads', 'tails'], description: 'Coin-flip call (required for coinflip)' }
                },
                required: ['game', 'bet']
            }
        },
        execute: async ({ game, bet, call, interactionContext }) => {
            const gamblingService = require('../services/gamblingService');
            const { formatHand } = require('./pokerHands');
            // Deliberately user-only: the games are framed as player-vs-bot,
            // so wagering Goobster's own wallet would be self-play.
            const account = resolveEconomyAccount(interactionContext, 'user');
            if (account.error) return account.error;
            const { guildId, userId } = account;

            try {
                const base = { guildId, userId, bet: Number(bet) };
                if (game === 'coinflip') {
                    const r = gamblingService.coinflip({ ...base, choice: call });
                    return `🪙 The coin landed ${r.result} - you ${r.won ? 'won' : 'lost'} ${bet.toLocaleString()} ${r.currencyName}. New balance: ${r.balance.toLocaleString()}.`;
                }
                if (game === 'd20') {
                    const r = gamblingService.d20(base);
                    return `🎲 You rolled ${r.playerRoll}, Goobster rolled ${r.botRoll} - ${r.outcome === 'push' ? 'a tie, bet returned' : r.outcome === 'win' ? `you won ${bet.toLocaleString()}` : `you lost ${bet.toLocaleString()}`} ${r.currencyName}. New balance: ${r.balance.toLocaleString()}.`;
                }
                if (game === 'poker') {
                    const r = gamblingService.poker(base);
                    return `🃏 Your hand: ${formatHand(r.playerHand)} (${r.playerHandName}) vs dealer: ${formatHand(r.dealerHand)} (${r.dealerHandName}) - ${r.outcome === 'push' ? 'a tie, bet returned' : r.outcome === 'win' ? `you won ${bet.toLocaleString()}` : `you lost ${bet.toLocaleString()}`} ${r.currencyName}. New balance: ${r.balance.toLocaleString()}.`;
                }
                return `❌ Unknown game "${game}". Choose coinflip, d20, or poker.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    tavernInfo: {
        definition: {
            name: 'tavernInfo',
            description: 'Look inside the Goobster Tavern (the server\'s tabletop-RPG hub): the Common Room status, the quest board, today\'s rumor, an NPC, the requesting user\'s character sheet, or the shared world lore written by past adventures.',
            parameters: {
                type: 'object',
                properties: {
                    topic: {
                        type: 'string',
                        enum: ['status', 'board', 'rumor', 'npc', 'character', 'world'],
                        description: 'What to look up.'
                    },
                    npc: {
                        type: 'string',
                        enum: ['marnie', 'bix', 'caldra', 'albert'],
                        description: 'Which NPC (required when topic="npc").'
                    }
                },
                required: ['topic']
            }
        },
        execute: async ({ topic, npc, interactionContext }) => {
            const guildId = interactionContext?.guildId;
            const userId = interactionContext?.user?.id;
            if (!guildId) return '❌ The Tavern only manifests inside servers.';
            const tavernService = require('../services/tavern/tavernService');
            const questLoader = require('../services/tavern/questLoader');
            const adventureService = require('../services/tavern/adventureService');
            const worldService = require('../services/tavern/worldService');
            const characterService = require('../services/tavern/characterService');

            if (topic === 'rumor') {
                return `🗣️ Rumor of the day: ${tavernService.getStatus(guildId).rumor}`;
            }
            if (topic === 'status') {
                const status = tavernService.getStatus(guildId);
                const open = status.openAdventures.map(a => `${a.title} (${a.status.toLowerCase()}, party of ${a.partySize}) in <#${a.channelId}>`);
                return `🍺 The Goobster Tavern. ${status.weather}\nRumor: ${status.rumor}\n` +
                    `Quests on the board: ${status.quests.map(q => q.title).join('; ')}.\n` +
                    `Open adventures: ${open.length > 0 ? open.join('; ') : 'none right now'}.\n` +
                    `${status.characterCount} adventurer(s) have characters here.`;
            }
            if (topic === 'board') {
                const quests = questLoader.getVisibleQuests();
                return quests.map(quest => {
                    const locked = !adventureService.isQuestUnlocked(guildId, quest);
                    return locked
                        ? `🔒 ${quest.title} - locked until the server completes "${questLoader.getQuest(quest.requires)?.title || quest.requires}".`
                        : `• ${quest.title} (${quest.players.min}-${quest.players.max} players, ${quest.duration}, ${quest.difficulty}): ${quest.hook.trim().split('\n')[0]}`;
                }).join('\n');
            }
            if (topic === 'npc') {
                const card = tavernService.getNpc(guildId, npc);
                if (!card) return `❌ Nobody named "${npc}" drinks here. Residents: marnie, bix, caldra, albert.`;
                const standing = userId ? worldService.getRelationship(guildId, npc, userId) : null;
                return `${card.emoji} ${card.name}, ${card.title}. ${card.description} ` +
                    `Today they say: "${card.line}"` +
                    (standing && standing.score !== 0 ? ` Their opinion of the requesting user: ${standing.label} (${standing.score}).` : '');
            }
            if (topic === 'character') {
                if (!userId) return '❌ I could not tell whose character to look up.';
                const character = characterService.getCharacter(guildId, userId);
                if (!character) return 'The requesting user has no character yet - `/character create` takes about a minute.';
                return `${character.name} (${character.origin}) - ${character.calling}. ` +
                    `Might +${character.might}, Finesse +${character.finesse}, Wits +${character.wits}, Heart +${character.heart}. ` +
                    `Health ${character.health}/${character.maxHealth}, Spark ${character.spark}, ` +
                    `milestones ${character.milestones - character.advancesSpent} unspent. ` +
                    `Complication: "${character.complication}". Inventory: ${character.inventory.join(', ') || 'empty'}.`;
            }
            if (topic === 'world') {
                const world = worldService.getWorld(guildId);
                const kinds = Object.keys(world);
                if (kinds.length === 0) return 'The Map Room is blank parchment - no adventure has marked the world yet.';
                return kinds.map(kind =>
                    `${kind}s: ${world[kind].map(entry => `${entry.name} (${entry.content.split('\n')[0].slice(0, 80)})`).join('; ')}`
                ).join('\n');
            }
            return `❌ Unknown topic "${topic}".`;
        }
    },
    tavernParty: {
        definition: {
            name: 'tavernParty',
            description: 'Manage the requesting user\'s adventure party in the CURRENT channel: post a new party for a quest, join the forming party, begin the adventure, leave it, or invite Goobster himself to play as a party member. Posts the party card / opening scene into the channel.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['create', 'join', 'begin', 'leave', 'invite-bot'],
                        description: 'What to do.'
                    },
                    questId: {
                        type: 'string',
                        description: 'Quest id for action="create" (see tavernInfo topic="board"; e.g. "missing-bell-of-brinewatch").'
                    }
                },
                required: ['action']
            }
        },
        execute: async ({ action, questId, interactionContext }) => {
            const guildId = interactionContext?.guildId;
            const channel = interactionContext?.channel;
            const userId = interactionContext?.user?.id;
            if (!guildId || !channel || !userId) return '❌ Adventures need a server text channel and a requesting user.';
            const adventureService = require('../services/tavern/adventureService');
            const { TavernError } = require('../services/tavern/tavernError');
            const views = require('./tavernViews');
            const { buildSceneView } = require('../services/tavern/interactionHandler');
            const botAdventurer = require('../services/tavern/botAdventurer');

            try {
                if (action === 'create') {
                    if (!questId) return '❌ action="create" needs a questId (see tavernInfo topic="board").';
                    const { adventure, quest } = adventureService.createParty({ guildId, channelId: channel.id, questId, userId });
                    await channel.send(views.partyMessage(adventure, quest, adventureService.getMembers(adventure.id)));
                    return `📜 Party posted for "${quest.title}" - the card with Join/Begin buttons is in the channel.`;
                }
                const open = adventureService.getOpenAdventureInChannel(channel.id);
                if (!open) return '❌ No adventure at this table. Use action="create" with a questId first.';
                if (action === 'join') {
                    const { quest, members } = adventureService.join(open.id, userId);
                    return `🍻 The requesting user joined "${quest.title}" (party of ${members.length}).`;
                }
                if (action === 'begin') {
                    const { quest, members } = adventureService.begin(open.id, userId);
                    await channel.send(buildSceneView(open.id, '*The tale begins.*'));
                    botAdventurer.maybeTakeTurn(open.id, channel);
                    return `🗡️ "${quest.title}" begins with a party of ${members.length}! The opening scene is posted in the channel.`;
                }
                if (action === 'leave') {
                    const { remaining, abandoned } = adventureService.leave(open.id, userId);
                    return abandoned
                        ? '👋 The requesting user left, emptying the table - the adventure is shelved.'
                        : `👋 The requesting user left the party; ${remaining} adventurer(s) remain.`;
                }
                if (action === 'invite-bot') {
                    const botId = interactionContext?.client?.user?.id;
                    if (!botId) return '❌ I could not resolve my own account to pull up a chair.';
                    const { quest, members } = adventureService.inviteBot(open.id, userId, botId);
                    return `🍻 Goobster pulls up a chair at the "${quest.title}" table (party of ${members.length}). He plays when the spotlight reaches him.`;
                }
                return `❌ Unknown action "${action}".`;
            } catch (error) {
                if (error instanceof TavernError) return `🍺 ${error.message}`;
                throw error;
            }
        }
    },
    tavernAct: {
        definition: {
            name: 'tavernAct',
            description: 'Take a freeform action for the requesting user in the CURRENT channel\'s active adventure - use this when they describe what their character does in plain words (e.g. "I ram the door with my cooking pot"). The engine rolls the check and posts the outcome to the channel.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        description: 'The player\'s action, in their words (1-300 characters).'
                    }
                },
                required: ['action']
            }
        },
        execute: async ({ action, interactionContext }) => {
            const guildId = interactionContext?.guildId;
            const channel = interactionContext?.channel;
            const userId = interactionContext?.user?.id;
            if (!guildId || !channel || !userId) return '❌ Adventures need a server text channel and a requesting user.';
            const adventureService = require('../services/tavern/adventureService');
            const questLoader = require('../services/tavern/questLoader');
            const narrator = require('../services/tavern/narrator');
            const characterService = require('../services/tavern/characterService');
            const { TavernError } = require('../services/tavern/tavernError');
            const views = require('./tavernViews');
            const { buildSceneView, sendEnding } = require('../services/tavern/interactionHandler');
            const botAdventurer = require('../services/tavern/botAdventurer');

            try {
                const open = adventureService.getOpenAdventureInChannel(channel.id);
                if (!open) return '❌ No adventure at this table right now.';

                let interpretation = null;
                try {
                    const { quest, scene } = adventureService.describe(open.id);
                    const character = characterService.getCharacter(guildId, userId);
                    if (quest && scene && character) {
                        interpretation = await narrator.interpretAction(action, { scene, character }, { guildId, userId });
                    }
                } catch {
                    interpretation = null;
                }

                const result = adventureService.freeform(open.id, userId, action, interpretation);
                try {
                    const { quest, scene } = adventureService.describe(open.id);
                    const narration = await narrator.narrateOutcome({
                        quest, scene: scene || { title: 'the end of the tale', text: '' },
                        character: result.character, actionText: action,
                        stat: result.stat, dc: result.dc, roll: result.roll, total: result.total,
                        success: result.success, happenings: result.happenings
                    }, { guildId, userId });
                    if (narration) result.outcomeText = narration;
                } catch {
                    // keep the stock line
                }

                await channel.send(views.checkResultMessage(result, open.id));
                if (result.ended) {
                    const quest = questLoader.getQuest(result.adventure.questId);
                    await sendEnding(channel, quest, result.ended, guildId);
                } else if (result.sceneChanged) {
                    await channel.send(buildSceneView(open.id));
                }
                botAdventurer.maybeTakeTurn(open.id, channel);

                return `🎲 ${result.character.name} tried "${action}": ` +
                    (result.auto ? 'auto-success (big move).' : `d20(${result.roll}) + ${result.stat} = ${result.total} vs DC ${result.dc} -> ${result.success ? 'SUCCESS' : 'FAILURE'}.`) +
                    (result.happenings.length > 0 ? ` Consequences: ${result.happenings.join('; ')}` : '') +
                    ' The full outcome is posted in the channel.';
            } catch (error) {
                if (error instanceof TavernError) return `🍺 ${error.message}`;
                throw error;
            }
        }
    },
    tavernAttack: {
        definition: {
            name: 'tavernAttack',
            description: 'Attack a foe in the CURRENT channel\'s active adventure encounter, for the requesting user. Use when they say things like "I attack the golem" and the scene has enemies.',
            parameters: {
                type: 'object',
                properties: {
                    enemy: { type: 'string', description: 'The foe\'s name (matched loosely against living enemies).' },
                    stat: { type: 'string', enum: ['might', 'finesse', 'wits', 'heart'], description: 'Optional attack stat (default: their best of might/finesse).' }
                },
                required: ['enemy']
            }
        },
        execute: async ({ enemy, stat, interactionContext }) => {
            const guildId = interactionContext?.guildId;
            const channel = interactionContext?.channel;
            const userId = interactionContext?.user?.id;
            if (!guildId || !channel || !userId) return '❌ Adventures need a server text channel and a requesting user.';
            const adventureService = require('../services/tavern/adventureService');
            const questLoader = require('../services/tavern/questLoader');
            const { TavernError } = require('../services/tavern/tavernError');
            const views = require('./tavernViews');
            const { buildSceneView, sendEnding } = require('../services/tavern/interactionHandler');
            const botAdventurer = require('../services/tavern/botAdventurer');

            try {
                const open = adventureService.getOpenAdventureInChannel(channel.id);
                if (!open) return '❌ No adventure at this table right now.';
                const quest = questLoader.getQuest(open.questId);
                const living = quest ? adventureService.livingEnemies(open, quest) : [];
                if (living.length === 0) return '🍺 Nothing here wants fighting - options and freeform actions still work.';

                const wanted = String(enemy).trim().toLowerCase();
                const target = living.find(e => e.id === wanted)
                    || living.find(e => e.name.toLowerCase().includes(wanted))
                    || living[0];

                const result = adventureService.attack(open.id, userId, target.id, stat);
                await channel.send(views.checkResultMessage(result, open.id));
                if (result.ended) {
                    await sendEnding(channel, questLoader.getQuest(result.adventure.questId), result.ended, guildId);
                } else if (result.sceneChanged) {
                    await channel.send(buildSceneView(open.id));
                }
                botAdventurer.maybeTakeTurn(open.id, channel);

                return `⚔️ ${result.character.name} attacked ${target.name}: ` +
                    (result.auto ? 'auto-hit (big move).' : `d20(${result.roll}) + ${result.stat} = ${result.total} vs defense ${result.dc} -> ${result.success ? 'HIT' : 'MISS'}.`) +
                    (result.happenings.length > 0 ? ` ${result.happenings.join('; ')}` : '');
            } catch (error) {
                if (error instanceof TavernError) return `🍺 ${error.message}`;
                throw error;
            }
        }
    },
    tavernTwist: {
        definition: {
            name: 'tavernTwist',
            description: 'Bend the running adventure\'s storyline: when the party wants the story to go somewhere the campaign didn\'t plan, forge new scenes that honor the idea and tie back into the campaign\'s existing endings. One twist per adventure; the requesting user must be a party member. Takes a while.',
            parameters: {
                type: 'object',
                properties: {
                    twist: { type: 'string', description: 'What the players want to happen instead (1-400 characters).' }
                },
                required: ['twist']
            }
        },
        execute: async ({ twist, interactionContext }) => {
            const guildId = interactionContext?.guildId;
            const channel = interactionContext?.channel;
            const userId = interactionContext?.user?.id;
            if (!guildId || !channel || !userId) return '❌ Adventures need a server text channel and a requesting user.';
            const adventureService = require('../services/tavern/adventureService');
            const campaignForge = require('../services/tavern/campaignForge');
            const { TavernError } = require('../services/tavern/tavernError');
            const { buildSceneView } = require('../services/tavern/interactionHandler');
            const botAdventurer = require('../services/tavern/botAdventurer');
            const db = require('../db');

            try {
                const open = adventureService.getOpenAdventureInChannel(channel.id);
                if (!open || open.status !== 'ACTIVE') return '❌ No adventure in play at this table.';
                if (!adventureService.getMembers(open.id).some(m => m.userId === userId)) {
                    return '🍺 Only party members may bend this story.';
                }
                if (open.state.twistUsed) {
                    return '🍺 This tale has already bent once - one big narrative detour per adventure keeps the spine intact.';
                }

                const { quest, scene } = adventureService.describe(open.id);
                const recentLog = db.all(
                    `SELECT content FROM tavern_adventure_log WHERE adventureId = @id ORDER BY id DESC LIMIT 8`,
                    { id: open.id }
                ).map(row => `- ${row.content}`).reverse().join('\n');

                const { forkQuestId, entrySceneId, note } = await campaignForge.forgeTwist({
                    adventure: open, quest, scene, recentLog, twist, guildId, userId
                });
                adventureService.applyTwist(open.id, forkQuestId, entrySceneId, note);

                await channel.send(`🌀 **The story bends.** ${note}`);
                await channel.send(buildSceneView(open.id));
                botAdventurer.maybeTakeTurn(open.id, channel);
                return `🌀 Twist applied: ${note}. New scenes were forged and the thread still leads back to the campaign's endings. The new scene is posted in the channel.`;
            } catch (error) {
                if (error instanceof TavernError) return `🍺 ${error.message}`;
                throw error;
            }
        }
    },
    tavernRecap: {
        definition: {
            name: 'tavernRecap',
            description: 'Fetch the stored recap of the most recently completed tavern adventure in this channel (or anywhere in the server).',
            parameters: { type: 'object', properties: {} }
        },
        execute: async ({ interactionContext }) => {
            const guildId = interactionContext?.guildId;
            if (!guildId) return '❌ The Tavern only manifests inside servers.';
            const adventureService = require('../services/tavern/adventureService');
            const recap = adventureService.getLatestRecap(guildId, interactionContext?.channel?.id || null)
                || adventureService.getLatestRecap(guildId);
            if (!recap) return 'No tales concluded here yet - the recap book is blank.';
            return recap.content;
        }
    },
    rollDice: {
        definition: {
            name: 'rollDice',
            description: 'Roll dice: either a free expression (e.g. "2d6+1") or a tavern stat check (d20 + the requesting user\'s character stat, optionally vs a difficulty).',
            parameters: {
                type: 'object',
                properties: {
                    expression: { type: 'string', description: 'Dice expression like "d20", "2d6+1", "4d8-2".' },
                    stat: { type: 'string', enum: ['might', 'finesse', 'wits', 'heart'], description: 'Stat check instead of an expression.' },
                    dc: { type: 'integer', description: 'Difficulty to beat for a stat check (10 routine, 13 challenging, 16 difficult, 19 heroic).' }
                }
            }
        },
        execute: async ({ expression, stat, dc, interactionContext }) => {
            if (stat) {
                const guildId = interactionContext?.guildId;
                const userId = interactionContext?.user?.id;
                const characterService = require('../services/tavern/characterService');
                const character = guildId && userId ? characterService.getCharacter(guildId, userId) : null;
                const bonus = character ? character[stat] : 0;
                const roll = 1 + Math.floor(Math.random() * 20);
                const total = roll + bonus;
                let line = `🎲 ${character ? character.name : 'Flat'} ${stat} check: ${roll} + ${bonus} = ${total}`;
                if (Number.isInteger(dc)) line += ` vs DC ${dc} -> ${total >= dc ? 'SUCCESS' : 'FAILURE'}`;
                if (roll === 20) line += ' (natural 20!)';
                if (roll === 1) line += ' (natural 1 - a complication blooms)';
                return line;
            }
            const match = String(expression || '').trim().match(/^(\d*)d(\d+)([+-]\d+)?$/i);
            if (!match) return '❌ Give me a stat check (stat/dc) or an expression like "2d6+1".';
            const count = Math.max(1, Number(match[1] || 1));
            const sides = Number(match[2]);
            const modifier = Number(match[3] || 0);
            if (count > 20 || sides < 2 || sides > 1000) return '❌ Keep it to at most 20 dice with 2-1000 sides.';
            const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
            const total = rolls.reduce((sum, r) => sum + r, 0) + modifier;
            return `🎲 ${expression} -> ${total} (${rolls.join(' + ')}${modifier ? (modifier > 0 ? ` + ${modifier}` : ` - ${Math.abs(modifier)}`) : ''})`;
        }
    },
    manageParlor: {
        definition: {
            name: 'manageParlor',
            description: 'Operate the requesting user\'s Parlor (the multi-persona workspace in Goobster\'s web app at /app). ' +
                'Personas each keep a private tag-first knowledge base of notes; discussions seat up to 4 personas who reply ' +
                'grounded in their own notes. Use this to inspect or build the user\'s parlor on their behalf: list or create/edit ' +
                'personas, explore or add workspace notes, manage discussions, invite a Discord friend into a discussion ' +
                '(action "invite-user" - the friend gets a DM with accept/decline buttons and, once joined, takes part from ' +
                'their own web app), or bootstrap a whole salon from one topic brief (action "quickstart"). Everything acts ' +
                'on the requesting user\'s own parlor; results are visible in the web app. ' +
                'This tool never deletes anything - point the user at the web app for that.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['overview', 'quickstart', 'create-persona', 'update-persona',
                            'list-notes', 'create-note', 'update-note',
                            'create-conversation', 'rename-conversation', 'add-participant', 'remove-participant',
                            'invite-user'],
                        description: 'What to do. "overview" lists personas and discussions; "list-notes" browses or semantically searches one persona\'s workspace; "invite-user" invites a Discord friend into one of the user\'s discussions.'
                    },
                    prompt: { type: 'string', description: 'For "quickstart": what the salon should be about (the concierge designs 2-4 personas with seed notes and opens a discussion).' },
                    personaId: { type: 'integer', description: 'Persona id (from "overview") for persona/note actions.' },
                    personaIds: { type: 'array', items: { type: 'integer' }, description: 'Persona ids for "create-conversation" (1-4 seats).' },
                    conversationId: { type: 'integer', description: 'Discussion id for conversation actions.' },
                    noteId: { type: 'integer', description: 'Note id for "update-note".' },
                    name: { type: 'string', description: 'Persona name (create/update-persona).' },
                    emoji: { type: 'string', description: 'Persona emoji (create/update-persona).' },
                    charter: { type: 'string', description: 'Persona charter - who it is and how it thinks, 2-4 sentences in second person (create/update-persona).' },
                    voice: { type: 'string', description: 'ElevenLabs voice name or id for the persona\'s spoken voice in live parlor sessions (create/update-persona). Empty string clears back to the default voice.' },
                    title: { type: 'string', description: 'Note title (create/update-note) or discussion title (rename-conversation).' },
                    content: { type: 'string', description: 'Note content, 1-3 sentences (create/update-note).' },
                    tags: { type: 'array', items: { type: 'string' }, description: 'Lowercase concept tags for a note - shared tags connect notes (create/update-note).' },
                    query: { type: 'string', description: 'For "list-notes": semantic search query (omit to browse recent notes).' },
                    userId: { type: 'string', description: 'For "invite-user": the Discord user id (snowflake) of the friend to invite. Resolve mentions like <@123> to the bare id.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, prompt, personaId, personaIds, conversationId, noteId,
            name, emoji, charter, voice, title, content, tags, query, userId, interactionContext }) => {
            const ownerId = interactionContext?.user?.id;
            if (!ownerId) return '❌ I could not tell whose parlor to open.';
            const parlorService = require('../services/parlorService');
            const { ParlorError } = require('../services/parlorService');

            const personaLine = (p) =>
                `#${p.id} ${p.emoji ? `${p.emoji} ` : ''}${p.name} (${p.noteCount ?? 0} notes, ${p.tagCount ?? 0} tags)`;
            const noteLine = (n) =>
                `[note #${n.id}] ${n.title}${n.tags?.length > 0 ? ` (tags: ${n.tags.map(t => t.name).join(', ')})` : ''}: ${n.content}`;

            try {
                if (action === 'overview') {
                    const personas = parlorService.listPersonas(ownerId);
                    const conversations = parlorService.listConversations(ownerId);
                    if (personas.length === 0 && conversations.length === 0) {
                        return 'The parlor is empty - no personas or discussions yet. Offer the "quickstart" action (one topic brief sets up a whole salon) or create personas individually.';
                    }
                    return `Personas:\n${personas.map(personaLine).join('\n') || '(none)'}\n\n` +
                        `Discussions:\n${conversations.map(c =>
                            `#${c.id} "${c.title || 'Untitled'}" - ${c.participants.map(p => p.name).join(' + ') || 'no seats'}, ${c.messageCount} messages`
                        ).join('\n') || '(none)'}`;
                }
                if (action === 'quickstart') {
                    if (!prompt) return '❌ "quickstart" needs a prompt describing what the salon should be about.';
                    const result = await parlorService.quickstart({ ownerId, prompt });
                    return `⚡ Salon assembled: discussion #${result.conversation.id} "${result.conversation.title || 'Untitled'}" with ` +
                        `${result.personas.map(p => `${p.emoji ? `${p.emoji} ` : ''}${p.name}`).join(', ')} ` +
                        `(${result.seededNotes} seed notes). The user can open it in the web app's Parlor tab` +
                        (result.opening ? `; a good opening message: "${result.opening}"` : '.');
                }
                // Voice changes resolve against ElevenLabs at save time; a bad
                // name reports back without undoing the rest of the edit.
                const applyVoice = async (persona) => {
                    if (voice === undefined) return '';
                    try {
                        const updated = await parlorService.setPersonaVoice({
                            ownerId, personaId: persona.id, voice
                        });
                        return updated.voiceName
                            ? ` Voice set to "${updated.voiceName}".`
                            : ' Voice cleared back to the default.';
                    } catch (error) {
                        if (error instanceof ParlorError) return ` (Voice not set: ${error.message})`;
                        throw error;
                    }
                };
                if (action === 'create-persona') {
                    const persona = parlorService.createPersona({ ownerId, name, emoji, charter });
                    const voiceNote = await applyVoice(persona);
                    return `✅ Persona ${personaLine(persona)} joined the parlor.${voiceNote} Seed their workspace with "create-note".`;
                }
                if (action === 'update-persona') {
                    if (!personaId) return '❌ "update-persona" needs a personaId (see "overview").';
                    const hasFields = name !== undefined || emoji !== undefined || charter !== undefined;
                    const persona = hasFields
                        ? parlorService.updatePersona({ ownerId, personaId, name, emoji, charter })
                        : parlorService.listPersonas(ownerId).find(p => p.id === Number(personaId));
                    if (!persona) return '🛋️ No such persona.';
                    const voiceNote = await applyVoice(persona);
                    return `✅ Persona updated: ${personaLine(persona)}.${voiceNote}`;
                }
                if (action === 'list-notes') {
                    if (!personaId) return '❌ "list-notes" needs a personaId (see "overview").';
                    if (query) {
                        const results = await parlorService.searchNotes({ ownerId, personaId, query, limit: 8 });
                        return results.length > 0
                            ? `Best matches in this workspace for "${query}":\n${results.map(noteLine).join('\n')}`
                            : `Nothing in this workspace matches "${query}".`;
                    }
                    const notes = parlorService.listNotes({ ownerId, personaId }).slice(0, 15);
                    return notes.length > 0
                        ? `Most recent notes:\n${notes.map(noteLine).join('\n')}`
                        : 'This workspace is empty - seed it with "create-note".';
                }
                if (action === 'create-note') {
                    if (!personaId) return '❌ "create-note" needs a personaId (see "overview").';
                    const note = parlorService.createNote({ ownerId, personaId, title, content, tags: tags || [] });
                    return `✅ Filed ${noteLine(note)}`;
                }
                if (action === 'update-note') {
                    if (!noteId) return '❌ "update-note" needs a noteId (see "list-notes").';
                    const note = parlorService.updateNote({ ownerId, noteId, title, content, tags });
                    return `✅ Updated ${noteLine(note)}`;
                }
                if (action === 'create-conversation') {
                    const conversation = parlorService.createConversation({ ownerId, personaIds: personaIds || [] });
                    return `✅ Discussion #${conversation.id} opened with ${conversation.participants.map(p => p.name).join(' + ')}. ` +
                        'The user talks to it in the web app\'s Parlor tab.';
                }
                if (action === 'rename-conversation') {
                    if (!conversationId) return '❌ "rename-conversation" needs a conversationId (see "overview").';
                    const renamed = parlorService.renameConversation({ ownerId, conversationId, title });
                    return `✅ Discussion #${renamed.id} is now "${renamed.title}".`;
                }
                if (action === 'add-participant' || action === 'remove-participant') {
                    if (!conversationId || !personaId) return `❌ "${action}" needs a conversationId and a personaId.`;
                    const { participants } = parlorService.setParticipant({
                        ownerId, conversationId, personaId, present: action === 'add-participant'
                    });
                    return `✅ Discussion #${conversationId} now seats: ${participants.map(p => p.name).join(' + ') || 'nobody'}.`;
                }
                if (action === 'invite-user') {
                    if (!conversationId || !userId) return '❌ "invite-user" needs a conversationId and the friend\'s Discord userId.';
                    const inviteeId = String(userId).replace(/^<@!?(\d+)>$/, '$1');
                    const { dmSent, inviteeName } = await parlorService.invite({
                        client: interactionContext?.client || null,
                        ownerId,
                        ownerName: interactionContext?.user?.username || null,
                        conversationId,
                        inviteeId
                    });
                    const who = inviteeName || `user ${inviteeId}`;
                    return dmSent
                        ? `✉️ Invitation sent - ${who} got a DM with accept/decline buttons. Once they accept, the discussion shows up in their own web app Parlor tab.`
                        : `✉️ Invitation created for ${who}, but I couldn't DM them (their privacy settings). It still shows in their web app's Parlor tab under Invitations.`;
                }
                return `❌ Unknown action "${action}".`;
            } catch (error) {
                if (error instanceof ParlorError) return `🛋️ ${error.message}`;
                throw error;
            }
        }
    },
    stockQuote: {
        definition: {
            name: 'stockQuote',
            description: 'Look up the current market price of a stock by ticker symbol (e.g. AAPL, TSLA) for the point-powered stock trading game.',
            parameters: {
                type: 'object',
                properties: {
                    symbol: { type: 'string', description: 'Stock ticker symbol, e.g. AAPL' }
                },
                required: ['symbol']
            }
        },
        execute: async ({ symbol }) => {
            const stockService = require('../services/stockService');
            try {
                const quote = await stockService.getQuote(symbol);
                return `📈 ${quote.symbol} (${quote.name}): $${quote.price.toFixed(2)}${quote.currency && quote.currency !== 'USD' ? ` ${quote.currency}` : ''} as of ${quote.asOf} UTC${quote.stale ? ' (stale - price source unavailable)' : ''}.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    tradeStock: {
        definition: {
            name: 'tradeStock',
            description: 'Buy or sell stock units in the point-powered trading game (1 point = $1, prices are live). Selling without units closes the whole position. Defaults to the requesting user\'s wallet; pass owner="bot" to trade with your own (Goobster\'s) wallet, e.g. when asked to invest YOUR points.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['buy', 'sell'], description: 'Trade direction' },
                    symbol: { type: 'string', description: 'Stock ticker symbol, e.g. AAPL' },
                    units: { type: 'number', description: 'How many shares (fractions allowed; omit on sell to sell all)' },
                    owner: {
                        type: 'string',
                        enum: ['user', 'bot'],
                        description: 'Whose wallet trades: "user" (default) = the human you are talking to, "bot" = Goobster\'s own account.'
                    }
                },
                required: ['action', 'symbol']
            }
        },
        execute: async ({ action, symbol, units, owner = 'user', interactionContext }) => {
            const stockPortfolioService = require('../services/stockPortfolioService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            try {
                if (action === 'buy') {
                    if (units === undefined || units === null) return '❌ Say how many units to buy.';
                    const t = await stockPortfolioService.buy({ guildId, userId, symbol, units });
                    return `🛒 Bought ${t.units} ${t.symbol} at $${t.price.toFixed(2)} for ${t.cost.toLocaleString()} points from ${whose} wallet. Balance: ${t.balance.toLocaleString()}.`;
                }
                const t = await stockPortfolioService.sell({ guildId, userId, symbol, units: units ?? null });
                return `💵 Sold ${t.units} ${t.symbol} at $${t.price.toFixed(2)} for ${t.proceeds.toLocaleString()} points into ${whose} wallet. Balance: ${t.balance.toLocaleString()}.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    checkPortfolio: {
        definition: {
            name: 'checkPortfolio',
            description: 'Check in on stock positions: refreshed prices, total value, and profit/loss versus cost. Defaults to the requesting user\'s portfolio; pass owner="bot" for your own (Goobster\'s) portfolio.',
            parameters: {
                type: 'object',
                properties: {
                    owner: {
                        type: 'string',
                        enum: ['user', 'bot'],
                        description: 'Whose portfolio: "user" (default) = the human you are talking to, "bot" = Goobster\'s own account.'
                    }
                }
            }
        },
        execute: async ({ owner = 'user', interactionContext }) => {
            const stockPortfolioService = require('../services/stockPortfolioService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            const { positions, totalValue, totalCost, totalPL } = await stockPortfolioService.getPortfolio({ guildId, userId });
            if (positions.length === 0) return `No stock positions in ${whose} portfolio yet.`;
            const lines = positions.map(p => p.price === null
                ? `${p.symbol}: ${p.units} units (price unavailable)`
                : `${p.symbol}: ${p.units} units @ $${p.price.toFixed(2)} = ${p.value.toFixed(2)} points (${p.profitLoss >= 0 ? '+' : ''}${p.profitLoss.toFixed(2)})`);
            return `💼 Portfolio (${whose}):\n${lines.join('\n')}\nTotal value ${totalValue.toFixed(2)} points on ${totalCost.toLocaleString()} invested (P/L ${totalPL >= 0 ? '+' : ''}${totalPL.toFixed(2)}).`;
        }
    },
    optionChain: {
        definition: {
            name: 'optionChain',
            description: 'Look up option prices for a symbol in the Jimbucks Exchange: either a full chain around the money, or one specific contract with its greeks, break-even, and probabilities. Index tickers like SPX, NDX, and VIX work. Premiums are simulated from the real underlying with Black-Scholes - say so if asked.',
            parameters: {
                type: 'object',
                properties: {
                    symbol: { type: 'string', description: 'Underlying ticker or index, e.g. AAPL or SPX' },
                    expiry: { type: 'string', description: 'Expiry date YYYY-MM-DD. Omit for the nearest expiry, or call with listExpiries=true to see what is tradable.' },
                    optionType: { type: 'string', enum: ['CALL', 'PUT'], description: 'Set with strike to price ONE contract instead of a chain.' },
                    strike: { type: 'number', description: 'Strike price, when pricing one contract.' },
                    listExpiries: { type: 'boolean', description: 'Return the tradable expiry calendar instead of prices.' }
                },
                required: ['symbol']
            }
        },
        execute: async ({ symbol, expiry, optionType, strike, listExpiries, interactionContext }) => {
            const optionsMarket = require('../services/exchange/optionsMarket');
            const guildId = interactionContext?.guildId || null;
            try {
                if (listExpiries) {
                    const expiries = optionsMarket.listExpiries({});
                    return `Tradable expiries: ${expiries.map(entry => `${entry.expiry} (${entry.label})`).join(', ')}. Same-day contracts need Goblin Mode.`;
                }
                if (optionType && strike) {
                    const contract = await optionsMarket.quoteContract({ symbol, optionType, strike, expiry, guildId });
                    return `${contract.underlyingAlias || contract.underlying} ${contract.strike} ${contract.optionType} ${contract.expiry}` +
                        `${contract.zeroDte ? ' (0DTE - expires today)' : ''}: bid $${contract.bid.toFixed(2)} / ask $${contract.ask.toFixed(2)}, ` +
                        `${contract.costPerContract.toLocaleString()} points per contract. Spot $${contract.spot.toFixed(2)}, IV ${(contract.iv * 100).toFixed(1)}%. ` +
                        `Delta ${contract.greeks.delta.toFixed(3)}, gamma ${contract.greeks.gamma.toFixed(5)}, theta ${contract.greeks.theta.toFixed(3)}/day, vega ${contract.greeks.vega.toFixed(3)}. ` +
                        `Break-even $${contract.breakEven.toFixed(2)}, ${(contract.probabilityItm * 100).toFixed(1)}% chance of finishing in the money, ` +
                        `${(contract.probabilityOfProfit * 100).toFixed(1)}% chance of finishing profitable. Max loss is the premium. Premium is simulated (Black-Scholes on the real underlying).`;
                }
                const chain = await optionsMarket.buildChain({ symbol, expiry, depth: 4, guildId });
                const rows = chain.rows.map(row =>
                    `${row.strike}: call $${row.call.ask.toFixed(2)} (Δ${row.call.greeks.delta.toFixed(2)}, ${(row.call.probabilityItm * 100).toFixed(0)}% ITM) / ` +
                    `put $${row.put.ask.toFixed(2)} (Δ${row.put.greeks.delta.toFixed(2)}, ${(row.put.probabilityItm * 100).toFixed(0)}% ITM)`);
                return `${chain.label} chain for ${chain.expiry}${chain.zeroDte ? ' (0DTE)' : ''}, spot $${chain.spot.toFixed(2)} (ask prices, per share; 1 contract = 100 shares):\n` +
                    `${rows.join('\n')}\nOther expiries: ${chain.expiries.map(entry => entry.expiry).join(', ')}.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    tradeOption: {
        definition: {
            name: 'tradeOption',
            description: 'Trade options in the point-powered exchange: buy long calls/puts (max loss = premium), close them, WRITE (sell to open) contracts that collect premium but owe the settlement (needs a margin account; naked calls have unbounded loss - always say so), or buy written ones back. Same-day (0DTE) contracts require Goblin Mode. ALWAYS report the max loss and the odds back to the user.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['buy', 'close', 'write', 'buyback', 'positions'], description: 'buy/close a long; write/buyback a short; positions lists what is held' },
                    symbol: { type: 'string', description: 'Underlying ticker or index, e.g. SPX (required to buy)' },
                    optionType: { type: 'string', enum: ['CALL', 'PUT'] },
                    strike: { type: 'number', description: 'Strike price' },
                    expiry: { type: 'string', description: 'Expiry date YYYY-MM-DD' },
                    contracts: { type: 'number', description: 'How many contracts (100 shares each). Omit on close to close the whole position.' },
                    positionId: { type: 'number', description: 'Position id to close (from the positions list)' },
                    owner: { type: 'string', enum: ['user', 'bot'], description: '"user" (default) = the human you are talking to, "bot" = Goobster\'s own account.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, symbol, optionType, strike, expiry, contracts, positionId, owner = 'user', interactionContext }) => {
            const optionsService = require('../services/exchange/optionsService');
            const accountService = require('../services/exchange/accountService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            try {
                if (action === 'positions') {
                    const snapshot = await accountService.getSnapshot({ guildId, userId });
                    if (snapshot.options.length === 0) return `No open contracts in ${whose} account.`;
                    return snapshot.options.map(option =>
                        `#${option.id}: ${option.side === 'SHORT' ? 'WROTE ' : ''}${option.contracts}x ${option.underlying} ${option.strike} ${option.optionType} ${option.expiry}` +
                        `${option.zeroDte ? ' (0DTE)' : ''}, ${option.side === 'SHORT' ? 'collected' : 'paid'} $${option.openPremium.toFixed(2)}` +
                        `${option.mark === null ? ' (unpriced)' : `, now $${(option.side === 'SHORT' ? option.markAsk : option.mark).toFixed(2)}, P/L ${option.profitLoss >= 0 ? '+' : ''}${Math.round(option.profitLoss).toLocaleString()} points` +
                            `, delta ${option.greeks.delta.toFixed(2)}, ${(option.probabilityItm * 100).toFixed(0)}% ITM odds`}`
                    ).join('\n');
                }
                if (action === 'buy' || action === 'write') {
                    if (!symbol || !optionType || !strike || !expiry || !contracts) {
                        return `❌ To ${action} a contract I need the symbol, call or put, strike, expiry, and how many contracts.`;
                    }
                    if (action === 'write') {
                        const fill = await optionsService.sellToOpen({ guildId, userId, symbol, optionType, strike, expiry, contracts });
                        const { contract } = fill;
                        return `Wrote ${fill.contracts}x ${contract.underlyingAlias || contract.underlying} ${contract.strike} ${contract.optionType} ${contract.expiry}` +
                            `${contract.zeroDte ? ' (0DTE - settles TODAY)' : ''}, collecting ${fill.credit.toLocaleString()} points into ${whose} wallet. ` +
                            `Margin requirement ${Math.ceil(fill.requirement).toLocaleString()}${fill.requirement === 0 ? ' (covered)' : ''}. ` +
                            `Max loss: ${fill.maxLoss === null ? 'UNBOUNDED (naked call - say this out loud)' : `${fill.maxLoss.toLocaleString()} points`}. ` +
                            `At expiry the intrinsic value is paid out of this account (assignment). Position id ${fill.positionId}. Balance ${fill.balance.toLocaleString()}.`;
                    }
                    const fill = await optionsService.buyToOpen({ guildId, userId, symbol, optionType, strike, expiry, contracts });
                    const { contract } = fill;
                    return `Bought ${fill.contracts}x ${contract.underlyingAlias || contract.underlying} ${contract.strike} ${contract.optionType} ${contract.expiry}` +
                        `${contract.zeroDte ? ' (0DTE - expires TODAY)' : ''} at $${contract.ask.toFixed(2)}/share from ${whose} wallet. ` +
                        `Cost ${fill.cost.toLocaleString()} points, which is also the maximum loss. Break-even $${contract.breakEven.toFixed(2)}; ` +
                        `${(contract.probabilityOfProfit * 100).toFixed(1)}% chance of finishing profitable. Position id ${fill.positionId}. Balance ${fill.balance.toLocaleString()}.`;
                }
                if (!positionId) return '❌ Tell me which position id to close (list them with action="positions").';
                if (action === 'buyback') {
                    const close = await optionsService.buyToClose({ guildId, userId, positionId, contracts: contracts ?? null });
                    return `Bought back ${close.contracts}x ${close.contract.underlying} ${close.contract.strike} ${close.contract.optionType} at $${close.contract.ask.toFixed(2)} ` +
                        `for ${close.cost.toLocaleString()} points (realized ${close.realized >= 0 ? '+' : ''}${close.realized.toLocaleString()} vs the premium collected). ` +
                        `Balance ${close.balance.toLocaleString()}.`;
                }
                const close = await optionsService.sellToClose({ guildId, userId, positionId, contracts: contracts ?? null });
                return `Closed ${close.contracts}x ${close.contract.underlying} ${close.contract.strike} ${close.contract.optionType} at $${close.contract.bid.toFixed(2)} ` +
                    `for ${close.proceeds.toLocaleString()} points into ${whose} wallet (realized ${close.realized >= 0 ? '+' : ''}${close.realized.toLocaleString()}). ` +
                    `Balance ${close.balance.toLocaleString()}.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    shortStock: {
        definition: {
            name: 'shortStock',
            description: 'Sell borrowed shares short, or buy them back to cover, in the point-powered exchange. Requires a margin account. A short\'s loss is unbounded - always say so when opening one.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['short', 'cover', 'positions'], description: 'Open a short, cover one, or list them' },
                    symbol: { type: 'string', description: 'Ticker symbol' },
                    units: { type: 'number', description: 'How many shares (omit on cover to close the whole position)' },
                    owner: { type: 'string', enum: ['user', 'bot'], description: '"user" (default) or "bot" for Goobster\'s own account.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, symbol, units, owner = 'user', interactionContext }) => {
            const shortService = require('../services/exchange/shortService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            try {
                if (action === 'positions') {
                    const positions = shortService.listPositions({ guildId, userId });
                    if (positions.length === 0) return `No short positions in ${whose} account.`;
                    return positions.map(position =>
                        `${position.symbol}: short ${position.units} units from $${position.avgPrice.toFixed(2)} ` +
                        `(${position.proceeds.toLocaleString()} points credited)` +
                        `${position.borrowFeeAccrued >= 1 ? `, ${Math.round(position.borrowFeeAccrued)} points of borrow fees owed` : ''}`
                    ).join('\n');
                }
                if (!symbol) return '❌ Which symbol?';
                if (action === 'short') {
                    if (!units) return '❌ Say how many shares to short.';
                    const short = await shortService.openShort({ guildId, userId, symbol, units });
                    return `Shorted ${short.units} ${short.symbol} at $${short.price.toFixed(2)}, crediting ${short.proceeds.toLocaleString()} points to ${whose} wallet. ` +
                        `${short.units} units are now owed back${short.liquidationPrice ? `; the exchange force-covers above $${short.liquidationPrice.toFixed(2)}` : ''}. ` +
                        'The loss on a short is unbounded - the price can keep rising.';
                }
                const cover = await shortService.cover({ guildId, userId, symbol, units: units ?? null });
                return `Covered ${cover.units} ${cover.symbol} at $${cover.price.toFixed(2)} for ${cover.cost.toLocaleString()} points` +
                    `${cover.borrowFee > 0 ? ` plus ${cover.borrowFee.toLocaleString()} of borrow fees` : ''}. ` +
                    `Realized ${cover.realized >= 0 ? '+' : ''}${cover.realized.toLocaleString()}. Balance ${cover.balance.toLocaleString()}.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    marginAccount: {
        definition: {
            name: 'marginAccount',
            description: 'Read or change an exchange account: cash vs margin, leverage tier, Goblin Mode (which unlocks same-day 0DTE contracts), and repaying the margin loan. Changing risk settings requires confirm=true, and you must explain the risk to the user before setting it.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['status', 'set_type', 'set_leverage', 'goblin_on', 'goblin_off', 'repay'],
                        description: 'What to do. "status" is always safe and needs no confirmation.'
                    },
                    accountType: { type: 'string', enum: ['CASH', 'MARGIN'] },
                    leverage: { type: 'number', description: 'Leverage multiple, e.g. 2 for 2x' },
                    points: { type: 'number', description: 'Points to repay (omit to repay as much as possible)' },
                    confirm: { type: 'boolean', description: 'Set true only after the user has explicitly asked for this change and you have explained the risk.' },
                    owner: { type: 'string', enum: ['user', 'bot'], description: '"user" (default) or "bot" for Goobster\'s own account.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, accountType, leverage, points, confirm, owner = 'user', interactionContext }) => {
            const accountService = require('../services/exchange/accountService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            try {
                if (action === 'status') {
                    const snapshot = await accountService.getSnapshot({ guildId, userId });
                    return `${whose} account: ${snapshot.account.accountType}` +
                        `${snapshot.account.accountType === 'MARGIN' ? ` at ${snapshot.account.leverage}x` : ''}` +
                        `${snapshot.account.goblinMode ? ', Goblin Mode ON (0DTE unlocked)' : ''}. ` +
                        `Cash ${Math.round(snapshot.cash).toLocaleString()}, equity ${Math.round(snapshot.equity).toLocaleString()}, ` +
                        `buying power ${Math.round(snapshot.buyingPower).toLocaleString()}, debt ${Math.round(snapshot.debt).toLocaleString()}, ` +
                        `maintenance requirement ${Math.round(snapshot.maintenance).toLocaleString()}.` +
                        `${snapshot.marginCall ? ' *** UNDER MARGIN CALL ***' : ''}` +
                        `${snapshot.marginMove && snapshot.marginMove.drop > 0 ? ` A ${(snapshot.marginMove.drop * 100).toFixed(1)}% adverse move triggers a margin call.` : ''}`;
                }

                if (!confirm) {
                    return '❌ That changes how much risk this account can take. Explain the consequences to the user, get an explicit yes, then call again with confirm=true.';
                }
                if (action === 'set_type') {
                    const updated = accountService.setAccountType({ guildId, userId, accountType: accountType || 'MARGIN' });
                    return `${whose} account is now a ${updated.accountType} account${updated.accountType === 'MARGIN' ? ` at ${updated.leverage}x` : ''}.`;
                }
                if (action === 'set_leverage') {
                    const updated = accountService.setLeverage({ guildId, userId, leverage });
                    return `Leverage set to ${updated.leverage}x on ${whose} account. Losses scale with it too.`;
                }
                if (action === 'goblin_on' || action === 'goblin_off') {
                    const enabled = action === 'goblin_on';
                    accountService.setGoblinMode({ guildId, userId, enabled });
                    return enabled
                        ? `Goblin Mode is ON for ${whose} account: same-day (0DTE) contracts are unlocked. Their most likely value at the bell is zero.`
                        : `Goblin Mode is OFF for ${whose} account. Same-day contracts are locked again; open positions are untouched.`;
                }
                const repaid = accountService.repay({ guildId, userId, amount: points ?? null });
                return `Repaid ${repaid.repaid.toLocaleString()} points. Loan remaining ${repaid.loan.toLocaleString()}, balance ${repaid.balance.toLocaleString()}.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    exchangeOrder: {
        definition: {
            name: 'exchangeOrder',
            description: 'Place, list, or cancel a resting order (limit, stop, stop-limit, trailing stop) in the point-powered exchange. Orders fill when the risk engine next checks prices, so a stop is a trigger and not a guaranteed price.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['place', 'list', 'cancel'] },
                    symbol: { type: 'string', description: 'Ticker symbol' },
                    side: { type: 'string', enum: ['BUY', 'SELL', 'SHORT', 'COVER'], description: 'What the fill does' },
                    orderType: { type: 'string', enum: ['LIMIT', 'STOP', 'STOP_LIMIT', 'TRAILING_STOP'] },
                    units: { type: 'number', description: 'How many shares' },
                    limitPrice: { type: 'number' },
                    stopPrice: { type: 'number' },
                    trailPercent: { type: 'number', description: 'Trail distance in percent, for trailing stops' },
                    orderId: { type: 'number', description: 'Order id to cancel' },
                    owner: { type: 'string', enum: ['user', 'bot'], description: '"user" (default) or "bot" for Goobster\'s own account.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, symbol, side, orderType, units, limitPrice, stopPrice, trailPercent, orderId, owner = 'user', interactionContext }) => {
            const orderService = require('../services/exchange/orderService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            try {
                if (action === 'list') {
                    const orders = orderService.list({ guildId, userId, status: 'working' });
                    if (orders.length === 0) return `No working orders in ${whose} account.`;
                    return orders.map(order =>
                        `#${order.id}: ${order.side} ${order.units} ${order.symbol} ${order.orderType}` +
                        `${order.limitPrice ? ` limit $${order.limitPrice}` : ''}${order.stopPrice ? ` stop $${order.stopPrice}` : ''}` +
                        `${order.trailPercent ? ` trailing ${order.trailPercent}%` : ''} [${order.status}]`
                    ).join('\n');
                }
                if (action === 'cancel') {
                    if (!orderId) return '❌ Which order id should I cancel?';
                    const order = orderService.cancel({ guildId, userId, id: orderId });
                    return `Cancelled order #${order.id} (${order.side} ${order.units} ${order.symbol}).`;
                }
                const placed = await orderService.place({
                    guildId, userId, symbol, side, orderType, units, limitPrice, stopPrice, trailPercent
                });
                return `Order #${placed.order.id} is resting: ${placed.order.side} ${placed.order.units} ${placed.order.symbol} - ${placed.triggerHint}. ` +
                    `The price right now is $${placed.referencePrice.toFixed(2)}. Nothing is reserved until it fills.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    eventContracts: {
        definition: {
            name: 'eventContracts',
            description: 'Binary event contracts in the exchange ("Will AAPL close above $250 on Friday?"). Each pays 100 points if its side is right and nothing if it is wrong; they settle automatically from the real price at the resolution time. Use this to list markets, buy a side, or show what someone holds.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['markets', 'buy', 'positions'] },
                    marketId: { type: 'number', description: 'Which market to trade' },
                    side: { type: 'string', enum: ['YES', 'NO'] },
                    contracts: { type: 'number', description: 'How many contracts' },
                    owner: { type: 'string', enum: ['user', 'bot'], description: '"user" (default) or "bot" for Goobster\'s own account.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, marketId, side, contracts, owner = 'user', interactionContext }) => {
            const predictionService = require('../services/exchange/predictionService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            try {
                if (action === 'markets') {
                    const markets = predictionService.listMarkets({ guildId, status: 'OPEN' });
                    if (markets.length === 0) return 'No open event markets. An admin can open one with /predict create.';
                    const lines = [];
                    for (const market of markets) {
                        try {
                            const pricing = await predictionService.quote({ market });
                            lines.push(`#${market.id} ${market.question} - YES ${pricing.yesPrice} / NO ${pricing.noPrice} points, ` +
                                `${market.symbol} at $${pricing.spot.toFixed(2)}, resolves ${market.resolvesAt} UTC`);
                        } catch {
                            lines.push(`#${market.id} ${market.question} - price unavailable, resolves ${market.resolvesAt} UTC`);
                        }
                    }
                    return lines.join('\n');
                }
                if (action === 'positions') {
                    const positions = predictionService.listPositions({ guildId, userId, status: 'all' });
                    if (positions.length === 0) return `No event contracts in ${whose} account.`;
                    return positions.map(position =>
                        `#${position.marketId} ${position.side} x${position.contracts} at ${Math.round(position.avgPrice)} - ${position.question}` +
                        `${position.status === 'SETTLED' ? ` [settled ${position.outcome}, paid ${Number(position.payout || 0).toLocaleString()}]` : ' [open]'}`
                    ).join('\n');
                }
                if (!marketId || !side || !contracts) return '❌ I need the market id, the side (YES or NO), and how many contracts.';
                const fill = await predictionService.buy({ guildId, userId, marketId, side, contracts });
                return `Bought ${fill.contracts}x ${fill.side} on "${fill.market.question}" at ${fill.price} points each ` +
                    `(${fill.cost.toLocaleString()} total) from ${whose} wallet. Pays ${fill.maxPayout.toLocaleString()} if right, 0 if wrong. ` +
                    `Implied odds ${(fill.pricing.probability * 100).toFixed(1)}% YES. Balance ${fill.balance.toLocaleString()}.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    tradeSpread: {
        definition: {
            name: 'tradeSpread',
            description: 'Quote or execute a multi-leg option spread (vertical, straddle, strangle, butterfly, iron condor, inverse iron condor) on one underlying. ALWAYS quote first (fire=false, the default) and read the pre-trade receipt back to the user - net debit/credit, max gain/loss, break-evens, collateral - then execute with fire=true only after they confirm.',
            parameters: {
                type: 'object',
                properties: {
                    symbol: { type: 'string', description: 'Underlying ticker, e.g. SPCX' },
                    legs: { type: 'string', description: 'Compact leg list, e.g. "buy 100p, sell 76p, buy 130c, sell 155c" (add x2 for 2 contracts on a leg)' },
                    expiry: { type: 'string', description: 'Expiry date YYYY-MM-DD applied to every leg' },
                    contracts: { type: 'number', description: 'Contracts per leg (default 1)' },
                    fire: { type: 'boolean', description: 'false (default) = receipt only; true = execute after the user confirmed' },
                    owner: { type: 'string', enum: ['user', 'bot'], description: '"user" (default) or "bot" for Goobster\'s own account.' }
                },
                required: ['symbol', 'legs', 'expiry']
            }
        },
        execute: async ({ symbol, legs, expiry, contracts = 1, fire = false, owner = 'user', interactionContext }) => {
            const spreadService = require('../services/exchange/spreadService');
            const { parseLegText } = require('../services/exchange/spreadService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            try {
                const parsed = parseLegText(legs, { expiry, contracts });
                const describe = receipt => {
                    const legLines = receipt.legs.map(leg =>
                        `${leg.action} ${leg.contracts}x ${leg.strike} ${leg.optionType} @ $${leg.premium.toFixed(2)}${leg.zeroDte ? ' (0DTE)' : ''}`);
                    return `${receipt.structure} on ${receipt.label}, spot $${receipt.spot.toFixed(2)} (simulated premiums, priced ${receipt.pricedAt} UTC):\n` +
                        `${legLines.join('\n')}\n` +
                        `Net ${Math.abs(receipt.netPoints).toLocaleString()} points ${receipt.netLabel}. ` +
                        `Max gain ${receipt.unboundedGain ? 'unbounded' : receipt.maxGain.toLocaleString()}, ` +
                        `max loss ${receipt.unboundedLoss ? 'UNBOUNDED' : Math.abs(receipt.maxLoss).toLocaleString()}, ` +
                        `break-even${receipt.breakEvens.length === 1 ? '' : 's'} ${receipt.breakEvens.map(be => `$${be}`).join(' and ') || 'none'}. ` +
                        `Collateral required ${receipt.collateralRequired.toLocaleString()}${receipt.needsMarginAccount ? ' (margin account needed)' : ''}.` +
                        `${receipt.zeroDte ? ' At least one leg expires TODAY and is most likely worth 0 at the bell.' : ''}`;
                };

                if (!fire) {
                    const receipt = await spreadService.quote({ guildId, symbol, legs: parsed });
                    return `PRE-TRADE RECEIPT (nothing executed):\n${describe(receipt)}\nRead this back to the user; execute with fire=true only after an explicit yes.`;
                }
                const result = await spreadService.execute({ guildId, userId, symbol, legs: parsed });
                return `🔥 FIRED for ${whose} account:\n${describe(result.receipt)}\n` +
                    `Positions: ${result.fills.map(f => `#${f.positionId} (${f.action} ${f.contracts}x ${f.strike} ${f.optionType})`).join(', ')}. ` +
                    `Balance ${result.balance.toLocaleString()}.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    tradePerp: {
        definition: {
            name: 'tradePerp',
            description: 'Perpetual futures: open or close leveraged long/short contracts on any USD symbol including crypto (BTC-USD, ETH-USD). Isolated margin - the posted margin is the maximum loss. Always report the liquidation price back to the user when opening.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['open', 'close', 'positions'] },
                    symbol: { type: 'string', description: 'Ticker, e.g. BTC-USD' },
                    direction: { type: 'string', enum: ['LONG', 'SHORT'] },
                    margin: { type: 'number', description: 'Points to post as margin' },
                    leverage: { type: 'number', description: 'e.g. 5 for 5x' },
                    positionId: { type: 'number', description: 'Which perp to close' },
                    owner: { type: 'string', enum: ['user', 'bot'], description: '"user" (default) or "bot" for Goobster\'s own account.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, symbol, direction, margin, leverage, positionId, owner = 'user', interactionContext }) => {
            const perpsService = require('../services/exchange/perpsService');
            const account = resolveEconomyAccount(interactionContext, owner);
            if (account.error) return account.error;
            const { guildId, userId, whose } = account;

            try {
                if (action === 'positions') {
                    const accountService = require('../services/exchange/accountService');
                    const snapshot = await accountService.getSnapshot({ guildId, userId });
                    if (snapshot.perps.length === 0) return `No open perps in ${whose} account.`;
                    return snapshot.perps.map(perp =>
                        `#${perp.id}: ${perp.direction} ${perp.symbol} ${perp.leverage}x, entry $${perp.entryPrice.toFixed(2)}` +
                        `${perp.priced ? `, now $${perp.price.toFixed(2)}, P/L ${perp.unrealized >= 0 ? '+' : ''}${Math.round(perp.unrealized).toLocaleString()}` : ' (unpriced)'}` +
                        `, margin ${perp.margin.toLocaleString()}, liquidates at $${perp.liquidationPrice.toFixed(2)}`
                    ).join('\n');
                }
                if (action === 'open') {
                    if (!symbol || !direction || !margin || !leverage) {
                        return '❌ To open a perp I need the symbol, direction (LONG/SHORT), margin in points, and leverage.';
                    }
                    const position = await perpsService.open({ guildId, userId, symbol, direction, margin, leverage });
                    return `Opened ${position.direction} perp #${position.id} on ${position.alias || position.symbol} at ${position.leverage}x: ` +
                        `entry $${position.entryPrice.toFixed(2)}, notional ${position.notional.toLocaleString()} points on ${position.margin.toLocaleString()} of margin. ` +
                        `LIQUIDATION at $${position.liquidationPrice.toFixed(2)} - crossing it forfeits the margin. ` +
                        `Funding ${(position.fundingRateDaily * 100).toFixed(3)}%/day. Max loss: the ${position.margin.toLocaleString()}-point margin (isolated). Balance ${position.balance.toLocaleString()}.`;
                }
                if (!positionId) return '❌ Which perp id should I close? (list them with action="positions")';
                const result = await perpsService.close({ guildId, userId, id: positionId });
                return `Closed perp #${positionId} (${result.position.direction} ${result.position.symbol}) at $${result.exitPrice.toFixed(2)}: ` +
                    `${result.payout.toLocaleString()} points returned (realized ${result.realized >= 0 ? '+' : ''}${result.realized.toLocaleString()}). Balance updated.`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    goblinWheel: {
        definition: {
            name: 'goblinWheel',
            description: "The Ballistic Goblin Wheel: the guild's group call-buying ritual. Manage opt-ins (join/leave, personal allocation caps), check who rides the next spin, or SPIN both wheels and deploy every participant's wallet. Spinning needs Manage Server AND confirm=true after you explained what it does. Opt-outs always win over the server-wide override.",
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['status', 'optin', 'optout', 'participants', 'spin'] },
                    maxPercent: { type: 'number', description: 'For optin: personal cap on how much of the wallet one spin may deploy (1-100)' },
                    symbol: { type: 'string', description: 'For spin: the underlying (default SPX)' },
                    confirm: { type: 'boolean', description: 'Required true for spin, after the user explicitly asked for it.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, maxPercent, symbol, confirm, interactionContext }) => {
            const groupPlayService = require('../services/exchange/groupPlayService');
            const wheelService = require('../services/exchange/wheelService');
            const guildId = interactionContext?.guildId;
            const userId = interactionContext?.user?.id;
            if (!guildId) return '❌ The Wheel only spins in servers.';

            try {
                if (action === 'status') {
                    const summary = groupPlayService.summarize(guildId);
                    const mine = userId ? groupPlayService.effectiveOptIn(guildId, userId) : null;
                    return `Wheel status: override-all ${summary.optInOverride ? 'ON (everyone with a wallet is in unless they opted out)' : 'off (explicit opt-ins only)'}; ` +
                        `${summary.explicitOptIns} explicit opt-in(s), ${summary.explicitOptOuts} opt-out(s), ${summary.participants} riding the next spin.` +
                        `${mine ? ` The requesting user is ${mine.optedIn ? 'IN' : 'OUT'} (${mine.source}${mine.maxAllocationPercent ? `, cap ${mine.maxAllocationPercent}%` : ''}).` : ''}`;
                }
                if (action === 'optin' || action === 'optout') {
                    if (!userId) return '❌ I could not tell whose opt-in to change.';
                    const state = groupPlayService.setOptIn({
                        guildId, userId, optedIn: action === 'optin', maxAllocationPercent: maxPercent ?? null
                    });
                    return action === 'optin'
                        ? `Opted in.${state.maxAllocationPercent ? ` Personal cap: ${state.maxAllocationPercent}% per spin.` : ''} They ride the next spin.`
                        : 'Opted out. No spin touches their wallet until they opt back in - the override cannot overrule this.';
                }
                if (action === 'participants') {
                    const participants = groupPlayService.listParticipants({ guildId });
                    if (participants.length === 0) return 'Nobody is riding the Wheel.';
                    return `${participants.length} member(s) ride the next spin: ` +
                        participants.map(p => `<@${p.userId}>${p.maxAllocationPercent ? ` (cap ${p.maxAllocationPercent}%)` : ''}`).join(', ');
                }

                // Spinning deploys other people's wallets: permission + confirm
                const hasManage = interactionContext?.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)
                    || interactionContext?.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);
                if (!hasManage) return '❌ Spinning the Wheel deploys every participant\'s wallet - it needs the Manage Server permission (use /wheel spin).';
                if (!confirm) {
                    return '❌ Spinning deploys a wheel-chosen percentage of EVERY participant\'s wallet into wheel-chosen calls. Explain that, get an explicit yes, then call again with confirm=true.';
                }
                const result = await wheelService.spin({ guildId, symbol: symbol || 'SPX' });
                const deployed = result.deployments.filter(d => !d.skipped);
                return `🎡 THE WHEEL HAS SPOKEN. Wheel 1 rolled ${result.strikeSpin.roll}/100 → +${result.strikeSpin.targetPercent}% target; ` +
                    `Wheel 2 rolled ${result.allocationSpin.roll}/100 → ${result.allocationSpin.percent}% of every wallet.\n` +
                    `Coordinates: ${result.label} ${result.strike} CALL ${result.expiry}${result.zeroDte ? ' (0DTE - most likely worth 0 at the bell)' : ''} ` +
                    `at $${result.premium.toFixed(2)}/share (${(result.probabilityItm * 100).toFixed(1)}% ITM odds).\n` +
                    `Deployed for ${deployed.length} of ${result.participants} riders: ${result.totalContracts} contracts, ${result.totalPoints.toLocaleString()} points total.` +
                    `${result.deployments.filter(d => d.skipped).length > 0 ? ` Skipped: ${result.deployments.filter(d => d.skipped).map(d => `<@${d.userId}> (${d.reason})`).slice(0, 5).join('; ')}.` : ''}`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    auditAccount: {
        definition: {
            name: 'auditAccount',
            description: "Audit any server member's exchange account end to end: every stock, short, option (with live greeks), resting order, and event contract, plus equity, leverage, buying power, debt, margin-call distance, liquidation levels, realized P/L, and whether their wallet reconciles with the ledger. Use this whenever someone asks how an account is doing, what somebody holds, or how much trouble they are in. Read-only.",
            parameters: {
                type: 'object',
                properties: {
                    user: {
                        type: 'string',
                        description: 'Who to audit: a mention, a user id, a username, or a display name. Omit for the person you are talking to; use "you" for Goobster\'s own account.'
                    }
                }
            }
        },
        execute: async ({ user, interactionContext }) => {
            const auditService = require('../services/exchange/auditService');
            const target = await resolveGuildMember(interactionContext, user);
            if (target.error) return target.error;
            try {
                const audit = await auditService.auditAccount({ guildId: target.guildId, userId: target.userId });
                return auditService.renderAccountAudit(audit, { label: target.label });
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    auditExchange: {
        definition: {
            name: 'auditExchange',
            description: "Audit the whole server's exchange: money supply, outstanding loans, who is on margin or in Goblin Mode, the most-held and most-shorted symbols, option open interest (including what expires today), working orders, event markets, the equity leaderboard, concentration, and what the risk engine has been doing. Can also run integrity checks that prove the books add up. Read-only.",
            parameters: {
                type: 'object',
                properties: {
                    view: {
                        type: 'string',
                        enum: ['overview', 'leaderboard', 'events', 'reconcile'],
                        description: 'overview = the market dashboard (default), leaderboard = traders by equity, events = the risk engine log, reconcile = integrity checks.'
                    },
                    user: { type: 'string', description: 'For the events view: limit the log to one member (mention, id, or name).' },
                    limit: { type: 'number', description: 'How many rows for the leaderboard or event log (default 10).' }
                }
            }
        },
        execute: async ({ view = 'overview', user, limit = 10, interactionContext }) => {
            const auditService = require('../services/exchange/auditService');
            const exchangeEvents = require('../services/exchange/exchangeEvents');
            const guildId = interactionContext?.guildId;
            if (!guildId) return '❌ The exchange only exists inside servers.';

            /** Best-effort display names so the audit reads like people, not snowflakes. */
            const nameFor = async userId => {
                try {
                    const guild = interactionContext.guild;
                    const member = guild?.members?.cache?.get(userId) || await guild?.members?.fetch(userId);
                    return member?.displayName || member?.user?.username || userId;
                } catch {
                    return userId;
                }
            };

            try {
                if (view === 'leaderboard') {
                    const board = await auditService.leaderboard({ guildId, limit: Math.min(25, Number(limit) || 10) });
                    if (board.length === 0) return 'Nobody is trading on the exchange yet.';
                    const lines = [];
                    for (const [index, trader] of board.entries()) {
                        lines.push(`${index + 1}. ${await nameFor(trader.userId)}: equity ${Math.round(trader.equity).toLocaleString()} points ` +
                            `(cash ${Math.round(trader.cash).toLocaleString()}, exposure ${Math.round(trader.exposure).toLocaleString()}` +
                            `${trader.debt > 0 ? `, debt ${Math.round(trader.debt).toLocaleString()}` : ''})` +
                            `${trader.accountType === 'MARGIN' ? ` on ${trader.leverage}x margin` : ''}` +
                            `${trader.goblinMode ? ', goblin mode' : ''}${trader.marginCall ? ', UNDER MARGIN CALL' : ''}`);
                    }
                    return `Exchange leaderboard by equity (wallet + positions - debt):\n${lines.join('\n')}`;
                }

                if (view === 'events') {
                    const target = user ? await resolveGuildMember(interactionContext, user) : null;
                    if (target?.error) return target.error;
                    const events = exchangeEvents.list({
                        guildId, userId: target?.userId || null, limit: Math.min(25, Number(limit) || 10)
                    });
                    if (events.length === 0) return 'The risk engine has not done anything in this server yet.';
                    const lines = [];
                    for (const event of events) {
                        lines.push(`${event.createdAt} ${event.eventType}${event.symbol ? ` ${event.symbol}` : ''}` +
                            `${event.userId ? ` (${await nameFor(event.userId)})` : ''}` +
                            `${event.amount === null ? '' : ` ${event.amount >= 0 ? '+' : ''}${event.amount.toLocaleString()} points`}` +
                            `${event.detail ? ` ${JSON.stringify(event.detail)}` : ''}`);
                    }
                    return `Exchange event log${target ? ` for ${target.label}` : ''}:\n${lines.join('\n')}`;
                }

                if (view === 'reconcile') {
                    const report = auditService.reconcile({ guildId });
                    const lines = report.checks.map(check =>
                        `${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.description}` +
                        `${check.ok ? '' : ` -> ${check.count} problem(s), e.g. ${JSON.stringify(check.sample[0])}`}`);
                    return `${report.ok ? 'The books add up - every check passed.' : 'Reconciliation found problems.'}\n${lines.join('\n')}`;
                }

                const audit = await auditService.auditGuild({ guildId });
                const names = new Map();
                for (const trader of audit.traders.slice(0, 5)) names.set(trader.userId, await nameFor(trader.userId));
                return auditService.renderGuildAudit(audit, { names });
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    scheduleFollowUp: {
        definition: {
            name: 'scheduleFollowUp',
            description: 'Schedule a one-time follow-up so you can circle back later, e.g. when a user mentions a deadline, plan, or event ("I\'ll deploy it tomorrow"). You will post in this channel at the scheduled time.',
            parameters: {
                type: 'object',
                properties: {
                    note: { type: 'string', description: 'What to follow up about, e.g. "Ask Rob how the deploy went".' },
                    when: { type: 'string', description: 'When to follow up, in natural language, e.g. "tomorrow at 3pm" or "in 2 hours".' }
                },
                required: ['note', 'when']
            }
        },
        execute: async ({ note, when, interactionContext }) => {
            const followupService = require('../services/followupService');
            const guildId = interactionContext?.guildId;
            const channelId = interactionContext?.channel?.id || interactionContext?.channelId;
            if (!guildId || !channelId) return '❌ Follow-ups can only be scheduled inside a server channel.';

            try {
                const { dueAt } = await followupService.schedule({
                    guildId,
                    channelId,
                    userId: interactionContext.user?.id || null,
                    note,
                    whenDescription: when
                });
                return `⏰ Follow-up scheduled for ${dueAt} UTC: "${note}"`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    searchGithubCode: {
        definition: {
            name: 'searchGithubCode',
            description: 'Search code in a GitHub repository. In a server: repos the server watches (via /github watch). In DMs or the web portal: any repo the user\'s connected GitHub account can read (connected in the web portal\'s Integrations dialog). Returns matching file paths.',
            parameters: {
                type: 'object',
                properties: {
                    repo: { type: 'string', description: 'Repository as owner/name, e.g. "nervous-rob/goobster".' },
                    query: { type: 'string', description: 'Code search query (keywords, symbol names).' }
                },
                required: ['repo', 'query']
            }
        },
        execute: async ({ repo, query, interactionContext }) => {
            const githubService = require('../services/githubService');
            try {
                const { service, parsed, error } = resolveGithubAccess(interactionContext, githubService, repo);
                if (error) return error;
                const results = await service.searchCode(parsed, query);
                if (!results.length) return `No code matches for "${query}" in ${parsed}.`;
                return `Code matches in ${parsed}:\n` + results.map(item => `- ${item.path} (${item.url})`).join('\n');
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    readGithubFile: {
        definition: {
            name: 'readGithubFile',
            description: 'Read a file from a GitHub repository. In a server: repos the server watches (via /github watch). In DMs or the web portal: any repo the user\'s connected GitHub account can read (connected in the web portal\'s Integrations dialog).',
            parameters: {
                type: 'object',
                properties: {
                    repo: { type: 'string', description: 'Repository as owner/name.' },
                    path: { type: 'string', description: 'File path within the repo, e.g. "src/index.js".' },
                    ref: { type: 'string', description: 'Optional branch, tag, or commit SHA (default branch when omitted).' }
                },
                required: ['repo', 'path']
            }
        },
        execute: async ({ repo, path: filePath, ref, interactionContext }) => {
            const githubService = require('../services/githubService');
            try {
                const { service, parsed, error } = resolveGithubAccess(interactionContext, githubService, repo);
                if (error) return error;
                const file = await service.getFileContent(parsed, filePath, { ref: ref || null });
                // Cap what goes back into the prompt; the size limit in the
                // service bounds the fetch itself.
                const body = file.content.length > 12_000 ? `${file.content.slice(0, 12_000)}\n…(truncated)` : file.content;
                return `${parsed}:${file.path}${file.ref ? `@${file.ref}` : ''} (${file.size} bytes)\n\n${body}`;
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    searchNotion: {
        definition: {
            name: 'searchNotion',
            description: 'Search the user\'s Notion workspace (pages and databases shared with their connected integration). Personal integration: only available in DMs and the web portal, after the user connects Notion in the web portal\'s Integrations dialog. Use it whenever the user references their notes, docs, or workspace.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search terms (page titles and content).' }
                },
                required: ['query']
            }
        },
        execute: async ({ query, interactionContext }) => {
            const notionService = require('../services/notionService');
            const { token, error } = resolveNotionAccess(interactionContext);
            if (error) return error;
            try {
                const results = await notionService.search(token, query);
                if (!results.length) return `No Notion matches for "${query}" (pages must be shared with the integration).`;
                return 'Notion matches:\n' + results.map(item =>
                    `- [${item.kind}] ${item.title} (id: ${item.id})${item.lastEdited ? ` last edited ${item.lastEdited}` : ''}`
                ).join('\n');
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    readNotionPage: {
        definition: {
            name: 'readNotionPage',
            description: 'Read the content of one Notion page (title + body as text) from the user\'s connected workspace. Personal integration: only available in DMs and the web portal. Pass a page id or URL, usually from a searchNotion result.',
            parameters: {
                type: 'object',
                properties: {
                    page: { type: 'string', description: 'Notion page id (UUID) or page URL.' }
                },
                required: ['page']
            }
        },
        execute: async ({ page, interactionContext }) => {
            const notionService = require('../services/notionService');
            const { token, error } = resolveNotionAccess(interactionContext);
            if (error) return error;
            try {
                const result = await notionService.getPageText(token, page);
                return `# ${result.title}${result.url ? `\n${result.url}` : ''}\n\n${result.content || '(empty page)'}` +
                    (result.truncated ? '\n…(truncated)' : '');
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    launchCursorAgent: {
        definition: {
            name: 'launchCursorAgent',
            description: 'Propose launching a Cursor cloud coding agent against a GitHub repo this server watches. Posts a confirmation button — a member with Manage Server must confirm before anything runs. Use when a user asks you to implement, fix, or investigate something in a repo.',
            parameters: {
                type: 'object',
                properties: {
                    repo: { type: 'string', description: 'Repository as owner/name.' },
                    prompt: { type: 'string', description: 'Clear task instructions for the coding agent (what to build/fix, relevant context).' },
                    branch: { type: 'string', description: 'Optional starting branch (default branch when omitted).' }
                },
                required: ['repo', 'prompt']
            }
        },
        execute: async ({ repo, prompt, branch, interactionContext }) => {
            const githubService = require('../services/githubService');
            const repoWatchService = require('../services/repoWatchService');
            const cursorAgentService = require('../services/cursorAgentService');
            const integrationActionService = require('../services/integrationActionService');

            const guildId = interactionContext?.guildId || interactionContext?.guild?.id;
            const channel = interactionContext?.channel;
            if (!guildId || !channel) return '❌ Agents can only be launched from a server channel.';
            if (!cursorAgentService.isConfigured()) return '❌ The Cursor integration is not configured (CURSOR_API_KEY).';

            try {
                const parsed = githubService.parseRepo(repo);
                if (!repoWatchService.isRepoAllowed(guildId, parsed)) {
                    return `❌ ${parsed} isn't allowlisted in this server. An admin must run /github watch first.`;
                }
                const { message } = integrationActionService.createPending({
                    type: 'agent-launch',
                    guildId,
                    channelId: channel.id,
                    requestedBy: interactionContext.user?.id || null,
                    payload: { repo: parsed, prompt, branch: branch || null }
                });
                await channel.send(message);
                return '🟡 I proposed the agent launch — a member with Manage Server needs to press Confirm on the message I just posted.';
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    createGithubIssue: {
        definition: {
            name: 'createGithubIssue',
            description: 'Propose filing a GitHub issue on a repo this server watches, e.g. when a user reports a bug or requests a feature. Posts a confirmation button — a member with Manage Server must confirm before the issue is created. Write a clear title and a body that captures the conversation context.',
            parameters: {
                type: 'object',
                properties: {
                    repo: { type: 'string', description: 'Repository as owner/name.' },
                    title: { type: 'string', description: 'Concise issue title.' },
                    body: { type: 'string', description: 'Issue body: what happened, expected behavior, reproduction details from the conversation.' }
                },
                required: ['repo', 'title']
            }
        },
        execute: async ({ repo, title, body, interactionContext }) => {
            const githubService = require('../services/githubService');
            const repoWatchService = require('../services/repoWatchService');
            const integrationActionService = require('../services/integrationActionService');

            const guildId = interactionContext?.guildId || interactionContext?.guild?.id;
            const channel = interactionContext?.channel;
            if (!guildId || !channel) return '❌ Issues can only be filed from a server channel.';
            if (!githubService.hasToken()) return '❌ Creating issues needs a GITHUB_TOKEN with Issues write access.';

            try {
                const parsed = githubService.parseRepo(repo);
                if (!repoWatchService.isRepoAllowed(guildId, parsed)) {
                    return `❌ ${parsed} isn't allowlisted in this server. An admin must run /github watch first.`;
                }
                const { message } = integrationActionService.createPending({
                    type: 'github-issue',
                    guildId,
                    channelId: channel.id,
                    requestedBy: interactionContext.user?.id || null,
                    payload: { repo: parsed, title, body: body || '' }
                });
                await channel.send(message);
                return '🟡 I drafted the issue — a member with Manage Server needs to press Confirm on the message I just posted.';
            } catch (error) {
                return `❌ ${error.message}`;
            }
        }
    },
    executePlan: {
        definition: {
            name: 'executePlan',
            description: 'Execute a dynamic plan where each step can access previous results and modify future steps.',
            parameters: {
                type: 'object',
                properties: {
                    plan: {
                        type: 'array',
                        description: 'Array of commands to execute. Steps can use ${stepN.fieldName} to reference results from previous steps.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: 'Tool name to execute' },
                                args: { type: 'object', description: 'Arguments for the tool. Can use ${stepN.field} syntax.' },
                                condition: { type: 'string', description: 'Optional condition using ${stepN} references' },
                                forEach: { type: 'string', description: 'Optional: iterate over array from previous step (e.g., "${step1.results}")' }
                            },
                            required: ['name']
                        }
                    },
                    stopOnError: {
                        type: 'boolean',
                        description: 'Whether to stop execution if any step fails',
                        default: false
                    }
                },
                required: ['plan']
            }
        },
        execute: async ({ plan = [], stopOnError = false, interactionContext }) => {
            if (!Array.isArray(plan)) throw new Error('Plan must be an array');
            if (plan.length === 0) return 'No actions to execute';
            
            console.log(`Executing dynamic plan with ${plan.length} initial steps...`);
            
            const results = [];
            const stepResults = {}; // Store results for reference by later steps
            const errors = [];
            let successCount = 0;
            let totalStepsExecuted = 0;
            
            // Helper function to resolve template strings with step results
            const resolveTemplate = (value, context) => {
                if (typeof value !== 'string') return value;
                
                // Replace ${stepN.field} with actual values
                value = value.replace(/\$\{step(\d+)\.?([^}]*)\}/g, (match, stepNum, field) => {
                    const stepIdx = parseInt(stepNum) - 1;
                    const stepResult = context[`step${stepNum}`];
                    
                    if (!stepResult) {
                        console.warn(`Reference to non-existent step${stepNum}`);
                        return match;
                    }
                    
                    if (!field) return JSON.stringify(stepResult);
                    
                    // Navigate nested fields (e.g., step1.results.0.id)
                    const fields = field.split('.');
                    let value = stepResult;
                    
                    for (const f of fields) {
                        if (value === null || value === undefined) break;
                        value = value[f];
                    }
                    
                    return value !== undefined ? value : match;
                });
                
                // Replace ${item.field} with actual values from forEach context
                value = value.replace(/\$\{item\.?([^}]*)\}/g, (match, field) => {
                    const item = context.item;
                    
                    if (!item) {
                        console.warn(`Reference to item but no item in context`);
                        return match;
                    }
                    
                    if (!field) return JSON.stringify(item);
                    
                    // Navigate nested fields (e.g., item.results.0.id)
                    const fields = field.split('.');
                    let value = item;
                    
                    for (const f of fields) {
                        if (value === null || value === undefined) break;
                        value = value[f];
                    }
                    
                    return value !== undefined ? value : match;
                });
                
                return value;
            };
            
            // Helper to resolve all args in an object
            const resolveArgs = (args, context) => {
                if (!args) return {};
                
                const resolved = {};
                for (const [key, value] of Object.entries(args)) {
                    if (typeof value === 'string') {
                        resolved[key] = resolveTemplate(value, context);
                    } else if (typeof value === 'object' && value !== null) {
                        resolved[key] = resolveArgs(value, context);
                    } else {
                        resolved[key] = value;
                    }
                }
                return resolved;
            };
            
            // Validate plan references before execution
            const validatePlanReferences = (steps) => {
                const errors = [];
                steps.forEach((step, index) => {
                    const stepNum = index + 1;
                    const { args, forEach } = step;
                    
                    // Check references in args
                    const argsStr = JSON.stringify(args || {});
                    const argRefs = argsStr.match(/\$\{step(\d+)[^}]*\}/g) || [];
                    argRefs.forEach(ref => {
                        const refStepNum = parseInt(ref.match(/step(\d+)/)[1]);
                        if (refStepNum >= stepNum) {
                            errors.push(`Step ${stepNum} references step ${refStepNum} which hasn't executed yet`);
                        }
                    });
                    
                    // Check forEach references
                    if (forEach) {
                        const forEachRefs = forEach.match(/\$\{step(\d+)[^}]*\}/g) || [];
                        forEachRefs.forEach(ref => {
                            const refStepNum = parseInt(ref.match(/step(\d+)/)[1]);
                            if (refStepNum >= stepNum) {
                                errors.push(`Step ${stepNum} forEach references step ${refStepNum} which hasn't executed yet`);
                            }
                        });
                    }
                });
                return errors;
            };
            
            // Validate the plan before execution
            const validationErrors = validatePlanReferences(plan);
            if (validationErrors.length > 0) {
                console.error('Plan validation errors:', validationErrors);
                return `❌ **Plan Validation Failed**\n\nThe execution plan has invalid references:\n${validationErrors.map(e => `• ${e}`).join('\n')}\n\n💡 **Tip**: Steps can only reference previous steps. Make sure all steps are in the correct order.`;
            }
            
            // Process the plan with support for dynamic expansion
            const processSteps = async (steps, startIdx = 0) => {
                for (let i = 0; i < steps.length; i++) {
                    const step = steps[i];
                    const stepNum = startIdx + i + 1;
                    const { name, args, condition, forEach } = step;
                    
                    // Check condition if present
                    if (condition) {
                        const evaluatedCondition = resolveTemplate(condition, stepResults);
                        if (evaluatedCondition === 'false' || evaluatedCondition === false) {
                            results.push(`⏭️ Step ${stepNum}: Skipped (condition not met)`);
                            continue;
                        }
                    }
                    
                    // Handle forEach - expand into multiple steps
                    if (forEach) {
                        // Directly evaluate the forEach expression to get the array
                        let items = [];
                        
                        // Extract the step reference (e.g., "step1.results" -> ["step1", "results"])
                        const forEachMatch = forEach.match(/\$\{step(\d+)\.?([^}]*)\}/);
                        if (forEachMatch) {
                            const stepNum = forEachMatch[1];
                            const fieldPath = forEachMatch[2];
                            const stepResult = stepResults[`step${stepNum}`];
                            
                            if (stepResult) {
                                if (fieldPath) {
                                    // Navigate to the nested field
                                    const fields = fieldPath.split('.');
                                    let value = stepResult;
                                    for (const field of fields) {
                                        if (value && typeof value === 'object') {
                                            value = value[field];
                                        }
                                    }
                                    items = Array.isArray(value) ? value : [];
                                } else {
                                    items = Array.isArray(stepResult) ? stepResult : [];
                                }
                            }
                        }
                        
                        if (!Array.isArray(items)) {
                            console.error('forEach did not resolve to an array:', { forEach, resolved: items });
                            items = [];
                        }
                        
                        if (Array.isArray(items) && items.length > 0) {
                            console.log(`Expanding step ${stepNum} into ${items.length} iterations`);
                            console.log('First item structure:', JSON.stringify(items[0], null, 2));
                            
                            const expandedSteps = items.map((item, idx) => ({
                                name: step.name,
                                args: {
                                    ...resolveArgs(args, { ...stepResults, item }),
                                    // Special handling for common patterns
                                    ...(item.id !== undefined && { id: item.id })
                                }
                            }));
                            
                            // Log the first expanded step for debugging
                            if (expandedSteps.length > 0) {
                                console.log('First expanded step:', JSON.stringify(expandedSteps[0], null, 2));
                            }
                            
                            // Insert expanded steps and continue
                            await processSteps(expandedSteps, stepNum - 1);
                            continue;
                        } else if (forEach.includes('${step')) {
                            // If forEach references a step but no items were found, log a warning
                            console.warn(`Step ${stepNum}: forEach referenced "${forEach}" but no items found to iterate over`);
                            console.warn('Step result structure:', JSON.stringify(stepResults, null, 2));
                            results.push(`⚠️ Step ${stepNum}: No items found to iterate over`);
                            continue;
                        }
                    }
                    
                    // Regular step execution
                    try {
                        // Validate tool exists
                        if (!tools[name]) {
                            throw new Error(`Unknown tool: ${name}`);
                        }
                        
                        console.log(`Executing step ${stepNum}: ${name}`);
                        
                        // Resolve args with context from previous steps
                        const resolvedArgs = resolveArgs(args, stepResults);
                        
                        console.log(`Step ${stepNum} resolved args:`, JSON.stringify(resolvedArgs, null, 2));
                        
                        const result = await tools[name].execute({ 
                            ...resolvedArgs, 
                            interactionContext 
                        });
                        
                        // Store result for future steps
                        stepResults[`step${stepNum}`] = result;
                        totalStepsExecuted++;
                        
                        // Handle special result formats
                        if (result && typeof result === 'object') {
                            // If result has both display and data properties (used by some tools)
                            if (result._display && result._data) {
                                stepResults[`step${stepNum}`] = result._data;
                                results.push(`✅ Step ${stepNum}: ${result._display}`);
                                successCount++;
                                console.log(`Step ${stepNum} completed successfully`);
                                continue;
                            }
                        }
                        
                        // Try to parse JSON results for easier access
                        try {
                            if (typeof result === 'string' && (result.startsWith('{') || result.startsWith('['))) {
                                stepResults[`step${stepNum}`] = JSON.parse(result);
                            }
                        } catch (e) {
                            // Keep original if not valid JSON
                        }
                        
                        results.push(`✅ Step ${stepNum}: ${typeof result === 'string' ? result : 'Completed successfully'}`);
                        successCount++;
                        
                        console.log(`Step ${stepNum} completed successfully`);
                    
                } catch (err) {
                        const errorMsg = `❌ Step ${stepNum} (${name}): ${err.message}`;
                    results.push(errorMsg);
                    errors.push(errorMsg);
                        totalStepsExecuted++;
                    
                        console.error(`Step ${stepNum} failed:`, err.message);
                    
                    if (stopOnError) {
                            results.push(`🛑 Execution stopped due to error in step ${stepNum}`);
                            return;
                        }
                    }
                }
            };
            
            // Execute the plan
            await processSteps(plan);
            
            // Build summary
            const summary = [
                `📊 Execution Summary: ${successCount}/${totalStepsExecuted} steps completed successfully`
            ];
            
            if (totalStepsExecuted > plan.length) {
                summary.push(`📈 Dynamically expanded from ${plan.length} to ${totalStepsExecuted} steps`);
            }
            
            if (errors.length > 0) {
                summary.push(`⚠️ ${errors.length} errors encountered`);
            }
            
            // Combine summary with results
            const finalResult = [...summary, '', ...results].join('\n');
            
            console.log(`Dynamic plan execution completed: ${successCount}/${totalStepsExecuted} successful`);
            
            return finalResult;
        }
    }
};

// Helper – mirrors playtrack's internal check
function isUserInBotVoiceChannel(interaction) {
    const botVoiceChannel = interaction.guild?.members?.me?.voice?.channel;
    if (!botVoiceChannel) return false;
    const userVoiceChannel = interaction.member?.voice?.channel;
    if (!userVoiceChannel) return false;
    return botVoiceChannel.id === userVoiceChannel.id;
}

function getCommandResponse(sub, track, playlistName) {
    switch (sub) {
        case 'play':
            return `Attempting to play **${track}**`;
        case 'pause':
            return '⏸️ Pausing playback';
        case 'resume':
            return '▶️ Resuming playback';
        case 'skip':
            return '⏭️ Skipping track';
        case 'stop':
            return '⏹️ Stopping playback';
        case 'volume':
            return '🔊 Adjusting volume';
        case 'list':
            return '📋 Listing available tracks';
        case 'queue':
            return '📋 Showing queue';
        case 'play_all':
            return '🎵 Playing all tracks';
        case 'shuffle_all':
            return '🔀 Shuffling all tracks';
        case 'playlist_create':
            return `✅ Creating playlist **${playlistName}**`;
        case 'playlist_add':
            return `➕ Adding to playlist **${playlistName}**`;
        case 'playlist_play':
            return `▶️ Playing playlist **${playlistName}**`;
        case 'playlist_list':
            return '📋 Listing playlists';
        case 'playlist_delete':
            return `🗑️ Deleting playlist **${playlistName}**`;
        case 'playlist_create_from_search':
            return `🔍 Creating playlist **${playlistName}** from search`;
        default:
            return '🎵 Executing music command';
    }
}

/**
 * Resolve GitHub access for a tool call. In a server, the global token is
 * used and the repo must be on the guild's watch allowlist. In DMs and the
 * web portal there is no guild authority, so the caller's own connected
 * GitHub token (user_integrations) is the credential - their token, their
 * repos, no allowlist.
 * @returns {{ service?: Object, parsed?: string, error?: string }}
 */
function resolveGithubAccess(interactionContext, githubService, repo) {
    const guildId = interactionContext?.guildId || interactionContext?.guild?.id;
    let parsed;
    try {
        parsed = githubService.parseRepo(repo);
    } catch (error) {
        return { error: `❌ ${error.message}` };
    }

    if (guildId) {
        const repoWatchService = require('../services/repoWatchService');
        if (!repoWatchService.isRepoAllowed(guildId, parsed)) {
            return { error: `❌ ${parsed} isn't allowlisted in this server. An admin must run /github watch first.` };
        }
        return { service: githubService, parsed };
    }

    const userId = interactionContext?.user?.id;
    if (!userId) return { error: '❌ GitHub tools need a known user in this context.' };
    const userIntegrationService = require('../services/userIntegrationService');
    const token = userIntegrationService.getToken(userId, 'github');
    if (!token) {
        return { error: '❌ No GitHub account connected. Connect one in the web portal (Integrations) to use GitHub tools here.' };
    }
    return { service: githubService.withToken(token), parsed };
}

/**
 * Resolve Notion access for a tool call. Notion is a personal integration:
 * it only works on private surfaces (DMs and the web portal), never in a
 * server channel, so personal workspace content can't leak into a guild.
 * @returns {{ token?: string, error?: string }}
 */
function resolveNotionAccess(interactionContext) {
    const guildId = interactionContext?.guildId || interactionContext?.guild?.id;
    if (guildId) {
        return { error: '❌ Notion is a personal integration - use it in a DM or the web portal, not in a server channel.' };
    }
    const userId = interactionContext?.user?.id;
    if (!userId) return { error: '❌ Notion tools need a known user in this context.' };
    const userIntegrationService = require('../services/userIntegrationService');
    const token = userIntegrationService.getToken(userId, 'notion');
    if (!token) {
        return { error: '❌ No Notion workspace connected. Connect one in the web portal (Integrations) to use Notion tools.' };
    }
    return { token };
}

module.exports = {
    /**
     * Return array of OpenAI function definitions.
     * @param {string[]} [names] - optional allowlist; when provided, only
     *   definitions for these tool names are returned (e.g. the voice-safe
     *   subset used by live voice sessions).
     */
    getDefinitions(names, { isWeb = false } = {}) {
        let definitions = Object.values(tools).map(t => t.definition);
        // The code sandbox is opt-in and can be scoped to the web app only.
        // Never offer the tool the model can't legally use in this context.
        const sandboxOffered = sandboxService.enabled
            && (sandboxConfig.scope === 'everywhere' || isWeb);
        if (!sandboxOffered) {
            definitions = definitions.filter(def => def.name !== 'runCode');
        }
        // The Observatory rides the sandbox and has its own switch + scope.
        const observatoryOffered = observatoryService.enabled
            && (observatoryConfig.scope === 'everywhere' || isWeb);
        if (!observatoryOffered) {
            definitions = definitions.filter(def => def.name !== 'observatory');
        }
        // Tell the model what Python can actually import HERE (probed once),
        // so it writes against packages that exist instead of finding a
        // missing numpy at runtime.
        if (sandboxOffered || observatoryOffered) {
            const note = ` ${sandboxService.pythonEnvironmentNote()}`;
            definitions = definitions.map(def =>
                (def.name === 'runCode' || def.name === 'observatory')
                    ? { ...def, description: def.description + note }
                    : def);
        }
        if (!Array.isArray(names)) return definitions;
        const allowed = new Set(names);
        return definitions.filter(def => allowed.has(def.name));
    },

    /**
     * Execute a tool by name with args. Throws if unknown.
     * @param {string} name
     * @param {object} args
     */
    async execute(name, args) {
        if (!tools[name]) throw new Error(`Unknown tool: ${name}`);
        return tools[name].execute(args || {});
    }
}; 