/**
 * A persona's knowledge workspace: the Spitball-style tag-first note base.
 * Notes tab (browse / seed / edit / semantic search, tag filtering) and the
 * Graph tab (tags + notes rendered with the shared canvas force layout -
 * notes connect only through shared tags, so the network is emergent).
 */
import { api } from './api.js';
import { GraphView } from './graph.js';
import { el, escapeText, timeLabel, openModal, personaColor, personaGlyph } from './parlorUi.js';

const WORKSPACE_COLORS = {
    tag: '#ffb454',
    note: '#59d18c'
};

const titleEl = document.getElementById('workspace-title');
const tabsEl = document.getElementById('workspace-tabs');
const notesPane = document.getElementById('wtab-notes');
const graphPane = document.getElementById('wtab-graph');
const notesEl = document.getElementById('workspace-notes');
const tagChipsEl = document.getElementById('workspace-tag-chips');
const searchEl = document.getElementById('note-search');

let persona = null;
let tags = [];
let activeTagId = null;
let currentTab = 'notes';
let graphView = null;
let showToast = () => {};
let confirmDialog = async () => false;
let onEditPersona = () => {};
let wired = false;

/* ---------- notes ---------- */

function noteCard(note) {
    const card = el(`
      <div class="note-card">
        <div class="note-head">
          <span class="note-title">${escapeText(note.title)}</span>
          <span class="note-actions">
            <button class="conv-action edit" title="Edit">✎</button>
            <button class="conv-action delete" title="Delete">🗑</button>
          </span>
        </div>
        <div class="note-body">${escapeText(note.content)}</div>
        <div class="note-foot">
          ${note.source === 'conversation' ? '<span class="badge learned-badge">🌱 learned</span>' : ''}
          ${(note.tags || []).map(tag => `<span class="gchip">${escapeText(tag.name)}</span>`).join('')}
          <span class="note-when">${escapeText(timeLabel(note.updatedAt))}</span>
        </div>
      </div>`);
    if (typeof note.score === 'number') {
        card.querySelector('.note-foot').prepend(
            el(`<span class="badge">match ${(note.score * 100).toFixed(0)}%</span>`)
        );
    }
    card.querySelector('.edit').addEventListener('click', () => openNoteModal(note));
    card.querySelector('.delete').addEventListener('click', async () => {
        if (!await confirmDialog(`Delete "${note.title}"? ${persona.name} forgets it for good.`)) return;
        try {
            await api.parlorDeleteNote(note.id);
            showToast('Note deleted.');
            await refreshWorkspace();
        } catch (error) {
            showToast(error.message, true);
        }
    });
    return card;
}

async function renderNotes() {
    notesEl.innerHTML = '<div class="empty">Loading&hellip;</div>';
    try {
        const query = searchEl.value.trim();
        let notes;
        if (query) {
            const { results } = await api.parlorSearch(persona.id, query);
            notes = results;
        } else {
            const response = await api.parlorNotes(persona.id, { tagId: activeTagId });
            notes = response.notes;
        }
        if (notes.length === 0) {
            notesEl.innerHTML = query
                ? '<div class="empty">Nothing in this workspace matches that.</div>'
                : `<div class="empty">No notes${activeTagId ? ' with this tag' : ''} yet.
                   Seed what ${escapeText(persona.name)} should know - conversations grow it from there.</div>`;
            return;
        }
        notesEl.replaceChildren(...notes.map(noteCard));
    } catch (error) {
        notesEl.innerHTML = `<div class="empty">${escapeText(error.message)}</div>`;
    }
}

function renderTagChips() {
    tagChipsEl.replaceChildren();
    if (tags.length === 0) return;
    const allChip = el(`<button class="tag-chip${activeTagId === null ? ' active' : ''}">all</button>`);
    allChip.addEventListener('click', () => {
        activeTagId = null;
        searchEl.value = '';
        renderTagChips();
        renderNotes();
    });
    tagChipsEl.appendChild(allChip);
    for (const tag of tags) {
        const chip = el(
            `<button class="tag-chip${activeTagId === tag.id ? ' active' : ''}">${escapeText(tag.name)}
               <span class="tag-count">${tag.noteCount}</span></button>`);
        chip.addEventListener('click', () => {
            activeTagId = activeTagId === tag.id ? null : tag.id;
            searchEl.value = '';
            renderTagChips();
            renderNotes();
        });
        tagChipsEl.appendChild(chip);
    }
}

/* ---------- note create / edit modal ---------- */

