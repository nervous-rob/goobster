/**
 * The Parlor pane: multi-persona discussions. A user converses with a small
 * cast of personas; each replies from (and writes back to) its own private
 * knowledge workspace. This module owns the discussion sidebar, the persona
 * roster, the streaming turn UX, and the persona/discussion modals; the
 * per-persona workspace lives in parlorWorkspace.js.
 */
import { api, streamParlorChat } from './api.js';
import { renderMarkdown } from './markdown.js';
import {
    el, escapeText, timeLabel, openModal,
    personaColor, personaGlyph, PERSONA_PALETTE
} from './parlorUi.js';
import { openWorkspace, closeWorkspace } from './parlorWorkspace.js';

const log = document.getElementById('parlor-log');
const scroller = document.getElementById('parlor-scroll');
const input = document.getElementById('parlor-input');
const sendBtn = document.getElementById('parlor-send');
const emptyState = document.getElementById('parlor-empty');
const suggestionsEl = document.getElementById('parlor-suggestions');
const convList = document.getElementById('parlor-conv-list');
const personaList = document.getElementById('parlor-persona-list');
const titleEl = document.getElementById('parlor-title');
const participantsEl = document.getElementById('parlor-participants');
const addParticipantBtn = document.getElementById('parlor-add-participant');

const SUGGESTIONS = [
    'Introduce yourselves - what do you each care about?',
    'What should we dig into together first?',
    'Here is my project idea - poke holes in it from your own angles.'
];

const STARTER_PERSONAS = [
    {
        name: 'The Researcher', emoji: '🔬',
        charter: 'You are a careful researcher. You care about evidence, sources, and methodology. ' +
            'You break questions down, flag what is unknown, and never overstate certainty.'
    },
    {
        name: 'The Engineer', emoji: '🔧',
        charter: 'You are a pragmatic engineer. You care about what ships: trade-offs, failure modes, ' +
            'maintenance cost, and the simplest thing that works. You think in concrete systems.'
    },
    {
        name: 'The Philosopher', emoji: '🦉',
        charter: 'You are a reflective philosopher. You question assumptions, surface the values at ' +
            'stake, and reframe problems. You are comfortable with ambiguity and love a good counterexample.'
    }
];

let personas = [];
let conversations = [];
let activeConvId = null;
let sending = false;
let abortController = null;
let showToast = () => {};
let confirmDialog = async () => false;
let wired = false;

/* ---------- utilities ---------- */

function nearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
}

function scrollToBottom(force = false) {
    if (force || nearBottom()) scroller.scrollTop = scroller.scrollHeight;
}

function activeConversation() {
    return conversations.find(c => c.id === activeConvId) || null;
}

function personaById(id) {
    return personas.find(p => p.id === id) || null;
}

/* ---------- persona roster (sidebar) ---------- */

function renderPersonaList() {
    personaList.replaceChildren();
    if (personas.length === 0) {
        personaList.appendChild(el(
            '<div class="hint" style="padding:4px 10px">No personas yet - create one, or start a discussion to meet the starter cast.</div>'
        ));
        return;
    }
    for (const persona of personas) {
        const item = el(`
          <div class="persona-item">
            <span class="persona-dot" style="background:${personaColor(persona)}">${escapeText(personaGlyph(persona))}</span>
            <span class="persona-name">${escapeText(persona.name)}</span>
            <span class="persona-count">${persona.noteCount ?? 0} 📝</span>
          </div>`);
        item.title = `Open ${persona.name}'s knowledge workspace`;
        item.addEventListener('click', () => showWorkspace(persona.id));
        personaList.appendChild(item);
    }
}

function showWorkspace(personaId) {
    const persona = personaById(personaId);
    if (!persona) return;
    document.getElementById('parlor-chat-view').classList.add('hidden');
    document.getElementById('parlor-workspace-view').classList.remove('hidden');
    openWorkspace({
        persona,
        toast: showToast,
        confirm: confirmDialog,
        onEditPersona: () => openPersonaModal(persona),
        onBack: showDiscussions
    });
}

function showDiscussions() {
    closeWorkspace();
    document.getElementById('parlor-workspace-view').classList.add('hidden');
    document.getElementById('parlor-chat-view').classList.remove('hidden');
}

/* ---------- persona create / edit modal ---------- */

