/**
 * Optional integrations are inventoried once at process start.
 * Provider constructors must stay silent so Jest suites do not each
 * reprint the same missing-key warning.
 */
const reportIntegrations = require('@goobster/core/config/reportIntegrations');

describe('reportIntegrations', () => {
    beforeEach(() => {
        reportIntegrations._resetForTests();
    });

    test('logs the inventory once, and again only when forced', () => {
        const logger = { info: jest.fn(), warn: jest.fn() };
        reportIntegrations.reportIntegrations({ logger });
        reportIntegrations.reportIntegrations({ logger });
        expect(logger.info).toHaveBeenCalledTimes(1);
        expect(logger.info.mock.calls[0][0]).toMatch(/^\[integrations] /);
        expect(logger.info.mock.calls[0][0]).toMatch(/OpenAI=/);
        expect(logger.info.mock.calls[0][0]).toMatch(/Anthropic=/);
        expect(logger.info.mock.calls[0][0]).toMatch(/Gemini=/);

        reportIntegrations.reportIntegrations({ logger, force: true });
        expect(logger.info).toHaveBeenCalledTimes(2);
    });

    test('warns about the Ollama fallback only when no cloud provider is configured', () => {
        const logger = { info: jest.fn(), warn: jest.fn() };
        reportIntegrations.reportIntegrations({ logger });
        if (reportIntegrations.cloudProviders().length === 0) {
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringMatching(/No cloud AI provider/)
            );
        } else {
            expect(logger.warn).not.toHaveBeenCalled();
        }
    });
});

describe('provider constructors stay quiet', () => {
    test('requiring providers does not warn about missing keys', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.isolateModules(() => {
            require('@goobster/core/services/openaiService');
            require('@goobster/core/services/anthropicService');
            require('@goobster/core/services/geminiService');
            require('@goobster/core/services/perplexityService');
            require('@goobster/core/services/aiService');
            require('@goobster/core/services/voice/elevenLabsTTSService');
            require('@goobster/core/services/spotdl/spotdlService');
        });
        const noisy = warn.mock.calls.filter(([message]) =>
            /API key|not configured|ElevenLabs|Spotify|Ollama fallback/i.test(String(message))
        );
        warn.mockRestore();
        expect(noisy).toEqual([]);
    });
});
