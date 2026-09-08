/**
 * Shared SSE writers for portal turns (Study chat and Observatory commands).
 */

const { SSE_HEARTBEAT_MS, sendError } = require('./appHelpers');

/**
 * Stream one web chat turn back as Server-Sent Events (the event
 * vocabulary documented on POST /api/app/chat). Shared by the chat
 * composer and the Observatory's custom-command endpoint.
 */
async function streamWebChatTurn(res, turn, ctx) {
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
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => {
        if (open) res.write(': ping\n\n');
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
    // The turn keeps running if the browser disconnects (the reply is
    // stored in history either way) - we just stop writing. NOTE: the
    // listener must be on res, not req - a consumed POST body emits
    // req 'close' immediately, long before the client goes away.
    res.on('close', () => { open = false; });

    try {
        send('start', { conversationId: turn.conversationId });
        await turn.run({
            onTyping: () => send('typing', {}),
            onDelta: (text) => send('delta', { text }),
            onTool: (event) => send('tool', event),
            onMessage: (message) => send('message', message)
        });
        send('done', { ok: true, conversationId: turn.conversationId });
    } catch (error) {
        ctx.logger.error?.('Web chat turn failed:', error.message);
        send('error', { code: 'INTERNAL', message: 'Something went wrong generating the reply.' });
    } finally {
        clearInterval(heartbeat);
        if (open) res.end();
    }
}

/**
 * Stream one reserved parlor turn back as Server-Sent Events.
 * Live-session tap is cosmetic — never breaks the turn.
 */
async function streamParlorTurn(res, turn, ctx) {
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
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => {
        if (open) res.write(': ping\n\n');
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
    res.on('close', () => { open = false; });

    const observe = (event, data) => {
        try { ctx.parlorLive?.observeTurn(turn.conversationId, event, data); } catch { /* cosmetic */ }
    };
    const emit = (event, data) => {
        send(event, data);
        observe(event, data);
    };

    try {
        send('start', { conversationId: turn.conversationId });
        await turn.run({
            onUserMessage: (message) => emit('user_message', message),
            onPersonaStart: (persona) => emit('persona_start', persona),
            onPersonaPass: (payload) => emit('persona_pass', payload),
            onDelta: (text) => emit('delta', { text }),
            onPersonaTool: (payload) => emit('persona_tool', payload),
            onPersonaMessage: (message) => emit('persona_message', message),
            onLearned: (payload) => emit('learned', payload)
        });
        emit('done', { ok: true, conversationId: turn.conversationId });
    } catch (error) {
        ctx.logger.error?.('Parlor turn failed:', error.message);
        emit('error', { code: 'INTERNAL', message: 'Something went wrong generating the replies.' });
    } finally {
        clearInterval(heartbeat);
        if (open) res.end();
    }
}

/**
 * Reconnect to an in-flight Study turn. Sends `start` + `snapshot` (the
 * current thoughts/tools/draft), then the same live events as POST /chat,
 * then `done`. Draft text stays on this dedicated stream — never on the
 * portal event bus (ids and hints only).
 *
 * Local replica: attach to the in-process listeners. Other replicas poll
 * `web_live_turns.progressJson` until the row is gone.
 */
async function streamLiveTurnProgress(res, { userId, chat }) {
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
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => {
        if (open) res.write(': ping\n\n');
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    let unsubscribe = () => {};
    const waiters = new Set();
    const wakeAll = () => {
        for (const resolve of waiters) resolve();
        waiters.clear();
    };
    res.on('close', () => {
        open = false;
        try { unsubscribe(); } catch { /* already dropped */ }
        wakeAll();
    });

    const wait = (ms) => new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            waiters.delete(finish);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        timer.unref?.();
        waiters.add(finish);
    });

    try {
        for (;;) {
            if (!open) return;
            let settled = false;
            const settledPromise = new Promise((resolve) => {
                waiters.add(resolve);
            });
            const listener = {
                onTyping: () => send('typing', {}),
                onDelta: (text) => send('delta', { text }),
                onTool: (event) => send('tool', event),
                onMessage: (message) => send('message', message),
                onSettled: () => {
                    settled = true;
                    send('done', { ok: true });
                    wakeAll();
                }
            };
            const attached = chat.attachToTurn ? chat.attachToTurn(userId, listener) : null;
            if (attached?.turnId) {
                unsubscribe = attached.unsubscribe || (() => {});
                send('start', {
                    conversationId: attached.conversationId ?? null,
                    turnId: attached.turnId
                });
                send('snapshot', attached.snapshot || {});
                if (!settled) await settledPromise;
                return;
            }
            const persisted = typeof chat.getPersistedTurn === 'function'
                ? await chat.getPersistedTurn(userId)
                : null;
            if (!persisted) {
                send('done', { ok: true });
                return;
            }
            send('start', {
                conversationId: persisted.conversationId ?? null,
                turnId: persisted.turnId
            });
            send('snapshot', persisted.progress || {});
            let lastJson = JSON.stringify(persisted.progress || {});
            while (open) {
                await wait(400);
                if (!open) return;
                const retry = chat.attachToTurn ? chat.attachToTurn(userId, listener) : null;
                if (retry?.turnId) {
                    unsubscribe = retry.unsubscribe || (() => {});
                    send('snapshot', retry.snapshot || {});
                    if (!settled) await settledPromise;
                    return;
                }
                const next = typeof chat.getPersistedTurn === 'function'
                    ? await chat.getPersistedTurn(userId)
                    : null;
                if (!next) {
                    send('done', { ok: true });
                    return;
                }
                const json = JSON.stringify(next.progress || {});
                if (json !== lastJson) {
                    lastJson = json;
                    send('snapshot', next.progress || {});
                }
            }
            return;
        }
    } finally {
        clearInterval(heartbeat);
        try { unsubscribe(); } catch { /* already dropped */ }
        wakeAll();
        if (open) res.end();
    }
}

function beginSseError(res, ctx, error, fallbackMessage = 'Something went wrong.') {
    const status = error.status || 500;
    sendError(res, status, error.code || 'INTERNAL',
        status === 500 ? fallbackMessage : error.message,
        error.details || null);
}

module.exports = { streamWebChatTurn, streamParlorTurn, streamLiveTurnProgress, beginSseError };