function openPersonaModal(persona = null, { onSaved = null } = {}) {
    openModal((dialog, close) => {
        const defaultColor = persona
            ? personaColor(persona)
            : PERSONA_PALETTE[personas.length % PERSONA_PALETTE.length];
        dialog.appendChild(el(`
          <div>
            <div class="modal-title">${persona ? 'Edit persona' : 'New persona'}</div>
            <div class="form-grid">
              <label>Name <input class="input" id="pm-name" maxlength="48" placeholder="The Researcher"></label>
              <div class="form-row">
                <label>Emoji <input class="input" id="pm-emoji" maxlength="8" placeholder="🔬" style="width:70px"></label>
                <label>Color <input type="color" id="pm-color" class="color-input"></label>
              </div>
              <label>Charter <span class="hint">who this persona is and how it thinks</span>
                <textarea class="input" id="pm-charter" rows="5" maxlength="2000"
                  placeholder="You are a careful researcher. You care about evidence..."></textarea>
              </label>
            </div>
            <div class="btn-row modal-actions">
              ${persona ? '<button class="btn danger" id="pm-delete">Delete</button>' : ''}
              <span style="flex:1"></span>
              <button class="btn" id="pm-cancel">Cancel</button>
              <button class="btn primary" id="pm-save">${persona ? 'Save' : 'Create'}</button>
            </div>
          </div>`));

        const nameEl = dialog.querySelector('#pm-name');
        const emojiEl = dialog.querySelector('#pm-emoji');
        const colorEl = dialog.querySelector('#pm-color');
        const charterEl = dialog.querySelector('#pm-charter');
        nameEl.value = persona?.name || '';
        emojiEl.value = persona?.emoji || '';
        colorEl.value = defaultColor;
        charterEl.value = persona?.charter || '';

        dialog.querySelector('#pm-cancel').addEventListener('click', close);
        dialog.querySelector('#pm-delete')?.addEventListener('click', async () => {
            if (!await confirmDialog(
                `Retire ${persona.name}? Their whole knowledge workspace (${persona.noteCount ?? 0} notes) goes with them.`)) return;
            try {
                await api.parlorDeletePersona(persona.id);
                close();
                showDiscussions();
                await refreshAll();
                showToast(`${persona.name} has left the parlor.`);
            } catch (error) {
                showToast(error.message, true);
            }
        });
        dialog.querySelector('#pm-save').addEventListener('click', async () => {
            const fields = {
                name: nameEl.value.trim(),
                emoji: emojiEl.value.trim() || null,
                color: colorEl.value,
                charter: charterEl.value.trim()
            };
            try {
                const saved = persona
                    ? await api.parlorUpdatePersona(persona.id, fields)
                    : await api.parlorCreatePersona(fields);
                close();
                await refreshPersonas();
                if (activeConvId) await loadMessages();
                showToast(persona ? 'Persona updated.' : `${saved.name} joined the parlor.`);
                onSaved?.(saved);
            } catch (error) {
                showToast(error.message, true);
            }
        });
        nameEl.focus();
    });
}

/* ---------- discussions sidebar ---------- */

function renderConversations() {
    convList.replaceChildren();
    for (const conversation of conversations) {
        const title = conversation.title || 'New discussion';
        const item = el(`
          <div class="conv-item${conversation.id === activeConvId ? ' active' : ''}">
            <span class="conv-title-text">${escapeText(title)}</span>
            <span class="conv-actions">
              <button class="conv-action rename" title="Rename">✎</button>
              <button class="conv-action delete" title="Delete">🗑</button>
            </span>
          </div>`);
        item.querySelector('.rename').addEventListener('click', (event) => {
            event.stopPropagation();
            startRename(item, conversation);
        });
        item.querySelector('.delete').addEventListener('click', async (event) => {
            event.stopPropagation();
            if (!await confirmDialog(`Delete "${title}"? The personas keep everything they learned.`)) return;
            try {
                await api.parlorDeleteConversation(conversation.id);
                conversations = conversations.filter(c => c.id !== conversation.id);
                if (activeConvId === conversation.id) {
                    activeConvId = conversations[0]?.id ?? null;
                    await loadMessages();
                }
                renderConversations();
                renderHeader();
                showToast('Discussion deleted.');
            } catch (error) {
                showToast(error.message, true);
            }
        });
        item.addEventListener('click', () => selectConversation(conversation.id));
        convList.appendChild(item);
    }
}

