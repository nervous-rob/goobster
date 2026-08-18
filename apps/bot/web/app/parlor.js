/**
 * The Parlor pane: multi-persona discussions. A user converses with a small
 * cast of personas; each replies from (and writes back to) its own private
 * knowledge workspace. This module owns the discussion sidebar, the persona
 * roster, the streaming turn UX, and the persona/discussion modals; the
 * per-persona workspace lives in parlorWorkspace.js.
 */
import { api, streamParlorChat, streamParlorNudge } from './api.js';
import { renderMarkdown } from './markdown.js';
import { renderMathIn } from './math.js';
import { decorateCodeBlocks, renderAttachments } from './codeblocks.js';
import {
    el, escapeText, timeLabel, openModal,
    personaColor, personaGlyph, PERSONA_PALETTE
} from './parlorUi.js';
import { openWorkspace, closeWorkspace } from './parlorWorkspace.js';
import {
    startLive, leaveLive, liveActive, liveConversationId, liveSay, liveNudge
} from './parlorLive.js';

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
const membersBtn = document.getElementById('parlor-members-btn');
const invitesEl = document.getElementById('parlor-invites');

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
let invites = [];
let activeConvId = null;
let myId = null;
let liveCaps = false; // loaded from /parlor/live/capabilities
let sending = false;
let abortController = null;
let showToast = () => {};
let confirmDialog = async () => false;
let wired = false;
// Shared-discussion refresh: other members' turns land while we watch
let pollTimer = null;
let lastRenderedMessageId = 0;

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

/** Whether the caller owns this discussion (vs joined it as a member). */
function isOwner(conversation) {
    return Boolean(conversation && conversation.role !== 'member');
}

