/**
 * App bootstrap: session check, login flow, room routing, and PWA
 * service worker registration. Home is the front door; chat is a room.
 */
import { api } from './api.js';
import { initChat, openConversation as openChatConversation, startNewChat } from './chat.js';
import { initMemory } from './memory.js';
import { initParlor, openConversation as openParlorConversation } from './parlor.js';
import { initExchange } from './exchange.js';
import { initTasks } from './tasks.js';
import { initMtga } from './mtga.js';
import { initObservatory } from './observatory.js';
import { initUsage } from './usage.js';
import { initHome } from './home.js';
import { initWorkshop } from './workshop.js';
import { applyAtmosphere } from './atmosphere.js';
import { openModal, closeModal } from './modal.js';

const loginView = document.getElementById('view-login');
const appView = document.getElementById('view-app');
const toastEl = document.getElementById('toast');

let me = null;
let toastTimer = null;
let currentRoom = 'home';

function toast(message, isError = false) {
    toastEl.textContent = message;
    toastEl.classList.toggle('error', isError);
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 4000);
}

function confirmDialog(text) {
    const backdrop = document.getElementById('dialog-backdrop');
    const textEl = document.getElementById('dialog-text');
    const confirmBtn = document.getElementById('dialog-confirm');
    const cancelBtn = document.getElementById('dialog-cancel');
    textEl.textContent = text;
    return new Promise((resolve) => {
        let settled = false;
        const close = (result) => {
            if (settled) return;
            settled = true;
            confirmBtn.removeEventListener('click', yes);
            cancelBtn.removeEventListener('click', no);
            closeModal(backdrop);
            resolve(result);
        };
        const yes = () => close(true);
        const no = () => close(false);
        confirmBtn.addEventListener('click', yes);
        cancelBtn.addEventListener('click', no);
        openModal(backdrop, { initialFocus: cancelBtn, onClose: () => close(false) });
    });
}

const ROOMS = {
    home: { pane: 'home', hash: 'home' },
    chat: { pane: 'chat', hash: 'study' },
    parlor: { pane: 'parlor', hash: 'parlor' },
    memory: { pane: 'memory', hash: 'library' },
    workshop: { pane: 'workshop', hash: 'workshop' },
    observatory: { pane: 'observatory', hash: 'observatory' },
    exchange: { pane: 'exchange', hash: 'exchange' },
    tasks: { pane: 'tasks', hash: 'tasks' },
    mtga: { pane: 'mtga', hash: 'decks' },
    usage: { pane: 'usage', hash: 'usage' }
};

const HASH_TO_ROOM = Object.fromEntries(
    Object.entries(ROOMS).map(([room, meta]) => [meta.hash, room])
);

function setHash(room, extra = '') {
    const hash = `#${ROOMS[room]?.hash || 'home'}${extra}`;
    if (location.hash !== hash) {
        history.replaceState(null, '', hash);
    }
}

function parseHash() {
    const raw = (location.hash || '#home').replace(/^#/, '');
    const [name, id] = raw.split('/');
    const room = HASH_TO_ROOM[name] || (ROOMS[name] ? name : 'home');
    return { room, id: id && /^\d+$/.test(id) ? Number(id) : null };
}

function setView(name) {
    if (!ROOMS[name]) name = 'home';
    if (name === 'observatory' && !me?.features?.observatory) name = 'home';
    currentRoom = name;
    for (const btn of document.querySelectorAll('.nav-btn, .brand-home')) {
        btn.classList.toggle('active', btn.dataset.view === name);
    }
    for (const room of Object.keys(ROOMS)) {
        const pane = document.getElementById(`pane-${ROOMS[room].pane}`);
        if (pane) pane.classList.toggle('is-in', room === name);
    }
    document.getElementById('conversations-panel').classList.toggle('hidden', name !== 'chat');
    document.getElementById('parlor-panel').classList.toggle('hidden', name !== 'parlor');
    applyAtmosphere(name);
}

async function navigate(room, opts = {}) {
    setView(room);
    const extra = opts.conversationId ? `/${opts.conversationId}` : '';
    setHash(room, extra);

    if (room === 'home') await initHome({ me, toast, navigate, forget: openForget });
    if (room === 'memory') initMemory({ me, toast, confirm: confirmDialog, forget: openForget });
    if (room === 'exchange') initExchange({ me, toast, confirm: confirmDialog });
    if (room === 'parlor') {
        await initParlor({ me, toast, confirm: confirmDialog });
        if (opts.conversationId) await openParlorConversation(opts.conversationId);
    }
    if (room === 'tasks') initTasks({ me, toast, confirm: confirmDialog });
    if (room === 'mtga') initMtga({ me, toast, confirm: confirmDialog });
    if (room === 'observatory') initObservatory({ me, toast, confirm: confirmDialog });
    if (room === 'usage') initUsage({ me, toast });
    if (room === 'workshop') await initWorkshop({ toast, confirm: confirmDialog, navigate });
    if (room === 'chat') {
        if (opts.newChat) startNewChat();
        else if (opts.conversationId) await openChatConversation(opts.conversationId);
    }
}

/* ---------- forget-me theater ---------- */

const forgetBackdrop = document.getElementById('forget-modal-backdrop');
const forgetInput = document.getElementById('forget-confirm-input');
const forgetRun = document.getElementById('forget-run');

function syncForgetReady() {
    forgetRun.disabled = forgetInput.value.trim().toUpperCase() !== 'FORGET ME';
}

function openForget() {
    forgetInput.value = '';
    syncForgetReady();
    openModal(forgetBackdrop, { initialFocus: forgetInput });
}

forgetInput.addEventListener('input', syncForgetReady);
document.getElementById('forget-cancel').addEventListener('click', () =>
    closeModal(forgetBackdrop));
forgetRun.addEventListener('click', async () => {
    if (forgetRun.disabled) return;
    forgetRun.disabled = true;
    forgetRun.textContent = 'Erasing…';
    try {
        const result = await api.forgetMe(forgetInput.value);
        closeModal(forgetBackdrop);
        playForgetTheater(result);
    } catch (error) {
        toast(error.message, true);
        forgetRun.textContent = 'Erase everything';
        syncForgetReady();
    }
});

function playForgetTheater({ counts, audit }) {
    const overlay = document.createElement('div');
    overlay.className = 'forget-theater';
    overlay.innerHTML = `
      <img src="icons/goobster.svg" alt="" width="64" height="64">
      <h2>Forgetting you.</h2>
      <p class="hint">Watching the rows go.</p>
      <ul class="forget-count-list"></ul>
      <p class="forget-audit hint"></p>`;
    document.body.appendChild(overlay);
    const list = overlay.querySelector('.forget-count-list');
    const shown = [
        ['Memories', counts.memories],
        ['Facts', counts.userFacts],
        ['Chats', counts.webConversations],
        ['Applets', counts.webApplets],
        ['Follow-ups', counts.followups],
        ['Sessions', counts.webSessions]
    ].filter(([, n]) => n > 0);
    if (shown.length === 0) {
        shown.push(['Everything already empty', 0]);
    }
    for (const [label, n] of shown) {
        const li = document.createElement('li');
        li.textContent = n ? `${label} — ${n}` : label;
        list.appendChild(li);
        requestAnimationFrame(() => li.classList.add('gone'));
    }
    const leftover = audit?.total ?? 0;
    overlay.querySelector('.forget-audit').textContent = leftover === 0
        ? 'Audit: zero rows left. You can walk out.'
        : `Audit still sees ${leftover} row(s) — tell the host.`;
    setTimeout(() => { window.location.reload(); }, 2800);
}

async function showLogin() {
    loginView.classList.remove('hidden');
    appView.classList.add('hidden');
    try {
        const config = await api.config();
        document.getElementById('login-btn').classList.toggle('hidden', !config.loginAvailable);
        document.getElementById('login-unavailable').classList.toggle(
            'hidden', config.loginAvailable || config.devMode);
        const devForm = document.getElementById('dev-login');
        devForm.classList.toggle('hidden', !config.devMode);
        if (config.devMode && !devForm.dataset.wired) {
            devForm.dataset.wired = '1';
            devForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                try {
                    await api.devSession(
                        document.getElementById('dev-user-id').value.trim(),
                        document.getElementById('dev-user-name').value.trim() || 'dev user'
                    );
                    await boot();
                } catch (error) {
                    toast(error.message, true);
                }
            });
        }
    } catch {
        document.getElementById('login-unavailable').classList.remove('hidden');
    }
}

