/**
 * Chat pane: conversation sidebar, streaming turns, markdown bubbles
 * (with KaTeX math and live HTML mini-app previews), message actions
 * (copy / edit & resend / regenerate), image attachments, stop
 * generation, Thoughtful Mode, and export.
 */
import { api, streamChat } from './api.js';
import { renderMarkdown } from './markdown.js';
import { renderMathIn } from './math.js';

const log = document.getElementById('chat-log');
const scroller = document.getElementById('chat-scroll');
const input = document.getElementById('chat-input');
const sendBtn = document.getElementById('chat-send');
const emptyState = document.getElementById('empty-state');
const suggestionsEl = document.getElementById('suggestions');
const convList = document.getElementById('conv-list');
const convSearch = document.getElementById('conv-search');
const newChatBtn = document.getElementById('new-chat-btn');
const chatTitle = document.getElementById('chat-title');
const thoughtfulBtn = document.getElementById('thoughtful-btn');
const exportBtn = document.getElementById('export-btn');
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const imageTray = document.getElementById('image-tray');
const scrollDownBtn = document.getElementById('scroll-down-btn');

const SUGGESTIONS = [
    'What do you remember about me?',
    'Generate an image of a blueberry running a casino',
    'Build me a playable mini-app: a tiny breakout game',
    'Explain the math behind compound interest, with formulas',
    'What can you do? Give me the highlights.',
    'Help me plan a movie night for the server'
];

let conversations = [];
let activeConvId = null;   // null = fresh "New chat" not yet persisted
let history = [];          // canonical rows from the server (with DB ids)
let pendingImages = [];    // { dataUrl, name }
// Images sent this session, so re-renders from server history (which stores
// text only) keep showing them next to their message. Session-only.
const sessionImages = new Map(); // `${convId}\n${text}` -> images[]
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

function timeLabel(iso) {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function copyText(text, label = 'Copied.') {
    try {
        await navigator.clipboard.writeText(text);
        showToast(label);
    } catch {
        showToast('Copy failed - browser blocked clipboard access.', true);
    }
}

/* ---------- conversations sidebar ---------- */

function activeConversation() {
    return conversations.find(c => c.id === activeConvId) || null;
}

function setHeaderTitle() {
    chatTitle.textContent = activeConversation()?.title || 'New chat';
}

function renderConversations() {
    const filter = convSearch.value.trim().toLowerCase();
    convList.replaceChildren();
    for (const conversation of conversations) {
        const title = conversation.title || 'New chat';
        if (filter && !title.toLowerCase().includes(filter)) continue;

        const item = document.createElement('div');
        item.className = `conv-item${conversation.id === activeConvId ? ' active' : ''}`;

        const titleEl = document.createElement('span');
        titleEl.className = 'conv-title-text';
        titleEl.textContent = title;
        item.appendChild(titleEl);

        const actions = document.createElement('span');
        actions.className = 'conv-actions';
        const renameBtn = document.createElement('button');
        renameBtn.className = 'conv-action';
        renameBtn.title = 'Rename';
        renameBtn.textContent = '✎';
        renameBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            startRename(item, conversation);
        });
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'conv-action';
        deleteBtn.title = 'Delete';
        deleteBtn.textContent = '🗑';
        deleteBtn.addEventListener('click', async (event) => {
            event.stopPropagation();
            if (!await confirmDialog(`Delete "${title}"? Its messages are gone for good.`)) return;
            try {
                await api.deleteConversation(conversation.id);
                conversations = conversations.filter(c => c.id !== conversation.id);
                if (activeConvId === conversation.id) newChat();
                renderConversations();
                showToast('Conversation deleted.');
            } catch (error) {
                showToast(error.message, true);
            }
        });
        actions.append(renameBtn, deleteBtn);
        item.appendChild(actions);

        item.addEventListener('click', () => selectConversation(conversation.id));
        convList.appendChild(item);
    }
}

