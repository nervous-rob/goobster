import { useEffect, useRef } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, gutter, GutterMarker } from '@codemirror/view';
import { EditorState, StateEffect, StateField, RangeSet, RangeSetBuilder, type Text } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { oneDark } from '@codemirror/theme-one-dark';
import { diffLines } from 'diff';

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

/** The selected text and the lines it spans (1-based), or empty. */
export type EditorSelection = { text: string; fromLine: number; toLine: number; empty: boolean };

// --- Git gutter: added / modified / deleted lines against a base text --------------

type GitKind = 'added' | 'modified' | 'deleted';
const GIT_TITLES: Record<GitKind, string> = { added: 'Added since HEAD', modified: 'Changed since HEAD', deleted: 'Lines removed here since HEAD' };

class GitMark extends GutterMarker {
    constructor(readonly kind: GitKind) { super(); }
    eq(other: GitMark) { return other.kind === this.kind; }
    toDOM() {
        const el = document.createElement('div');
        el.className = `cm-git-mark is-${this.kind}`;
        el.title = GIT_TITLES[this.kind];
        return el;
    }
}
const MARKS: Record<GitKind, GitMark> = { added: new GitMark('added'), modified: new GitMark('modified'), deleted: new GitMark('deleted') };
const setGitMarks = StateEffect.define<RangeSet<GutterMarker>>();
const gitMarksField = StateField.define<RangeSet<GutterMarker>>({
    create: () => RangeSet.empty,
    update(value, tr) {
        let next = value.map(tr.changes);
        for (const effect of tr.effects) if (effect.is(setGitMarks)) next = effect.value;
        return next;
    }
});
const gitGutter = [
    gitMarksField,
    gutter({ class: 'cm-git-gutter', markers: (view) => view.state.field(gitMarksField) })
];

/** Marks for `doc` against `base`, one per line, in document order. */
export function gitMarks(doc: Text, base: string): RangeSet<GutterMarker> {
    const builder = new RangeSetBuilder<GutterMarker>();
    const parts = diffLines(base, doc.toString());
    let line = 1;
    let last = 0;
    const mark = (lineNumber: number, kind: GitKind) => {
        const n = Math.min(Math.max(lineNumber, 1), doc.lines);
        if (n <= last) return;
        last = n;
        builder.add(doc.line(n).from, doc.line(n).from, MARKS[kind]);
    };
    const countOf = (part: { count?: number; value: string }) =>
        part.count ?? (part.value.endsWith('\n') ? part.value.split('\n').length - 1 : part.value.split('\n').length);
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.removed) {
            const next = parts[i + 1];
            if (next?.added) {
                for (let k = 0; k < countOf(next); k++) mark(line + k, 'modified');
                line += countOf(next);
                i++;
            } else {
                mark(line, 'deleted');
            }
        } else if (part.added) {
            for (let k = 0; k < countOf(part); k++) mark(line + k, 'added');
            line += countOf(part);
        } else {
            line += countOf(part);
        }
    }
    return builder.finish();
}

export function CodeEditor({
    value,
    language,
    readOnly = false,
    onChange,
    gitBase = null,
    onSelectionChange,
    onSave
}: {
    value: string;
    language?: string | null;
    readOnly?: boolean;
    onChange?: (value: string) => void;
    /** The text at HEAD: shows a gutter of added / changed / removed lines. */
    gitBase?: string | null;
    onSelectionChange?: (selection: EditorSelection) => void;
    /** Ctrl/Cmd+S. */
    onSave?: () => void;
}) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onSelectionRef = useRef(onSelectionChange);
    onSelectionRef.current = onSelectionChange;
    const onSaveRef = useRef(onSave);
    onSaveRef.current = onSave;
    const baseRef = useRef<string | null>(gitBase);
    baseRef.current = gitBase;
    const marksTimer = useRef<number | undefined>(undefined);

    const refreshMarks = (view: EditorView) => {
        window.clearTimeout(marksTimer.current);
        marksTimer.current = window.setTimeout(() => {
            const base = baseRef.current;
            if (viewRef.current !== view) return;
            view.dispatch({ effects: setGitMarks.of(base == null ? RangeSet.empty : gitMarks(view.state.doc, base)) });
        }, 200);
    };

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const extensions = [
            lineNumbers(),
            gitGutter,
            highlightActiveLine(),
            history(),
            bracketMatching(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            keymap.of([
                { key: 'Mod-s', preventDefault: true, run: () => { onSaveRef.current?.(); return Boolean(onSaveRef.current); } },
                ...defaultKeymap, ...historyKeymap, indentWithTab
            ]),
            languageExtension(language),
            oneDark,
            EditorView.editable.of(!readOnly),
            EditorState.readOnly.of(readOnly),
            EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                    onChangeRef.current?.(update.state.doc.toString());
                    refreshMarks(update.view);
                }
                if ((update.selectionSet || update.docChanged) && onSelectionRef.current) {
                    const range = update.state.selection.main;
                    const doc = update.state.doc;
                    onSelectionRef.current({
                        text: doc.sliceString(range.from, range.to),
                        fromLine: doc.lineAt(range.from).number,
                        toLine: doc.lineAt(range.to).number,
                        empty: range.empty
                    });
                }
            }),
            EditorView.theme({
                '&': { height: '100%', fontSize: '13px' },
                '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
                '.cm-git-gutter': { width: '4px', marginRight: '2px' },
                '.cm-git-mark': { width: '3px', height: '100%' },
                '.cm-git-mark.is-added': { background: '#3fb950' },
                '.cm-git-mark.is-modified': { background: '#d29922' },
                '.cm-git-mark.is-deleted': { borderTop: '3px solid #f85149', height: '0' }
            })
        ];
        const view = new EditorView({
            state: EditorState.create({ doc: value, extensions }),
            parent: host
        });
        viewRef.current = view;
        refreshMarks(view);
        return () => {
            window.clearTimeout(marksTimer.current);
            view.destroy();
            viewRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
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

    useEffect(() => {
        const view = viewRef.current;
        if (view) refreshMarks(view);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gitBase]);

    return <div ref={hostRef} className="cm-host" />;
}
