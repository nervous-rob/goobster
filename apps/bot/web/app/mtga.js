/**
 * MTGA deck library pane: import Magic: The Gathering Arena deck exports
 * (the "Export to clipboard" text) into folders, browse them, and copy
 * them back out in Arena's own format. Two subviews share the pane: the
 * folder library, and one deck's card list.
 */
import { api } from './api.js';
import { openModal, closeModal } from './modal.js';

const content = document.getElementById('mtga-content');
const titleEl = document.getElementById('mtga-title');
const backBtn = document.getElementById('mtga-back');
const importBtn = document.getElementById('mtga-import-btn');
const folderAddBtn = document.getElementById('mtga-folder-add-btn');

const importBackdrop = document.getElementById('mtga-import-backdrop');
const importText = document.getElementById('mtga-import-text');
const importFolder = document.getElementById('mtga-import-folder');
const importName = document.getElementById('mtga-import-name');
const importSave = document.getElementById('mtga-import-save');
const importModeSegment = document.getElementById('mtga-import-mode');
const importPasteFields = document.getElementById('mtga-import-paste-fields');
const importLogFields = document.getElementById('mtga-import-log-fields');
const importFile = document.getElementById('mtga-import-file');
const importLogStatus = document.getElementById('mtga-import-log-status');
const importDeckPicker = document.getElementById('mtga-import-deck-picker');
const importDeckList = document.getElementById('mtga-import-deck-list');
const importSelectAll = document.getElementById('mtga-import-select-all');
const importSelectedCount = document.getElementById('mtga-import-selected-count');
const importDeckFilter = document.getElementById('mtga-import-deck-filter');

const nameBackdrop = document.getElementById('mtga-folder-backdrop');
const nameTitle = document.getElementById('mtga-folder-title');
const nameInput = document.getElementById('mtga-folder-name');
const nameSave = document.getElementById('mtga-folder-save');

let showToast = () => {};
let confirmDialog = async () => false;
let wired = false;

let library = { folders: [], decks: [] };
let openDeckId = null; // null = the library view
let nameSubmit = null; // the active name-modal handler
let importMode = 'paste';
let logPreview = { excerpt: '', decks: [] };
const LOOKUP_BATCH = 150;

const BOARD_LABELS = new Map([
    ['commander', 'Commander'],
    ['companion', 'Companion'],
    ['main', 'Maindeck'],
    ['sideboard', 'Sideboard']
]);

function el(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
}

function escapeText(text) {
    const span = document.createElement('span');
    span.textContent = String(text ?? '');
    return span.innerHTML;
}