function openNoteModal(note = null) {
    openModal((dialog, close) => {
        dialog.appendChild(el(`
          <div>
            <div class="modal-title">${note ? 'Edit note' : `New note for ${escapeText(persona.name)}`}</div>
            <div class="form-grid">
              <label>Title <input class="input" id="nm-title" maxlength="120" placeholder="A short, unique title"></label>
              <label>Content
                <textarea class="input" id="nm-content" rows="6" maxlength="4000"
                  placeholder="The knowledge itself - a few sentences."></textarea>
              </label>
              <label>Tags <span class="hint">comma-separated concepts; shared tags connect notes</span>
                <div class="form-row">
                  <input class="input" id="nm-tags" style="flex:1" placeholder="distributed systems, consensus">
                  <button class="btn" id="nm-suggest" title="Let the AI suggest tags">✨ Suggest</button>
                </div>
              </label>
            </div>
            <div class="btn-row modal-actions">
              <button class="btn" id="nm-cancel">Cancel</button>
              <button class="btn primary" id="nm-save">${note ? 'Save' : 'Add note'}</button>
            </div>
          </div>`));

        const titleInput = dialog.querySelector('#nm-title');
        const contentInput = dialog.querySelector('#nm-content');
        const tagsInput = dialog.querySelector('#nm-tags');
        titleInput.value = note?.title || '';
        contentInput.value = note?.content || '';
        tagsInput.value = (note?.tags || []).map(t => t.name).join(', ');

        dialog.querySelector('#nm-cancel').addEventListener('click', close);
        const suggestBtn = dialog.querySelector('#nm-suggest');
        suggestBtn.addEventListener('click', async () => {
            suggestBtn.disabled = true;
            suggestBtn.textContent = '…';
            try {
                const { tags: suggested } = await api.parlorSuggestTags(
                    persona.id, titleInput.value, contentInput.value);
                if (suggested.length === 0) {
                    showToast('No suggestions (is an AI provider configured?).', true);
                } else {
                    const existing = tagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
                    tagsInput.value = [...new Set([...existing, ...suggested])].join(', ');
                }
            } catch (error) {
                showToast(error.message, true);
            } finally {
                suggestBtn.disabled = false;
                suggestBtn.textContent = '✨ Suggest';
            }
        });
        dialog.querySelector('#nm-save').addEventListener('click', async () => {
            const fields = {
                title: titleInput.value.trim(),
                content: contentInput.value.trim(),
                tags: tagsInput.value.split(',').map(t => t.trim()).filter(Boolean)
            };
            try {
                if (note) await api.parlorUpdateNote(note.id, fields);
                else await api.parlorCreateNote(persona.id, fields);
                close();
                showToast(note ? 'Note updated.' : `${persona.name} now knows it.`);
                await refreshWorkspace();
            } catch (error) {
                showToast(error.message, true);
            }
        });
        titleInput.focus();
    });
}

/* ---------- graph ---------- */

function renderGraphDetail(node) {
    const detail = document.getElementById('parlor-graph-detail');
    if (!node) {
        detail.classList.add('hidden');
        return;
    }
    detail.classList.remove('hidden');
    detail.innerHTML = `
      <div class="gd-type">${escapeText(node.type)}${node.source === 'conversation' ? ' · 🌱 learned' : ''}</div>
      <div class="gd-label">${escapeText(node.label)}</div>
      ${node.content ? `<div class="gd-content">${escapeText(node.content)}</div>` : ''}
    `;
}

async function renderGraph() {
    const emptyEl = document.getElementById('parlor-graph-empty');
    const legend = document.getElementById('parlor-graph-legend');
    emptyEl.classList.add('hidden');
    renderGraphDetail(null);
    try {
        const { nodes, edges } = await api.parlorGraph(persona.id);
        legend.replaceChildren(...Object.entries(WORKSPACE_COLORS).map(([type, color]) =>
            el(`<span class="key"><span class="dot" style="background:${color}"></span>${type}</span>`)));
        if (!graphView) {
            graphView = new GraphView(document.getElementById('parlor-graph-canvas'), {
                onSelect: renderGraphDetail,
                colors: WORKSPACE_COLORS
            });
        }
        graphView.setData({ nodes, edges });
        if (nodes.length === 0) emptyEl.classList.remove('hidden');
    } catch (error) {
        emptyEl.classList.remove('hidden');
        emptyEl.textContent = error.message;
    }
}

/* ---------- wiring ---------- */

function setTab(tab) {
    currentTab = tab;
    for (const btn of tabsEl.querySelectorAll('.segment-btn')) {
        btn.classList.toggle('active', btn.dataset.wtab === tab);
    }
    notesPane.classList.toggle('hidden', tab !== 'notes');
    graphPane.classList.toggle('hidden', tab !== 'graph');
    if (tab === 'graph') renderGraph();
    else graphView?.stop();
}

async function refreshWorkspace() {
    tags = await api.parlorTags(persona.id).then(r => r.tags).catch(() => []);
    renderTagChips();
    if (currentTab === 'notes') await renderNotes();
    else await renderGraph();
}

/**
 * Show one persona's workspace in the workspace view.
 * @param {Object} params - { persona, toast, confirm, onEditPersona, onBack }
 */
export function openWorkspace(params) {
    persona = params.persona;
    showToast = params.toast;
    confirmDialog = params.confirm;
    onEditPersona = params.onEditPersona;

    titleEl.innerHTML =
        `<span class="persona-dot" style="background:${personaColor(persona)}">${escapeText(personaGlyph(persona))}</span> ` +
        `${escapeText(persona.name)}'s workspace`;
    activeTagId = null;
    searchEl.value = '';
    setTab('notes');
    refreshWorkspace();

    if (wired) return;
    wired = true;
    tabsEl.addEventListener('click', (event) => {
        const btn = event.target.closest('.segment-btn');
        if (btn) setTab(btn.dataset.wtab);
    });
    document.getElementById('note-add-btn').addEventListener('click', () => openNoteModal());
    document.getElementById('workspace-edit-persona').addEventListener('click', () => onEditPersona());
    let searchTimer = null;
    searchEl.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(renderNotes, 350);
    });
}

/** Halt the graph animation when leaving the workspace view. */
export function closeWorkspace() {
    graphView?.stop();
}
