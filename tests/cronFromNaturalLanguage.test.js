/**
 * Shared NL → cron converter used by /automation and /digest schedule.
 */
const mockAi = {
    chatText: jest.fn()
};
jest.mock('@goobster/core/services/aiService', () => mockAi);

const { cronFromNaturalLanguage } = require('@goobster/core/utils/cronFromNaturalLanguage');
const { CRON_FROM_NL_SYSTEM } = require('@goobster/core/utils/chat/promptFragments');

beforeEach(() => {
    mockAi.chatText.mockReset();
});

describe('cronFromNaturalLanguage', () => {
    test('sends the shared converter prompt and returns a 5-part cron', async () => {
        mockAi.chatText.mockResolvedValue('0 9 * * 1-5');
        const cron = await cronFromNaturalLanguage('weekday mornings');
        expect(cron).toBe('0 9 * * 1-5');
        expect(mockAi.chatText).toHaveBeenCalledWith(
            [
                { role: 'system', content: CRON_FROM_NL_SYSTEM },
                { role: 'user', content: 'weekday mornings' }
            ],
            expect.objectContaining({ preset: 'deterministic' })
        );
    });

    test('rejects INVALID and malformed expressions', async () => {
        mockAi.chatText.mockResolvedValue('INVALID');
        await expect(cronFromNaturalLanguage('whenever')).rejects.toThrow(/understand the schedule/);

        mockAi.chatText.mockResolvedValue('0 9 * *');
        await expect(cronFromNaturalLanguage('broken')).rejects.toThrow(/valid schedule format/);

        mockAi.chatText.mockResolvedValue('foo bar baz qux quux');
        await expect(cronFromNaturalLanguage('impossible')).rejects.toThrow(/valid schedule/);
    });
});