function whenLabel(iso) {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function countsLabel(deck) {
    const parts = [];
    if (deck.commanderCount) parts.push(`${deck.commanderCount} commander`);
    if (deck.companionCount) parts.push(`${deck.companionCount} companion`);
    parts.push(`${deck.mainCount} main`);
    if (deck.sideboardCount) parts.push(`${deck.sideboardCount} side`);
    return parts.join(' · ');
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Clipboard API can be unavailable (http, permissions) - fall back
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

async function copyDeckExport(deckId) {
    try {
        const { name, text } = await api.mtgaExportDeck(deckId);
        if (await copyText(text)) {
            showToast(`Copied "${name}" - paste it into Arena's import.`);
        } else {
            showToast('Could not access the clipboard.', true);
        }
    } catch (error) {
        showToast(error.message, true);
    }
}

/** One reusable name dialog: new folder, rename folder, rename deck. */
function openNameModal({ title, value = '', maxLength = 60, placeholder = '', onSubmit }) {
    nameTitle.textContent = title;
    nameInput.value = value;
    nameInput.maxLength = maxLength;
    nameInput.placeholder = placeholder;
    nameSubmit = onSubmit;
    openModal(nameBackdrop, { initialFocus: nameInput });
    nameInput.select();
}

async function submitNameModal() {
    const value = nameInput.value.trim();
    if (!value || !nameSubmit) return;
    nameSave.disabled = true;
    try {
        await nameSubmit(value);
        closeModal(nameBackdrop);
        await refresh();
    } catch (error) {
        showToast(error.message, true);
    } finally {
        nameSave.disabled = false;
    }
}

// --- Library view -----------------------------------------------------------

function deckRow(deck) {
    const row = el(`
      <div class="list-row mtga-deck-row">
        <button class="row-body mtga-deck-open" title="Open deck">
          🃏 <strong>${escapeText(deck.name)}</strong>
          ${deck.format ? `<span class="badge">${escapeText(deck.format)}</span>` : ''}
          <div class="row-meta">${escapeText(countsLabel(deck))} &middot; imported ${whenLabel(deck.createdAt)}</div>
        </button>
        <button class="icon-action" title="Copy Arena export" aria-label="Copy Arena export of ${escapeText(deck.name)}">📋</button>
        <button class="row-delete" title="Delete deck" aria-label="Delete ${escapeText(deck.name)}">✕</button>
      </div>`);
    row.querySelector('.mtga-deck-open').addEventListener('click', () => openDeck(deck.id));
    row.querySelector('.icon-action').addEventListener('click', () => copyDeckExport(deck.id));
    row.querySelector('.row-delete').addEventListener('click', async () => {
        if (!await confirmDialog(`Delete "${deck.name}" from your library?`)) return;
        try {
            await api.mtgaDeleteDeck(deck.id);
            showToast('Deck deleted.');
            await refresh();
        } catch (error) {
            showToast(error.message, true);
        }
    });
    return row;
}

function folderSection(folder, decks) {
    const section = el(`
      <div class="mtga-folder">
        <div class="section-title mtga-folder-head">
          <span>🗂 ${escapeText(folder.name)} <span class="hint-inline">(${decks.length})</span></span>
          <span class="mtga-folder-actions">
            <button class="icon-action" data-act="rename" title="Rename folder" aria-label="Rename ${escapeText(folder.name)}">✎</button>
            <button class="row-delete" data-act="delete" title="Delete folder (decks are kept)" aria-label="Delete ${escapeText(folder.name)}">✕</button>
          </span>
        </div>
      </div>`);
    section.querySelector('[data-act="rename"]').addEventListener('click', () => {
        openNameModal({
            title: 'Rename folder',
            value: folder.name,
            onSubmit: async (value) => {
                await api.mtgaRenameFolder(folder.id, value);
                showToast('Folder renamed.');
            }
        });
    });
    section.querySelector('[data-act="delete"]').addEventListener('click', async () => {
        const note = decks.length > 0 ? ' Its decks move to Unfiled.' : '';
        if (!await confirmDialog(`Delete the folder "${folder.name}"?${note}`)) return;
        try {
            await api.mtgaDeleteFolder(folder.id);
            showToast('Folder deleted.');
            await refresh();
        } catch (error) {
            showToast(error.message, true);
        }
    });

    if (decks.length === 0) {
        section.appendChild(el('<div class="hint" style="margin:2px 0 6px">No decks in this folder yet.</div>'));
    } else {
        const list = el('<div class="list-card"></div>');
        for (const deck of decks) list.appendChild(deckRow(deck));
        section.appendChild(list);
    }
    return section;
}

function renderLibrary() {
    openDeckId = null;
    titleEl.textContent = 'MTGA decks';
    backBtn.classList.add('hidden');
    content.replaceChildren();

    const { folders, decks } = library;
    if (folders.length === 0 && decks.length === 0) {
        content.appendChild(el(`
          <div class="empty-state" style="margin-top:6vh">
            <div class="empty-logo">🃏</div>
            <div class="empty-title">No decks yet</div>
            <div class="hint" style="max-width:460px;margin:0 auto">
              In MTG Arena, open a deck and pick <strong>Export to clipboard</strong>,
              then hit <strong>⬇ Import</strong> here and paste &mdash; or pick decks
              from Arena's <strong>Player.log</strong>.
              Folders keep formats, brews, and archives apart.
            </div>
          </div>`));
        return;
    }

    for (const folder of folders) {
        content.appendChild(folderSection(folder, decks.filter(d => d.folderId === folder.id)));
    }
    const unfiled = decks.filter(d => d.folderId === null);
    if (unfiled.length > 0) {
        const section = el(`
          <div class="mtga-folder">
            <div class="section-title">🃏 Unfiled <span class="hint-inline">(${unfiled.length})</span></div>
          </div>`);
        const list = el('<div class="list-card"></div>');
        for (const deck of unfiled) list.appendChild(deckRow(deck));
        section.appendChild(list);
        content.appendChild(section);
    }
    content.appendChild(el(
        '<div class="hint" style="margin-top:10px">📋 copies a deck back out in Arena\'s own format - paste it into Arena\'s deck import.</div>'
    ));
}

// --- Deck view ----------------------------------------------------------------

async function openDeck(deckId) {
    try {
        const deck = await api.mtgaDeck(deckId);
        renderDeck(deck);
    } catch (error) {
        showToast(error.message, true);
    }
}

function renderDeck(deck) {
    openDeckId = deck.id;
    titleEl.textContent = deck.name;
    backBtn.classList.remove('hidden');
    content.replaceChildren();

    const folderOptions = [
        `<option value="">Unfiled</option>`,
        ...library.folders.map(folder =>
            `<option value="${folder.id}"${folder.id === deck.folderId ? ' selected' : ''}>${escapeText(folder.name)}</option>`)
    ].join('');

    const head = el(`
      <div class="list-card mtga-deck-head">
        <div class="list-row">
          <div class="row-body">
            <strong>${escapeText(deck.name)}</strong>
            ${deck.format ? `<span class="badge">${escapeText(deck.format)}</span>` : ''}
            <div class="row-meta">${escapeText(countsLabel(deck))} &middot; imported ${whenLabel(deck.createdAt)}</div>
          </div>
          <label class="mtga-folder-pick">
            <span class="hint-inline">Folder</span>
            <select class="select" aria-label="Folder">${folderOptions}</select>
          </label>
          <button class="icon-action" data-act="rename" title="Rename deck" aria-label="Rename deck">✎</button>
          <button class="btn" data-act="copy" title="Copy Arena export">📋 Export</button>
          <button class="row-delete" data-act="delete" title="Delete deck" aria-label="Delete deck">✕</button>
        </div>
      </div>`);

    head.querySelector('select').addEventListener('change', async (event) => {
        const value = event.target.value;
        try {
            await api.mtgaUpdateDeck(deck.id, { folderId: value === '' ? null : Number(value) });
            showToast(value === '' ? 'Moved to Unfiled.' : 'Deck moved.');
            library = await api.mtgaLibrary();
        } catch (error) {
            showToast(error.message, true);
        }
    });
    head.querySelector('[data-act="rename"]').addEventListener('click', () => {
        openNameModal({
            title: 'Rename deck',
            value: deck.name,
            maxLength: 120,
            onSubmit: async (value) => {
                await api.mtgaUpdateDeck(deck.id, { name: value });
                showToast('Deck renamed.');
                await openDeck(deck.id);
            }
        });
    });
    head.querySelector('[data-act="copy"]').addEventListener('click', () => copyDeckExport(deck.id));
    head.querySelector('[data-act="delete"]').addEventListener('click', async () => {
        if (!await confirmDialog(`Delete "${deck.name}" from your library?`)) return;
        try {
            await api.mtgaDeleteDeck(deck.id);
            showToast('Deck deleted.');
            await refresh();
        } catch (error) {
            showToast(error.message, true);
        }
    });
    content.appendChild(head);

    for (const group of deck.boards) {
        const total = group.cards.reduce((sum, card) => sum + card.count, 0);
        content.appendChild(el(
            `<div class="section-title">${BOARD_LABELS.get(group.board) || group.board} <span class="hint-inline">(${total})</span></div>`));
        const list = el('<div class="list-card mtga-card-list"></div>');
        for (const card of group.cards) {
            list.appendChild(el(`
              <div class="mtga-card-row">
                <span class="mtga-card-count">${card.count}×</span>
                <span class="mtga-card-name">${escapeText(card.name)}</span>
                ${card.setCode ? `<span class="mtga-card-set">${escapeText(card.setCode)}${card.collectorNumber ? ` ${escapeText(card.collectorNumber)}` : ''}</span>` : ''}
              </div>`));
        }
        content.appendChild(list);
    }
}

// --- Import ------------------------------------------------------------------

function fillFolderSelect(select, selectedId = null) {
    select.replaceChildren();
    select.appendChild(el('<option value="">Unfiled</option>'));
    for (const folder of library.folders) {
        const option = el(`<option value="${folder.id}">${escapeText(folder.name)}</option>`);
        if (folder.id === selectedId) option.selected = true;
        select.appendChild(option);
    }
}

function setImportMode(mode) {
    importMode = mode;
    for (const btn of importModeSegment.querySelectorAll('.segment-btn')) {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    }
    importPasteFields.classList.toggle('hidden', mode !== 'paste');
    importLogFields.classList.toggle('hidden', mode !== 'log');
}

function resetLogPreview() {
    logPreview = { excerpt: '', decks: [] };
    importLogStatus.classList.add('hidden');
    importLogStatus.textContent = '';
    importDeckPicker.classList.add('hidden');
    importDeckList.replaceChildren();
    importDeckFilter.value = '';
    importSelectAll.checked = false;
    importSelectAll.indeterminate = false;
    importSelectedCount.textContent = '';
}

function openImportModal() {
    importText.value = '';
    importName.value = '';
    importFile.value = '';
    resetLogPreview();
    setImportMode('paste');
    fillFolderSelect(importFolder);
    openModal(importBackdrop, { initialFocus: importText });
}

/**
 * Stream Player.log locally and keep only the deck-bearing lines - a
 * 200MB log boils down to a few hundred KB, and nothing else leaves
 * the browser. Falls back to file.text() when streams are unavailable.
 */
async function readLogExcerpt(file) {
    if (typeof file.stream !== 'function') {
        const text = await file.text();
        return text.split(/\r?\n/).filter(line => /maindeck/i.test(line)).join('\n');
    }
    const reader = file.stream().getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const lines = [];
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

function selectedLogKeys() {
    return [...importDeckList.querySelectorAll('input[type="checkbox"]:checked')]
        .map(box => box.value);
}

function updatePickerSelection() {
    const boxes = [...importDeckList.querySelectorAll('input[type="checkbox"]')];
    const checked = boxes.filter(box => box.checked).length;
    importSelectedCount.textContent = boxes.length === 0
        ? ''
        : `${checked} of ${boxes.length} selected`;
    importSelectAll.checked = boxes.length > 0 && checked === boxes.length;
    importSelectAll.indeterminate = checked > 0 && checked < boxes.length;
}

function applyDeckFilter() {
    const query = importDeckFilter.value.trim().toLowerCase();
    for (const row of importDeckList.querySelectorAll('.mtga-picker-row')) {
        const hay = row.dataset.filter || '';
        row.classList.toggle('hidden', Boolean(query) && !hay.includes(query));
    }
}

function renderDeckPicker(decks) {
    importDeckList.replaceChildren();
    for (const deck of decks) {
        const counts = countsLabel({
            commanderCount: deck.commanderCount,
            companionCount: deck.companionCount,
            mainCount: deck.mainCount,
            sideboardCount: deck.sideboardCount
        });
        const row = el(`
          <label class="mtga-picker-row">
            <input type="checkbox" checked>
            <span class="row-body">
              <strong>${escapeText(deck.name || 'Untitled deck')}</strong>
              ${deck.format ? `<span class="badge">${escapeText(deck.format)}</span>` : ''}
              <div class="row-meta">${escapeText(counts)} · ${deck.uniqueCards} unique cards</div>
            </span>
          </label>`);
        row.dataset.filter = `${deck.name || ''} ${deck.format || ''}`.toLowerCase();
        const box = row.querySelector('input');
        box.value = deck.key;
        box.addEventListener('change', updatePickerSelection);
        importDeckList.appendChild(row);
    }
    importDeckPicker.classList.toggle('hidden', decks.length === 0);
    updatePickerSelection();
}

async function scanLogFile() {
    const file = importFile.files?.[0];
    resetLogPreview();
    if (!file) return;
    importLogStatus.classList.remove('hidden');
    importLogStatus.textContent = `Reading ${file.name}…`;
    try {
        const excerpt = await readLogExcerpt(file);
        if (!excerpt) {
            importLogStatus.textContent = 'No deck lists found in that file - enable Detailed Logs in Arena (Options → Account), restart the game, and try the fresh Player.log.';
            return;
        }
        importLogStatus.textContent = 'Scanning decks…';
        const preview = await api.mtgaPreviewLog({ text: excerpt });
        logPreview = { excerpt, decks: preview.decks || [] };
        if (logPreview.decks.length === 0) {
            importLogStatus.textContent = 'No deck lists found in that file.';
            return;
        }
        importLogStatus.textContent = `Found ${logPreview.decks.length} deck${logPreview.decks.length === 1 ? '' : 's'} - pick the ones to import.`;
        renderDeckPicker(logPreview.decks);
    } catch (error) {
        importLogStatus.textContent = error.message;
        showToast(error.message, true);
    }
}

function importSummaryToast({ decks, skipped = 0, unresolvedCards = 0 }) {
    const parts = [];
    parts.push(decks.length === 1 ? `Imported "${decks[0].name}".` : `Imported ${decks.length} decks.`);
    if (skipped > 0) parts.push(`${skipped} already in your library.`);
    if (unresolvedCards > 0) parts.push(`${unresolvedCards} cards could not be identified.`);
    if (decks.length === 0 && skipped > 0) {
        showToast(`Nothing new - all ${skipped} decks are already in your library.`);
        return;
    }
    showToast(parts.join(' '), decks.length === 0);
}

async function importSelectedLogDecks(folderId) {
    if (!logPreview.excerpt) {
        showToast('Pick your Player.log file first.', true);
        return null;
    }
    const deckKeys = selectedLogKeys();
    if (deckKeys.length === 0) {
        showToast('Pick at least one deck to import.', true);
        return null;
    }
    let result;
    do {
        result = await api.mtgaImportLog({
            text: logPreview.excerpt,
            folderId,
            deckKeys,
            lookupBudget: LOOKUP_BATCH
        });
        if (result.status === 'resolving') {
            const done = result.resolved || 0;
            const total = result.total || done;
            importSave.textContent = total
                ? `Looking up cards… ${done}/${total}`
                : 'Looking up cards…';
        }
    } while (result.status === 'resolving');
    return result;
}

async function submitImport() {
    const folderId = importFolder.value === '' ? null : Number(importFolder.value);
    importSave.disabled = true;
    const label = importSave.textContent;
    importSave.textContent = 'Importing…';
    try {
        const result = importMode === 'log'
            ? await importSelectedLogDecks(folderId)
            : await (async () => {
                const text = importText.value.trim();
                if (!text) {
                    showToast('Paste a deck export first.', true);
                    return null;
                }
                return api.mtgaImportDecks({ text, folderId, name: importName.value.trim() || null });
            })();
        if (!result) return;
        closeModal(importBackdrop);
        importSummaryToast(result);
        await refresh();
    } catch (error) {
        showToast(error.message, true);
    } finally {
        importSave.disabled = false;
        importSave.textContent = label;
    }
}

// --- Pane lifecycle -------------------------------------------------------------

async function refresh() {
    try {
        library = await api.mtgaLibrary();
    } catch (error) {
        content.innerHTML = `<div class="empty">${escapeText(error.message)}</div>`;
        return;
    }
    // Refresh whichever subview is open; a deleted deck falls back home
    if (openDeckId !== null && library.decks.some(d => d.id === openDeckId)) {
        await openDeck(openDeckId);
    } else {
        renderLibrary();
    }
}

/**
 * Prepare the MTGA decks pane (idempotent; refreshes on every visit).
 * @param {Object} params - { me, toast, confirm }
 */
export function initMtga({ toast, confirm }) {
    showToast = toast;
    confirmDialog = confirm;

    if (!wired) {
        wired = true;
        backBtn.addEventListener('click', () => renderLibrary());
        importBtn.addEventListener('click', openImportModal);
        importSave.addEventListener('click', submitImport);
        importModeSegment.addEventListener('click', (event) => {
            const btn = event.target.closest('.segment-btn');
            if (btn) setImportMode(btn.dataset.mode);
        });
        importFile.addEventListener('change', () => { scanLogFile(); });
        importSelectAll.addEventListener('change', () => {
            const on = importSelectAll.checked;
            for (const box of importDeckList.querySelectorAll('input[type="checkbox"]')) {
                box.checked = on;
            }
            updatePickerSelection();
        });
        importDeckFilter.addEventListener('input', applyDeckFilter);
        document.getElementById('mtga-import-cancel')
            .addEventListener('click', () => closeModal(importBackdrop));
        folderAddBtn.addEventListener('click', () => {
            openNameModal({
                title: 'New folder',
                placeholder: 'Standard brews',
                onSubmit: async (value) => {
                    await api.mtgaCreateFolder(value);
                    showToast('Folder created.');
                }
            });
        });
        nameSave.addEventListener('click', submitNameModal);
        nameInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                submitNameModal();
            }
        });
        document.getElementById('mtga-folder-cancel')
            .addEventListener('click', () => closeModal(nameBackdrop));
    }

    content.innerHTML = '<div class="empty">Loading&hellip;</div>';
    refresh();
}
