/** Revalidate long-lived connections against the database, including other replicas. */
async function authorizeSession(ctx, token, expected = null, alive = () => true) {
    if (!alive()) return null;
    const session = token ? await ctx.sessions.get(token, { touch: false }) : null;
    if (!alive()) return null;
    if (!session || (expected && (session.userId !== expected.userId || session.id !== expected.id))) return null;
    const actor = await ctx.identity.resolveActor({
        principalId: session.userId, surface: 'web', sessionId: String(session.id)
    });
    if (!alive()) return null;
    if (session.sessionVersion != null && actor.account
        && Number(session.sessionVersion) !== Number(actor.account.sessionVersion)) return null;
    return { session, actor };
}

async function reserveConnection(session) {
    const policy = require('../config/admissionConfig');
    return require('../services/resourceAdmissionService').acquire({
        resource: 'stream', actorId: session.userId, scopeId: `session:${session.id || session.userId}`,
        limit: policy.streamConcurrent, perActor: policy.streamPerAccount,
        scopeLimit: policy.streamPerSession, leaseMs: 30000
    });
}

/**
 * Bounded, ordered output. Authorization is checked before each batch, never
 * cached for a connection's lifetime. Idle connections recheck every second.
 * A database/authorization failure closes the connection (no wider fallback).
 */
function authorizedChannel({ authorize, write, close, intervalMs = 1000, maxBytes = 1024 * 1024 }) {
    let open = true;
    let pending = [];
    let bytes = 0;
    let flushing = null;
    const stop = (revoked = false) => {
        if (!open) return;
        open = false;
        pending = [];
        bytes = 0;
        clearInterval(timer);
        close(revoked);
    };
    const flush = () => {
        if (!open) return Promise.resolve();
        if (flushing) return flushing;
        flushing = (async () => {
            do {
                if (!(await authorize())) { stop(true); return; }
                if (!open) return;
                const batch = pending;
                pending = [];
                bytes = 0;
                for (const value of batch) {
                    if (!open) return;
                    write(value);
                }
            } while (pending.length && open);
        })().catch(error => stop(error?.status === 429 ? error : true)).finally(() => { flushing = null; });
        return flushing;
    };
    const timer = setInterval(flush, intervalMs);
    timer.unref?.();
    return {
        send(value) {
            if (!open) return;
            bytes += Buffer.byteLength(value);
            if (bytes > maxBytes) { stop(true); return; }
            pending.push(value);
            void flush();
        },
        async end() { await flush(); stop(); },
        flush,
        stop,
        get open() { return open; }
    };
}

function createSseChannel(res, authorizeResource = null) {
    res.status(200).set({
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    const channel = authorizedChannel({
        authorize: async () => {
            if (res.locals?.authorizeStream && !(await res.locals.authorizeStream())) return false;
            if (authorizeResource) await authorizeResource();
            return true;
        },
        write: value => res.write(value),
        close: revoked => {
            if (res.destroyed || res.writableEnded) return;
            if (revoked?.status === 429) res.write(`event: error\ndata: ${JSON.stringify({ code: revoked.code, message: revoked.message })}\n\n`);
            else if (revoked) res.write('event: session-revoked\ndata: {}\n\n');
            res.end();
        }
    });
    res.on('close', () => channel.stop());
    return {
        send: (event, data) => channel.send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        ping: () => channel.send(': ping\n\n'),
        end: () => channel.end(),
        get open() { return channel.open; }
    };
}

module.exports = { authorizeSession, authorizedChannel, createSseChannel, reserveConnection };
