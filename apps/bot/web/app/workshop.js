/**
 * Workshop: first-class canvas for mini-apps Goobster built in chat.
 * Pins are stored copies; discoveries are scanned from assistant fences.
 */
import { api } from './api.js';
import { renderApplet } from './codeblocks.js';
import { bindTilt } from './atmosphere.js';

const content = document.getElementById('workshop-content');
const preview = document.getElementById('workshop-preview');
const stage = document.getElementById('workshop-preview-stage');
const previewTitle = document.getElementById('workshop-preview-title');
const pinBtn = document.getElementById('workshop-preview-pin');
const studyBtn = document.getElementById('workshop-preview-study');
const backBtn = document.getElementById('workshop-preview-back');
const refreshBtn = document.getElementById('workshop-refresh-btn');

let showToast = () => {};
let confirmDialog = async () => false;
let goTo = () => {};
let wired = false;
let catalog = { pinned: [], discovered: [] };
let current = null;

function escapeText(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function el(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
}

function showPreview(applet) {
    current = applet;
    previewTitle.textContent = applet.title || 'Mini-app';
    pinBtn.textContent = applet.pinned ? '📌 Unpin' : '📌 Pin';
    pinBtn.classList.toggle('danger', Boolean(applet.pinned));
    pinBtn.classList.toggle('primary', !applet.pinned);
    studyBtn.classList.toggle('hidden', !applet.conversationId);
    preview.classList.remove('hidden');
    content.classList.add('hidden');
    stage.replaceChildren();
    renderApplet(stage, {
        source: applet.source,
        language: applet.language,
        notify: showToast
    });
    if (applet.pinned && applet.id) {
        api.touchApplet(applet.id).catch(() => {});
    }
}

function hidePreview() {
    current = null;
    preview.classList.add('hidden');
    content.classList.remove('hidden');
    stage.replaceChildren();
    document.body.classList.remove('applet-open');
}

function tile(applet) {
    const card = el(`<button type="button" class="workshop-tile">
      <div class="workshop-tile-mark">${applet.language === 'svg' ? '✎' : '✨'}</div>
      <div class="workshop-tile-title">${escapeText(applet.title)}</div>
      <div class="workshop-tile-meta">${
          applet.pinned ? 'Pinned' : 'From chat'
      }${applet.conversationTitle ? ` · ${escapeText(applet.conversationTitle)}` : ''}</div>
    </button>`);
    card.addEventListener('click', () => showPreview(applet));
    bindTilt(card);
    return card;
}

function section(title, items, empty) {
    const wrap = el(`<section class="workshop-section">
      <h2>${escapeText(title)}</h2>
      <div class="workshop-grid"></div>
    </section>`);
    const grid = wrap.querySelector('.workshop-grid');
    if (items.length === 0) {
        grid.replaceWith(el(`<div class="hint">${escapeText(empty)}</div>`));
    } else {
        for (const applet of items) grid.appendChild(tile(applet));
    }
    return wrap;
}

async function refresh() {
    content.innerHTML = '<div class="empty">Looking through the bench&hellip;</div>';
    try {
        catalog = await api.applets();
    } catch (error) {
        content.innerHTML = `<div class="empty">${escapeText(error.message)}</div>`;
        return;
    }
    const root = el('<div class="workshop-shell"></div>');
    root.appendChild(el(`<p class="hint workshop-lead">
      Mini-apps Goobster built in the Study. Pin one and it stays on the bench —
      reopen it anytime, even if the chat is gone.
    </p>`));
    root.appendChild(section('Pinned', catalog.pinned || [],
        'Nothing pinned yet. Open a discovered app and pin it, or ask in the Study: “build me a …”'));
    root.appendChild(section('Found in chat', catalog.discovered || [],
        'No unpinned mini-apps in recent chats.'));
    content.replaceChildren(root);
}

async function togglePin() {
    if (!current) return;
    try {
        if (current.pinned && current.id) {
            if (!await confirmDialog('Unpin this mini-app from the Workshop?')) return;
            await api.unpinApplet(current.id);
            showToast('Unpinned.');
            hidePreview();
            await refresh();
            return;
        }
        const pinned = await api.pinApplet({
            title: current.title,
            language: current.language,
            source: current.source,
            conversationId: current.conversationId,
            messageId: current.messageId
        });
        showToast('Pinned to the Workshop.');
        current = pinned;
        pinBtn.textContent = '📌 Unpin';
        pinBtn.classList.add('danger');
        pinBtn.classList.remove('primary');
        await refresh();
    } catch (error) {
        showToast(error.message, true);
    }
}

export async function initWorkshop({ toast, confirm, navigate }) {
    showToast = toast;
    confirmDialog = confirm;
    goTo = navigate;
    if (!wired) {
        wired = true;
        backBtn.addEventListener('click', hidePreview);
        pinBtn.addEventListener('click', togglePin);
        studyBtn.addEventListener('click', () => {
            if (current?.conversationId) goTo('chat', { conversationId: current.conversationId });
        });
        refreshBtn.addEventListener('click', () => refresh());
    }
    hidePreview();
    await refresh();
}

export function openWorkshopApplet(applet) {
    if (applet) showPreview(applet);
}