function startRename(item, conversation) {
    const inputEl = el('<input class="conv-rename-input" maxlength="80">');
    inputEl.value = conversation.title || '';
    item.replaceChildren(inputEl);
    inputEl.focus();
    inputEl.select();
    const finish = async (save) => {
        const title = inputEl.value.trim();
        if (save && title && title !== conversation.title) {
            try {
                await api.parlorRenameConversation(conversation.id, title);
                conversation.title = title;
            } catch (error) {
                showToast(error.message, true);
            }
        }
        renderConversations();
        renderHeader();
    };
    inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') finish(false);
    });
    inputEl.addEventListener('blur', () => finish(true));
}

async function selectConversation(id) {
    if (sending || id === activeConvId) return;
    activeConvId = id;
    showDiscussions();
    renderConversations();
    renderHeader();
    await loadMessages();
}

/* ---------- new discussion modal ---------- */

async function openNewDiscussionModal() {
    // First visit: offer the concierge quickstart (or a template) so the
    // parlor is never empty.
    if (personas.length === 0) {
        openGettingStartedModal();
        return;
    }
    openModal((dialog, close) => {
        dialog.appendChild(el(`
          <div>
            <div class="modal-title">New discussion</div>
            <div class="hint" style="margin-bottom:10px">Invite up to 4 personas. Each replies in turn, grounded in its own workspace.</div>
            <div id="nd-list" class="persona-picker"></div>
            <div class="btn-row modal-actions">
              <button class="btn" id="nd-new-persona">✚ New persona</button>
              <span style="flex:1"></span>
              <button class="btn" id="nd-cancel">Cancel</button>
              <button class="btn primary" id="nd-create" disabled>Start</button>
            </div>
          </div>`));
        const list = dialog.querySelector('#nd-list');
        const createBtn = dialog.querySelector('#nd-create');
        const selected = new Set();

        const renderPicker = () => {
            list.replaceChildren(...personas.map(persona => {
                const row = el(`
                  <div class="persona-pick${selected.has(persona.id) ? ' picked' : ''}">
                    <span class="persona-dot" style="background:${personaColor(persona)}">${escapeText(personaGlyph(persona))}</span>
                    <span class="persona-pick-body">
                      <span class="persona-name">${escapeText(persona.name)}</span>
                      <span class="hint">${escapeText(persona.charter.slice(0, 90))}${persona.charter.length > 90 ? '…' : ''}</span>
                    </span>
                    <span class="persona-check">${selected.has(persona.id) ? '✓' : ''}</span>
                  </div>`);
                row.addEventListener('click', () => {
                    if (selected.has(persona.id)) selected.delete(persona.id);
                    else if (selected.size < 4) selected.add(persona.id);
                    else showToast('At most 4 personas per discussion.', true);
                    renderPicker();
                    createBtn.disabled = selected.size === 0;
                });
                return row;
            }));
        };
        renderPicker();

        dialog.querySelector('#nd-cancel').addEventListener('click', close);
        dialog.querySelector('#nd-new-persona').addEventListener('click', () => {
            close();
            openPersonaModal(null, { onSaved: () => openNewDiscussionModal() });
        });
        createBtn.addEventListener('click', async () => {
            try {
                const created = await api.parlorCreateConversation([...selected]);
                conversations.unshift(created);
                activeConvId = created.id;
                close();
                showDiscussions();
                renderConversations();
                renderHeader();
                await loadMessages();
                input.focus();
            } catch (error) {
                showToast(error.message, true);
            }
        });
    });
}

/**
 * First-run setup: the featured path is the concierge quickstart (describe
 * the topic, an agent designs the personas, seeds their knowledge, and
 * opens the discussion); the starter cast and manual creation remain as
 * alternatives.
 */
