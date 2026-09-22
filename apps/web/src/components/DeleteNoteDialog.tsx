import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useMe } from '../hooks/useSession';
import { useToast } from '../hooks/useToast';
import { Modal } from './Modal';
import { describeAudience } from './TransferNoteModal';
import type { NoteDestinations, UserNote } from '../lib/types';

/** The caller's own space (`dm:<userId>`) - the only scope whose notes can be transferred. */
export function isPersonalScope(scope: string): boolean {
    return scope.startsWith('dm:');
}

/** What deleting this note does - and does not - remove (ADR 0008 §6). */
export function deleteNoteWarning(note: UserNote): string {
    const base = `Delete “${note.label}”? This removes the note, its connections, tags and evidence links from the Map.`;
    if (note.type === 'fact') {
        return `${base} It is a distilled fact, so Goobster forgets the fact too. The raw memories and chats it came from are not deleted.`;
    }
    return `${base} Raw memories and chat transcripts it was distilled from are not deleted - manage those in Personal memory.`;
}

/**
 * Deleting a personal note names every scope the note has reached (ADR
 * 0010 §4): references vanish with it, published copies stay unless the
 * caller ticks them here, and a message already in a discussion is part of
 * that transcript. Nothing is removed silently.
 */
export function DeleteNoteDialog({
    scope,
    note,
    onClose,
    onDeleted
}: {
    scope: string;
    note: UserNote;
    onClose: () => void;
    onDeleted: () => void;
}) {
    const me = useMe();
    const toast = useToast();
    const [alsoRemove, setAlsoRemove] = useState<Record<number, boolean>>({});
    const [busy, setBusy] = useState(false);
    // Only personal notes travel (ADR 0010); a server scope has no ledger to check.
    const personal = isPersonalScope(scope);
    const destinationsQ = useQuery({
        queryKey: keys.noteTransfers(note.id),
        queryFn: () => api.noteTransfers(note.id) as Promise<NoteDestinations>,
        enabled: personal,
        retry: false
    });
    const dest = destinationsQ.data;
    const references = (dest?.projects || []).filter((row) => row.mode === 'reference');
    const copies = (dest?.projects || []).filter((row) => row.mode === 'copy');
    const discussions = (dest?.discussions || []).filter((row) => row.messageExists);
    const reached = references.length + copies.length + discussions.length > 0;

    async function remove() {
        setBusy(true);
        const failures: string[] = [];
        try {
            for (const copy of copies) {
                if (!alsoRemove[copy.transferId] || !copy.canRemove || !copy.copyNodeId) continue;
                try {
                    await api.deleteProjectKnowledgeNote(copy.slug, copy.copyNodeId, copy.ownerId);
                } catch (error) {
                    failures.push(`${copy.name}: ${(error as Error).message}`);
                }
            }
            await api.spitballDeleteNote(scope, note.id);
            if (failures.length) toast(`Note deleted, but some copies stayed - ${failures.join('; ')}`, true);
            else toast('Note deleted.');
            onDeleted();
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal onClose={onClose} className="delete-note-dialog">
            <h2>Delete note</h2>
            <p className="hint">{deleteNoteWarning(note)}</p>
            {personal && destinationsQ.isPending && <div className="hint">Checking where this note has gone…</div>}
            {destinationsQ.isError && (
                <div className="hint">Could not check where this note has gone: {(destinationsQ.error as Error).message}</div>
            )}
            {dest && reached && (
                <div className="delete-note-scopes" data-testid="delete-note-scopes">
                    <div className="section-title">This note has also reached</div>
                    <ul className="delete-note-list">
                        {references.map((row) => (
                            <li key={row.transferId}>
                                <strong>{row.name}</strong> (your private project) — referenced there, only you could see it.
                                The reference goes with the note.
                            </li>
                        ))}
                        {copies.map((row) => (
                            <li key={row.transferId}>
                                <label className="delete-note-choice">
                                    <input
                                        type="checkbox"
                                        disabled={!row.canRemove}
                                        checked={Boolean(alsoRemove[row.transferId])}
                                        onChange={(event) => setAlsoRemove((prev) => ({ ...prev, [row.transferId]: event.target.checked }))}
                                    />
                                    <span>
                                        <strong>{row.name}</strong>
                                        {row.role === 'collaborator' ? ` (${row.audience?.ownerName || row.ownerId}'s project)` : ''} — a published copy,
                                        readable by {describeAudience(row.audience, me.user.id) || 'the project'}.
                                        {' '}
                                        {row.canRemove
                                            ? 'Tick to remove that copy too; otherwise it stays in the project.'
                                            : 'You cannot remove it; it stays in the project.'}
                                    </span>
                                </label>
                            </li>
                        ))}
                        {discussions.map((row) => (
                            <li key={row.transferId}>
                                <strong>{row.title || `Discussion #${row.conversationId}`}</strong> — posted as a message from you;
                                it stays in that transcript.
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {dest && !reached && <div className="hint">It has not been added to any project or discussion.</div>}
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button
                    type="button"
                    className="btn danger"
                    data-testid="delete-note-confirm"
                    disabled={busy || (personal && destinationsQ.isPending)}
                    onClick={() => void remove()}
                >
                    {busy ? 'Deleting…' : 'Delete'}
                </button>
            </div>
        </Modal>
    );
}
