/**
 * Reconnect SSE for an in-flight Study turn: the stream is bound to the
 * turnId it first saw, so a queued follow-up (even in another chat) cannot
 * splice its snapshot into the previous conversation.
 */
const { streamLiveTurnProgress } = require('@goobster/core/web/appStream');

function mockRes() {
    const chunks = [];
    const listeners = {};
    const res = {
        chunks,
        ended: false,
        status() { return this; },
        set() { return this; },
        flushHeaders() {},
        write(chunk) { chunks.push(String(chunk)); },
        end() { this.ended = true; },
        on(event, fn) { listeners[event] = fn; }
    };
    return res;
}

function sseEvents(res) {
    return res.chunks.join('').split('\n\n')
        .map((block) => {
            const event = block.match(/^event: (.*)$/m)?.[1];
            const data = block.match(/^data: (.*)$/m)?.[1];
            return event ? { event, data: data ? JSON.parse(data) : null } : null;
        })
        .filter(Boolean);
}

function noLocalTurn() {
    return { snapshot: null, conversationId: null, turnId: null, unsubscribe: () => {} };
}

test('reconnect poll ends when the original turnId is replaced', async () => {
    const res = mockRes();
    let calls = 0;
    const chat = {
        attachToTurn: () => noLocalTurn(),
        getPersistedTurn: async () => {
            calls += 1;
            if (calls === 1) {
                return {
                    turnId: 'turn-a',
                    conversationId: 1,
                    progress: { userContent: 'first', draft: 'Hel', typing: false, steps: [] }
                };
            }
            return {
                turnId: 'turn-b',
                conversationId: 2,
                progress: { userContent: 'second', draft: 'Other chat', typing: false, steps: [] }
            };
        }
    };
    await streamLiveTurnProgress(res, { userId: 'u1', chat });
    const events = sseEvents(res);
    expect(events[0]).toEqual({
        event: 'start', data: { conversationId: 1, turnId: 'turn-a' }
    });
    expect(events.find((row) => row.event === 'snapshot').data.draft).toBe('Hel');
    expect(events.some((row) => row.data?.draft === 'Other chat')).toBe(false);
    expect(events.some((row) => row.data?.turnId === 'turn-b')).toBe(false);
    expect(events.at(-1).event).toBe('done');
    expect(res.ended).toBe(true);
});

test('switching to a local listener for a different turn ends the stream', async () => {
    const res = mockRes();
    const unsubscribeB = jest.fn();
    let attachCalls = 0;
    const chat = {
        attachToTurn: () => {
            attachCalls += 1;
            if (attachCalls === 1) return noLocalTurn();
            return {
                snapshot: { draft: 'next chat' },
                conversationId: 99,
                turnId: 'turn-b',
                unsubscribe: unsubscribeB
            };
        },
        getPersistedTurn: async () => ({
            turnId: 'turn-a',
            conversationId: 1,
            progress: { draft: 'first' }
        })
    };
    await streamLiveTurnProgress(res, { userId: 'u1', chat });
    const events = sseEvents(res);
    expect(events.find((row) => row.event === 'start').data.turnId).toBe('turn-a');
    expect(events.some((row) => row.data?.draft === 'next chat')).toBe(false);
    expect(unsubscribeB).toHaveBeenCalled();
    expect(events.at(-1).event).toBe('done');
});

test('switching to a local listener for the same turn keeps watching it', async () => {
    const res = mockRes();
    let attachCalls = 0;
    const chat = {
        attachToTurn: (_userId, listener) => {
            attachCalls += 1;
            if (attachCalls === 1) return noLocalTurn();
            queueMicrotask(() => listener.onSettled?.());
            return {
                snapshot: { draft: 'still going' },
                conversationId: 1,
                turnId: 'turn-a',
                unsubscribe: () => {}
            };
        },
        getPersistedTurn: async () => ({
            turnId: 'turn-a',
            conversationId: 1,
            progress: { draft: 'first' }
        })
    };
    await streamLiveTurnProgress(res, { userId: 'u1', chat });
    const events = sseEvents(res);
    expect(events.find((row) => row.event === 'start').data.turnId).toBe('turn-a');
    expect(events.some((row) => row.data?.draft === 'still going')).toBe(true);
    expect(events.at(-1).event).toBe('done');
});