function openGettingStartedModal() {
    openModal((dialog, close) => {
        dialog.appendChild(el(`
          <div>
            <div class="modal-title">Set up your parlor</div>
            <div class="hint" style="margin-bottom:14px">
              Tell the concierge what you want to talk about, and it will design a cast of
              personas with distinct perspectives, seed their knowledge workspaces, and open
              the discussion for you.
            </div>
            <textarea class="input qs-prompt" id="qs-prompt" rows="3" maxlength="2000"
              placeholder="e.g. I want to design a self-hosted home automation setup - I care about privacy, reliability, and keeping costs low."></textarea>
            <button class="btn primary qs-go" id="qs-go">⚡ Build my salon</button>
            <div class="qs-divider hint">or start without the concierge</div>
            <div class="btn-row" style="justify-content:center">
              <button class="btn" id="qs-cast">Seat the starter cast</button>
              <button class="btn" id="qs-own">Create my own persona</button>
            </div>
          </div>`));

        const promptEl = dialog.querySelector('#qs-prompt');
        const goBtn = dialog.querySelector('#qs-go');

        goBtn.addEventListener('click', async () => {
            const prompt = promptEl.value.trim();
            if (!prompt) {
                showToast('Tell the concierge what the salon should be about.', true);
                promptEl.focus();
                return;
            }
            goBtn.disabled = true;
            goBtn.textContent = '⚡ Assembling your salon…';
            try {
                const result = await api.parlorQuickstart(prompt);
                close();
                await refreshPersonas();
                await refreshConversations();
                activeConvId = result.conversation.id;
                showDiscussions();
                renderConversations();
                renderHeader();
                await loadMessages();
                if (result.opening) {
                    input.value = result.opening;
                    autosize();
                }
                input.focus();
                showToast(`${result.personas.length} personas seated, ${result.seededNotes} notes seeded. Say the word.`);
            } catch (error) {
                showToast(error.message, true);
                goBtn.disabled = false;
                goBtn.textContent = '⚡ Build my salon';
            }
        });
        promptEl.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                goBtn.click();
            }
        });

        dialog.querySelector('#qs-own').addEventListener('click', () => {
            close();
            openPersonaModal(null, { onSaved: () => openNewDiscussionModal() });
        });
        dialog.querySelector('#qs-cast').addEventListener('click', async () => {
            try {
                for (let i = 0; i < STARTER_PERSONAS.length; i++) {
                    await api.parlorCreatePersona({
                        ...STARTER_PERSONAS[i],
                        color: PERSONA_PALETTE[i % PERSONA_PALETTE.length]
                    });
                }
                await refreshPersonas();
                close();
                openNewDiscussionModal();
            } catch (error) {
                showToast(error.message, true);
            }
        });
        promptEl.focus();
    });
}

/* ---------- discussion header (participants) ---------- */

function renderHeader() {
    const conversation = activeConversation();
    titleEl.textContent = conversation ? (conversation.title || 'New discussion') : 'The Parlor';
    participantsEl.replaceChildren();
    addParticipantBtn.classList.toggle('hidden', !conversation);
    if (!conversation) return;

    for (const participant of conversation.participants || []) {
        const chip = el(`
          <span class="participant-chip" style="border-color:${personaColor(participant)}">
            <span class="persona-dot small" style="background:${personaColor(participant)}">${escapeText(personaGlyph(participant))}</span>
            ${escapeText(participant.name)}
            <button class="chip-remove" title="Remove from this discussion">✕</button>
          </span>`);
        chip.querySelector('.chip-remove').addEventListener('click', async () => {
            try {
                const { participants } = await api.parlorSetParticipant(conversation.id, participant.id, false);
                conversation.participants = participants;
                renderHeader();
            } catch (error) {
                showToast(error.message, true);
            }
        });
        participantsEl.appendChild(chip);
    }
}

function openAddParticipant() {
    const conversation = activeConversation();
    if (!conversation) return;
    const present = new Set((conversation.participants || []).map(p => p.id));
    const available = personas.filter(p => !present.has(p.id));
    if (available.length === 0) {
        showToast('Every persona is already seated (or create a new one first).', true);
        return;
    }
    openModal((dialog, close) => {
        dialog.appendChild(el('<div><div class="modal-title">Invite a persona</div><div id="ap-list" class="persona-picker"></div></div>'));
        const list = dialog.querySelector('#ap-list');
        for (const persona of available) {
            const row = el(`
              <div class="persona-pick">
                <span class="persona-dot" style="background:${personaColor(persona)}">${escapeText(personaGlyph(persona))}</span>
                <span class="persona-pick-body"><span class="persona-name">${escapeText(persona.name)}</span></span>
              </div>`);
            row.addEventListener('click', async () => {
                try {
                    const { participants } = await api.parlorSetParticipant(conversation.id, persona.id, true);
                    conversation.participants = participants;
                    close();
                    renderHeader();
                } catch (error) {
                    showToast(error.message, true);
                }
            });
            list.appendChild(row);
        }
    });
}

/* ---------- transcript rendering ---------- */

function setEmptyState(show) {
    emptyState.classList.toggle('hidden', !show);
}

function groundingRow(grounding = []) {
    if (!grounding || grounding.length === 0) return null;
    const row = el('<div class="grounding">📎 grounded on:</div>');
    for (const note of grounding) {
        row.appendChild(el(`<span class="gchip" title="Workspace note #${note.id}">${escapeText(note.title)}</span>`));
    }
    return row;
}

