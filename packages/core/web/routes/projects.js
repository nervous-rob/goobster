/**
 * Portal routes: Projects.
 * Mounted by packages/core/web/appApi.js — do not require this file from apps.
 */

const { OBSERVATORY_COMMAND_MAX_LENGTH } = require('../appHelpers');
const { streamWebChatTurn } = require('../appStream');

function mountProjects(app, ctx, h) {
    const { requireAuth, chatRoute, sendError, projectOwner } = h;

    // --- The Observatory (persistent simulation projects) ---------------------

    // Project list with sizes and job counts (the pane's overview)
    app.get('/api/app/observatory/projects', requireAuth, chatRoute(async (req) => ({
        projects: await ctx.observatory.listProjects(req.webUser.userId)
    })));

    app.get('/api/app/projects/invites', requireAuth, chatRoute(async (req) => ({
        invites: await ctx.observatory.listInvites(req.webUser.userId)
    })));

    app.post('/api/app/projects/invites/:inviteId/respond', requireAuth, chatRoute(async (req) =>
        ctx.observatory.respondInvite({
            userId: req.webUser.userId,
            userName: req.webUser.userName,
            inviteId: req.params.inviteId,
            accept: req.body?.accept !== false
        })
    ));

    app.delete('/api/app/projects/invites/:inviteId', requireAuth, chatRoute(async (req) =>
        ctx.observatory.revokeInvite({
            userId: req.webUser.userId,
            inviteId: req.params.inviteId
        })
    ));

    // One project, standardized: registry + status counts, jobs with
    // output tails, checkpoint, and the workspace listing (files get
    // owner-bound servable URLs through the same registry as generated
    // chat images) - everything the project view renders, in one shape.
    app.get('/api/app/observatory/projects/:slug', requireAuth, chatRoute(async (req) => {
        const userId = req.webUser.userId;
        const owner = projectOwner(req);
        const detail = await ctx.observatory.getProjectDetail({
            userId, project: req.params.slug, owner
        });
        const files = [];
        for (const file of detail.files) {
            let url = null;
            try {
                const resolved = await ctx.observatory.resolveFile({
                    userId, project: detail.project.slug, relPath: file.path,
                    owner: detail.project.ownerId
                });
                url = (await ctx.chat.registerFile(resolved.path, userId))?.url || null;
            } catch { /* raced away - listed without a link */ }
            files.push({ ...file, url });
        }
        return { ...detail, files };
    }));

    /**
     * Find (or create) the Observatory's dedicated web conversation for
     * one title. Custom commands share that thread, so the agent keeps
     * context across commands and the transcript stays browsable from
     * the Chat pane.
     */
    async function observatoryConversation(userId, title) {
        const existing = (await ctx.chat.listConversations(userId)).find(c => c.title === title);
        if (existing) return { id: existing.id, title: existing.title, created: false };
        const created = await ctx.chat.createConversation(userId);
        const renamed = await ctx.chat.renameConversation({
            userId, conversationId: created.id, title
        });
        return { id: renamed?.id || created.id, title, created: true };
    }

    async function observatoryConversationId(userId, title) {
        return (await observatoryConversation(userId, title)).id;
    }

    /**
     * One full agent turn (same startTurn + SSE vocabulary as the Study
     * composer) scoped to a project when a slug is known. The old
     * /observatory/command route is an alias that still allows an optional
     * project so list-view commands can create one.
     */
    async function handleProjectChat(req, res, { requiredSlug = null } = {}) {
        let turn;
        try {
            if (ctx.observatory.enabled !== true) {
                sendError(res, 403, 'DISABLED', 'The Observatory is disabled on this server.');
                return;
            }
            const userId = req.webUser.userId;
            const instructions = String(req.body?.message ?? req.body?.instructions ?? '').trim();
            if (!instructions) {
                sendError(res, 400, 'EMPTY_COMMAND', 'Tell Goobster what to do first.');
                return;
            }
            if (instructions.length > OBSERVATORY_COMMAND_MAX_LENGTH) {
                sendError(res, 400, 'COMMAND_TOO_LONG',
                    `Keep commands under ${OBSERVATORY_COMMAND_MAX_LENGTH} characters.`);
                return;
            }
            const projectRef = requiredSlug || (req.body?.project ? String(req.body.project) : null);
            const owner = projectOwner(req);
            const project = projectRef
                ? await ctx.observatory.resolveProject({ userId, project: projectRef, owner })
                : null;

            let manifestText = '';
            if (project && typeof ctx.observatory.buildChatManifest === 'function') {
                try {
                    const manifest = await ctx.observatory.buildChatManifest({
                        userId, project: project.slug, owner: project.ownerId
                    });
                    manifestText = manifest?.text ? `\n\n${manifest.text}\n` : '';
                } catch { /* preamble is best-effort */ }
            }

            const message = (project
                ? `[Observatory command for project "${project.name}" (slug: ${project.slug})] `
                  + 'Use the observatory tool on this project to carry out the instructions below. '
                : '[Observatory command] Use the observatory tool to carry out the instructions below '
                  + '(create a project first if none fits). ')
                + 'Prefer background jobs with the checkpoint.json convention for anything long, and '
                + 'report back what you started, changed, or found.'
                + manifestText
                + '\n\n'
                + instructions;

            turn = await ctx.chat.startTurn({
                client: ctx.client,
                gateway: ctx.gateway,
                userId,
                userName: req.webUser.userName,
                message,
                conversationId: await observatoryConversationId(
                    userId, project ? `🔭 ${project.name}` : '🔭 Observatory')
            });
        } catch (error) {
            const status = error.status || 500;
            sendError(res, status, error.code || 'INTERNAL',
                status === 500 ? 'Something went wrong.' : error.message,
                error.details || null);
            return;
        }
        await streamWebChatTurn(res, turn, ctx);
    }

    app.post('/api/app/projects/:slug/chat', requireAuth, (req, res) =>
        handleProjectChat(req, res, { requiredSlug: req.params.slug })
    );
    app.get('/api/app/projects/:slug/conversation', requireAuth, chatRoute(async (req) => {
        if (ctx.observatory.enabled !== true) {
            const err = new Error('The Observatory is disabled on this server.');
            err.status = 403;
            err.code = 'DISABLED';
            throw err;
        }
        const project = await ctx.observatory.resolveProject({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req)
        });
        return observatoryConversation(req.webUser.userId, `🔭 ${project.name}`);
    }));
    // Alias: list-view commands still post here with an optional project.
    app.post('/api/app/observatory/command', requireAuth, (req, res) =>
        handleProjectChat(req, res)
    );

    // The project parlor (§14): get-or-create the project's shared group
    // discussion (owner + members + the built-in Goobster seat). Any
    // member may open it; the transcript, turns, and nudges then go
    // through the normal /api/app/parlor routes.
    app.get('/api/app/projects/:slug/parlor', requireAuth, chatRoute(async (req) =>
        ctx.observatory.getProjectParlor({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req)
        })
    ));

    app.delete('/api/app/observatory/projects/:slug', requireAuth, chatRoute(async (req) =>
        ctx.observatory.deleteProject({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req),
            gateway: ctx.gateway
        })
    ));

    app.post('/api/app/observatory/jobs/:jobId/cancel', requireAuth, chatRoute(async (req) =>
        ctx.observatory.cancel({
            userId: req.webUser.userId,
            jobId: req.params.jobId
        })
    ));

    app.post('/api/app/observatory/jobs/:jobId/resume', requireAuth, chatRoute(async (req) =>
        ctx.observatory.resume({
            userId: req.webUser.userId,
            jobId: req.params.jobId,
            client: ctx.gateway
        })
    ));

    // Stitch the project's frames now (the dashboard's Render button)
    app.post('/api/app/observatory/projects/:slug/render', requireAuth, chatRoute(async (req) =>
        ctx.observatory.render({
            userId: req.webUser.userId,
            project: req.params.slug,
            fps: req.body?.fps ?? null,
            owner: projectOwner(req)
        })
    ));

    // The owner's live dashboard page (regenerated when stale; ?fresh=1
    // forces). Server-generated trusted HTML - never snippet-authored.
    app.get('/api/app/observatory/projects/:slug/dashboard', requireAuth, async (req, res) => {
        try {
            const { html } = await ctx.observatory.getDashboard({
                userId: req.webUser.userId,
                project: req.params.slug,
                force: req.query.fresh === '1',
                owner: projectOwner(req)
            });
            res.status(200).type('html').send(html);
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Observatory dashboard failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

    // Dashboard share links: create (idempotent), inspect, revoke.
    app.post('/api/app/observatory/projects/:slug/share', requireAuth, chatRoute(async (req) =>
        ctx.observatory.createShareLink({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req)
        })
    ));

    app.get('/api/app/observatory/projects/:slug/share', requireAuth, chatRoute(async (req) =>
        ctx.observatory.getShareLink({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req)
        })
    ));

    app.delete('/api/app/observatory/projects/:slug/share', requireAuth, chatRoute(async (req) =>
        ctx.observatory.revokeShareLink({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req)
        })
    ));

    // Owner-only workspace file reader for the applet capability bridge.
    // Not public-share infrastructure: requireAuth + service ownership.
    // Express 4 splat lands in req.params[0].
    app.get('/api/app/observatory/projects/:slug/content/*', requireAuth, async (req, res) => {
        try {
            const file = await ctx.observatory.readWorkspaceFile({
                userId: req.webUser.userId,
                slug: req.params.slug,
                relativePath: req.params[0],
                owner: projectOwner(req)
            });
            res.status(200)
                .set({
                    'Content-Type': file.mime,
                    'Content-Length': file.size,
                    'Cache-Control': 'private, no-store',
                    'X-Content-Type-Options': 'nosniff',
                    'Content-Disposition': `inline; filename="${String(file.name).replace(/["\r\n]/g, '')}"`
                })
                .send(file.bytes);
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Observatory content read failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

    function sendWorkspaceFile(res, file, disposition = 'inline') {
        res.status(200)
            .set({
                'Content-Type': file.mime,
                'Content-Length': file.size,
                'Cache-Control': 'private, no-store',
                'X-Content-Type-Options': 'nosniff',
                'Content-Disposition': `${disposition}; filename="${String(file.name).replace(/["\r\n]/g, '')}"`
            })
            .send(file.bytes);
    }

    function readRawBody(req, maxBytes) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > maxBytes) {
                    const err = new Error('Upload too large');
                    err.status = 413;
                    err.code = 'FILE_TOO_LARGE';
                    req.destroy();
                    reject(err);
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
        });
    }

    function extractMultipartFile(raw, contentType) {
        const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
        if (!match) return null;
        const boundary = match[1] || match[2];
        const text = raw.toString('latin1');
        const parts = text.split(`--${boundary}`);
        for (const part of parts) {
            const headerEnd = part.indexOf('\r\n\r\n');
            if (headerEnd === -1) continue;
            const header = part.slice(0, headerEnd);
            let body = part.slice(headerEnd + 4);
            if (body.endsWith('\r\n')) body = body.slice(0, -2);
            const fileName = (header.match(/filename="([^"]*)"/i) || [])[1];
            const fieldName = (header.match(/\bname="([^"]*)"/i) || [])[1];
            if (fileName != null || fieldName === 'file' || fieldName === 'content') {
                return {
                    filename: fileName || null,
                    bytes: Buffer.from(body, 'latin1')
                };
            }
        }
        return null;
    }

    async function readWorkspaceWriteBytes(req) {
        const type = String(req.headers['content-type'] || '');
        if (type.includes('application/json')) {
            return Buffer.from(String(req.body?.content ?? req.body?.text ?? ''), 'utf8');
        }
        const maxBytes = 2100 * 1024 * 1024;
        const raw = await readRawBody(req, maxBytes);
        if (type.includes('multipart/form-data')) {
            const part = extractMultipartFile(raw, type);
            if (!part) {
                const err = new Error('Expected a file part in the multipart body.');
                err.status = 400;
                err.code = 'BAD_REQUEST';
                throw err;
            }
            return part.bytes;
        }
        return raw;
    }

    async function writeWorkspaceContent(req, res) {
        try {
            const bytes = await readWorkspaceWriteBytes(req);
            const written = await ctx.observatory.writeWorkspaceFile({
                userId: req.webUser.userId,
                slug: req.params.slug,
                relativePath: req.params[0],
                bytes,
                owner: projectOwner(req)
            });
            res.status(200).json(written);
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Observatory content write failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    }

    async function deleteWorkspaceContent(req, res) {
        try {
            const result = await ctx.observatory.deleteWorkspaceFile({
                userId: req.webUser.userId,
                slug: req.params.slug,
                relativePath: req.params[0],
                owner: projectOwner(req)
            });
            res.status(200).json(result);
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Observatory content delete failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    }

    // Portal explorer: owner-only tree listing (lazy per-directory when path=)
    app.get('/api/app/projects/:slug/files', requireAuth, chatRoute(async (req) =>
        ctx.observatory.listFiles({
            userId: req.webUser.userId,
            project: req.params.slug,
            path: Object.prototype.hasOwnProperty.call(req.query, 'path')
                ? String(req.query.path)
                : undefined,
            owner: projectOwner(req)
        })
    ));

    // Portal content (any file type) + writes. Same legalize helper as the
    // applet reader; quota and maxUploadMb apply before a byte is accepted.
    app.get('/api/app/projects/:slug/content/*', requireAuth, async (req, res) => {
        try {
            const file = await ctx.observatory.readWorkspaceFile({
                userId: req.webUser.userId,
                slug: req.params.slug,
                relativePath: req.params[0],
                purpose: 'portal',
                owner: projectOwner(req)
            });
            const asDownload = String(req.query.download || '') === '1';
            sendWorkspaceFile(res, file, asDownload ? 'attachment' : 'inline');
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Project content read failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

    app.put('/api/app/projects/:slug/content/*', requireAuth, writeWorkspaceContent);
    app.delete('/api/app/projects/:slug/content/*', requireAuth, deleteWorkspaceContent);
    app.put('/api/app/observatory/projects/:slug/content/*', requireAuth, writeWorkspaceContent);
    app.delete('/api/app/observatory/projects/:slug/content/*', requireAuth, deleteWorkspaceContent);

    // --- Project assets (versioned apps / scripts / notes) -------------------
    // Auth + error contract match the Observatory routes: requireAuth and
    // chatRoute (status+code from ProjectAssetError). Ownership is
    // service-level (userId + project slug).

    app.get('/api/app/projects/:slug/assets', requireAuth, chatRoute(async (req) => ({
        assets: await ctx.projectAssets.list({
            userId: req.webUser.userId,
            project: req.params.slug,
            kind: req.query.kind || null,
            owner: projectOwner(req)
        })
    })));

    app.post('/api/app/projects/:slug/assets', requireAuth, chatRoute(async (req) =>
        ctx.projectAssets.save({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req),
            slug: req.body?.slug,
            name: req.body?.name,
            kind: req.body?.kind,
            language: req.body?.language,
            source: req.body?.source,
            note: req.body?.note,
            origin: req.body?.origin || 'portal',
            conversationId: req.body?.conversationId,
            messageId: req.body?.messageId,
            grants: req.body?.grants
        })
    ));

    app.get('/api/app/projects/:slug/assets/:asset', requireAuth, chatRoute(async (req) =>
        ctx.projectAssets.get({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req),
            asset: req.params.asset,
            version: req.query.version ?? null
        })
    ));

    app.patch('/api/app/projects/:slug/assets/:asset', requireAuth, chatRoute(async (req) =>
        ctx.projectAssets.update({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req),
            asset: req.params.asset,
            name: req.body?.name,
            grants: req.body?.grants
        })
    ));

    app.delete('/api/app/projects/:slug/assets/:asset', requireAuth, chatRoute(async (req) =>
        ctx.projectAssets.delete({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req),
            asset: req.params.asset
        })
    ));

    app.get('/api/app/projects/:slug/assets/:asset/versions', requireAuth, chatRoute(async (req) =>
        ctx.projectAssets.listVersions({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req),
            asset: req.params.asset
        })
    ));

    app.get('/api/app/projects/:slug/assets/:asset/versions/:n', requireAuth, chatRoute(async (req) =>
        ctx.projectAssets.get({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req),
            asset: req.params.asset,
            version: req.params.n
        })
    ));

    app.post('/api/app/projects/:slug/assets/:asset/rollback', requireAuth, chatRoute(async (req) =>
        ctx.projectAssets.rollback({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req),
            asset: req.params.asset,
            version: req.body?.version
        })
    ));

    app.post('/api/app/projects/:slug/assets/:asset/run', requireAuth, chatRoute(async (req) => {
        const owner = projectOwner(req);
        const asset = await ctx.projectAssets.get({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner,
            asset: req.params.asset
        });
        if (asset.kind !== 'script') {
            const err = new Error(`"${asset.slug}" is a ${asset.kind}, not a script.`);
            err.status = 400;
            err.code = 'NOT_A_SCRIPT';
            throw err;
        }
        return ctx.observatory.run({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner,
            language: asset.language,
            code: asset.source,
            background: req.body?.background === true,
            client: ctx.gateway,
            assetVersionId: asset.versionId,
            startedBy: 'portal'
        });
    }));

    // --- Project triggers (cron / event automations) ------------------------
    app.get('/api/app/projects/:slug/triggers', requireAuth, chatRoute(async (req) => ({
        triggers: await ctx.projectTriggers.list({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req)
        })
    })));

    app.get('/api/app/projects/:slug/triggers/:trigger', requireAuth, chatRoute(async (req) =>
        ctx.projectTriggers.get({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req),
            trigger: req.params.trigger
        })
    ));

    app.post('/api/app/projects/:slug/triggers', requireAuth, chatRoute(async (req) => {
        return ctx.projectTriggers.create({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req),
            name: req.body?.name,
            kind: req.body?.kind,
            schedule: req.body?.schedule,
            eventTopic: req.body?.eventTopic,
            action: req.body?.action,
            actionAssetId: req.body?.actionAssetId,
            actionAsset: req.body?.actionAsset,
            actionParams: req.body?.actionParams,
            isEnabled: req.body?.isEnabled
        });
    }));

    app.patch('/api/app/projects/:slug/triggers/:trigger', requireAuth, chatRoute(async (req) =>
        ctx.projectTriggers.update({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req),
            trigger: req.params.trigger,
            name: req.body?.name,
            kind: req.body?.kind,
            schedule: req.body?.schedule,
            eventTopic: req.body?.eventTopic,
            action: req.body?.action,
            actionAssetId: req.body?.actionAssetId,
            actionAsset: req.body?.actionAsset,
            actionParams: req.body?.actionParams,
            isEnabled: req.body?.isEnabled
        })
    ));

    app.delete('/api/app/projects/:slug/triggers/:trigger', requireAuth, chatRoute(async (req) =>
        ctx.projectTriggers.delete({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req),
            trigger: req.params.trigger
        })
    ));

    // --- Project members & invitations --------------------------------------
    app.get('/api/app/projects/:slug/members', requireAuth, chatRoute(async (req) =>
        ctx.observatory.listMembers({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req)
        })
    ));

    app.get('/api/app/projects/:slug/invitable', requireAuth, chatRoute(async (req) =>
        ctx.observatory.listInvitable({
            gateway: ctx.gateway,
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req),
            q: req.query.q || null
        })
    ));

    app.post('/api/app/projects/:slug/invites', requireAuth, chatRoute(async (req) =>
        ctx.observatory.invite({
            gateway: ctx.gateway,
            userId: req.webUser.userId,
            ownerName: req.webUser.userName,
            project: req.params.slug,
            owner: projectOwner(req),
            inviteeId: req.body?.userId
        })
    ));

    app.get('/api/app/projects/:slug/knowledge', requireAuth, chatRoute(async (req) =>
        ctx.observatory.getKnowledgeGraph({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req)
        })
    ));

    app.get('/api/app/projects/:slug/knowledge/notes', requireAuth, chatRoute(async (req) => ({
        notes: await ctx.observatory.listKnowledgeNotes({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req),
            q: req.query.q || null
        })
    })));

    app.delete('/api/app/projects/:slug/members/:memberId', requireAuth, chatRoute(async (req) =>
        ctx.observatory.removeMember({
            userId: req.webUser.userId,
            project: req.params.slug,
            owner: projectOwner(req),
            memberId: req.params.memberId
        })
    ));

    // --- Spitball Expeditions (autonomous research over the user's graph) ----
    // Personal expeditions write into USER:<userId>. A project-targeted
    // expedition writes into PROJECT:<projectId> after actor resolution.
    // chatRoute translates SpitballError's status+code contract.

}

module.exports = { mountProjects };
