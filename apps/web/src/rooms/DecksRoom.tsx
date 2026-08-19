import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { Modal } from '../components/Modal';

type Folder = { id: number; name: string };
type DeckSummary = {
    id: number;
    name: string;
    folderId: number | null;
    format?: string | null;
    commanderCount?: number;
    companionCount?: number;
    mainCount: number;
    sideboardCount?: number;
    createdAt?: string;
};
type DeckCard = { name: string; count: number; setCode?: string; collectorNumber?: string };
type DeckDetail = DeckSummary & { boards: Array<{ board: string; cards: DeckCard[] }> };
type LibraryPayload = { folders: Folder[]; decks: DeckSummary[] };
type ExportPayload = { name: string; text: string };
type ImportResult = {
    decks: Array<{ name: string }>;
    skipped?: number;
    unresolvedCards?: number;
    status?: 'ok' | 'resolving';
    resolved?: number;
    total?: number;
};
type PreviewDeck = {
    key: string;
    name: string;
    format?: string | null;
    commanderCount?: number;
    companionCount?: number;
    mainCount: number;
    sideboardCount?: number;
    uniqueCards: number;
};

const BOARD_LABELS = new Map([
    ['commander', 'Commander'],
    ['companion', 'Companion'],
    ['main', 'Maindeck'],
    ['sideboard', 'Sideboard']
]);

function whenLabel(iso?: string): string {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function countsLabel(deck: {
    commanderCount?: number;
    companionCount?: number;
    mainCount: number;
    sideboardCount?: number;
}): string {
    const parts: string[] = [];
    if (deck.commanderCount) parts.push(`${deck.commanderCount} commander`);
    if (deck.companionCount) parts.push(`${deck.companionCount} companion`);
    parts.push(`${deck.mainCount} main`);
    if (deck.sideboardCount) parts.push(`${deck.sideboardCount} side`);
    return parts.join(' · ');
}

async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { /* denied */ }
        area.remove();
        return ok;
    }
}

function NameModal({
    title, value, placeholder, maxLength, onClose, onSubmit
}: {
    title: string;
    value?: string;
    placeholder?: string;
    maxLength?: number;
    onClose: () => void;
    onSubmit: (name: string) => Promise<void>;
}) {
    const toast = useToast();
    const [name, setName] = useState(value || '');
    const [busy, setBusy] = useState(false);
    async function save() {
        const trimmed = name.trim();
        if (!trimmed || busy) return;
        setBusy(true);
        try {
            await onSubmit(trimmed);
            onClose();
        } catch (error) {
            toast((error as Error).message, true);
            setBusy(false);
        }
    }
    return (
        <Modal onClose={onClose}>
            <h2>{title}</h2>
            <input
                className="input"
                value={name}
                maxLength={maxLength || 60}
                placeholder={placeholder}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }}
            />
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>
                    Save
                </button>
            </div>
        </Modal>
    );
}

const LOOKUP_BATCH = 150;

async function readLogExcerpt(file: File): Promise<string> {
    if (typeof file.stream !== 'function') {
        const text = await file.text();
        return text.split(/\r?\n/).filter((line) => /maindeck/i.test(line)).join('\n');
    }
    const reader = file.stream().getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const lines: string[] = [];
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            if (/maindeck/i.test(line)) lines.push(line);
        }
    }
    const tail = buffer.replace(/\r$/, '');
    if (tail && /maindeck/i.test(tail)) lines.push(tail);
    return lines.join('\n');
}

function importSummaryToast(result: ImportResult, toast: (message: string, isError?: boolean) => void) {
    const decks = result.decks || [];
    const parts: string[] = [];
    parts.push(decks.length === 1 ? `Imported "${decks[0].name}".` : `Imported ${decks.length} decks.`);
    if (result.skipped) parts.push(`${result.skipped} already in your library.`);
    if (result.unresolvedCards) parts.push(`${result.unresolvedCards} cards could not be identified.`);
    if (decks.length === 0 && result.skipped) {
        toast(`Nothing new — all ${result.skipped} decks are already in your library.`);
        return;
    }
    toast(parts.join(' '), decks.length === 0);
}

