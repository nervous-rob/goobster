/**
 * Shared tool-result windowing (utils/toolResultWindow.js).
 *
 * File reads return a line window with a nextOffset instead of a silent
 * head-clip; run streams and prior-turn re-injection share the same caps.
 */
const {
    TOOL_RESULT_CHARS,
    STREAM_CHARS,
    PRIOR_RESULT_CHARS,
    PRIOR_BLOCK_CHARS,
    DEFAULT_READ_LINES,
    MAX_READ_LINES,
    windowLines,
    formatTextWindow,
    clipStream,
    fenceLanguage,
    clampReadLimit,
    clampReadOffset
} = require('@goobster/core/utils/toolResultWindow');

describe('caps', () => {
    test('live result, storage, and prior-turn budgets stay aligned', () => {
        expect(TOOL_RESULT_CHARS).toBeGreaterThanOrEqual(STREAM_CHARS);
        expect(PRIOR_RESULT_CHARS).toBeGreaterThan(4000);
        expect(PRIOR_BLOCK_CHARS).toBeGreaterThanOrEqual(PRIOR_RESULT_CHARS);
        expect(DEFAULT_READ_LINES).toBe(400);
        expect(MAX_READ_LINES).toBe(800);
    });
});

describe('windowLines', () => {
    const numbered = Array.from({ length: 600 }, (_, i) => `line-${i + 1}`).join('\n');

    test('defaults to the first 400 lines and points at the next offset', () => {
        const win = windowLines(numbered);
        expect(win.startLine).toBe(1);
        expect(win.endLine).toBe(400);
        expect(win.totalLines).toBe(600);
        expect(win.nextOffset).toBe(401);
        expect(win.truncated).toBe(true);
        expect(win.content).toContain('line-1');
        expect(win.content).toContain('line-400');
        expect(win.content).not.toContain('line-401');
    });

    test('offset+limit pages the rest of the file', () => {
        const win = windowLines(numbered, { offset: 401, limit: 400 });
        expect(win.startLine).toBe(401);
        expect(win.endLine).toBe(600);
        expect(win.nextOffset).toBeNull();
        expect(win.truncated).toBe(false);
        expect(win.content).toContain('line-401');
        expect(win.content).toContain('line-600');
        expect(win.content).not.toContain('line-400');
    });

    test('offset past the end is empty, not a wrap', () => {
        const win = windowLines(numbered, { offset: 900 });
        expect(win.content).toBe('');
        expect(win.startLine).toBe(900);
        expect(win.totalLines).toBe(600);
        expect(win.nextOffset).toBeNull();
    });

    test('limit and offset are clamped', () => {
        expect(clampReadLimit(0)).toBe(DEFAULT_READ_LINES);
        expect(clampReadLimit(10_000)).toBe(MAX_READ_LINES);
        expect(clampReadOffset(0)).toBe(1);
        expect(clampReadOffset(-3)).toBe(1);
        const long = Array.from({ length: 900 }, (_, i) => `n-${i + 1}`).join('\n');
        const win = windowLines(long, { offset: -1, limit: 10_000 });
        expect(win.startLine).toBe(1);
        expect(win.endLine).toBe(MAX_READ_LINES);
    });

    test('a single enormous line is character-capped', () => {
        const win = windowLines('x'.repeat(TOOL_RESULT_CHARS + 500), { limit: 10 });
        expect(win.charCapped).toBe(true);
        expect(win.content.length).toBe(TOOL_RESULT_CHARS);
        expect(win.truncated).toBe(true);
    });
});

describe('formatTextWindow', () => {
    test('renders a fence, a nextOffset hint, and never an absolute path', () => {
        const win = windowLines('a\nb\nc\nd', { offset: 1, limit: 2 });
        const text = formatTextWindow({
            label: 'src/main.py',
            size: 80,
            window: win,
            fence: 'python'
        });
        expect(text).toMatch(/^src\/main\.py lines 1-2 of 4 \(80 bytes\)/);
        expect(text).toContain('… more remains; continue with offset=3');
        expect(text).toContain('```python');
        expect(text).toContain('a\nb');
        expect(text).not.toMatch(/\/data\/sandbox/);
    });

    test('offset past the end is a clear observation, not an empty fence', () => {
        const win = windowLines('only\ntwo', { offset: 9 });
        const text = formatTextWindow({ label: 'notes.md', window: win });
        expect(text).toContain('has 2 lines');
        expect(text).toContain('offset=9 is past the end');
        expect(text).not.toContain('```');
    });
});

describe('clipStream', () => {
    test('passes through short streams and annotates long ones', () => {
        expect(clipStream('hello')).toBe('hello');
        const long = 'y'.repeat(STREAM_CHARS + 120);
        const clipped = clipStream(long, { hint: 'truncated — use read' });
        expect(clipped.startsWith('y'.repeat(STREAM_CHARS))).toBe(true);
        expect(clipped).toContain('120 chars omitted');
        expect(clipped).toContain('use read');
        expect(clipped.length).toBeLessThan(long.length);
    });
});

describe('fenceLanguage', () => {
    test('maps common extensions and an explicit fallback', () => {
        expect(fenceLanguage('main.py')).toBe('python');
        expect(fenceLanguage('app.js')).toBe('javascript');
        expect(fenceLanguage('unknown.bin')).toBe('');
        expect(fenceLanguage('x', 'html')).toBe('html');
    });
});