function startRename(item, conversation) {
    const inputEl = document.createElement('input');
    inputEl.className = 'conv-rename-input';
    inputEl.value = conversation.title || '';
    inputEl.maxLength = 80;
    item.replaceChildren(inputEl);
    inputEl.focus();
    inputEl.select();

    const finish = async (save) => {
        const title = inputEl.value.trim();
        if (save && title && title !== conversation.title) {
            try {
                await api.renameConversation(conversation.id, title);
                conversation.title = title;
                setHeaderTitle();
            } catch (error) {
                showToast(error.message, true);
            }
        }
        renderConversations();
    };
    inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') finish(false);
    });
    inputEl.addEventListener('blur', () => finish(true));
}

async function refreshConversations() {
    try {
        const { conversations: list } = await api.conversations();
        conversations = list;
        renderConversations();
        setHeaderTitle();
    } catch (error) {
        showToast(`Couldn't load conversations: ${error.message}`, true);
    }
}

function newChat() {
    if (sending) return;
    activeConvId = null;
    history = [];
    log.replaceChildren();
    setEmptyState(true);
    setHeaderTitle();
    renderConversations();
    input.focus();
}

async function selectConversation(id) {
    if (sending || id === activeConvId) return;
    activeConvId = id;
    renderConversations();
    setHeaderTitle();
    await loadHistory();
}

/* ---------- message rendering ---------- */

function setEmptyState(show) {
    emptyState.classList.toggle('hidden', !show);
}

function messageActions(role, message) {
    const bar = document.createElement('div');
    bar.className = 'msg-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action';
    copyBtn.textContent = '⧉ Copy';
    copyBtn.addEventListener('click', () => copyText(message.content));
    bar.appendChild(copyBtn);

    if (role === 'user' && message.id) {
        const editBtn = document.createElement('button');
        editBtn.className = 'msg-action';
        editBtn.textContent = '✎ Edit';
        editBtn.addEventListener('click', () => startEdit(message));
        bar.appendChild(editBtn);
    }
    if (role === 'assistant' && message.isLastAssistant) {
        const regenBtn = document.createElement('button');
        regenBtn.className = 'msg-action';
        regenBtn.textContent = '↻ Regenerate';
        regenBtn.addEventListener('click', regenerate);
        bar.appendChild(regenBtn);
    }
    return bar;
}

/**
 * Languages whose fenced blocks become live mini-apps: a complete
 * self-contained document runs in a sandboxed iframe (opaque origin, no
 * cookies, no parent DOM - `sandbox` without allow-same-origin), with
 * Preview/Code tabs, restart, fullscreen, and download.
 */
const APPLET_LANGS = new Set(['html', 'svg']);

function appletButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
}

