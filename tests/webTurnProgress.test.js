const {
    emptyProgress,
    applyProgressEvent,
    parseProgress,
    cloneProgress
} = require('@goobster/core/utils/webTurnProgress');

describe('webTurnProgress', () => {
    test('accumulates draft tokens and keeps userContent', () => {
        const progress = emptyProgress('hello there');
        applyProgressEvent(progress, 'typing');
        applyProgressEvent(progress, 'delta', 'Hel');
        applyProgressEvent(progress, 'delta', 'lo');
        expect(progress).toMatchObject({
            userContent: 'hello there',
            draft: 'Hello',
            typing: false,
            steps: []
        });
    });

    test('moves interstitial draft into a text step when a tool starts', () => {
        const progress = emptyProgress('q');
        applyProgressEvent(progress, 'delta', 'Looking that up.');
        applyProgressEvent(progress, 'tool', { phase: 'start', id: 'c1', name: 'performSearch' });
        expect(progress.draft).toBe('');
        expect(progress.steps).toEqual([
            { type: 'text', content: 'Looking that up.' },
            expect.objectContaining({ type: 'tool', id: 'c1', name: 'performSearch', running: true })
        ]);
        applyProgressEvent(progress, 'tool', {
            phase: 'result', id: 'c1', name: 'performSearch', isError: false, resultPreview: 'ok'
        });
        expect(progress.steps[1]).toMatchObject({ running: false, resultPreview: 'ok' });
    });

    test('a completed assistant message clears the live snapshot', () => {
        const progress = emptyProgress('q');
        applyProgressEvent(progress, 'delta', 'partial');
        applyProgressEvent(progress, 'tool', { phase: 'start', name: 'runCode' });
        applyProgressEvent(progress, 'message', { content: 'done' });
        expect(progress).toMatchObject({ userContent: 'q', draft: '', typing: false, steps: [] });
    });

    test('parseProgress tolerates bad JSON', () => {
        expect(parseProgress('not-json')).toEqual(emptyProgress());
        expect(cloneProgress(parseProgress('{"draft":"x","steps":[{"type":"text","content":"a"}]}')).draft).toBe('x');
    });
});
