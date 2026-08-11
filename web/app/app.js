/**
 * App bootstrap: session check, login flow, and view routing.
 */
import { api } from './api.js';
import { initChat } from './chat.js';
import { initMemory } from './memory.js';
import { initParlor } from './parlor.js';

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
    backdrop.classList.remove('hidden');
    return new Promise((resolve) => {
        const close = (result) => {
            backdrop.classList.add('hidden');
            confirmBtn.removeEventListener('click', yes);
            cancelBtn.removeEventListener('click', no);
            resolve(result);
        };
        const yes = () => close(true);
        const no = () => close(false);
        confirmBtn.addEventListener('click', yes);
        cancelBtn.addEventListener('click', no);
    });
}

function setView(name) {
    for (const btn of document.querySelectorAll('.nav-btn')) {
        btn.classList.toggle('active', btn.dataset.view === name);
    }
    document.getElementById('pane-chat').classList.toggle('hidden', name !== 'chat');
    document.getElementById('pane-parlor').classList.toggle('hidden', name !== 'parlor');
    document.getElementById('pane-memory').classList.toggle('hidden', name !== 'memory');
    document.getElementById('conversations-panel').classList.toggle('hidden', name !== 'chat');
    document.getElementById('parlor-panel').classList.toggle('hidden', name !== 'parlor');
    if (name === 'memory') initMemory({ me, toast, confirm: confirmDialog });
    if (name === 'parlor') initParlor({ toast, confirm: confirmDialog });
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

boot();