function ImportModal({
    folders, onClose, onImported
}: {
    folders: Folder[];
    onClose: () => void;
    onImported: () => void;
}) {
    const toast = useToast();
    const [mode, setMode] = useState<'paste' | 'log'>('paste');
    const [text, setText] = useState('');
    const [name, setName] = useState('');
    const [folderId, setFolderId] = useState('');
    const [busy, setBusy] = useState(false);
    const [busyLabel, setBusyLabel] = useState('Import');
    const [excerpt, setExcerpt] = useState('');
    const [previewDecks, setPreviewDecks] = useState<PreviewDeck[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [filter, setFilter] = useState('');
    const [logStatus, setLogStatus] = useState('');

    function resetLogPreview() {
        setExcerpt('');
        setPreviewDecks([]);
        setSelected(new Set());
        setFilter('');
        setLogStatus('');
    }

    async function scanLogFile(file: File | undefined) {
        resetLogPreview();
        if (!file) return;
        setLogStatus(`Reading ${file.name}…`);
        try {
            const nextExcerpt = await readLogExcerpt(file);
            if (!nextExcerpt) {
                setLogStatus('No deck lists found in that file - enable Detailed Logs in Arena (Options → Account), restart the game, and try the fresh Player.log.');
                return;
            }
            setLogStatus('Scanning decks…');
            const preview = await api.mtgaPreviewLog({ text: nextExcerpt }) as { decks?: PreviewDeck[] };
            const decks = preview.decks || [];
            setExcerpt(nextExcerpt);
            setPreviewDecks(decks);
            setSelected(new Set(decks.map((deck) => deck.key)));
            setLogStatus(decks.length === 0
                ? 'No deck lists found in that file.'
                : `Found ${decks.length} deck${decks.length === 1 ? '' : 's'} - pick the ones to import.`);
        } catch (error) {
            setLogStatus((error as Error).message);
            toast((error as Error).message, true);
        }
    }

    async function importSelectedLogDecks(targetFolder: number | null): Promise<ImportResult | null> {
        if (!excerpt) {
            toast('Pick your Player.log file first.', true);
            return null;
        }
        const deckKeys = [...selected];
        if (deckKeys.length === 0) {
            toast('Pick at least one deck to import.', true);
            return null;
        }
        let result: ImportResult;
        do {
            result = await api.mtgaImportLog({
                text: excerpt,
                folderId: targetFolder,
                deckKeys,
                lookupBudget: LOOKUP_BATCH
            }) as ImportResult;
            if (result.status === 'resolving') {
                const done = result.resolved || 0;
                const total = result.total || done;
                setBusyLabel(total ? `Looking up cards… ${done}/${total}` : 'Looking up cards…');
            }
        } while (result.status === 'resolving');
        return result;
    }

    async function submit() {
        const targetFolder = folderId === '' ? null : Number(folderId);
        setBusy(true);
        setBusyLabel('Importing…');
        try {
            const result = mode === 'log'
                ? await importSelectedLogDecks(targetFolder)
                : await (async () => {
                    if (!text.trim()) {
                        toast('Paste a deck export first.', true);
                        return null;
                    }
                    return api.mtgaImportDecks({
                        text: text.trim(),
                        folderId: targetFolder,
                        name: name.trim() || null
                    }) as Promise<ImportResult>;
                })();
            if (!result) {
                setBusy(false);
                setBusyLabel('Import');
                return;
            }
            importSummaryToast(result, toast);
            onImported();
            onClose();
        } catch (error) {
            toast((error as Error).message, true);
            setBusy(false);
            setBusyLabel('Import');
        }
    }

    const visible = previewDecks.filter((deck) => {
        if (!filter.trim()) return true;
        const hay = `${deck.name || ''} ${deck.format || ''}`.toLowerCase();
        return hay.includes(filter.trim().toLowerCase());
    });
    const allVisibleSelected = visible.length > 0 && visible.every((deck) => selected.has(deck.key));
    const someVisibleSelected = visible.some((deck) => selected.has(deck.key));

    return (
        <Modal onClose={onClose} wide className="mtga-import-modal">
            <h2>Import Arena decks</h2>
            <div className="field">
                <label>Source</label>
                <div className="segment" role="group" aria-label="Import source">
                    <button type="button" className={`segment-btn${mode === 'paste' ? ' active' : ''}`}
                        onClick={() => setMode('paste')}>Paste export</button>
                    <button type="button" className={`segment-btn${mode === 'log' ? ' active' : ''}`}
                        onClick={() => setMode('log')}>From Player.log</button>
                </div>
            </div>
            {mode === 'paste' ? (
                <>
                    <p className="hint">Paste an Arena “Export to clipboard” deck list.</p>
                    <textarea
                        className="input"
                        rows={10}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder="Deck&#10;4 Lightning Bolt&#10;…"
                        autoFocus
                    />
                    <input className="input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
                </>
            ) : (
                <>
                    <p className="hint">
                        Reads your Arena library from the game&apos;s log so you can <strong>pick which decks to import</strong>.
                        In Arena, enable <strong>Options → Account → Detailed Logs (Plugin Support)</strong>, restart the game, then pick
                        {' '}<code>Player.log</code>. Only the deck lists leave your browser. Any size log is fine.
                        Card names are looked up on Scryfall in small batches (cached after the first time).
                    </p>
                    <div className="field">
                        <label htmlFor="mtga-import-file">Player.log</label>
                        <input
                            id="mtga-import-file"
                            className="input"
                            type="file"
                            accept=".log,.txt,text/plain"
                            onChange={(event) => { void scanLogFile(event.target.files?.[0]); }}
                        />
                    </div>
                    {logStatus && <div className="hint">{logStatus}</div>}
                    {previewDecks.length > 0 && (
                        <div>
                            <div className="mtga-picker-head">
                                <label className="mtga-picker-all">
                                    <input
                                        type="checkbox"
                                        checked={allVisibleSelected}
                                        ref={(el) => {
                                            if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected;
                                        }}
                                        onChange={(event) => {
                                            const on = event.target.checked;
                                            setSelected((prev) => {
                                                const next = new Set(prev);
                                                for (const deck of visible) {
                                                    if (on) next.add(deck.key);
                                                    else next.delete(deck.key);
                                                }
                                                return next;
                                            });
                                        }}
                                    />
                                    <span>Select all</span>
                                </label>
                                <span className="hint-inline">{selected.size} of {previewDecks.length} selected</span>
                            </div>
                            <input
                                className="input"
                                type="search"
                                placeholder="Filter decks…"
                                value={filter}
                                onChange={(e) => setFilter(e.target.value)}
                                autoComplete="off"
                            />
                            <div className="mtga-picker-list" role="group" aria-label="Decks in this log">
                                {visible.map((deck) => (
                                    <label key={deck.key} className="mtga-picker-row">
                                        <input
                                            type="checkbox"
                                            checked={selected.has(deck.key)}
                                            onChange={(event) => {
                                                setSelected((prev) => {
                                                    const next = new Set(prev);
                                                    if (event.target.checked) next.add(deck.key);
                                                    else next.delete(deck.key);
                                                    return next;
                                                });
                                            }}
                                        />
                                        <span className="row-body">
                                            <strong>{deck.name || 'Untitled deck'}</strong>
                                            {deck.format ? <span className="badge">{deck.format}</span> : null}
                                            <div className="row-meta">{countsLabel(deck)} · {deck.uniqueCards} unique cards</div>
                                        </span>
                                    </label>
                                ))}
                            </div>
                        </div>
                    )}
                </>
            )}
            <select className="select" value={folderId} onChange={(e) => setFolderId(e.target.value)} aria-label="Folder">
                <option value="">Unfiled</option>
                {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
                    {busy ? busyLabel : 'Import'}
                </button>
            </div>
        </Modal>
    );
}

function DeckRow({
    deck, onOpen, onExport, onDelete
}: {
    deck: DeckSummary;
    onOpen: (id: number) => void;
    onExport: (id: number) => void;
    onDelete: (deck: DeckSummary) => void;
}) {
    return (
        <div className="list-row mtga-deck-row">
            <button type="button" className="row-body mtga-deck-open" title="Open deck" onClick={() => onOpen(deck.id)}>
                🃏 <strong>{deck.name}</strong>
                {deck.format ? <span className="badge">{deck.format}</span> : null}
                <div className="row-meta">{countsLabel(deck)} · imported {whenLabel(deck.createdAt)}</div>
            </button>
            <button type="button" className="icon-action" title="Copy Arena export" aria-label={`Copy Arena export of ${deck.name}`} onClick={() => onExport(deck.id)}>📋</button>
            <button type="button" className="row-delete" title="Delete deck" aria-label={`Delete ${deck.name}`} onClick={() => onDelete(deck)}>✕</button>
        </div>
    );
}

export function DecksRoom() {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const library = useQuery({
        queryKey: keys.mtga,
        queryFn: () => api.mtgaLibrary() as Promise<LibraryPayload>
    });
    const [openDeckId, setOpenDeckId] = useState<number | null>(null);
    const [importOpen, setImportOpen] = useState(false);
    const [nameModal, setNameModal] = useState<
        { kind: 'folder-create' } |
        { kind: 'folder-rename'; id: number; value: string } |
        { kind: 'deck-rename'; id: number; value: string } |
        null
    >(null);

    const deckQuery = useQuery({
        queryKey: [...keys.mtga, 'deck', openDeckId],
        queryFn: () => api.mtgaDeck(openDeckId as number) as Promise<DeckDetail>,
        enabled: openDeckId !== null
    });

    const folders = library.data?.folders || [];
    const decks = library.data?.decks || [];

    async function exportDeck(id: number) {
        try {
            const result = await api.mtgaExportDeck(id) as ExportPayload;
            if (await copyText(result.text)) toast(`Copied "${result.name}" — paste it into Arena's import.`);
            else toast('Could not access the clipboard.', true);
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function deleteDeck(deck: DeckSummary | DeckDetail) {
        if (!await confirm(`Delete "${deck.name}" from your library?`)) return;
        try {
            await api.mtgaDeleteDeck(deck.id);
            toast('Deck deleted.');
            setOpenDeckId(null);
            await queryClient.invalidateQueries({ queryKey: keys.mtga });
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function deleteFolder(folder: Folder, folderDecks: DeckSummary[]) {
        const note = folderDecks.length > 0 ? ' Its decks move to Unfiled.' : '';
        if (!await confirm(`Delete the folder "${folder.name}"?${note}`)) return;
        try {
            await api.mtgaDeleteFolder(folder.id);
            toast('Folder deleted.');
            await queryClient.invalidateQueries({ queryKey: keys.mtga });
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    const invalidate = () => queryClient.invalidateQueries({ queryKey: keys.mtga });
    const deck = deckQuery.data;

    return (
        <main className="pane next-pane is-in" id="pane-decks">
            <header className="pane-header">
                <h1>{deck && openDeckId !== null ? deck.name : 'MTGA decks'}</h1>
                <div className="pane-header-actions">
                    {openDeckId !== null ? (
                        <button type="button" className="btn" onClick={() => setOpenDeckId(null)}>← Back</button>
                    ) : (
                        <>
                            <button type="button" className="btn" onClick={() => setNameModal({ kind: 'folder-create' })}>✚ Folder</button>
                            <button type="button" className="btn primary" onClick={() => setImportOpen(true)}>⬇ Import</button>
                        </>
                    )}
                </div>
            </header>
            <div className="pane-body">
                {library.isPending && openDeckId === null && <div className="empty">Loading…</div>}
                {library.isError && <div className="empty">{(library.error as Error).message}</div>}

                {openDeckId !== null && (
                    <>
                        {deckQuery.isPending && <div className="empty">Loading…</div>}
                        {deckQuery.isError && <div className="empty">{(deckQuery.error as Error).message}</div>}
                        {deck && (
                            <>
                                <div className="list-card mtga-deck-head">
                                    <div className="list-row">
                                        <div className="row-body">
                                            <strong>{deck.name}</strong>
                                            {deck.format ? <span className="badge">{deck.format}</span> : null}
                                            <div className="row-meta">{countsLabel(deck)} · imported {whenLabel(deck.createdAt)}</div>
                                        </div>
                                        <label className="mtga-folder-pick">
                                            <span className="hint-inline">Folder</span>
                                            <select
                                                className="select"
                                                aria-label="Folder"
                                                value={deck.folderId ?? ''}
                                                onChange={async (event) => {
                                                    const value = event.target.value;
                                                    try {
                                                        await api.mtgaUpdateDeck(deck.id, { folderId: value === '' ? null : Number(value) });
                                                        toast(value === '' ? 'Moved to Unfiled.' : 'Deck moved.');
                                                        invalidate();
                                                    } catch (error) {
                                                        toast((error as Error).message, true);
                                                    }
                                                }}
                                            >
                                                <option value="">Unfiled</option>
                                                {folders.map((folder) => (
                                                    <option key={folder.id} value={folder.id}>{folder.name}</option>
                                                ))}
                                            </select>
                                        </label>
                                        <button type="button" className="icon-action" title="Rename deck" onClick={() => setNameModal({ kind: 'deck-rename', id: deck.id, value: deck.name })}>✎</button>
                                        <button type="button" className="btn" title="Copy Arena export" onClick={() => exportDeck(deck.id)}>📋 Export</button>
                                        <button type="button" className="row-delete" title="Delete deck" onClick={() => deleteDeck(deck)}>✕</button>
                                    </div>
                                </div>
                                {deck.boards.map((group) => {
                                    const total = group.cards.reduce((sum, card) => sum + card.count, 0);
                                    return (
                                        <div key={group.board}>
                                            <div className="section-title">
                                                {BOARD_LABELS.get(group.board) || group.board}{' '}
                                                <span className="hint-inline">({total})</span>
                                            </div>
                                            <div className="list-card mtga-card-list">
                                                {group.cards.map((card) => (
                                                    <div key={`${card.name}-${card.setCode || ''}-${card.collectorNumber || ''}`} className="mtga-card-row">
                                                        <span className="mtga-card-count">{card.count}×</span>
                                                        <span className="mtga-card-name">{card.name}</span>
                                                        {card.setCode ? (
                                                            <span className="mtga-card-set">
                                                                {card.setCode}{card.collectorNumber ? ` ${card.collectorNumber}` : ''}
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })}
                            </>
                        )}
                    </>
                )}

                {openDeckId === null && library.data && folders.length === 0 && decks.length === 0 && (
                    <div className="empty-state" style={{ marginTop: '6vh' }}>
                        <div className="empty-logo">🃏</div>
                        <div className="empty-title">No decks yet</div>
                        <div className="hint" style={{ maxWidth: 460, margin: '0 auto' }}>
                            In MTG Arena, open a deck and pick <strong>Export to clipboard</strong>,
                            then hit <strong>⬇ Import</strong> here and paste — or pick decks
                            from Arena&apos;s <strong>Player.log</strong>.
                            Folders keep formats, brews, and archives apart.
                        </div>
                    </div>
                )}

                {openDeckId === null && library.data && (folders.length > 0 || decks.length > 0) && (
                    <>
                        {folders.map((folder) => {
                            const folderDecks = decks.filter((d) => d.folderId === folder.id);
                            return (
                                <div key={folder.id} className="mtga-folder">
                                    <div className="section-title mtga-folder-head">
                                        <span>🗂 {folder.name} <span className="hint-inline">({folderDecks.length})</span></span>
                                        <span className="mtga-folder-actions">
                                            <button type="button" className="icon-action" title="Rename folder" onClick={() => setNameModal({ kind: 'folder-rename', id: folder.id, value: folder.name })}>✎</button>
                                            <button type="button" className="row-delete" title="Delete folder (decks are kept)" onClick={() => deleteFolder(folder, folderDecks)}>✕</button>
                                        </span>
                                    </div>
                                    {folderDecks.length === 0
                                        ? <div className="hint" style={{ margin: '2px 0 6px' }}>No decks in this folder yet.</div>
                                        : (
                                            <div className="list-card">
                                                {folderDecks.map((deckRow) => (
                                                    <DeckRow key={deckRow.id} deck={deckRow} onOpen={setOpenDeckId} onExport={exportDeck} onDelete={deleteDeck} />
                                                ))}
                                            </div>
                                        )}
                                </div>
                            );
                        })}
                        {(() => {
                            const unfiled = decks.filter((d) => d.folderId === null);
                            if (unfiled.length === 0) return null;
                            return (
                                <div className="mtga-folder">
                                    <div className="section-title">🃏 Unfiled <span className="hint-inline">({unfiled.length})</span></div>
                                    <div className="list-card">
                                        {unfiled.map((deckRow) => (
                                            <DeckRow key={deckRow.id} deck={deckRow} onOpen={setOpenDeckId} onExport={exportDeck} onDelete={deleteDeck} />
                                        ))}
                                    </div>
                                </div>
                            );
                        })()}
                        <div className="hint" style={{ marginTop: 10 }}>
                            📋 copies a deck back out in Arena&apos;s own format — paste it into Arena&apos;s deck import.
                        </div>
                    </>
                )}
            </div>

            {importOpen && (
                <ImportModal folders={folders} onClose={() => setImportOpen(false)} onImported={invalidate} />
            )}
            {nameModal?.kind === 'folder-create' && (
                <NameModal
                    title="New folder"
                    placeholder="Standard brews"
                    onClose={() => setNameModal(null)}
                    onSubmit={async (value) => {
                        await api.mtgaCreateFolder(value);
                        toast('Folder created.');
                        invalidate();
                    }}
                />
            )}
            {nameModal?.kind === 'folder-rename' && (
                <NameModal
                    title="Rename folder"
                    value={nameModal.value}
                    onClose={() => setNameModal(null)}
                    onSubmit={async (value) => {
                        await api.mtgaRenameFolder(nameModal.id, value);
                        toast('Folder renamed.');
                        invalidate();
                    }}
                />
            )}
            {nameModal?.kind === 'deck-rename' && (
                <NameModal
                    title="Rename deck"
                    value={nameModal.value}
                    maxLength={120}
                    onClose={() => setNameModal(null)}
                    onSubmit={async (value) => {
                        await api.mtgaUpdateDeck(nameModal.id, { name: value });
                        toast('Deck renamed.');
                        invalidate();
                    }}
                />
            )}
        </main>
    );
}
