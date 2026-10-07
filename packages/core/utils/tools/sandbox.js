/**
 * Chat tools: the code sandbox (runCode, requestPythonPackages).
 * Required by packages/core/utils/toolsRegistry.js — apps keep requiring the facade.
 */

const path = require('node:path');
const sandboxService = require('../../services/sandboxService');
const sandboxConfig = require('../../config/sandboxConfig');
const sandboxRequestService = require('../../services/sandboxRequestService');
const { clipStream } = require('../toolResultWindow');

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
