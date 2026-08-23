import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { NoteEditor } from './NoteEditor';
import type { UserNote, NotesPayload } from '../lib/types';

type SortKey = 'updated' | 'label' | 'type';

function whenLabel(iso?: string): string {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export function NotesTab({ scope }: { scope: string }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [q, setQ] = useState('');
    const [type, setType] = useState('');
    const [tag, setTag] = useState('');
    const [source, setSource] = useState('');
    const [sort, setSort] = useState<SortKey>('updated');
    const [editor, setEditor] = useState<UserNote | 'new' | null>(null);

    const filters = { q: q.trim(), type, tag, source };
    const notesQ = useQuery({
        queryKey: keys.spitballNotes(scope, filters),
        queryFn: () => api.spitballNotes(scope, { ...filters, limit: 1000 }) as Promise<NotesPayload>,
        enabled: Boolean(scope)
    });
    const data = notesQ.data;
    const notes = useMemo(() => {
        const rows = [...(data?.notes || [])];
        if (sort === 'label') rows.sort((a, b) => a.label.localeCompare(b.label));
        else if (sort === 'type') rows.sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label));
        return rows;
    }, [data?.notes, sort]);

    function invalidateNotes() {
        queryClient.invalidateQueries({ queryKey: keys.spitballNotesRoot(scope) });
        queryClient.invalidateQueries({ queryKey: keys.memory(scope, 'map') });
        queryClient.invalidateQueries({ queryKey: keys.memory(scope, 'facts') });
    }

    return (
        <div className="mtab mtab-notes">
            <div className="notes-toolbar">
                <input
                    className="input"
                    type="search"
                    placeholder="Search titles, content, tags…"
                    value={q}
                    onChange={(event) => setQ(event.target.value)}
                />
                <select className="select" aria-label="Sort notes" value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
                    <option value="updated">Recently updated</option>
                    <option value="label">Title</option>
                    <option value="type">Type</option>
                </select>
                <button type="button" className="btn primary" onClick={() => setEditor('new')}>✚ New note</button>
            </div>
            <div className="notes-filters">
                <select className="select" aria-label="Filter by type" value={type} onChange={(event) => setType(event.target.value)}>
                    <option value="">All types</option>
                    {(data?.nodeTypes || []).map((item) => (
                        <option key={item} value={item}>{item}</option>
                    ))}
                </select>
                <select className="select" aria-label="Filter by tag" value={tag} onChange={(event) => setTag(event.target.value)}>
                    <option value="">All tags</option>
                    {(data?.tags || []).map((item) => (
                        <option key={item.name} value={item.name}>{item.name} ({item.uses})</option>
                    ))}
                </select>
                <select className="select" aria-label="Filter by source" value={source} onChange={(event) => setSource(event.target.value)}>
                    <option value="">All sources</option>
                    {(data?.nodeSources || []).map((item) => (
                        <option key={item} value={item}>{item}</option>
                    ))}
                </select>
                <span className="hint">
                    {notesQ.isPending
                        ? 'Loading…'
                        : `${notes.length} of ${data?.total ?? 0} notes · cap ${data?.cap ?? '—'}`}
                </span>
            </div>
            {notesQ.isError && <div className="empty">{(notesQ.error as Error).message}</div>}
            {!notesQ.isPending && notes.length === 0 && (
                <div className="empty">No notes match — write one, or loosen the filters.</div>
            )}
            <div className="workspace-notes">
                {notes.map((item) => (
                    <div key={item.id} className="note-card">
                        <div className="note-head">
                            <span className="note-title">{item.label}</span>
                            <span className="note-actions">
                                <button type="button" className="conv-action" title="Edit" onClick={() => setEditor(item)}>✎</button>
                                <button
                                    type="button"
                                    className="conv-action"
                                    title="Delete"
                                    onClick={async () => {
                                        if (!await confirm(`Delete “${item.label}”? This removes it from the map too.`)) return;
                                        try {
                                            await api.spitballDeleteNote(scope, item.id);
                                            toast('Note deleted.');
                                            invalidateNotes();
                                        } catch (error) {
                                            toast((error as Error).message, true);
                                        }
                                    }}
                                >🗑</button>
                            </span>
                        </div>
                        {item.content ? <div className="note-body">{item.content}</div> : null}
                        <div className="note-foot">
                            <span className="badge">{item.type}</span>
                            {item.source ? <span className="badge">{item.source}</span> : null}
                            {(item.tags || []).map((name) => <span key={name} className="gchip">{name}</span>)}
                            <span className="note-when">{whenLabel(item.updatedAt)}</span>
                        </div>
                    </div>
                ))}
            </div>
            {editor && (
                <NoteEditor
                    scope={scope}
                    note={editor === 'new' ? null : editor}
                    onClose={() => setEditor(null)}
                    onSaved={() => {
                        setEditor(null);
                        invalidateNotes();
                    }}
                />
            )}
        </div>
    );
}
