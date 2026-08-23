import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { NoteEditor } from './NoteEditor';
import { TYPE_COLORS } from '../renderers/graph.js';
import type { UserNote, NotesPayload } from '../lib/types';

type SortKey = 'updated' | 'label' | 'type';

const TYPE_COLOR_MAP = TYPE_COLORS as Record<string, string>;

function whenLabel(iso?: string): string {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function excerpt(content?: string | null): string {
    const text = String(content || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

function metaLine(note: UserNote): string {
    const parts = [note.type];
    if (note.source && note.source !== 'user') parts.push(note.source);
    if (note.tags?.length) parts.push(note.tags.join(', '));
    const when = whenLabel(note.updatedAt);
    if (when) parts.push(when);
    return parts.join(' · ');
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

    const usedTypes = data?.types || [];
    const usedTags = data?.tags || [];
    const usedSources = (data?.sources || []).filter((row) => row.source);
    const filtered = Boolean(type || tag || source || q.trim());

    function invalidateNotes() {
        queryClient.invalidateQueries({ queryKey: keys.spitballNotesRoot(scope) });
        queryClient.invalidateQueries({ queryKey: keys.memory(scope, 'map') });
        queryClient.invalidateQueries({ queryKey: keys.memory(scope, 'facts') });
    }

    async function removeNote(note: UserNote) {
        if (!await confirm(`Delete “${note.label}”? This removes it from the map too.`)) return;
        try {
            await api.spitballDeleteNote(scope, note.id);
            toast('Note deleted.');
            invalidateNotes();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    return (
        <div className="mtab mtab-notes">
            <div className="notes-bar">
                <input
                    className="input"
                    type="search"
                    placeholder="Search notes"
                    value={q}
                    onChange={(event) => setQ(event.target.value)}
                />
                <button type="button" className="btn primary" onClick={() => setEditor('new')}>
                    New note
                </button>
            </div>

            {usedTypes.length > 1 && (
                <div className="notes-chips" role="tablist" aria-label="Filter by type">
                    <button
                        type="button"
                        className={`notes-chip${type === '' ? ' on' : ''}`}
                        onClick={() => setType('')}
                    >
                        All
                    </button>
                    {usedTypes.map((row) => (
                        <button
                            key={row.type}
                            type="button"
                            className={`notes-chip${type === row.type ? ' on' : ''}`}
                            onClick={() => setType(type === row.type ? '' : row.type)}
                        >
                            <span className="notes-dot" style={{ background: TYPE_COLOR_MAP[row.type] || 'var(--accent)' }} />
                            {row.type}
                            <span className="notes-chip-count">{row.c}</span>
                        </button>
                    ))}
                </div>
            )}

            <div className="notes-meta">
                <span>
                    {notesQ.isPending
                        ? 'Loading…'
                        : `${data?.total ?? 0} note${(data?.total ?? 0) === 1 ? '' : 's'}`}
                </span>
                {(usedTags.length > 0 || usedSources.length > 1) && (
                    <span className="notes-meta-filters">
                        {usedTags.length > 0 && (
                            <select
                                className="notes-quiet-select"
                                aria-label="Filter by tag"
                                value={tag}
                                onChange={(event) => setTag(event.target.value)}
                            >
                                <option value="">Any tag</option>
                                {usedTags.map((item) => (
                                    <option key={item.name} value={item.name}>{item.name}</option>
                                ))}
                            </select>
                        )}
                        {usedSources.length > 1 && (
                            <select
                                className="notes-quiet-select"
                                aria-label="Filter by source"
                                value={source}
                                onChange={(event) => setSource(event.target.value)}
                            >
                                <option value="">Any source</option>
                                {usedSources.map((item) => (
                                    <option key={item.source} value={item.source}>{item.source}</option>
                                ))}
                            </select>
                        )}
                    </span>
                )}
                <select
                    className="notes-quiet-select"
                    aria-label="Sort notes"
                    value={sort}
                    onChange={(event) => setSort(event.target.value as SortKey)}
                >
                    <option value="updated">Recent</option>
                    <option value="label">Title</option>
                    <option value="type">Type</option>
                </select>
                {filtered && (
                    <button
                        type="button"
                        className="notes-clear"
                        onClick={() => { setQ(''); setType(''); setTag(''); setSource(''); }}
                    >
                        Clear
                    </button>
                )}
            </div>

            {notesQ.isError && <div className="empty">{(notesQ.error as Error).message}</div>}
            {!notesQ.isPending && notes.length === 0 && (
                <div className="empty">
                    {filtered ? 'Nothing matches those filters.' : 'No notes yet — write one, or talk in the Study.'}
                </div>
            )}

            {notes.length > 0 && (
                <div className="notes-list">
                    {notes.map((item) => (
                        <div key={item.id} className="notes-row">
                            <button
                                type="button"
                                className="notes-row-main"
                                onClick={() => setEditor(item)}
                            >
                                <span
                                    className="notes-dot"
                                    style={{ background: TYPE_COLOR_MAP[item.type] || 'var(--accent)' }}
                                    aria-hidden
                                />
                                <span className="notes-row-copy">
                                    <span className="notes-row-title">{item.label}</span>
                                    {excerpt(item.content) ? (
                                        <span className="notes-row-excerpt">{excerpt(item.content)}</span>
                                    ) : null}
                                    <span className="notes-row-sub">{metaLine(item)}</span>
                                </span>
                            </button>
                            <button
                                type="button"
                                className="row-delete"
                                title="Delete"
                                onClick={() => removeNote(item)}
                            >
                                ✕
                            </button>
                        </div>
                    ))}
                </div>
            )}

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