function addUserMessage(message) {
    setEmptyState(false);
    const item = el('<div class="msg user"><div class="msg-bubble"></div></div>');
    item.querySelector('.msg-bubble').textContent = message.content;
    if (message.createdAt) {
        item.appendChild(el(`<div class="msg-meta">${escapeText(timeLabel(message.createdAt))}</div>`));
    }
    log.appendChild(item);
    scrollToBottom();
    return item;
}

function addPersonaMessage(message) {
    setEmptyState(false);
    const persona = message.personaId ? personaById(message.personaId) : null;
    const color = persona ? personaColor(persona) : 'var(--text-dim)';
    const glyph = persona ? personaGlyph(persona) : '·';
    const name = message.personaName || persona?.name || 'a former persona';

    const item = el(`
      <div class="msg assistant persona-msg${message.isError ? ' error' : ''}">
        <div class="persona-byline" style="color:${color}">
          <span class="persona-dot small" style="background:${color}">${escapeText(glyph)}</span>
          ${escapeText(name)}
        </div>
        <div class="msg-bubble" style="border-left: 3px solid ${color}"></div>
      </div>`);
    const bubble = item.querySelector('.msg-bubble');
    bubble.innerHTML = renderMarkdown(message.content || '');
    for (const file of message.attachments || []) {
        if (!file?.url) continue;
        const img = document.createElement('img');
        img.className = 'attachment';
        img.src = file.url;
        img.alt = file.name || 'attachment';
        img.loading = 'lazy';
        bubble.appendChild(img);
    }
    const grounding = groundingRow(message.grounding);
    if (grounding) item.appendChild(grounding);
    if (message.createdAt) {
        item.appendChild(el(`<div class="msg-meta">${escapeText(timeLabel(message.createdAt))}</div>`));
    }
    log.appendChild(item);
    scrollToBottom();
    return item;
}

function addLearnedLine({ personaName, notes }) {
    const titles = notes.map(n => `“${n.title}”`).join(', ');
    log.appendChild(el(
        `<div class="parlor-learned">🌱 ${escapeText(personaName)} filed ${escapeText(titles)} in their workspace</div>`
    ));
    scrollToBottom();
}

const TOOL_LABELS = {
    performSearch: 'searching the web…',
    generateImage: 'painting something…',
    runCode: 'running some code…',
    rollDice: 'rolling dice…',
    stockQuote: 'checking the market…'
};

function toolLabel(tools = []) {
    const labels = [...new Set(tools.map(t => TOOL_LABELS[t] || 'using a tool…'))];
    return labels.join(' ') || 'using a tool…';
}

function typingIndicator(persona, label = 'consulting their notes…') {
    const color = persona ? personaColor(persona) : 'var(--text-dim)';
    const item = el(`
      <div class="msg assistant persona-msg">
        <div class="persona-byline" style="color:${color}">
          <span class="persona-dot small" style="background:${color}">${escapeText(persona ? personaGlyph(persona) : '·')}</span>
          ${escapeText(persona?.name || '')} <span class="hint">${escapeText(label)}</span>
        </div>
        <div class="msg-bubble"><span class="typing"><i></i><i></i><i></i></span></div>
      </div>`);
    log.appendChild(item);
    scrollToBottom(true);
    return item;
}

async function loadMessages() {
    log.replaceChildren();
    if (!activeConvId) {
        setEmptyState(true);
        return;
    }
    try {
        const { messages } = await api.parlorMessages(activeConvId);
        setEmptyState(messages.length === 0);
        for (const message of messages) {
            if (message.role === 'user') addUserMessage(message);
            else addPersonaMessage(message);
        }
        scrollToBottom(true);
    } catch (error) {
        showToast(`Couldn't load the discussion: ${error.message}`, true);
    }
}

/* ---------- sending ---------- */

function setSending(active) {
    sending = active;
    sendBtn.classList.toggle('stop', active);
    sendBtn.textContent = active ? '◼' : '➤';
    sendBtn.title = active ? 'Stop the turn' : 'Send';
}

async function stopGenerating() {
    try { await api.parlorStop(); } catch { /* turn may have just finished */ }
    abortController?.abort();
}

