/**
 * Portal routes: EventsStatic.
 * Mounted by packages/core/web/appApi.js — do not require this file from apps.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const eventBusService = require('../../services/eventBusService');
const { workspaceRoot } = require('../../runtimePaths');
const { SSE_HEARTBEAT_MS } = require('../appHelpers');
const { createSseChannel } = require('../liveAuthorization');

function mountEventsStatic(app, ctx, h) {
    const { requireAuth, sendError } = h;


    // --- The portal event stream ---------------------------------------------

    // One SSE stream multiplexing gateway-originated events (a follow-up
    // delivered, an automation ran, an agent run updated) plus server-side
    // invalidation hints. In the full deployment the events travel from the
    // bot through Postgres LISTEN/NOTIFY into this process; in the lite
    // single process they are the same in-process bus. This is what lets
    // the reactive client (Phase 4) stop polling.
    app.get('/api/app/events', requireAuth, (req, res) => {
        const channel = createSseChannel(res);
        const send = channel.send;
        const heartbeat = setInterval(() => {
            channel.ping();
            // An open portal tab holds this stream; touching the session on
            // each beat is what keeps the user "online" for presenceService
            // (closing the tab lets it go stale within the window).
            if (channel.open) ctx.sessions.touch?.(req.webSessionToken)
                ?.catch(() => { /* presence is cosmetic */ });
        }, SSE_HEARTBEAT_MS);
        heartbeat.unref?.();

        send('hello', { userId: req.webUser.userId });

        // Strictly user-scoped: only events attributed to this session's
        // user are forwarded (events carry ids and hints, never content).
        const unsubscribe = ctx.events.subscribe((event) => {
            if (!event || event.payload?.userId !== req.webUser.userId) return;
            // Kind-level hints plus any scoped hints the publisher attached
            // (e.g. parlor-messages:<conversationId>, so only the affected
            // discussion's transcript refetches).
            const scoped = Array.isArray(event.payload?.invalidate) ? event.payload.invalidate : [];
            send(event.kind, {
                ...event.payload,
                at: event.at,
                invalidate: [...eventBusService.invalidationHints(event.kind), ...scoped]
            });
        });

        res.on('close', () => {
            clearInterval(heartbeat);
            unsubscribe();
        });
    });

    // Unknown API routes answer JSON, not the SPA fallback
    app.use('/api/app', (req, res) => {
        sendError(res, 404, 'NOT_FOUND', 'No such API route.');
    });

    // --- Static client -----------------------------------------------------

    // KaTeX (LaTeX rendering) is served straight from node_modules, the same
    // pattern as the embedded-app-sdk in activityApi.js - no bundler, and a
    // self-hosted instance needs no CDN. The client lazy-loads it only when a
    // message actually contains math.
    app.use('/app/vendor/katex', express.static(path.join(
        path.dirname(require.resolve('katex/package.json')),
        'dist'
    )));

    const reactDir = ctx.webDistDir || path.join(workspaceRoot, 'apps/web/dist');
    const reactIndex = () => path.join(reactDir, 'index.html');
    const reactBuilt = () => fs.existsSync(reactIndex());

    // The service worker's cache is named after the build it shipped with
    // (documentation/pwa.md): index.html points at hashed chunks, so its
    // content hash changes with every `build:web` and a new worker
    // activates whose `activate` step drops the previous build's cache.
    let buildStamp = null;
    const currentBuildStamp = () => {
        if (buildStamp) return buildStamp;
        try {
            buildStamp = crypto.createHash('sha256').update(fs.readFileSync(reactIndex())).digest('hex').slice(0, 12);
        } catch {
            buildStamp = 'dev';
        }
        return buildStamp;
    };
    app.get('/app/sw.js', (req, res, next) => {
        const file = path.join(reactDir, 'sw.js');
        fs.readFile(file, 'utf8', (error, source) => {
            if (error) return next();
            // Browsers cap a worker script's freshness at 24h anyway; asking
            // for revalidation makes a deploy visible on the next load.
            res.set({
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'no-cache',
                'Service-Worker-Allowed': '/app/'
            });
            res.send(source.replace(/__GOOBSTER_BUILD__/g, currentBuildStamp()));
        });
    });

    // The Web Share Target lands here when the worker is not (yet) in
    // control: nothing to hand over, so open a fresh chat. With the
    // worker installed, the POST never reaches the server.
    app.post('/app/share-target', (req, res) => {
        res.redirect(303, '/app/chat');
    });

    // Shared Observatory dashboards - deliberately NO auth: the unguessable
    // token is the capability, and the self-contained page it unlocks
    // exposes no other file or route (control buttons stay inert because
    // the owner-session probe fails for viewers).
    app.get('/app/observatory/share/:token', async (req, res) => {
        if (!ctx.observatory) {
            sendError(res, 404, 'NOT_FOUND', 'No such dashboard.');
            return;
        }
        try {
            const { html } = await ctx.observatory.getSharedDashboard(req.params.token);
            res.status(200).type('html').send(html);
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Shared observatory dashboard failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

    // Bookmarks to the strangler-era /app/next URL land on /app.
    app.get(/^\/app\/next(\/.*)?$/, (req, res) => {
        const rest = String(req.path || '').replace(/^\/app\/next\/?/, '');
        res.redirect(302, rest ? `/app/${rest}` : '/app/');
    });

    // The React client (apps/web/dist) is the only web client. Share links
    // (/app/share/<token>) are SPA routes like everything else. When the
    // build is missing, say so plainly instead of a bare 404.
    if (reactBuilt()) {
        // Vite names every chunk after its content, so a hashed asset can
        // be cached forever; everything else (manifest, icons, the stable
        // style.css, offline.html) revalidates on each load.
        app.use('/app/assets', express.static(path.join(reactDir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: true }));
        app.use('/app', express.static(reactDir, { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
        app.get(['/app', '/app/*'], (req, res, next) => {
            if (path.extname(req.path)) return next();
            res.set('Cache-Control', 'no-cache');
            res.sendFile(reactIndex());
        });
    } else {
        app.get(['/app', '/app/*'], (req, res) => {
            sendError(res, 503, 'WEB_CLIENT_UNBUILT',
                'The web client is not built. Run npm run build:web.');
        });
    }

}

module.exports = { mountEventsStatic };
