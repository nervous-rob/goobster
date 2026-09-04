/**
 * The toolsRegistry facade must keep the historical definition order
 * after the capability split (voice subsets and prompt builders walk
 * getDefinitions() in this sequence).
 */
const { TOOL_ORDER, getDefinitions } = require('@goobster/core/utils/toolsRegistry');

describe('toolsRegistry catalog', () => {
    test('TOOL_ORDER is the pre-split sequence', () => {
        expect(TOOL_ORDER[0]).toBe('performSearch');
        expect(TOOL_ORDER[1]).toBe('generateImage');
        expect(TOOL_ORDER[2]).toBe('runCode');
        expect(TOOL_ORDER[3]).toBe('observatory');
        expect(TOOL_ORDER).toContain('manageParlor');
        expect(TOOL_ORDER).toContain('tavernInfo');
        expect(TOOL_ORDER[TOOL_ORDER.length - 1]).toBe('executePlan');
        expect(TOOL_ORDER).toHaveLength(48);
        expect(new Set(TOOL_ORDER).size).toBe(48);
    });

    test('getDefinitions preserves that order after gating', async () => {
        const names = (await getDefinitions()).map(def => def.name);
        expect(names).toEqual(TOOL_ORDER.filter(name => names.includes(name)));
    });
});