/** Turn an html/svg <pre> into a runnable mini-app card. */
function buildApplet(pre) {
    const source = pre.textContent;
    const wrap = document.createElement('div');
    wrap.className = 'applet';

    const head = document.createElement('div');
    head.className = 'code-head applet-head';

    const tabs = document.createElement('div');
    tabs.className = 'applet-tabs';
    const previewTab = document.createElement('button');
    previewTab.className = 'applet-tab active';
    previewTab.textContent = '✨ Preview';
    const codeTab = document.createElement('button');
    codeTab.className = 'applet-tab';
    codeTab.textContent = 'Code';
    tabs.append(previewTab, codeTab);

    const body = document.createElement('div');
    body.className = 'applet-body';
    const frame = document.createElement('iframe');
    frame.className = 'applet-frame';
    // No allow-same-origin: the app runs on an opaque origin and can never
    // reach the session cookie, the API, or this page's DOM.
    frame.setAttribute('sandbox', 'allow-scripts allow-modals allow-popups');
    frame.title = 'Goobster mini-app';
    frame.srcdoc = source;
    // Take pre's spot in the bubble first, THEN move pre inside the card -
    // the other way round replaceWith would nest the card into its own body.
    pre.replaceWith(wrap);
    body.append(frame, pre);
    pre.classList.add('hidden');

    const setTab = (preview) => {
        previewTab.classList.toggle('active', preview);
        codeTab.classList.toggle('active', !preview);
        frame.classList.toggle('hidden', !preview);
        pre.classList.toggle('hidden', preview);
    };
    previewTab.addEventListener('click', () => setTab(true));
    codeTab.addEventListener('click', () => setTab(false));

    const actions = document.createElement('div');
    actions.className = 'applet-actions';
    actions.append(
        appletButton('↻', 'Restart the app', () => { frame.srcdoc = source; }),
        appletButton('⧉', 'Copy source', () => copyText(source, 'Source copied.')),
        appletButton('⬇', 'Download as .html', () => {
            const blob = new Blob([source], { type: 'text/html' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'goobster-app.html';
            link.click();
            URL.revokeObjectURL(link.href);
        })
    );
    const expandBtn = appletButton('⛶', 'Fullscreen', () => {
        const full = wrap.classList.toggle('full');
        expandBtn.textContent = full ? '✕' : '⛶';
        expandBtn.title = full ? 'Exit fullscreen' : 'Fullscreen';
        document.body.classList.toggle('applet-open', full);
    });
    actions.appendChild(expandBtn);

    head.append(tabs, actions);
    wrap.append(head, body);
}

/** Wrap each <pre> in a header bar with its language and a copy button. */
function decorateCodeBlocks(bubble) {
    for (const pre of [...bubble.querySelectorAll('pre')]) {
        if (pre.parentElement?.classList.contains('codewrap') || pre.closest('.applet')) continue;
        if (APPLET_LANGS.has((pre.dataset.lang || '').toLowerCase())) {
            buildApplet(pre);
            continue;
        }
        const wrap = document.createElement('div');
        wrap.className = 'codewrap';
        const head = document.createElement('div');
        head.className = 'code-head';
        const lang = document.createElement('span');
        lang.textContent = pre.dataset.lang || 'code';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'code-copy';
        copyBtn.textContent = '⧉ copy';
        copyBtn.addEventListener('click', () => copyText(pre.textContent, 'Code copied.'));
        head.append(lang, copyBtn);
        pre.replaceWith(wrap);
        wrap.append(head, pre);
    }
}

/**
 * Append a message bubble.
 * @returns {{ bubble: HTMLElement, el: HTMLElement }}
 */
function addMessage(role, message = {}) {
    const { content = '', meta = '', isError = false, images = [], attachments = [] } = message;
    setEmptyState(false);
    const el = document.createElement('div');
    el.className = `msg ${role}${isError ? ' error' : ''}`;
    if (message.id) el.dataset.msgId = String(message.id);

    if (images.length > 0) {
        const tray = document.createElement('div');
        tray.className = 'msg-images';
        for (const image of images) {
            const img = document.createElement('img');
            img.src = image.dataUrl || image;
            img.alt = 'attached image';
            tray.appendChild(img);
        }
        el.appendChild(tray);
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    if (role === 'assistant') {
        bubble.innerHTML = renderMarkdown(content);
        decorateCodeBlocks(bubble);
        renderMathIn(bubble);
    } else {
        bubble.textContent = content;
    }
    addAttachments(bubble, attachments);
    el.appendChild(bubble);

    if (meta) {
        const metaEl = document.createElement('div');
        metaEl.className = 'msg-meta';
        metaEl.textContent = meta;
        el.appendChild(metaEl);
    }
    if (content) el.appendChild(messageActions(role, message));

    log.appendChild(el);
    scrollToBottom();
    return { bubble, el };
}

function addAttachments(bubble, attachments = []) {
    for (const file of attachments) {
        if (!file?.url) continue;
        const img = document.createElement('img');
        img.className = 'attachment';
        img.src = file.url;
        img.alt = file.name || 'attachment';
        img.loading = 'lazy';
        bubble.appendChild(img);
    }
}

function typingIndicator() {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = '<div class="msg-bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
    log.appendChild(el);
    scrollToBottom(true);
    return el;
}

async function loadHistory({ silent = false } = {}) {
    try {
        if (activeConvId === null) {
            history = [];
            log.replaceChildren();
            setEmptyState(true);
            return;
        }
        const { messages } = await api.chatHistory(activeConvId);
        history = messages;
        log.replaceChildren();
        setEmptyState(messages.length === 0);

        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
        for (const message of messages) {
            addMessage(message.role === 'assistant' ? 'assistant' : 'user', {
                ...message,
                meta: timeLabel(message.createdAt),
                isLastAssistant: message === lastAssistant,
                images: message.role === 'user'
                    ? (sessionImages.get(`${activeConvId}\n${message.content}`) || [])
                    : []
            });
        }
        scrollToBottom(true);
    } catch (error) {
        if (!silent) showToast(`Couldn't load chat history: ${error.message}`, true);
    }
}

/* ---------- edit / regenerate ---------- */

function startEdit(message) {
    if (sending) return;
    const items = [...log.querySelectorAll('.msg')];
    const el = items.find(item => item.dataset.msgId === String(message.id));
    const target = el || null;
    const editor = document.createElement('div');
    editor.className = 'msg msg-edit user';
    editor.innerHTML = `
      <textarea></textarea>
      <div class="btn-row">
        <button class="btn cancel">Cancel</button>
        <button class="btn primary save">Save &amp; resend</button>
      </div>`;
    const textarea = editor.querySelector('textarea');
    textarea.value = message.content;
    editor.querySelector('.cancel').addEventListener('click', () => loadHistory({ silent: true }));
    editor.querySelector('.save').addEventListener('click', async () => {
        const text = textarea.value.trim();
        if (!text) return;
        try {
            await api.truncate(activeConvId, message.id);
            await loadHistory({ silent: true });
            await sendMessage(text);
        } catch (error) {
            showToast(error.message, true);
            loadHistory({ silent: true });
        }
    });
    if (target) target.replaceWith(editor);
    else log.appendChild(editor);
    textarea.focus();
}

async function regenerate() {
    if (sending) return;
    const lastUser = [...history].reverse().find(m => m.role === 'user');
    if (!lastUser) return;
    try {
        await api.truncate(activeConvId, lastUser.id);
        await loadHistory({ silent: true });
        await sendMessage(lastUser.content);
    } catch (error) {
        showToast(error.message, true);
    }
}

/* ---------- image attachments ---------- */

const MAX_ATTACH = 4;
const MAX_DIMENSION = 1568;

function renderImageTray() {
    imageTray.classList.toggle('hidden', pendingImages.length === 0);
    imageTray.replaceChildren(...pendingImages.map((image, index) => {
        const thumb = document.createElement('div');
        thumb.className = 'image-thumb';
        const img = document.createElement('img');
        img.src = image.dataUrl;
        img.alt = image.name;
        const remove = document.createElement('button');
        remove.textContent = '✕';
        remove.title = 'Remove';
        remove.addEventListener('click', () => {
            pendingImages.splice(index, 1);
            renderImageTray();
        });
        thumb.append(img, remove);
        return thumb;
    }));
}

/** Downscale large images client-side so payloads stay reasonable. */
function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
            if (scale === 1 && file.size < 400 * 1024) {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
                return;
            }
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Not a readable image.')); };
        img.src = url;
    });
}

