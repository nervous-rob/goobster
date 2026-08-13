/**
 * App bootstrap: session check, login flow, view routing, and PWA service
 * worker registration.
 */
import { api } from './api.js';
import { initChat } from './chat.js';
import { initMemory } from './memory.js';
import { initParlor } from './parlor.js';
import { initTasks } from './tasks.js';
import { initUsage } from './usage.js';
import { openModal, closeModal } from './modal.js';

const loginView = document.getElementById('view-login');
const appView = document.getElementById('view-app');
const toastEl = document.getElementById('toast');

let me = null;
let toastTimer = null;

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
        // Escape / backdrop click resolve as "cancel"
        openModal(backdrop, { initialFocus: cancelBtn, onClose: () => close(false) });
    });
}

const PANES = ['chat', 'parlor', 'memory', 'tasks', 'usage'];

function setView(name) {
    for (const btn of document.querySelectorAll('.nav-btn')) {
        btn.classList.toggle('active', btn.dataset.view === name);
    }
    for (const pane of PANES) {
        document.getElementById(`pane-${pane}`).classList.toggle('hidden', pane !== name);
    }
    document.getElementById('conversations-panel').classList.toggle('hidden', name !== 'chat');
    document.getElementById('parlor-panel').classList.toggle('hidden', name !== 'parlor');
    if (name === 'memory') initMemory({ me, toast, confirm: confirmDialog });
    if (name === 'parlor') initParlor({ me, toast, confirm: confirmDialog });
    if (name === 'tasks') initTasks({ me, toast, confirm: confirmDialog });
    if (name === 'usage') initUsage({ me, toast });
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
    await initChat({ toast, confirm: confirmDialog });
    setView('chat');
}

/* Mobile drawer: the sidebar slides in behind the ☰ buttons on small
 * screens (pure CSS on desktop - .open is inert there). */
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
// Growing past the mobile breakpoint (resize, rotate) retires the drawer
// so its backdrop can't linger over the desktop layout.
window.matchMedia('(min-width: 721px)').addEventListener('change', (event) => {
    if (event.matches) setSidebar(false);
});
// Picking a destination in the drawer closes it; row-level edit controls
// (rename, delete, add-persona) keep it open.
sidebar.addEventListener('click', (event) => {
    if (event.target.closest('.conv-action, .conv-rename-input, .panel-add')) return;
    if (event.target.closest('.nav-btn, .conv-item, .persona-item, .new-chat')) setSidebar(false);
});

/* Theme: dark by default, persisted per browser. */
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
    if (btn) setView(btn.dataset.view);
});

document.getElementById('logout-btn').addEventListener('click', async () => {
    try { await api.logout(); } catch { /* already logged out */ }
    window.location.reload();
});

/* PWA: register the service worker (network-first, so updates always win
 * when online; the cached shell covers offline launches). */
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {
        /* not fatal - the app runs fine without it */
    });
}

boot();
