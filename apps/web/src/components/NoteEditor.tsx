import { useEffect, useRef, useState } from 'react';
import { useAttachmentDrop } from '../hooks/useAttachmentDrop';
import { markdownLink, MAX_ATTACHMENT_BYTES, type AttachmentDrop, type DroppedLink } from '../lib/attachmentDrop';
import { Markdown } from './Markdown';
import { useMutation } from '@tanstack/react-query';
import { Modal } from './Modal';
import { useToast } from '../hooks/useToast';
import { api, ApiError } from '../lib/api';
import type { UserNote } from '../lib/types';

const NODE_TYPES = [
    'concept', 'fact', 'opinion', 'experience',
    'person', 'place', 'event', 'thing', 'artifact'
] as const;

const MAX_CONTENT = 1000;

function parseTags(value: string): string[] {
    return value.split(',').map((tag) => tag.trim()).filter(Boolean);
}

export function NoteEditor({
    scope,
    note,
    onClose,
    onSaved,
    initialDrop
}: {
    initialDrop?: AttachmentDrop;
    scope: string;
    note: UserNote | null;
    onClose: () => void;
    onSaved: (note: UserNote) => void;
}) {
    const toast = useToast();
    const [label, setLabel] = useState(note?.label || initialDrop?.files[0]?.name.slice(0, 120) || initialDrop?.links[0]?.name.slice(0, 120) || '');
    const [content, setContent] = useState(note?.content || '');
    const [pendingFiles, setPendingFiles] = useState<File[]>(() => (initialDrop?.files || []).filter(file => file.size <= MAX_ATTACHMENT_BYTES).slice(0, 4));
    const [pendingLinks, setPendingLinks] = useState<DroppedLink[]>(() => (initialDrop?.links || []).slice(0, 4));
    const fileInput = useRef<HTMLInputElement>(null);
    const uploaded = useRef(new Map<File, { url: string; name: string }>());
    const committed = useRef(false);
    useEffect(() => () => {
        if (!committed.current) for (const attachment of uploaded.current.values()) void api.deleteNoteAttachment(attachment.url).catch(() => {});
    }, []);
    useEffect(() => {
        if (initialDrop?.files.some(file => file.size > MAX_ATTACHMENT_BYTES)) toast('Attachments must be 8 MB or smaller.', true);
        if ((initialDrop?.files.length || 0) > 4 || (initialDrop?.links.length || 0) > 4) toast('Add up to four files and four links at a time.', true);
    }, []);
    const [type, setType] = useState(note?.type || (initialDrop?.files.length ? 'artifact' : 'concept'));
    const [tags, setTags] = useState((note?.tags || []).join(', '));
    const [revision, setRevision] = useState(note?.revision);
    const [currentNote, setCurrentNote] = useState<UserNote | null>(null);
    const save = useMutation({
        mutationFn: async () => {
            const links = [...pendingLinks];
            // Reserve room before writing files so a full note does not leave unused uploads.
            const reserved = pendingFiles.map(file => markdownLink({ name: file.name, url: `/api/app/note-attachments/${'0'.repeat(32)}-${encodeURIComponent(file.name)}` }));
            if ([content.trim(), ...links.map(markdownLink), ...reserved].filter(Boolean).join('\n\n').length > MAX_CONTENT) throw new Error('Make room in the note for its attachment links (1,000 characters total).');
            for (const file of pendingFiles) {
                let attachment = uploaded.current.get(file);
                if (!attachment) {
                    attachment = await api.uploadNoteAttachment(file);
                    uploaded.current.set(file, attachment);
                }
                links.push(attachment);
            }
            const savedContent = [content.trim(), ...links.map(markdownLink)].filter(Boolean).join('\n\n');
            const fields = {
                label: label.trim(),
                content: savedContent,
                type,
                expectedRevision: revision,
                tags: parseTags(tags)
            };
            committed.current = true; // A lost save response must not erase a referenced attachment.
            if (note) {
                return api.spitballUpdateNote(scope, note.id, fields) as Promise<{ note: UserNote }>;
            }
            return api.spitballCreateNote(scope, fields) as Promise<{ note: UserNote }>;
        },
        onSuccess: (result) => {
            committed.current = true;
            toast(note ? 'Note updated.' : 'Note added.');
            onSaved(result.note);
        },
        onError: (error) => {
            if (error instanceof ApiError && error.code === 'EDIT_CONFLICT') {
                setCurrentNote((error.details as { note?: UserNote })?.note || null);
            }
            toast((error as Error).message, true);
        }
    });
    function stage(drop: AttachmentDrop) {
        const accepted = drop.files.filter(file => {
            if (file.size <= MAX_ATTACHMENT_BYTES) return true;
            toast(`“${file.name}” is too large (max 8 MB).`, true);
            return false;
        });
        if (pendingFiles.length + accepted.length > 4 || pendingLinks.length + drop.links.length > 4) toast('Add up to four files and four links at a time.', true);
        setPendingFiles(prev => [...prev, ...accepted].slice(0, 4));
        setPendingLinks(prev => [...prev, ...drop.links].slice(0, 4));
        if (!label.trim()) setLabel((accepted[0]?.name || drop.links[0]?.name || '').slice(0, 120));
    }
    const drop = useAttachmentDrop({ label: 'Drop attachments into this note', disabled: save.isPending, onDrop: stage });
    const close = () => { if (!save.isPending && !drop.busy) onClose(); };
    return (
        <Modal onClose={close} wide className="note-editor-modal">
            <div className="attachment-drop-zone" {...drop.dropProps}>
                {drop.indicator}
                <h2>{note ? 'Edit note' : 'New note'}</h2>
                <div className="note-editor-grid">
                    <div className="field">
                        <label htmlFor="note-title">Title</label>
                        <input
                            disabled={save.isPending}
                            id="note-title"
                            className="input"
                            maxLength={120}
                            placeholder="A short, unique title"
                            value={label}
                            onChange={(event) => setLabel(event.target.value)}
                        />
                    </div>
                    <div className="field">
                        <label htmlFor="note-type">Type</label>
                        <select
                            disabled={save.isPending}
                            id="note-type"
                            className="select"
                            value={type}
                            onChange={(event) => setType(event.target.value)}
                        >
                            {NODE_TYPES.map((item) => (
                                <option key={item} value={item}>{item}</option>
                            ))}
                        </select>
                    </div>
                </div>
                <div className="field">
                    <label htmlFor="note-content">Content</label>
                    <textarea
                        disabled={save.isPending}
                        id="note-content"
                        className="input"
                        rows={8}
                        maxLength={MAX_CONTENT}
                        placeholder="What this note should say"
                        value={content}
                        onChange={(event) => setContent(event.target.value)}
                    />
                    <div className="hint">{content.length}/{MAX_CONTENT}</div>
                </div>
                <div className="field">
                    <label htmlFor="note-tags">Tags</label>
                    <input
                        disabled={save.isPending}
                        id="note-tags"
                        className="input"
                        placeholder="Tags, comma-separated"
                        value={tags}
                        onChange={(event) => setTags(event.target.value)}
                    />
                </div>
                <div className="note-attachments">
                    <button type="button" className="btn" disabled={save.isPending || drop.busy} onClick={() => fileInput.current?.click()}>Attach files</button>
                    <input ref={fileInput} type="file" multiple hidden onChange={event => {
                        stage({ files: Array.from(event.target.files || []), links: [], warnings: [] });
                        event.target.value = '';
                    }} />
                    <p className="hint">Drop files, photos or web links here. Up to 4 files, 8 MB each. Files stay private to your account.</p>
                    {pendingFiles.map((file, index) => <div className="pending-file-chip" key={index}>
                        <span>{file.name}</span>
                        <button type="button" disabled={save.isPending} aria-label={`Remove ${file.name}`} onClick={() => {
                            const attachment = uploaded.current.get(file);
                            if (attachment) void api.deleteNoteAttachment(attachment.url).catch(() => {});
                            uploaded.current.delete(file);
                            setPendingFiles(prev => prev.filter((_, i) => i !== index));
                        }}>✕</button>
                    </div>)}
                    {pendingLinks.map((link, index) => <div className="pending-file-chip" key={index}>
                        <span>{link.name}</span><button type="button" disabled={save.isPending} aria-label={`Remove ${link.name}`} onClick={() => setPendingLinks(prev => prev.filter((_, i) => i !== index))}>✕</button>
                    </div>)}
                    {content.includes('/api/app/note-attachments/') && <details><summary>Open saved attachments</summary><Markdown source={content} /></details>}
                </div>
                {currentNote && <div role="alert" className="panel">
                    <p>Your draft is kept above. Current saved note:</p>
                    <strong>{currentNote.label}</strong><pre>{currentNote.content}</pre>
                    <p>{currentNote.tags.join(', ')}</p>
                    <button className="btn" onClick={() => { setRevision(currentNote.revision); setCurrentNote(null); }}>I have compared and merged my changes</button>
                </div>}
                <div className="modal-actions">
                    <button type="button" className="btn" disabled={save.isPending || drop.busy} onClick={close}>Cancel</button>
                    <button
                        type="button"
                        className="btn primary"
                        disabled={save.isPending || drop.busy || !label.trim() || Boolean(currentNote)}
                        onClick={() => save.mutate()}
                    >
                        {note ? 'Save' : 'Add note'}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