async function addImageFiles(files) {
    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        if (pendingImages.length >= MAX_ATTACH) {
            showToast(`At most ${MAX_ATTACH} images per message.`, true);
            break;
        }
        try {
            const dataUrl = await fileToDataUrl(file);
            pendingImages.push({ dataUrl, name: file.name || 'image' });
        } catch (error) {
            showToast(error.message, true);
        }
    }
    renderImageTray();
}

/* ---------- export ---------- */

function exportChat() {
    if (history.length === 0) {
        showToast('Nothing to export yet.', true);
        return;
    }
    const title = activeConversation()?.title || 'Goobster chat';
    const lines = [`# ${title}`, ''];
    for (const message of history) {
        lines.push(`**${message.role === 'assistant' ? 'Goobster' : 'You'}** · ${message.createdAt} UTC`, '');
        lines.push(message.content, '');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${title.replace(/[^\w-]+/g, '_').slice(0, 40) || 'chat'}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
}

/* ---------- thoughtful mode ---------- */

async function loadAiSettings() {
    try {
        const settings = await api.chatSettings();
        thoughtfulBtn.classList.toggle('on', settings.thoughtful);
        thoughtfulBtn.setAttribute('aria-checked', String(settings.thoughtful));
        document.getElementById('thoughtful-wrap').classList.toggle('hidden', !settings.thoughtfulAvailable);
    } catch {
        document.getElementById('thoughtful-wrap').classList.add('hidden');
    }
}

async function toggleThoughtful() {
    const next = !thoughtfulBtn.classList.contains('on');
    thoughtfulBtn.disabled = true;
    try {
        const settings = await api.setThoughtful(next);
        thoughtfulBtn.classList.toggle('on', settings.thoughtful);
        thoughtfulBtn.setAttribute('aria-checked', String(settings.thoughtful));
        showToast(settings.thoughtful
            ? `Thoughtful Mode on - ${settings.model}, deeper reasoning.`
            : 'Thoughtful Mode off - back to the everyday model.');
    } catch (error) {
        showToast(error.message, true);
    } finally {
        thoughtfulBtn.disabled = false;
    }
}

/* ---------- sending ---------- */

function setSending(active) {
    sending = active;
    sendBtn.classList.toggle('stop', active);
    sendBtn.textContent = active ? '◼' : '➤';
    sendBtn.title = active ? 'Stop generating' : 'Send';
    input.disabled = false;
}

async function stopGenerating() {
    try { await api.stop(); } catch { /* turn may have just finished */ }
    abortController?.abort();
}

async function sendMessage(forcedText = null) {
    if (sending) { stopGenerating(); return; }
    const text = (forcedText ?? input.value).trim();
    if (!text) return;

    // A fresh "New chat" is persisted on first send, so it never lands in
    // an older conversation.
    if (activeConvId === null) {
        try {
            const created = await api.createConversation();
            conversations.unshift(created);
            activeConvId = created.id;
            renderConversations();
        } catch (error) {
            showToast(error.message, true);
            return;
        }
    }

    const images = pendingImages;
    pendingImages = [];
    renderImageTray();
    if (images.length > 0) sessionImages.set(`${activeConvId}\n${text}`, images);
    if (forcedText === null) {
        input.value = '';
        autosize();
    }

    setSending(true);
    abortController = new AbortController();

    addMessage('user', { content: text, images });
    let pending = typingIndicator();
    let draft = null;
    let draftText = '';
    let gotFinal = false;
    let stopped = false;

    const clearPending = () => {
        pending?.remove();
        pending = null;
    };
    const ensureDraft = () => {
        if (!draft) {
            clearPending();
            draft = addMessage('assistant', { content: '' });
        }
        return draft;
    };

    try {
        await streamChat(
            {
                message: text,
                conversationId: activeConvId,
                images: images.map(image => image.dataUrl)
            },
            {
                onTyping: () => {
                    if (!draft && !pending) pending = typingIndicator();
                },
                onDelta: (delta) => {
                    const target = ensureDraft();
                    draftText += delta;
                    target.bubble.innerHTML = renderMarkdown(draftText) + '<span class="cursor-caret">&nbsp;</span>';
                    renderMathIn(target.bubble);
                    scrollToBottom();
                },
                onMessage: ({ content, attachments, isError }) => {
                    clearPending();
                    gotFinal = true;
                    if (draft) {
                        draft.bubble.innerHTML = renderMarkdown(content || draftText);
                        decorateCodeBlocks(draft.bubble);
                        renderMathIn(draft.bubble);
                        if (isError) draft.el.classList.add('error');
                        addAttachments(draft.bubble, attachments);
                        draft = null;
                        draftText = '';
                    } else {
                        addMessage('assistant', { content: content || '', isError, attachments });
                    }
                    scrollToBottom();
                },
                onError: ({ message }) => {
                    clearPending();
                    gotFinal = true;
                    addMessage('assistant', { content: message || 'Something went wrong.', isError: true });
                }
            },
            abortController.signal
        );

        if (!gotFinal && draft && draftText) {
            draft.bubble.innerHTML = renderMarkdown(draftText);
            decorateCodeBlocks(draft.bubble);
            renderMathIn(draft.bubble);
        } else if (!gotFinal && !draft) {
            clearPending();
            addMessage('assistant', { content: 'No reply arrived - try again.', isError: true });
        }
    } catch (error) {
        clearPending();
        if (error.name === 'AbortError') {
            stopped = true;
            if (draft) {
                draft.bubble.innerHTML = renderMarkdown(draftText);
                decorateCodeBlocks(draft.bubble);
                renderMathIn(draft.bubble);
                const meta = document.createElement('div');
                meta.className = 'msg-meta';
                meta.textContent = 'stopped';
                draft.el.appendChild(meta);
            }
        } else {
            draft?.el?.remove();
            addMessage('assistant', { content: error.message || 'Something went wrong.', isError: true });
            if (error.status === 429 || error.status === 409) showToast(error.message, true);
        }
    } finally {
        clearPending();
        setSending(false);
        abortController = null;
        input.focus();
        // Re-sync with the server: canonical DB ids for edit/regenerate,
        // titles and ordering for the sidebar. On stop, give the server a
        // beat to finish the aborted round first.
        const resync = async () => {
            await loadHistory({ silent: true });
            await refreshConversations();
        };
        if (stopped) setTimeout(resync, 1200);
        else resync();
        // The AI-written title may land a moment later
        setTimeout(refreshConversations, 4000);
    }
}

/* ---------- wiring ---------- */

function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
}

