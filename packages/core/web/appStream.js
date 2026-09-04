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

function beginSseError(res, ctx, error, fallbackMessage = 'Something went wrong.') {
    const status = error.status || 500;
    sendError(res, status, error.code || 'INTERNAL',
        status === 500 ? fallbackMessage : error.message,
        error.details || null);
}

module.exports = { streamWebChatTurn, streamParlorTurn, beginSseError };
