/**
 * Portal routes: EventsStatic.
 * Mounted by packages/core/web/appApi.js — do not require this file from apps.
 */

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const eventBusService = require('../../services/eventBusService');
const { SSE_HEARTBEAT_MS } = require('../appHelpers');

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
        res.status(200).set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();

        let open = true;
        const send = (event, data) => {
            if (!open) return;
            try {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            } catch { open = false; }
        };
        const heartbeat = setInterval(() => {
            if (open) res.write(': ping\n\n');
            // An open portal tab holds this stream; touching the session on
            // each beat is what keeps the user "online" for presenceService
            // (closing the tab lets it go stale within the window).
            if (open) ctx.sessions.touch?.(req.webSessionToken)
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
            open = false;
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

    const reactDir = path.join(__dirname, '../../../apps/web/dist');
    const reactIndex = () => path.join(reactDir, 'index.html');
    const reactBuilt = () => fs.existsSync(reactIndex());

    // Shared Observatory dashboards - deliberately NO auth: the unguessable
    // token is the capability, and the self-contained page it unlocks
    // exposes no other file or route (control buttons stay inert because
    // the owner-session probe fails for viewers).
    app.get('/app/observatory/share/:token', async (req, res) => {
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
        app.use('/app', express.static(reactDir));
        app.get(['/app', '/app/*'], (req, res, next) => {
            if (path.extname(req.path)) return next();
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