export async function initChat({ toast, confirm }) {
    showToast = toast;
    confirmDialog = confirm;

    suggestionsEl.replaceChildren(...SUGGESTIONS.map(text => {
        const btn = document.createElement('button');
        btn.className = 'suggestion';
        btn.textContent = text;
        btn.addEventListener('click', () => {
            input.value = text;
            autosize();
            input.focus();
        });
        return btn;
    }));

    await refreshConversations();
    activeConvId = conversations[0]?.id ?? null;
    renderConversations();
    setHeaderTitle();
    await loadHistory();
    loadAiSettings();

    if (wired) return;
    wired = true;

    sendBtn.addEventListener('click', () => sendMessage());
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });
    input.addEventListener('input', autosize);
    input.addEventListener('paste', (event) => {
        const files = [...(event.clipboardData?.items || [])]
            .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
            .map(item => item.getAsFile())
            .filter(Boolean);
        if (files.length > 0) {
            event.preventDefault();
            addImageFiles(files);
        }
    });

    newChatBtn.addEventListener('click', newChat);
    convSearch.addEventListener('input', renderConversations);
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        addImageFiles([...fileInput.files]);
        fileInput.value = '';
    });
    exportBtn.addEventListener('click', exportChat);
    thoughtfulBtn.addEventListener('click', toggleThoughtful);

    scroller.addEventListener('scroll', () => {
        scrollDownBtn.classList.toggle('hidden', nearBottom());
    });
    scrollDownBtn.addEventListener('click', () => scrollToBottom(true));

    input.focus();
}
