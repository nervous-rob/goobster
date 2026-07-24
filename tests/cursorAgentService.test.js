/**
 * Cursor Cloud Agents API wrapper (services/cursorAgentService.js): the
 * not-configured guard, v1 request shapes (launch, follow-up, cancel), and
 * error mapping. No network — global.fetch is mocked.
 */
const integrationsConfig = require('../config/integrationsConfig');
const cursorAgentService = require('../services/cursorAgentService');

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    };
}

const MODELS_RESPONSE = {
    items: [
        { id: 'composer-2', displayName: 'Composer 2', aliases: ['composer-latest', 'composer'] },
        { id: 'claude-4.8-opus-thinking', displayName: 'Claude 4.8 Opus (Thinking)' },
        { id: 'claude-4.6-sonnet-thinking', displayName: 'Claude 4.6 Sonnet (Thinking)' }
    ]
};

describe('cursorAgentService', () => {
    let originalKey;
    let originalDefault;

    beforeEach(() => {
        originalKey = integrationsConfig.cursor.apiKey;
        originalDefault = integrationsConfig.cursor.defaultModel;
        integrationsConfig.cursor.defaultModel = null;
        cursorAgentService._modelsCache = null;
        global.fetch = jest.fn();
    });

    afterEach(() => {
        integrationsConfig.cursor.apiKey = originalKey;
        integrationsConfig.cursor.defaultModel = originalDefault;
        delete global.fetch;
    });

    test('every call fails fast with NOT_CONFIGURED when no key is set', async () => {
        integrationsConfig.cursor.apiKey = null;
        expect(cursorAgentService.isConfigured()).toBe(false);
        await expect(cursorAgentService.launchAgent({ prompt: 'x', repo: 'o/r' }))
            .rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('launchAgent posts the v1 create-agent shape with Bearer auth', async () => {
        integrationsConfig.cursor.apiKey = 'key_test';
        global.fetch
            .mockResolvedValueOnce(jsonResponse(MODELS_RESPONSE)) // model resolution
            .mockResolvedValueOnce(jsonResponse({
                agent: { id: 'bc-1', url: 'https://cursor.com/agents/bc-1' },
                run: { id: 'run-1', status: 'CREATING' }
            }));

        const { agent, run } = await cursorAgentService.launchAgent({
            prompt: 'Fix the flaky test',
            repo: 'nervous-rob/goobster',
            ref: 'main',
            autoCreatePr: true,
            model: 'composer-2'
        });

        const [url, options] = global.fetch.mock.calls[1];
        expect(String(url)).toBe('https://api.cursor.com/v1/agents');
        expect(options.method).toBe('POST');
        expect(options.headers.Authorization).toBe('Bearer key_test');
        expect(JSON.parse(options.body)).toEqual({
            prompt: { text: 'Fix the flaky test' },
            repos: [{ url: 'https://github.com/nervous-rob/goobster', startingRef: 'main' }],
            autoCreatePR: true,
            model: { id: 'composer-2' }
        });
        expect(agent.id).toBe('bc-1');
        expect(run.status).toBe('CREATING');
    });

    test('launchAgent omits startingRef and model when not provided', async () => {
        integrationsConfig.cursor.apiKey = 'key_test';
        global.fetch.mockResolvedValue(jsonResponse({ agent: { id: 'bc-2' }, run: { id: 'run-2' } }));

        await cursorAgentService.launchAgent({ prompt: 'x', repo: 'o/r' });

        // No model requested and no default: the models endpoint is never hit
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.repos).toEqual([{ url: 'https://github.com/o/r' }]);
        expect(body.model).toBeUndefined();
    });

    describe('model resolution', () => {
        beforeEach(() => {
            integrationsConfig.cursor.apiKey = 'key_test';
        });

        test('resolves exact ids, aliases, and fuzzy names', async () => {
            global.fetch.mockResolvedValue(jsonResponse(MODELS_RESPONSE));
            expect(await cursorAgentService.resolveModelId('claude-4.8-opus-thinking')).toBe('claude-4.8-opus-thinking');
            expect(await cursorAgentService.resolveModelId('composer-latest')).toBe('composer-2');
            // Anthropic-style id and a plain name both land on Cursor's slug
            expect(await cursorAgentService.resolveModelId('claude-opus-4-8')).toBe('claude-4.8-opus-thinking');
            expect(await cursorAgentService.resolveModelId('Claude Opus 4.8')).toBe('claude-4.8-opus-thinking');
            expect(await cursorAgentService.resolveModelId('gpt-99-nonexistent')).toBeNull();
            // Cached: all of the above used one models fetch
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        test('the configured default falls back to the account default when unresolvable', async () => {
            integrationsConfig.cursor.defaultModel = 'claude-opus-4-8';
            global.fetch
                .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'composer-2', displayName: 'Composer 2' }] }))
                .mockResolvedValueOnce(jsonResponse({ agent: { id: 'bc-3' }, run: { id: 'run-3' } }));

            await cursorAgentService.launchAgent({ prompt: 'x', repo: 'o/r' });
            const body = JSON.parse(global.fetch.mock.calls[1][1].body);
            expect(body.model).toBeUndefined();
        });

        test('an explicitly requested unknown model raises BAD_MODEL', async () => {
            global.fetch.mockResolvedValue(jsonResponse(MODELS_RESPONSE));
            await expect(cursorAgentService.launchAgent({ prompt: 'x', repo: 'o/r', model: 'made-up-model' }))
                .rejects.toMatchObject({ code: 'BAD_MODEL', message: expect.stringContaining('composer-2') });
        });

        test('a models-endpoint outage passes the requested model through', async () => {
            global.fetch.mockRejectedValueOnce(new Error('down'));
            expect(await cursorAgentService.resolveModelId('claude-4.8-opus-thinking')).toBe('claude-4.8-opus-thinking');
        });
    });

    test('followUp and cancelRun hit the per-agent run endpoints', async () => {
        integrationsConfig.cursor.apiKey = 'key_test';
        global.fetch.mockResolvedValue(jsonResponse({ id: 'run-9' }));

        await cursorAgentService.followUp('bc-1', 'also update the docs');
        expect(String(global.fetch.mock.calls[0][0])).toBe('https://api.cursor.com/v1/agents/bc-1/runs');
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ prompt: { text: 'also update the docs' } });

        await cursorAgentService.cancelRun('bc-1', 'run-9');
        expect(String(global.fetch.mock.calls[1][0])).toBe('https://api.cursor.com/v1/agents/bc-1/runs/run-9/cancel');
        expect(global.fetch.mock.calls[1][1].method).toBe('POST');
    });

    test('maps API failures to coded errors', async () => {
        integrationsConfig.cursor.apiKey = 'key_test';

        global.fetch.mockResolvedValueOnce(jsonResponse({}, 401));
        await expect(cursorAgentService.getAgent('bc-1')).rejects.toMatchObject({ code: 'BAD_KEY' });

        global.fetch.mockResolvedValueOnce(jsonResponse({}, 404));
        await expect(cursorAgentService.getRun('bc-1', 'run-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });

        global.fetch.mockResolvedValueOnce(jsonResponse({ error: { message: 'quota exceeded' } }, 429));
        await expect(cursorAgentService.getAgent('bc-1')).rejects.toMatchObject({ code: 'API_ERROR' });
    });

    test('isTerminalStatus recognizes the four terminal states', () => {
        for (const status of ['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED', 'finished']) {
            expect(cursorAgentService.isTerminalStatus(status)).toBe(true);
        }
        for (const status of ['CREATING', 'RUNNING', null, '']) {
            expect(cursorAgentService.isTerminalStatus(status)).toBe(false);
        }
    });
});