/** Whether this discussion has (or could show) other humans. */
function isShared(conversation) {
    return Boolean(conversation
        && (conversation.role === 'member' || (conversation.members || []).length > 0));
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

// The ElevenLabs voice library for the voice picker, fetched once per page
// load. null = voices unavailable (no key) - the picker simply never shows.
let voicesPromise = null;
function loadVoices() {
    if (!voicesPromise) {
        voicesPromise = api.parlorVoices().then(r => r.voices).catch(() => null);
    }
    return voicesPromise;
}

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
              <label id="pm-voice-row" class="hidden">Voice <span class="hint">how they sound in live sessions</span>
                <select class="input" id="pm-voice"><option value="">Default (auto-assigned)</option></select>
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

        // Voice picker (Parlor Live): fed by the ElevenLabs voice library;
        // hidden when the server has no key (graceful degradation).
        const voiceRow = dialog.querySelector('#pm-voice-row');
        const voiceSel = dialog.querySelector('#pm-voice');
        let voicesLoaded = false;
        loadVoices().then(voices => {
            if (!voices || voices.length === 0 || !dialog.contains(voiceRow)) return;
            for (const voice of voices) {
                voiceSel.appendChild(el(
                    `<option value="${escapeText(voice.id)}">${escapeText(voice.name)}</option>`));
            }
            // A voice configured outside the library list stays selectable
            if (persona?.voiceId && ![...voiceSel.options].some(o => o.value === persona.voiceId)) {
                voiceSel.appendChild(el(
                    `<option value="${escapeText(persona.voiceId)}">${escapeText(persona.voiceName || persona.voiceId)}</option>`));
            }
            voiceSel.value = persona?.voiceId || '';
            voiceRow.classList.remove('hidden');
            voicesLoaded = true;
        });

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
                // Voice resolves against ElevenLabs at save time - a bad
                // pick fails loudly here, never mid-session.
                if (voicesLoaded && voiceSel.value !== (persona?.voiceId || '')) {
                    try {
                        await api.parlorSetPersonaVoice(saved.id, voiceSel.value);
                    } catch (error) {
                        showToast(`Voice not saved: ${error.message}`, true);
                    }
                }
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
        const shared = isShared(conversation);
        const mine = isOwner(conversation);
        const item = el(`
          <div class="conv-item${conversation.id === activeConvId ? ' active' : ''}">
            ${shared ? '<span class="shared-badge" title="Shared discussion">👥</span>' : ''}
            <span class="conv-title-text">${escapeText(title)}</span>
            <span class="conv-actions">
              ${mine
        ? '<button class="conv-action rename" title="Rename">✎</button>' +
                  '<button class="conv-action delete" title="Delete">🗑</button>'
        : '<button class="conv-action leave" title="Leave this discussion">🚪</button>'}
            </span>
          </div>`);
        item.querySelector('.rename')?.addEventListener('click', (event) => {
            event.stopPropagation();
            startRename(item, conversation);
        });
        item.querySelector('.delete')?.addEventListener('click', async (event) => {
            event.stopPropagation();
            if (!await confirmDialog(`Delete "${title}"? The personas keep everything they learned.`)) return;
            try {
                await api.parlorDeleteConversation(conversation.id);
                if (liveActive() && liveConversationId() === conversation.id) leaveLive();
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
        item.querySelector('.leave')?.addEventListener('click', async (event) => {
            event.stopPropagation();
            if (!await confirmDialog(`Leave "${title}"? The host can invite you back later.`)) return;
            try {
                await api.parlorRemoveMember(conversation.id, myId);
                if (liveActive() && liveConversationId() === conversation.id) leaveLive();
                conversations = conversations.filter(c => c.id !== conversation.id);
                if (activeConvId === conversation.id) {
                    activeConvId = conversations[0]?.id ?? null;
                    await loadMessages();
                }
                renderConversations();
                renderHeader();
                showToast('You left the discussion.');
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
    if (liveActive()) leaveLive(); // live sessions are per discussion
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

/* ---------- invitations (shared discussions) ---------- */

let inviteFingerprint = null;

async function refreshInvites() {
    try {
        const { invites: list } = await api.parlorInvites();
        invites = list;
    } catch {
        invites = [];
    }
    // Re-render only on change so the 5s poll never replaces buttons
    // someone is about to click
    const fingerprint = JSON.stringify(invites.map(i => i.id));
    if (fingerprint !== inviteFingerprint) {
        inviteFingerprint = fingerprint;
        renderInvites();
    }
}

function renderInvites() {
    invitesEl.replaceChildren();
    if (invites.length === 0) return;
    invitesEl.appendChild(el('<div class="panel-section-head"><span>Invitations</span></div>'));
    for (const invite of invites) {
        const item = el(`
          <div class="invite-item">
            <span class="invite-body">
              <span class="invite-title">${escapeText(invite.title || 'A parlor discussion')}</span>
              <span class="hint">from ${escapeText(invite.inviterName || invite.inviterId)}</span>
            </span>
            <button class="invite-action accept" title="Accept">✓</button>
            <button class="invite-action decline" title="Decline">✕</button>
          </div>`);
        item.querySelector('.accept').addEventListener('click', async () => {
            try {
                const result = await api.parlorRespondInvite(invite.id, true);
                await refreshInvites();
                await refreshConversations();
                await selectConversation(result.conversationId);
                showToast('You joined the discussion. Say hello!');
            } catch (error) {
                showToast(error.message, true);
            }
        });
        item.querySelector('.decline').addEventListener('click', async () => {
            try {
                await api.parlorRespondInvite(invite.id, false);
                await refreshInvites();
            } catch (error) {
                showToast(error.message, true);
            }
        });
        invitesEl.appendChild(item);
    }
}

/* ---------- members modal (shared discussions) ---------- */

function openMembersModal() {
    const conversation = activeConversation();
    if (!conversation) return;
    openModal(async (dialog, close) => {
        dialog.appendChild(el('<div><div class="modal-title">People in this discussion</div><div id="mm-body"><div class="hint">Loading…</div></div></div>'));
        const body = dialog.querySelector('#mm-body');

        const render = async () => {
            let roster;
            try {
                roster = await api.parlorMembers(conversation.id);
            } catch (error) {
                body.replaceChildren(el(`<div class="hint">${escapeText(error.message)}</div>`));
                return;
            }
            const mine = roster.role === 'owner';
            body.replaceChildren();
            const list = el('<div class="member-list"></div>');

            list.appendChild(el(`
              <div class="member-item">
                <span class="member-name">${escapeText(mine ? 'You' : `User ${roster.ownerId}`)}</span>
                <span class="member-role">host</span>
              </div>`));
            for (const member of roster.members) {
                const isMe = member.userId === myId;
                const row = el(`
                  <div class="member-item">
                    <span class="member-name">${escapeText(isMe ? 'You' : (member.userName || `User ${member.userId}`))}</span>
                    ${(mine || isMe)
        ? `<button class="conv-action remove" title="${isMe ? 'Leave this discussion' : 'Remove from this discussion'}">✕</button>`
        : ''}
                  </div>`);
                row.querySelector('.remove')?.addEventListener('click', async () => {
                    if (isMe && !await confirmDialog('Leave this discussion? The host can invite you back later.')) return;
                    try {
                        await api.parlorRemoveMember(conversation.id, member.userId);
                        if (isMe) {
                            close();
                            conversations = conversations.filter(c => c.id !== conversation.id);
                            activeConvId = conversations[0]?.id ?? null;
                            renderConversations();
                            renderHeader();
                            await loadMessages();
                            showToast('You left the discussion.');
                            return;
                        }
                        await refreshConversations();
                        await render();
                    } catch (error) {
                        showToast(error.message, true);
                    }
                });
                list.appendChild(row);
            }
            for (const invite of (roster.invites || [])) {
                const row = el(`
                  <div class="member-item pending">
                    <span class="member-name">${escapeText(invite.inviteeName || `User ${invite.inviteeId}`)}</span>
                    <span class="member-role">invited</span>
                    <button class="conv-action revoke" title="Withdraw invitation">✕</button>
                  </div>`);
                row.querySelector('.revoke').addEventListener('click', async () => {
                    try {
                        await api.parlorRevokeInvite(invite.id);
                        await render();
                    } catch (error) {
                        showToast(error.message, true);
                    }
                });
                list.appendChild(row);
            }
            body.appendChild(list);

            if (mine) body.appendChild(buildInvitePicker(conversation, render));
        };
        await render();
    });
}

/**
 * The invite picker: pick a person instead of pasting a snowflake. The
 * source is the user's Discord friends (synced by the Activity - the only
 * surface Discord lets read a friend list) followed by the people they
 * share a server with. Typing a raw user id still works, so an invite is
 * always possible even when neither source has anyone.
 * @param {Object} conversation
 * @param {Function} onInvited - re-render the roster after a successful invite
 */
function buildInvitePicker(conversation, onInvited) {
    const form = el(`
      <div class="invite-form">
        <div class="panel-section-head"><span>Invite someone</span></div>
        <input class="input" id="mm-search" placeholder="Search your friends and servers, or paste a user id" autocomplete="off">
        <div id="mm-results" class="people-list"><div class="hint">Loading…</div></div>
      </div>`);
    const searchEl = form.querySelector('#mm-search');
    const resultsEl = form.querySelector('#mm-results');

    const invite = async (userId, label) => {
        try {
            const { dmSent, inviteeName } = await api.parlorInvite(conversation.id, userId);
            const who = inviteeName || label || userId;
            showToast(dmSent
                ? `Invitation sent to ${who} by DM.`
                : `Invitation created for ${who} - their DMs are closed, but it shows in their web app.`);
            searchEl.value = '';
            await onInvited();
        } catch (error) {
            showToast(error.message, true);
        }
    };

    const renderResults = async (query) => {
        let result;
        try {
            result = await api.parlorInvitable(conversation.id, query);
        } catch (error) {
            resultsEl.replaceChildren(el(`<div class="hint">${escapeText(error.message)}</div>`));
            return;
        }
        // A pasted snowflake is always invitable, even if we have never
        // seen that person (no Activity sync, no shared server).
        const rawId = /^\d{5,20}$/.test(query.trim()) ? query.trim() : null;
        const known = result.people.some(person => person.id === rawId);

        resultsEl.replaceChildren();
        if (rawId && !known) {
            const row = el(`
              <div class="person-item">
                <span class="person-avatar">＋</span>
                <span class="person-body"><span class="person-name">Invite user ${escapeText(rawId)}</span>
                  <span class="hint">by Discord user id</span></span>
              </div>`);
            row.addEventListener('click', () => invite(rawId, null));
            resultsEl.appendChild(row);
        }
        for (const person of result.people) {
            const row = el(`
              <div class="person-item">
                ${person.avatar
        ? `<img class="person-avatar" src="${escapeText(person.avatar)}" alt="">`
        : '<span class="person-avatar">🙂</span>'}
                <span class="person-body">
                  <span class="person-name">${escapeText(person.name)}</span>
                  <span class="hint">${person.source === 'friend'
        ? 'Discord friend'
        : `shares ${escapeText(person.via || 'a server')}`}</span>
                </span>
                ${person.source === 'friend' ? '<span class="person-badge">friend</span>' : ''}
              </div>`);
            row.addEventListener('click', () => invite(person.id, person.name));
            resultsEl.appendChild(row);
        }
        if (resultsEl.children.length === 0) {
            resultsEl.appendChild(el(`<div class="hint">${query
                ? 'Nobody matches that - you can also paste their Discord user id.'
                : (result.friendsSynced
                    ? 'Everyone you know is already here.'
                    : 'No friends synced yet - open Goobster\'s Activity in Discord to bring your friend list over, or paste a Discord user id.')}</div>`));
        }
    };

    let searchTimer = null;
    searchEl.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => renderResults(searchEl.value.trim()), 220);
    });
    renderResults('');
    setTimeout(() => searchEl.focus(), 0);
    return form;
}

/* ---------- discussion header (participants) ---------- */

function renderHeader() {
    const conversation = activeConversation();
    const mine = isOwner(conversation);
    titleEl.textContent = conversation ? (conversation.title || 'New discussion') : 'The Parlor';
    participantsEl.replaceChildren();
    // Persona seats are the owner's to manage; members get the roster view
    addParticipantBtn.classList.toggle('hidden', !conversation || !mine);
    membersBtn.classList.toggle('hidden', !conversation);
    // Parlor Live: no ElevenLabs key means the button never renders
    const liveBtn = document.getElementById('parlor-live-btn');
    const liveHere = Boolean(conversation) && liveActive() && liveConversationId() === conversation.id;
    liveBtn.classList.toggle('hidden', !conversation || !liveCaps);
    liveBtn.classList.toggle('on', liveHere);
    liveBtn.title = liveHere
        ? 'End the live voice session'
        : 'Go live - talk to the personas by voice';
    if (!conversation) return;

    for (const participant of conversation.participants || []) {
        const chip = el(`
          <span class="participant-chip" style="border-color:${personaColor(participant)}"
                title="Ask ${escapeText(participant.name)} to speak now">
            <span class="persona-dot small" style="background:${personaColor(participant)}">${escapeText(personaGlyph(participant))}</span>
            ${escapeText(participant.name)}
            ${mine ? '<button class="chip-remove" title="Remove from this discussion">✕</button>' : ''}
          </span>`);
        chip.dataset.personaId = participant.id;
        // Clicking the chip nudges that persona to respond right now (no
        // new user message) - handy for storytelling rounds and planning.
        chip.addEventListener('click', () => nudgePersona(participant.id));
        chip.querySelector('.chip-remove')?.addEventListener('click', async (event) => {
            event.stopPropagation();
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
    // Shared discussions: label messages from the other humans (old rows
    // predating sharing have no userId and read as the viewer's own)
    if (message.userId && message.userId !== myId) {
        item.classList.add('from-member');
        item.prepend(el(
            `<div class="member-byline">${escapeText(message.userName || `User ${message.userId}`)}</div>`
        ));
    }
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
    decorateCodeBlocks(bubble, showToast);
    renderMathIn(bubble);
    renderAttachments(bubble, message.attachments || []);
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

function addPassLine({ personaName, reason }) {
    const line = el(
        `<div class="parlor-learned">🤫 ${escapeText(personaName)} listens quietly</div>`
    );
    if (reason) line.title = reason;
    log.appendChild(line);
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
    lastRenderedMessageId = 0;
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
            if (message.id > lastRenderedMessageId) lastRenderedMessageId = message.id;
        }
        scrollToBottom(true);
    } catch (error) {
        showToast(`Couldn't load the discussion: ${error.message}`, true);
    }
}

/* ---------- shared-discussion refresh ----------
 * Other members' turns (and new invitations) land while we watch, so the
 * parlor polls lightly while its pane is visible: new transcript rows in
 * the active shared discussion reload the log, and the invitation list
 * stays current. Our own streamed turns keep lastRenderedMessageId up to
 * date, so polling never fights the SSE stream. */

const POLL_INTERVAL_MS = 5000;

function paneVisible() {
    return !document.getElementById('pane-parlor').classList.contains('hidden')
        && document.visibilityState === 'visible';
}

let convFingerprint = null;

async function pollTick() {
    if (!paneVisible() || sending) return;
    try {
        await refreshInvites();

        // Keep the conversation list current (a friend accepting an invite
        // flips a discussion to shared), re-rendering only on change - and
        // never while a rename input is open.
        const { conversations: list } = await api.parlorConversations();
        conversations = list;
        const fingerprint = JSON.stringify(list.map(c =>
            [c.id, c.title, c.role, (c.members || []).length]));
        if (fingerprint !== convFingerprint) {
            const changed = convFingerprint !== null;
            convFingerprint = fingerprint;
            if (changed && !convList.querySelector('.conv-rename-input')) {
                renderConversations();
                renderHeader();
            }
        }

        const conversation = activeConversation();
        if (!conversation || !isShared(conversation)) return;
        const { messages } = await api.parlorMessages(activeConvId);
        const newest = messages.length > 0 ? messages[messages.length - 1].id : 0;
        if (newest > lastRenderedMessageId) await loadMessages();
    } catch {
        // transient - the next tick retries
    }
}

function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollTick, POLL_INTERVAL_MS);
}

/* ---------- Parlor Live (voice sessions) ---------- */

/** Highlight the participant chip of the persona currently speaking. */
function setSpeakingPersona(personaId) {
    for (const chip of participantsEl.querySelectorAll('.participant-chip')) {
        chip.classList.toggle('speaking',
            personaId != null && Number(chip.dataset.personaId) === Number(personaId));
    }
}

/**
 * Turn-event renderer for live sessions: the same transcript UX as the
 * SSE stream (typing indicator, streamed draft, tool labels, grounding),
 * but persistent across turns - anyone in the session may trigger one.
 */
function createLiveRenderer() {
    let pending = null;
    let draft = null;
    let draftText = '';
    let currentPersona = null;

    const clearPending = () => { pending?.remove(); pending = null; };
    const clearDraft = () => { draft?.remove(); draft = null; draftText = ''; };

    return (event, data) => {
        if (event === 'user_message') {
            addUserMessage(data);
            if (data.id > lastRenderedMessageId) lastRenderedMessageId = data.id;
        } else if (event === 'persona_start') {
            clearPending();
            clearDraft();
            currentPersona = personaById(data.id) || data;
            pending = typingIndicator(currentPersona);
        } else if (event === 'persona_pass') {
            clearPending();
            addPassLine(data);
        } else if (event === 'delta') {
            if (!draft) {
                clearPending();
                draft = addPersonaMessage({
                    personaId: currentPersona?.id,
                    personaName: currentPersona?.name,
                    content: ''
                });
            }
            draftText += data.text || '';
            const bubble = draft.querySelector('.msg-bubble');
            bubble.innerHTML = renderMarkdown(draftText) + '<span class="cursor-caret">&nbsp;</span>';
            renderMathIn(bubble);
            scrollToBottom();
        } else if (event === 'persona_tool') {
            clearDraft();
            clearPending();
            pending = typingIndicator(currentPersona, toolLabel(data.tools));
        } else if (event === 'persona_message') {
            clearPending();
            clearDraft();
            addPersonaMessage(data);
            if (data.id && data.id > lastRenderedMessageId) lastRenderedMessageId = data.id;
        } else if (event === 'learned') {
            addLearnedLine(data);
        } else if (event === 'turn_done' || event === 'turn_error') {
            clearPending();
            clearDraft();
            if (event === 'turn_error') {
                addPersonaMessage({ content: data.message || 'Something went wrong.', isError: true });
            }
            // Titles land async; note counts changed if personas learned.
            setTimeout(async () => {
                await refreshConversations();
                await refreshPersonas();
            }, 1500);
        }
    };
}

async function toggleLive() {
    if (liveActive()) {
        leaveLive();
        renderHeader();
        return;
    }
    if (!activeConvId) return;
    const renderLiveEvent = createLiveRenderer();
    try {
        await startLive(activeConvId, {
            onTurnEvent: renderLiveEvent,
            onSpeaking: setSpeakingPersona,
            onEnded: () => {
                setSpeakingPersona(null);
                renderHeader();
            },
            toast: showToast
        });
        renderHeader();
        showToast('You are live - just start talking. The personas answer out loud.');
    } catch (error) {
        showToast(error.name === 'NotAllowedError'
            ? 'Microphone access was denied.'
            : (error.message || 'Could not start the live session.'), true);
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

/**
 * Run one streamed parlor turn (a user message or a manual persona nudge)
 * with the shared draft/typing/tool-activity UX.
 * @param {(handlers: Object, signal: AbortSignal) => Promise<void>} runner
 */
async function runTurnStream(runner) {
    setSending(true);
    abortController = new AbortController();

    let pending = null;
    let draft = null;
    let draftText = '';
    let currentPersona = null;

    const clearPending = () => {
        pending?.remove();
        pending = null;
    };

    try {
        await runner({
            onUserMessage: (message) => {
                // Already echoed locally; just track the stored id so the
                // shared-discussion poll doesn't reload our own turn.
                if (message.id > lastRenderedMessageId) lastRenderedMessageId = message.id;
            },
            onPersonaStart: (persona) => {
                clearPending();
                currentPersona = personaById(persona.id) || persona;
                pending = typingIndicator(currentPersona);
                draft = null;
                draftText = '';
            },
            onPersonaPass: (payload) => {
                // The gate decided this persona has nothing to add
                clearPending();
                addPassLine(payload);
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
                const bubble = draft.querySelector('.msg-bubble');
                bubble.innerHTML = renderMarkdown(draftText) + '<span class="cursor-caret">&nbsp;</span>';
                renderMathIn(bubble);
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
                if (message.id && message.id > lastRenderedMessageId) lastRenderedMessageId = message.id;
            },
            onLearned: (payload) => addLearnedLine(payload),
            onError: ({ message }) => {
                clearPending();
                addPersonaMessage({ content: message || 'Something went wrong.', isError: true });
            }
        }, abortController.signal);
    } catch (error) {
        clearPending();
        if (error.name === 'AbortError') {
            if (draft && draftText) {
                const bubble = draft.querySelector('.msg-bubble');
                bubble.innerHTML = renderMarkdown(draftText);
                renderMathIn(bubble);
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

async function sendMessage() {
    if (sending) { stopGenerating(); return; }
    const text = input.value.trim();
    if (!text) return;
    if (!activeConvId) {
        openNewDiscussionModal();
        return;
    }

    // In a live session, typed messages ride the live socket too: the
    // session's queue runs them as normal turns, everyone connected sees
    // them stream, and the replies are spoken aloud.
    if (liveActive() && liveConversationId() === activeConvId) {
        input.value = '';
        autosize();
        if (!liveSay(text)) showToast('The live session dropped - try again.', true);
        return;
    }

    input.value = '';
    autosize();
    addUserMessage({ content: text });
    await runTurnStream((handlers, signal) =>
        streamParlorChat({ message: text, conversationId: activeConvId }, handlers, signal));
}

/** Ask one seated persona to speak right now (participant-chip click). */
async function nudgePersona(personaId) {
    if (sending || !activeConvId) return;
    if (liveActive() && liveConversationId() === activeConvId) {
        liveNudge(personaId);
        return;
    }
    await runTurnStream((handlers, signal) =>
        streamParlorNudge(activeConvId, personaId, handlers, signal));
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
 * @param {Object} params - { me, toast, confirm }
 */
export async function openConversation(id) {
    if (id == null) return;
    await selectConversation(Number(id));
}

export async function initParlor({ me = null, toast, confirm }) {
    showToast = toast;
    confirmDialog = confirm;
    myId = me?.user?.id || null;

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
        await refreshInvites();
    } catch (error) {
        showToast(`Couldn't load the parlor: ${error.message}`, true);
        return;
    }
    try {
        liveCaps = (await api.parlorLiveCapabilities()).live === true;
    } catch {
        liveCaps = false; // no key or old server - the button never renders
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
    membersBtn.addEventListener('click', openMembersModal);
    document.getElementById('parlor-live-btn').addEventListener('click', toggleLive);
    document.getElementById('workspace-back').addEventListener('click', showDiscussions);
    startPolling();
}