async function sendMessage() {
    if (sending) { stopGenerating(); return; }
    const text = input.value.trim();
    if (!text) return;
    if (!activeConvId) {
        openNewDiscussionModal();
        return;
    }

    input.value = '';
    autosize();
    setSending(true);
    abortController = new AbortController();

    addUserMessage({ content: text });
    let pending = null;
    let draft = null;
    let draftText = '';
    let currentPersona = null;

    const clearPending = () => {
        pending?.remove();
        pending = null;
    };

    try {
        await streamParlorChat(
            { message: text, conversationId: activeConvId },
            {
                onPersonaStart: (persona) => {
                    clearPending();
                    currentPersona = personaById(persona.id) || persona;
                    pending = typingIndicator(currentPersona);
                    draft = null;
                    draftText = '';
                },
                onDelta: (delta) => {
                    if (!draft) {
                        clearPending();
                        draft = addPersonaMessage({
                            personaId: currentPersona?.id,
                            personaName: currentPersona?.name,
                            content: ''
                        });
                    }
                    draftText += delta;
                    draft.querySelector('.msg-bubble').innerHTML =
                        renderMarkdown(draftText) + '<span class="cursor-caret">&nbsp;</span>';
                    scrollToBottom();
                },
                onPersonaTool: ({ tools }) => {
                    // A tool round supersedes the streamed preamble: the next
                    // model round starts a fresh reply, so reset the draft
                    // and show what the persona is doing meanwhile.
                    if (draft) {
                        draft.remove();
                        draft = null;
                        draftText = '';
                    }
                    clearPending();
                    pending = typingIndicator(currentPersona, toolLabel(tools));
                },
                onPersonaMessage: (message) => {
                    clearPending();
                    if (draft) draft.remove();
                    draft = null;
                    draftText = '';
                    addPersonaMessage(message);
                },
                onLearned: (payload) => addLearnedLine(payload),
                onError: ({ message }) => {
                    clearPending();
                    addPersonaMessage({ content: message || 'Something went wrong.', isError: true });
                }
            },
            abortController.signal
        );
    } catch (error) {
        clearPending();
        if (error.name === 'AbortError') {
            if (draft && draftText) {
                draft.querySelector('.msg-bubble').innerHTML = renderMarkdown(draftText);
                draft.appendChild(el('<div class="msg-meta">stopped</div>'));
            }
        } else {
            addPersonaMessage({ content: error.message || 'Something went wrong.', isError: true });
            if (error.status === 429 || error.status === 409) showToast(error.message, true);
        }
    } finally {
        clearPending();
        setSending(false);
        abortController = null;
        input.focus();
        // Titles land async; note counts changed if personas learned.
        setTimeout(async () => {
            await refreshConversations();
            await refreshPersonas();
        }, 1500);
    }
}

/* ---------- data ---------- */

async function refreshPersonas() {
    const { personas: list } = await api.parlorPersonas();
    personas = list;
    renderPersonaList();
}

async function refreshConversations() {
    const { conversations: list } = await api.parlorConversations();
    conversations = list;
    renderConversations();
    renderHeader();
}

async function refreshAll() {
    await refreshPersonas();
    await refreshConversations();
    if (activeConvId && !activeConversation()) {
        activeConvId = conversations[0]?.id ?? null;
        await loadMessages();
    }
}

/* ---------- wiring ---------- */

function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
}

/**
 * Prepare the parlor pane (idempotent; refreshes on every visit).
 * @param {Object} params - { toast, confirm }
 */
export async function initParlor({ toast, confirm }) {
    showToast = toast;
    confirmDialog = confirm;

    suggestionsEl.replaceChildren(...SUGGESTIONS.map(text => {
        const btn = el(`<button class="suggestion">${escapeText(text)}</button>`);
        btn.addEventListener('click', () => {
            input.value = text;
            autosize();
            input.focus();
        });
        return btn;
    }));

    try {
        await refreshPersonas();
        await refreshConversations();
    } catch (error) {
        showToast(`Couldn't load the parlor: ${error.message}`, true);
        return;
    }

    if (!activeConvId || !activeConversation()) {
        activeConvId = conversations[0]?.id ?? null;
    }
    renderConversations();
    renderHeader();
    await loadMessages();

    if (wired) return;
    wired = true;

    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });
    input.addEventListener('input', autosize);
    document.getElementById('parlor-new-btn').addEventListener('click', openNewDiscussionModal);
    document.getElementById('parlor-quickstart-btn').addEventListener('click', openGettingStartedModal);
    document.getElementById('persona-add-btn').addEventListener('click', () => openPersonaModal());
    addParticipantBtn.addEventListener('click', openAddParticipant);
    document.getElementById('workspace-back').addEventListener('click', showDiscussions);
}
