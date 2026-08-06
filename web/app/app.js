/**
 * App bootstrap: session check, login flow, and view routing.
 */
import { api } from './api.js';
import { initChat } from './chat.js';
import { initMemory } from './memory.js';

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
    document.getElementById('pane-memory').classList.toggle('hidden', name !== 'memory');
    if (name === 'memory') initMemory({ me, toast, confirm: confirmDialog });
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
    await initChat({ toast });
    setView('chat');
}

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
