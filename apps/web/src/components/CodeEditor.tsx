import { useEffect, useRef } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { oneDark } from '@codemirror/theme-one-dark';

function languageExtension(language?: string | null) {
    const key = String(language || '').toLowerCase();
    if (key === 'javascript' || key === 'js' || key === 'jsx' || key === 'ts' || key === 'tsx') {
        return javascript();
    }
    if (key === 'python' || key === 'py') return python();
    if (key === 'html' || key === 'htm' || key === 'svg') return html();
    if (key === 'markdown' || key === 'md') return markdown();
    if (key === 'json') return json();
    if (key === 'css') return css();
    return [];
}

export function languageFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const map: Record<string, string> = {
        js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
        ts: 'javascript', tsx: 'javascript',
        py: 'python', html: 'html', htm: 'html', svg: 'html',
        md: 'markdown', json: 'json', css: 'css'
    };
    return map[ext] || 'text';
}

export function CodeEditor({
    value,
    language,
    readOnly = false,
    onChange
}: {
    value: string;
    language?: string | null;
    readOnly?: boolean;
    onChange?: (value: string) => void;
}) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const extensions = [
            lineNumbers(),
            highlightActiveLine(),
            history(),
            bracketMatching(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
            languageExtension(language),
            oneDark,
            EditorView.editable.of(!readOnly),
            EditorState.readOnly.of(readOnly),
            EditorView.updateListener.of((update) => {
                if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
            }),
            EditorView.theme({
                '&': { height: '100%', fontSize: '13px' },
                '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
            })
        ];
        const view = new EditorView({
            state: EditorState.create({ doc: value, extensions }),
            parent: host
        });
        viewRef.current = view;
        return () => {
            view.destroy();
            viewRef.current = null;
        };
    }, [language, readOnly]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        const current = view.state.doc.toString();
        if (current === value) return;
        view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: value }
        });
    }, [value]);

    return <div ref={hostRef} className="cm-host" />;
}