async function showApp() {
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');

    document.getElementById('user-name').textContent = me.user.name || me.user.id;
    const avatar = document.getElementById('user-avatar');
    if (me.user.avatar) {
        avatar.src = me.user.avatar;
        avatar.classList.remove('hidden');
    }

    document.getElementById('chat-input').maxLength = me.maxInputLength || 20000;
    document.getElementById('observatory-nav-btn').classList.toggle(
        'hidden', !me.features?.observatory);
    await initChat({ toast, confirm: confirmDialog, onPinApplet });
    const { room, id } = parseHash();
    await navigate(room, id ? { conversationId: id } : {});
}

async function onPinApplet({ source, language, title }) {
    try {
        await api.pinApplet({ source, language, title });
        toast('Pinned to the Workshop.');
    } catch (error) {
        toast(error.message, true);
    }
}

/* Mobile drawer */
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');

function setSidebar(open) {
    sidebar.classList.toggle('open', open);
    sidebarBackdrop.classList.toggle('hidden', !open);
}

for (const btn of document.querySelectorAll('.menu-btn')) {
    btn.addEventListener('click', () => setSidebar(!sidebar.classList.contains('open')));
}
sidebarBackdrop.addEventListener('click', () => setSidebar(false));
window.matchMedia('(min-width: 721px)').addEventListener('change', (event) => {
    if (event.matches) setSidebar(false);
});
sidebar.addEventListener('click', (event) => {
    if (event.target.closest('.conv-action, .conv-rename-input, .panel-add')) return;
    if (event.target.closest('.nav-btn, .brand-home, .conv-item, .persona-item, .new-chat')) {
        setSidebar(false);
    }
});

function applyTheme(theme) {
    document.body.classList.toggle('light', theme === 'light');
    document.getElementById('theme-btn').textContent = theme === 'light' ? '☀️ Theme' : '🌙 Theme';
    localStorage.setItem('goobster-theme', theme);
}

applyTheme(localStorage.getItem('goobster-theme') === 'light' ? 'light' : 'dark');
document.getElementById('theme-btn').addEventListener('click', () => {
    applyTheme(document.body.classList.contains('light') ? 'dark' : 'light');
});

async function boot() {
    try {
        me = await api.me();
        await showApp();
    } catch (error) {
        if (error.status === 401) await showLogin();
        else toast(error.message, true);
    }
}

document.querySelector('.nav').addEventListener('click', (event) => {
    const btn = event.target.closest('.nav-btn');
    if (btn) navigate(btn.dataset.view);
});
document.querySelector('.brand-home').addEventListener('click', () => navigate('home'));

window.addEventListener('hashchange', () => {
    const { room, id } = parseHash();
    if (room !== currentRoom || id) navigate(room, id ? { conversationId: id } : {});
});

document.getElementById('logout-btn').addEventListener('click', async () => {
    try { await api.logout(); } catch { /* already logged out */ }
    window.location.reload();
});

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {});
}

boot();
