/** Project organization has no dependency on sandbox execution. */
const projects = require('../../services/observatoryService');
const assets = require('../../services/projectAssetService');
const applets = require('../../services/webAppletService');
const config = require('../../config/observatoryConfig');
const { windowLines, formatTextWindow, fenceLanguage } = require('../toolResultWindow');

module.exports = {
    projectAssets: {
        definition: {
            name: 'projectAssets',
            description: 'Organize projects and save apps, scripts or notes WITHOUT running code. Prefer this tool directly over executePlan for project assets. To save a new app use save_app with project, name, language=html (or svg), code=complete source. To file an existing Chat app unchanged, list_unfiled_apps then file_app using its exact contentHash or appletId. Use list_projects to find the target, create_project only when requested, list_assets/get_asset to inspect existing assets. Saves are versioned; identical source is a no-op. This tool never runs code or changes external services. Code execution and project missions use observatory.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list_projects', 'create_project', 'list_assets', 'get_asset', 'save_app', 'save_script', 'save_note', 'list_unfiled_apps', 'file_app'] },
                    project: { type: 'string', description: 'Existing project name or slug; required for asset actions and file_app.' },
                    owner: { type: 'string', description: 'Owner user ID when accessible projects share a slug. Copy it from list_projects.' },
                    name: { type: 'string', description: 'Required for create_project or new save_* assets; optional title for file_app.' },
                    slug: { type: 'string', description: 'get_asset: required existing asset slug. save_*/file_app: target slug, derived from name if omitted. Reusing a slug appends a version.' },
                    language: { type: 'string', enum: ['html', 'svg', 'python', 'javascript', 'markdown'], description: 'save_app: html/svg; save_script: python/javascript; save_note: markdown. Defaults by kind when omitted.' },
                    code: { type: 'string', description: 'save_*: complete source, without Markdown fences. Not a filename, URL or description. save_app must be a complete self-contained document.' },
                    note: { type: 'string', description: 'Optional version note for save_* or file_app.' },
                    kind: { type: 'string', enum: ['app', 'script', 'note'], description: 'Optional list_assets filter.' },
                    version: { type: 'integer', description: 'get_asset version; omit for current head.' },
                    offset: { type: 'integer', description: 'get_asset: first line, 1-based.' },
                    limit: { type: 'integer', description: 'get_asset: line count (default 400, maximum 800).' },
                    appletId: { type: 'integer', description: 'file_app: exact pinned app ID from list_unfiled_apps; use this OR contentHash.' },
                    contentHash: { type: 'string', description: 'file_app: exact discovered Chat app hash from list_unfiled_apps; use this OR appletId.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, project, owner, name, slug, language, code, note, kind, version, offset, limit, appletId, contentHash, interactionContext }) => {
            const userId = interactionContext?.user?.id;
            const trusted = interactionContext?.channelId?.startsWith('web:') || interactionContext?.isAutomation === true;
            if (config.scope === 'web' && !trusted) return { ok: false, code: 'WEB_ONLY', message: 'Project tools are only available in the web app on this installation.' };
            if (!userId) return { ok: false, code: 'NO_USER', message: 'Project tools require a signed-in user.' };
            if (!projects.organizationEnabled) return { ok: false, code: 'PROJECTS_DISABLED', message: 'Projects are disabled on this installation.' };
            try {
                if (action === 'list_projects') return { projects: await projects.listProjects(userId) };
                if (action === 'create_project') return { project: await projects.createProject({ userId, name }) };
                if (action === 'list_unfiled_apps') {
                    const found = await applets.listWorkshop(userId);
                    const summary = app => ({ appletId: app.id, contentHash: app.contentHash, name: app.title, language: app.language, conversationId: app.conversationId, messageId: app.messageId });
                    return { pinned: found.pinned.filter(app => !app.migrated).map(summary), discovered: found.discovered.map(summary) };
                }
                if (!project) throw new Error('Provide project from list_projects.');
                if (action === 'list_assets') return { assets: await assets.list({ userId, project, owner, kind }) };
                if (action === 'get_asset') {
                    const app = await assets.get({ userId, project, owner, asset: slug, version });
                    return formatTextWindow({ label: `${app.kind} ${app.slug} v${app.version} · ${app.language}`, size: app.source.length, window: windowLines(app.source, { offset, limit }), fence: app.language || fenceLanguage(app.slug) });
                }
                let source = code;
                let savedLanguage = language;
                let savedName = name;
                let provenance = {};
                if (action === 'file_app') {
                    if (Boolean(appletId) === Boolean(contentHash)) throw new Error('Provide exactly one appletId or contentHash from list_unfiled_apps.');
                    const app = appletId ? await applets.get({ userId, appletId }) : (await applets.discover(userId)).find(item => item.contentHash === contentHash);
                    if (!app) throw new Error('That Chat app is no longer in the discovery window. List unfiled apps again, or save_app with the original complete source.');
                    source = app.source;
                    savedLanguage = app.language;
                    savedName = name || app.title;
                    provenance = { conversationId: app.conversationId, messageId: app.messageId };
                } else if (!['save_app', 'save_script', 'save_note'].includes(action)) throw new Error(`Unknown projectAssets action: ${action}`);
                const saved = await assets.save({ userId, project, owner, name: savedName, slug, language: savedLanguage,
                    kind: action === 'file_app' ? 'app' : action.slice(5), source, note, origin: 'agent', ...provenance });
                // Return metadata only; avoid echoing large app source back into the model context.
                return { ok: true, project: saved.project, slug: saved.slug, name: saved.name, kind: saved.kind, version: saved.version, deduped: saved.deduped === true };
            } catch (error) {
                return { ok: false, code: error.code || 'PROJECT_ASSET_ERROR', message: error.message };
            }
        }
    }
};
