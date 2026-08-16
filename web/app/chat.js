/**
 * Chat pane: conversation sidebar, streaming turns, markdown bubbles
 * (with KaTeX math and live HTML mini-app previews), message actions
 * (copy / edit & resend / edit & branch / regenerate / read aloud),
 * image + text-file attachments, voice dictation, stop generation,
 * model/provider/reasoning settings, Thoughtful Mode, incognito mode,
 * read-only share links, platform integrations, and export.
 */
import { api, streamChat, fetchSpeech } from './api.js';
import { renderMarkdown } from './markdown.js';
import { renderMathIn } from './math.js';
import { decorateCodeBlocks as decorateShared, renderAttachments } from './codeblocks.js';
import { openModal, closeModal } from './modal.js';

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
const modelChip = document.getElementById('model-chip');
const modelChipLabel = document.getElementById('model-chip-label');
const incognitoBtn = document.getElementById('incognito-btn');
const integrationsBtn = document.getElementById('integrations-btn');
const incognitoBanner = document.getElementById('incognito-banner');
const composerHint = document.getElementById('composer-hint');
const chatPane = document.getElementById('pane-chat');
const micBtn = document.getElementById('mic-btn');
const shareBtn = document.getElementById('share-btn');
const moreBtn = document.getElementById('chat-more-btn');
const moreMenu = document.getElementById('chat-more-menu');

const DEFAULT_HINT = 'Goobster shares memory with your Discord DMs. He can make mistakes.';
const INCOGNITO_HINT = 'Incognito: nothing here is saved to history or memory. Close or switch chats and it\u2019s gone.';

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
let pendingFiles = [];     // { name, content } text attachments
let incognito = false;     // transient chat: no history, no memory
let aiSettings = null;     // last-loaded /chat/settings payload
// Images sent this session, so re-renders from server history (which stores
// text only) keep showing them next to their message. Session-only.
const sessionImages = new Map(); // `${convId}\n${text}` -> images[]
let sending = false;
let abortController = null;
// A reply generating server-side that THIS page session didn't start (found
// after a reload, or via a 409 from another conversation - the lock is per
// user). The send button becomes Stop for it, and a light poll notices when
// it finishes so the composer unlocks on its own.
let remoteTurn = false;
let remoteTurnTimer = null;
let showToast = () => {};
let confirmDialog = async () => false;
let wired = false;
let voiceCaps = { stt: false, tts: false }; // loaded from /voice/capabilities

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

/**
 * Split the attachment blocks the server folds into stored user messages
 * (webChatService._composeWithFiles) back out, so history reloads render
 * them as chips and re-sends (edit / regenerate) go back as files.
 */
const ATTACH_BLOCK_RE = /\n*\[Attached file: ([^\]\n]{1,120})\]\n````\n([\s\S]*?)\n````/g;

function splitAttachments(content) {
    const files = [];
    const text = String(content || '')
        .replace(ATTACH_BLOCK_RE, (match, name, body) => {
            files.push({ name, content: body });
            return '';
        })
        .trim();
    return { text, files };
}

/* ---------- conversations sidebar ---------- */

function activeConversation() {
    return conversations.find(c => c.id === activeConvId) || null;
}

function setHeaderTitle() {
    chatTitle.textContent = incognito
        ? 'Incognito chat'
        : (activeConversation()?.title || 'New chat');
}

/* ---------- incognito mode ---------- */

function applyIncognitoUi() {
    incognitoBtn.classList.toggle('on', incognito);
    incognitoBtn.setAttribute('aria-pressed', String(incognito));
    chatPane.classList.toggle('incognito', incognito);
    incognitoBanner.classList.toggle('hidden', !incognito);
    composerHint.textContent = incognito ? INCOGNITO_HINT : DEFAULT_HINT;
}

/** Leave incognito (dropping the server-side transient window). */
function exitIncognito() {
    if (!incognito) return;
    incognito = false;
    applyIncognitoUi();
    api.clearIncognito().catch(() => { /* nothing to clear */ });
}

function enterIncognito() {
    incognito = true;
    activeConvId = null;
    history = [];
    log.replaceChildren();
    setEmptyState(true);
    applyIncognitoUi();
    setHeaderTitle();
    renderConversations();
    input.focus();
}

function toggleIncognito() {
    if (sending) return;
    if (incognito) {
        exitIncognito();
        newChat();
        showToast('Incognito off - back to saved chats.');
    } else {
        enterIncognito();
        showToast('Incognito on - this chat won\u2019t be saved.');
    }
}

/* Server-side message search (the sidebar box searches titles instantly and
 * message content after a debounce). */
let messageHits = [];
let searchDebounce = null;

async function runMessageSearch() {
    const query = convSearch.value.trim();
    if (query.length < 2) return;
    try {
        const { results } = await api.searchMessages(query);
        if (convSearch.value.trim() !== query) return; // stale response
        messageHits = results;
        renderConversations();
    } catch { /* search is best-effort */ }
}

function onSearchInput() {
    if (convSearch.value.trim().length < 2) messageHits = [];
    renderConversations();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(runMessageSearch, 250);
}

async function openMessageHit(hit) {
    if (sending) return;
    exitIncognito();
    if (activeConvId !== hit.conversationId) {
        activeConvId = hit.conversationId;
        renderConversations();
        setHeaderTitle();
        await loadHistory();
    }
    const el = log.querySelector(`[data-msg-id="${hit.messageId}"]`);
    if (el) {
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
        el.classList.add('search-hit');
        setTimeout(() => el.classList.remove('search-hit'), 2400);
    }
}

function renderConversations() {
    const filter = convSearch.value.trim().toLowerCase();
    convList.replaceChildren();
    for (const conversation of conversations) {
        const title = conversation.title || 'New chat';
        if (filter && !title.toLowerCase().includes(filter)) continue;

        const item = document.createElement('div');
        item.className = `conv-item${conversation.id === activeConvId ? ' active' : ''}`;
        item.setAttribute('role', 'button');
        item.tabIndex = 0;

        if (conversation.parentConversationId) {
            const badge = document.createElement('span');
            badge.className = 'conv-badge';
            badge.title = 'Branched from another conversation';
            badge.textContent = '⑂';
            item.appendChild(badge);
        }
        const titleEl = document.createElement('span');
        titleEl.className = 'conv-title-text';
        titleEl.textContent = title;
        item.appendChild(titleEl);
        if (conversation.shared) {
            const sharedBadge = document.createElement('span');
            sharedBadge.className = 'conv-badge shared';
            sharedBadge.title = 'Has an active share link';
            sharedBadge.textContent = '🔗';
            item.appendChild(sharedBadge);
        }

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
        item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectConversation(conversation.id);
            }
        });
        convList.appendChild(item);
    }

    // Full-text hits inside message content, below the title matches
    if (filter && messageHits.length > 0) {
        const header = document.createElement('div');
        header.className = 'search-group-label';
        header.textContent = 'In messages';
        convList.appendChild(header);
        for (const hit of messageHits) {
            const item = document.createElement('div');
            item.className = 'conv-item search-hit-item';
            const titleEl = document.createElement('span');
            titleEl.className = 'conv-title-text';
            titleEl.textContent = hit.title || 'New chat';
            const snippetEl = document.createElement('span');
            snippetEl.className = 'search-snippet';
            snippetEl.textContent = `${hit.role === 'assistant' ? 'Goobster: ' : 'You: '}${hit.snippet}`;
            item.append(titleEl, snippetEl);
            item.addEventListener('click', () => openMessageHit(hit));
            convList.appendChild(item);
        }
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
    // A remote turn (generating server-side, not streaming here) must not
    // pin the user to one conversation - only a live local stream does.
    if (sending && !remoteTurn) return;
    exitIncognito();
    activeConvId = null;
    history = [];
    log.replaceChildren();
    setEmptyState(true);
    setHeaderTitle();
    renderConversations();
    input.focus();
}

async function selectConversation(id) {
    if ((sending && !remoteTurn) || (id === activeConvId && !incognito)) return;
    exitIncognito();
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
    if (role === 'assistant' && voiceCaps.tts && message.content) {
        const listenBtn = document.createElement('button');
        listenBtn.className = 'msg-action listen';
        listenBtn.textContent = '🔊 Listen';
        listenBtn.addEventListener('click', () => toggleReadAloud(listenBtn, message.content));
        bar.appendChild(listenBtn);
    }
    return bar;
}

/* ---------- read-aloud (TTS) ---------- */

let activeSpeech = null; // { audio, button, url }

function stopReadAloud() {
    if (!activeSpeech) return;
    activeSpeech.audio.pause();
    URL.revokeObjectURL(activeSpeech.url);
    activeSpeech.button.textContent = '🔊 Listen';
    activeSpeech.button.classList.remove('playing');
    activeSpeech = null;
}

async function toggleReadAloud(button, text) {
    if (activeSpeech?.button === button) {
        stopReadAloud();
        return;
    }
    stopReadAloud();
    button.textContent = '… Loading';
    button.disabled = true;
    try {
        const blob = await fetchSpeech(text);
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        activeSpeech = { audio, button, url };
        audio.addEventListener('ended', stopReadAloud);
        audio.addEventListener('error', stopReadAloud);
        await audio.play();
        button.textContent = '◼ Stop';
        button.classList.add('playing');
    } catch (error) {
        stopReadAloud();
        button.textContent = '🔊 Listen';
        showToast(error.message || 'Read-aloud failed.', true);
    } finally {
        button.disabled = false;
    }
}

/* ---------- voice dictation (STT) ---------- */

let recorder = null;       // active MediaRecorder
let recorderTimeout = null;
const MAX_RECORDING_MS = 120 * 1000;

function setMicState(recording) {
    micBtn.classList.toggle('recording', recording);
    micBtn.setAttribute('aria-pressed', String(recording));
    micBtn.textContent = recording ? '◼' : '🎤';
    micBtn.title = recording ? 'Stop recording' : 'Dictate a message (speech-to-text)';
}

function pickRecorderMime() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    return candidates.find(type => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}

async function toggleDictation() {
    if (recorder) {
        recorder.stop();
        return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        showToast('This browser does not support microphone recording.', true);
        return;
    }
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
        showToast('Microphone access was denied.', true);
        return;
    }
    const mimeType = pickRecorderMime();
    const chunks = [];
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.addEventListener('dataavailable', (event) => {
        if (event.data?.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener('stop', async () => {
        clearTimeout(recorderTimeout);
        stream.getTracks().forEach(track => track.stop());
        const type = recorder.mimeType || mimeType || 'audio/webm';
        recorder = null;
        setMicState(false);
        const blob = new Blob(chunks, { type });
        if (blob.size < 1000) return; // an accidental tap, nothing said
        micBtn.disabled = true;
        micBtn.textContent = '…';
        try {
            const base64 = await blobToBase64(blob);
            const { text } = await api.transcribe(base64, type);
            if (text) {
                input.value = input.value ? `${input.value.replace(/\s+$/, '')} ${text}` : text;
                autosize();
                input.focus();
            } else {
                showToast('Nothing was recognized - try again a little closer to the mic.', true);
            }
        } catch (error) {
            showToast(error.message || 'Transcription failed.', true);
        } finally {
            micBtn.disabled = false;
            setMicState(false);
        }
    });
    recorder.start();
    setMicState(true);
    recorderTimeout = setTimeout(() => recorder?.stop(), MAX_RECORDING_MS);
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const comma = result.indexOf(',');
            resolve(comma === -1 ? result : result.slice(comma + 1));
        };
        reader.onerror = () => reject(new Error('Could not read the recording.'));
        reader.readAsDataURL(blob);
    });
}

async function loadVoiceCapabilities() {
    try {
        voiceCaps = await api.voiceCapabilities();
    } catch {
        voiceCaps = { stt: false, tts: false };
    }
    micBtn.classList.toggle('hidden', !voiceCaps.stt);
}

/* ---------- share links ---------- */

const shareBackdrop = document.getElementById('share-modal-backdrop');
const shareState = document.getElementById('share-state');

function renderShareState(state) {
    shareState.replaceChildren();
    if (state.shared) {
        const url = new URL(state.url, window.location.origin).toString();
        const row = document.createElement('div');
        row.className = 'share-link-row';
        const linkInput = document.createElement('input');
        linkInput.className = 'input share-link-input';
        linkInput.type = 'text';
        linkInput.readOnly = true;
        linkInput.value = url;
        linkInput.setAttribute('aria-label', 'Share link');
        linkInput.addEventListener('focus', () => linkInput.select());
        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn primary';
        copyBtn.textContent = '⧉ Copy';
        copyBtn.addEventListener('click', () => copyText(url, 'Share link copied.'));
        row.append(linkInput, copyBtn);

        const revokeBtn = document.createElement('button');
        revokeBtn.className = 'btn danger';
        revokeBtn.textContent = 'Revoke link';
        revokeBtn.addEventListener('click', async () => {
            try {
                await api.revokeShare(activeConvId);
                renderShareState({ shared: false });
                refreshConversations();
                showToast('Share link revoked - it no longer works.');
            } catch (error) {
                showToast(error.message, true);
            }
        });

        const meta = document.createElement('div');
        meta.className = 'hint';
        meta.textContent = `Shared since ${timeLabel(state.createdAt) || 'now'}. New messages appear in the shared view too.`;
        shareState.append(row, meta, revokeBtn);
    } else {
        const createBtn = document.createElement('button');
        createBtn.className = 'btn primary';
        createBtn.textContent = '🔗 Create share link';
        createBtn.addEventListener('click', async () => {
            try {
                const created = await api.createShare(activeConvId);
                renderShareState({ shared: true, url: created.url, createdAt: created.createdAt });
                refreshConversations();
                copyText(new URL(created.url, window.location.origin).toString(), 'Share link created and copied.');
            } catch (error) {
                showToast(error.message, true);
            }
        });
        shareState.append(createBtn);
    }
}

async function openShare() {
    if (incognito) {
        showToast('Incognito chats are never stored, so they cannot be shared.', true);
        return;
    }
    if (activeConvId === null) {
        showToast('Say something first - an empty chat has nothing to share.', true);
        return;
    }
    try {
        const state = await api.shareStatus(activeConvId);
        renderShareState(state);
        openModal(shareBackdrop);
    } catch (error) {
        showToast(error.message, true);
    }
}

/** Code-block chrome + mini-apps live in the shared module. */
function decorateCodeBlocks(bubble) {
    decorateShared(bubble, (message, isError) => showToast(message, isError));
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
        // Stored user messages carry their text attachments inline
        // (webChatService folds them in); render them as collapsible chips.
        const parsed = splitAttachments(content);
        const files = [...(message.files || []), ...parsed.files];
        bubble.textContent = parsed.text || (files.length ? '' : content);
        for (const file of files) {
            bubble.appendChild(fileChip(file));
        }
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
    renderAttachments(bubble, attachments);
}

/**
 * Collapsible chip for one attachment on a user message. Text files carry
 * their content; just-sent PDFs only carry contentBase64 (the server
 * extracts the text), so the preview explains that instead of crashing.
 */
function fileChip(file) {
    const details = document.createElement('details');
    details.className = 'file-chip';
    const isPdf = typeof file.content !== 'string';
    const summary = document.createElement('summary');
    summary.textContent = `${isPdf ? '📕' : '📄'} ${file.name}`;
    const pre = document.createElement('pre');
    if (isPdf) {
        pre.textContent = 'PDF document - the text is extracted on the server and appears here once the reply arrives.';
    } else {
        pre.textContent = file.content.length > 4000
            ? `${file.content.slice(0, 4000)}\n…(truncated preview)`
            : file.content;
    }
    details.append(summary, pre);
    return details;
}

function typingIndicator() {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = '<div class="msg-bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
    log.appendChild(el);
    scrollToBottom(true);
    return el;
}

/* ---------- tool activity (what Goobster is doing mid-turn) ---------- */

const TOOL_LABELS = {
    performSearch: ['Searching the web', 'Searched the web'],
    generateImage: ['Generating an image', 'Generated an image'],
    runCode: ['Running code', 'Ran code'],
    searchGithubCode: ['Searching GitHub', 'Searched GitHub'],
    readGithubFile: ['Reading a GitHub file', 'Read a GitHub file'],
    searchNotion: ['Searching Notion', 'Searched Notion'],
    readNotionPage: ['Reading a Notion page', 'Read a Notion page'],
    rememberFact: ['Saving a memory', 'Saved a memory'],
    forgetFact: ['Removing a memory', 'Removed a memory'],
    scheduleFollowUp: ['Scheduling a follow-up', 'Scheduled a follow-up'],
    manageAutomations: ['Managing your automations', 'Managed your automations'],
    manageParlor: ['Working in your Parlor', 'Worked in your Parlor'],
    stockQuote: ['Checking stock prices', 'Checked stock prices'],
    rollDice: ['Rolling dice', 'Rolled dice']
};

function toolLabel(name, done) {
    const entry = TOOL_LABELS[name];
    if (entry) return entry[done ? 1 : 0];
    // Fall back to a humanized camelCase name
    const words = String(name).replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    return done ? `Finished: ${words}` : `Working: ${words}`;
}

/**
 * The activity strip shown while tools run: one chip per tool call, spinner
 * while running, ✓/⚠ when finished. Removed when the reply lands (the
 * transcript itself is the durable record).
 */
function createToolStrip() {
    const el = document.createElement('div');
    el.className = 'msg assistant tool-strip';
    log.appendChild(el);
    scrollToBottom();
    const running = [];
    return {
        el,
        onEvent(event) {
            if (event.phase === 'start') {
                const chip = document.createElement('span');
                chip.className = 'tool-chip running';
                chip.innerHTML = `<span class="tool-spinner"></span> ${escapeHtml(toolLabel(event.name, false))}…`;
                el.appendChild(chip);
                running.push({ name: event.name, chip });
                scrollToBottom();
            } else if (event.phase === 'result') {
                const index = running.findIndex(r => r.name === event.name);
                const entry = index === -1 ? null : running.splice(index, 1)[0];
                if (entry) {
                    entry.chip.className = `tool-chip ${event.isError ? 'failed' : 'done'}`;
                    entry.chip.textContent = `${event.isError ? '⚠' : '✓'} ${toolLabel(event.name, true)}`;
                }
            }
        },
        remove() { el.remove(); }
    };
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

async function loadHistory({ silent = false } = {}) {
    stopReadAloud();
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
                // Uploaded images come back as durable attachments now; the
                // session cache only covers messages sent before that landed.
                images: message.role === 'user' && !(message.attachments?.length)
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
      <textarea aria-label="Edit message"></textarea>
      <div class="btn-row">
        <button class="btn cancel">Cancel</button>
        <button class="btn branch" title="Keep this conversation as it is and continue the edit in a new branch">⑂ Branch</button>
        <button class="btn primary save" title="Rewrite history: replies after this point are discarded">Save &amp; resend</button>
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
    // Branch: the old conversation stays intact; history before this
    // message is copied into a fresh conversation and the edit continues
    // there.
    editor.querySelector('.branch').addEventListener('click', async () => {
        const text = textarea.value.trim();
        if (!text) return;
        try {
            const branch = await api.branch(activeConvId, message.id);
            conversations.unshift(branch);
            activeConvId = branch.id;
            renderConversations();
            setHeaderTitle();
            await loadHistory({ silent: true });
            showToast('Branched - the original conversation is untouched.');
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

/* ---------- attachments (images + text files) ---------- */

const MAX_ATTACH = 4;
const MAX_DIMENSION = 1568;
const MAX_TEXT_FILE_BYTES = 200 * 1024;
const MAX_TEXT_FILE_CHARS = 50000;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

function renderImageTray() {
    const empty = pendingImages.length === 0 && pendingFiles.length === 0;
    imageTray.classList.toggle('hidden', empty);
    const thumbs = pendingImages.map((image, index) => {
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
    });
    const chips = pendingFiles.map((file, index) => {
        const chip = document.createElement('div');
        chip.className = 'pending-file-chip';
        const label = document.createElement('span');
        label.textContent = `${file.contentBase64 ? '📕' : '📄'} ${file.name}`;
        const remove = document.createElement('button');
        remove.textContent = '✕';
        remove.title = 'Remove';
        remove.addEventListener('click', () => {
            pendingFiles.splice(index, 1);
            renderImageTray();
        });
        chip.append(label, remove);
        return chip;
    });
    imageTray.replaceChildren(...thumbs, ...chips);
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

/** Read one PDF as base64 (the server extracts the text). */
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        if (file.size > MAX_PDF_BYTES) {
            reject(new Error(`"${file.name}" is too large (max ${Math.round(MAX_PDF_BYTES / (1024 * 1024))}MB per PDF).`));
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const comma = result.indexOf(',');
            resolve(comma === -1 ? result : result.slice(comma + 1));
        };
        reader.onerror = () => reject(new Error(`Couldn't read "${file.name}".`));
        reader.readAsDataURL(file);
    });
}

/** Read one non-image file as text (bounded). */
function fileToText(file) {
    return new Promise((resolve, reject) => {
        if (file.size > MAX_TEXT_FILE_BYTES) {
            reject(new Error(`"${file.name}" is too large (max ${Math.round(MAX_TEXT_FILE_BYTES / 1024)}KB per file).`));
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const text = String(reader.result || '');
            // Binary sniff: real text shouldn't contain NUL bytes
            if (text.includes('\u0000')) {
                reject(new Error(`"${file.name}" doesn't look like a text file.`));
                return;
            }
            resolve(text.length > MAX_TEXT_FILE_CHARS ? text.slice(0, MAX_TEXT_FILE_CHARS) : text);
        };
        reader.onerror = () => reject(new Error(`Couldn't read "${file.name}".`));
        reader.readAsText(file);
    });
}

async function addFiles(files) {
    for (const file of files) {
        if (file.type.startsWith('image/')) {
            if (pendingImages.length >= MAX_ATTACH) {
                showToast(`At most ${MAX_ATTACH} images per message.`, true);
                continue;
            }
            try {
                const dataUrl = await fileToDataUrl(file);
                pendingImages.push({ dataUrl, name: file.name || 'image' });
            } catch (error) {
                showToast(error.message, true);
            }
        } else if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) {
            if (pendingFiles.length >= MAX_ATTACH) {
                showToast(`At most ${MAX_ATTACH} files per message.`, true);
                continue;
            }
            try {
                const contentBase64 = await fileToBase64(file);
                pendingFiles.push({ name: file.name || 'document.pdf', contentBase64 });
            } catch (error) {
                showToast(error.message, true);
            }
        } else {
            if (pendingFiles.length >= MAX_ATTACH) {
                showToast(`At most ${MAX_ATTACH} files per message.`, true);
                continue;
            }
            try {
                const content = await fileToText(file);
                pendingFiles.push({ name: file.name || 'attachment.txt', content });
            } catch (error) {
                showToast(error.message, true);
            }
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

/* ---------- AI settings (provider / model / reasoning / thoughtful) ---------- */

function applyAiSettings(settings) {
    aiSettings = settings;
    thoughtfulBtn.classList.toggle('on', settings.thoughtful);
    thoughtfulBtn.setAttribute('aria-checked', String(settings.thoughtful));
    document.getElementById('thoughtful-wrap').classList.toggle('hidden', !settings.thoughtfulAvailable);
    const effort = settings.effective.reasoningEffort;
    modelChipLabel.textContent = `${settings.effective.model}${effort ? ` · ${effort}` : ''}`;
    modelChip.title = `${settings.effective.providerName} · ${settings.effective.model}` +
        `${effort ? ` · ${effort} reasoning` : ''} - click to change`;
}

async function loadAiSettings() {
    try {
        applyAiSettings(await api.chatSettings());
    } catch {
        document.getElementById('thoughtful-wrap').classList.add('hidden');
        modelChipLabel.textContent = 'Model';
    }
}

async function toggleThoughtful() {
    const next = !thoughtfulBtn.classList.contains('on');
    thoughtfulBtn.disabled = true;
    try {
        const settings = await api.setThoughtful(next);
        applyAiSettings(settings);
        showToast(settings.thoughtful
            ? `Thoughtful Mode on - ${settings.effective.model}, deeper reasoning.`
            : 'Thoughtful Mode off - back to the everyday model.');
    } catch (error) {
        showToast(error.message, true);
    } finally {
        thoughtfulBtn.disabled = false;
    }
}

/* ---------- settings modal ---------- */

const settingsBackdrop = document.getElementById('settings-modal-backdrop');
const providerSelect = document.getElementById('settings-provider');
const modelSelect = document.getElementById('settings-model');
const reasoningSegment = document.getElementById('settings-reasoning');
const instructionsInput = document.getElementById('settings-instructions');
const settingsHint = document.getElementById('settings-hint');

const REASONING_OPTIONS = [
    { value: '', label: 'Default' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' }
];
let selectedReasoning = '';

function providerEntry(key) {
    return aiSettings?.providers?.find(p => p.key === key) || null;
}

/**
 * Fill the model dropdown for the chosen provider: "Provider default" first,
 * then the models the API key can actually use (live listing from the
 * server, cached there). Falls back to the catalog defaults when the
 * listing is unavailable, and always keeps the current override selectable.
 */
let modelLoadSeq = 0;
async function populateModelSelect(providerKey, selected) {
    const entry = providerEntry(providerKey);
    const seq = ++modelLoadSeq;

    const render = (models) => {
        if (seq !== modelLoadSeq) return; // a newer provider choice won
        const ids = [...new Set(models)];
        // The saved override must stay selectable even if the listing
        // doesn't include it (e.g. an alias or a fine-tune).
        if (selected && !ids.includes(selected)) ids.unshift(selected);
        modelSelect.replaceChildren(
            Object.assign(document.createElement('option'), {
                value: '',
                textContent: entry?.chatModel
                    ? `Provider default (${entry.chatModel})`
                    : 'Provider default'
            }),
            ...ids.map(id => Object.assign(document.createElement('option'), { value: id, textContent: id }))
        );
        modelSelect.value = selected && ids.includes(selected) ? selected : '';
        modelSelect.disabled = false;
    };

    // Placeholder while the listing loads
    modelSelect.replaceChildren(Object.assign(document.createElement('option'), {
        value: selected || '',
        textContent: selected || 'Loading models…'
    }));
    modelSelect.disabled = true;

    const fallback = [entry?.chatModel, entry?.thoughtfulModel].filter(Boolean);
    try {
        const { models } = await api.listModels(providerKey || undefined);
        render(models?.length ? models : fallback);
    } catch {
        render(fallback);
    }
}

function refreshSettingsModal() {
    const chosen = providerSelect.value;
    // "Default" means the server default provider - not the currently
    // effective one (which may be the very override being cleared).
    const serverDefaultKey = aiSettings?.providers?.find(p => p.isDefault)?.key;
    const entry = providerEntry(chosen || serverDefaultKey);

    const supportsReasoning = !entry || entry.reasoningEffort;
    reasoningSegment.replaceChildren(...REASONING_OPTIONS.map(option => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `segment-btn${selectedReasoning === option.value ? ' active' : ''}`;
        btn.textContent = option.label;
        btn.disabled = !supportsReasoning && option.value !== '';
        btn.addEventListener('click', () => {
            selectedReasoning = option.value;
            refreshSettingsModal();
        });
        return btn;
    }));
    settingsHint.textContent = supportsReasoning
        ? 'Settings apply to this web chat and your Discord DMs. The model list shows what your API key can use.'
        : 'Ollama (local) doesn\u2019t support reasoning effort.';
}

async function openSettings() {
    try {
        if (!aiSettings) applyAiSettings(await api.chatSettings());
    } catch (error) {
        showToast(error.message, true);
        return;
    }
    providerSelect.replaceChildren(
        Object.assign(document.createElement('option'), {
            value: '',
            textContent: `Default (${providerEntry(aiSettings.providers.find(p => p.isDefault)?.key)?.name || 'auto'})`
        }),
        ...aiSettings.providers.map(provider => {
            const option = document.createElement('option');
            option.value = provider.key;
            option.textContent = provider.configured ? provider.name : `${provider.name} - not configured`;
            option.disabled = !provider.configured;
            return option;
        })
    );
    providerSelect.value = aiSettings.provider || '';
    selectedReasoning = aiSettings.reasoningEffort || '';
    instructionsInput.value = aiSettings.customInstructions || '';
    refreshSettingsModal();
    const serverDefaultKey = aiSettings.providers.find(p => p.isDefault)?.key;
    populateModelSelect(aiSettings.provider || serverDefaultKey, aiSettings.model || null);
    openModal(settingsBackdrop, { initialFocus: providerSelect });
}

async function saveSettings() {
    const saveBtn = document.getElementById('settings-save');
    saveBtn.disabled = true;
    try {
        const settings = await api.saveChatSettings({
            provider: providerSelect.value || null,
            model: modelSelect.value || null,
            reasoningEffort: selectedReasoning || null,
            customInstructions: instructionsInput.value.trim() || null
        });
        applyAiSettings(settings);
        closeModal(settingsBackdrop);
        showToast(`Model settings saved - ${settings.effective.providerName} · ${settings.effective.model}.`);
    } catch (error) {
        showToast(error.message, true);
    } finally {
        saveBtn.disabled = false;
    }
}

/* ---------- integrations modal ---------- */

const integrationsBackdrop = document.getElementById('integrations-modal-backdrop');
const integrationsList = document.getElementById('integrations-list');

const INTEGRATION_ICONS = { github: '🐙', notion: '📓' };

function integrationCard(item) {
    const card = document.createElement('div');
    card.className = 'integration-card';

    const head = document.createElement('div');
    head.className = 'integration-head';
    const title = document.createElement('div');
    title.className = 'integration-title';
    title.textContent = `${INTEGRATION_ICONS[item.provider] || '🔌'} ${item.name}`;
    const status = document.createElement('span');
    status.className = `integration-status${item.connected ? ' connected' : ''}`;
    status.textContent = item.connected ? `Connected · ${item.account || 'account'}` : 'Not connected';
    head.append(title, status);
    card.appendChild(head);

    const description = document.createElement('div');
    description.className = 'hint';
    description.textContent = item.description;
    card.appendChild(description);

    if (item.connected) {
        const row = document.createElement('div');
        row.className = 'integration-actions';
        const disconnectBtn = document.createElement('button');
        disconnectBtn.className = 'btn danger';
        disconnectBtn.textContent = 'Disconnect';
        disconnectBtn.addEventListener('click', async () => {
            if (!await confirmDialog(`Disconnect ${item.name}? The stored token is deleted.`)) return;
            try {
                await api.disconnectIntegration(item.provider);
                showToast(`${item.name} disconnected.`);
                await renderIntegrations();
            } catch (error) {
                showToast(error.message, true);
            }
        });
        row.appendChild(disconnectBtn);
        card.appendChild(row);
    } else {
        const hint = document.createElement('div');
        hint.className = 'hint integration-token-hint';
        hint.textContent = item.tokenHint;
        card.appendChild(hint);

        const row = document.createElement('div');
        row.className = 'integration-actions';
        const tokenInput = document.createElement('input');
        tokenInput.className = 'input integration-token';
        tokenInput.type = 'password';
        tokenInput.placeholder = `${item.name} token`;
        tokenInput.autocomplete = 'off';
        const connectBtn = document.createElement('button');
        connectBtn.className = 'btn primary';
        connectBtn.textContent = 'Connect';
        const connect = async () => {
            const token = tokenInput.value.trim();
            if (!token) { tokenInput.focus(); return; }
            connectBtn.disabled = true;
            connectBtn.textContent = 'Verifying…';
            try {
                const result = await api.connectIntegration(item.provider, token);
                showToast(`${item.name} connected as ${result.account}.`);
                await renderIntegrations();
            } catch (error) {
                showToast(error.message, true);
                connectBtn.disabled = false;
                connectBtn.textContent = 'Connect';
            }
        };
        connectBtn.addEventListener('click', connect);
        tokenInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') connect();
        });
        row.append(tokenInput, connectBtn);
        card.appendChild(row);

        const docs = document.createElement('a');
        docs.className = 'integration-docs';
        docs.href = item.docsUrl;
        docs.target = '_blank';
        docs.rel = 'noreferrer';
        docs.textContent = 'Where do I get a token? ↗';
        card.appendChild(docs);
    }
    return card;
}

async function renderIntegrations() {
    try {
        const { integrations } = await api.integrations();
        integrationsList.replaceChildren(...integrations.map(integrationCard));
        integrationsBtn.classList.toggle('on', integrations.some(item => item.connected));
    } catch (error) {
        integrationsList.replaceChildren(
            Object.assign(document.createElement('div'), { className: 'hint', textContent: error.message })
        );
    }
}

async function openIntegrations() {
    integrationsList.replaceChildren(
        Object.assign(document.createElement('div'), { className: 'hint', textContent: 'Loading…' })
    );
    openModal(integrationsBackdrop);
    await renderIntegrations();
}

/* ---------- sending ---------- */

function setSending(active) {
    sending = active;
    sendBtn.classList.toggle('stop', active);
    sendBtn.textContent = active ? '◼' : '➤';
    sendBtn.title = active ? 'Stop generating' : 'Send';
    input.disabled = false;
}

function formatElapsed(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function clearRemoteTurn() {
    remoteTurn = false;
    if (remoteTurnTimer) {
        clearInterval(remoteTurnTimer);
        remoteTurnTimer = null;
    }
}

/**
 * Reflect a server-side reply this page didn't start: the send button
 * becomes Stop, and a poll notices the turn finishing (or being stopped
 * elsewhere) so the composer unlocks and the reply appears without a
 * manual refresh.
 */
function enterRemoteTurn() {
    if (remoteTurn) return;
    remoteTurn = true;
    setSending(true);
    remoteTurnTimer = setInterval(async () => {
        let status;
        try { status = await api.turnStatus(); } catch { return; }
        if (status.inFlight) return;
        clearRemoteTurn();
        setSending(false);
        showToast('That reply finished.');
        await loadHistory({ silent: true });
        await refreshConversations();
    }, 5000);
}

async function stopGenerating() {
    try { await api.stop(); } catch { /* turn may have just finished */ }
    abortController?.abort();
    if (remoteTurn) {
        clearRemoteTurn();
        setSending(false);
        showToast('Stopped that reply - you can send again.');
        // The aborted turn stores its partial text a beat later.
        setTimeout(() => loadHistory({ silent: true }), 1200);
    }
}

async function sendMessage(forcedText = null) {
    if (sending) { stopGenerating(); return; }
    // Re-sends of stored messages (edit / regenerate) carry their
    // attachment blocks inline - split them back out into files.
    const raw = (forcedText ?? input.value).trim();
    const recovered = forcedText === null ? { text: raw, files: [] } : splitAttachments(raw);
    const text = recovered.text;
    if (!text) return;

    // A fresh "New chat" is persisted on first send, so it never lands in
    // an older conversation. Incognito chats are never persisted at all.
    if (activeConvId === null && !incognito) {
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
    const files = [...recovered.files, ...pendingFiles];
    pendingImages = [];
    pendingFiles = [];
    renderImageTray();
    if (images.length > 0) sessionImages.set(`${activeConvId}\n${text}`, images);
    if (forcedText === null) {
        input.value = '';
        autosize();
    }

    setSending(true);
    abortController = new AbortController();

    let pending = null;
    let draft = null;
    let draftText = '';
    let gotFinal = false;
    let stopped = false;
    let toolStrip = null;

    const clearPending = () => {
        pending?.remove();
        pending = null;
    };
    const clearToolStrip = () => {
        toolStrip?.remove();
        toolStrip = null;
    };
    const ensureDraft = () => {
        if (!draft) {
            clearPending();
            draft = addMessage('assistant', { content: '' });
        }
        return draft;
    };

    let finalReply = '';
    try {
        // Inside the try so a render bug can never wedge the composer in
        // the "sending" state with no visible error.
        addMessage('user', { content: text, images, files });
        pending = typingIndicator();
        await streamChat(
            {
                message: text,
                conversationId: incognito ? null : activeConvId,
                images: images.map(image => image.dataUrl),
                files,
                incognito
            },
            {
                onTyping: () => {
                    if (!draft && !pending && !toolStrip) pending = typingIndicator();
                },
                onTool: (event) => {
                    // A new tool call makes any streamed "planning" text
                    // stale - the real answer streams after the tools.
                    if (event.phase === 'start' && draft) {
                        draft.el.remove();
                        draft = null;
                        draftText = '';
                    }
                    if (!toolStrip) {
                        clearPending();
                        toolStrip = createToolStrip();
                    }
                    toolStrip.onEvent(event);
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
                    clearToolStrip();
                    gotFinal = true;
                    if (!isError && content) finalReply = content;
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
                    clearToolStrip();
                    gotFinal = true;
                    addMessage('assistant', { content: message || 'Something went wrong.', isError: true });
                }
            },
            abortController.signal
        );

        clearToolStrip();
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
        clearToolStrip();
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
        } else if (error.status === 409 && error.code === 'TURN_IN_FLIGHT') {
            // Another reply (possibly in another conversation, or from
            // before a reload) holds the per-user lock. Surface it and turn
            // the send button into its Stop button instead of dead-ending.
            draft?.el?.remove();
            enterRemoteTurn();
            // Put the rejected message back so it can be resent once the
            // in-flight reply finishes or is stopped.
            if (forcedText === null && !input.value) {
                input.value = raw;
                autosize();
            }
            showToast(`${error.message} The ◼ button stops it.`, true);
        } else {
            draft?.el?.remove();
            addMessage('assistant', { content: error.message || 'Something went wrong.', isError: true });
            if (error.status === 429) showToast(error.message, true);
        }
    } finally {
        clearPending();
        setSending(remoteTurn);
        abortController = null;
        input.focus();
        if (incognito) {
            // Nothing to resync - the server kept nothing. Track the
            // exchange locally so export still works.
            history.push({ role: 'user', content: text, createdAt: new Date().toISOString() });
            if (finalReply || draftText) {
                history.push({ role: 'assistant', content: finalReply || draftText, createdAt: new Date().toISOString() });
            }
        } else {
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
}

/* ---------- header overflow menu (mobile) ---------- */

/* Below the mobile breakpoint the secondary header actions live in a ⋯
 * dropdown; on desktop the container is display: contents, so .open is inert
 * there (the same trick the sidebar drawer uses). */
function setMoreMenu(open) {
    moreMenu.classList.toggle('open', open);
    moreBtn.setAttribute('aria-expanded', String(open));
}

function wireMoreMenu() {
    moreBtn.addEventListener('click', () => setMoreMenu(!moreMenu.classList.contains('open')));
    // Picking an action closes the menu; the action's own handler still runs.
    moreMenu.addEventListener('click', () => setMoreMenu(false));
    document.addEventListener('click', (event) => {
        if (!event.target.closest('#chat-more-menu, #chat-more-btn')) setMoreMenu(false);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && moreMenu.classList.contains('open')) {
            setMoreMenu(false);
            moreBtn.focus();
        }
    });
    // Growing past the breakpoint puts the actions back in the header row.
    window.matchMedia('(min-width: 721px)').addEventListener('change', (event) => {
        if (event.matches) setMoreMenu(false);
    });
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
    // Capabilities gate the mic + Listen buttons, so resolve them before
    // the first history render.
    await loadVoiceCapabilities();
    await loadHistory();
    loadAiSettings();

    // A reply may still be generating from before this page load (long tool
    // runs / slow models keep working after the browser goes away). Reflect
    // it instead of silently rejecting the next send with a 409.
    try {
        const status = await api.turnStatus();
        if (status.inFlight) {
            enterRemoteTurn();
            showToast(`A reply you asked for ${formatElapsed(status.elapsedMs)} ago is still being generated - the ◼ button stops it.`);
        }
    } catch { /* cosmetic; the 409 path still covers it */ }

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
            addFiles(files);
        }
    });

    newChatBtn.addEventListener('click', newChat);
    convSearch.addEventListener('input', onSearchInput);
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        addFiles([...fileInput.files]);
        fileInput.value = '';
    });
    exportBtn.addEventListener('click', exportChat);
    wireMoreMenu();
    thoughtfulBtn.addEventListener('click', toggleThoughtful);
    incognitoBtn.addEventListener('click', toggleIncognito);
    micBtn.addEventListener('click', toggleDictation);

    // Share modal
    shareBtn.addEventListener('click', openShare);
    document.getElementById('share-close').addEventListener('click', () =>
        closeModal(shareBackdrop));

    // Settings modal
    modelChip.addEventListener('click', openSettings);
    providerSelect.addEventListener('change', () => {
        refreshSettingsModal();
        // Switching platforms resets the model choice to that platform's
        // default - the old override belongs to the old provider.
        const serverDefaultKey = aiSettings?.providers?.find(p => p.isDefault)?.key;
        populateModelSelect(providerSelect.value || serverDefaultKey, null);
    });
    document.getElementById('settings-save').addEventListener('click', saveSettings);
    document.getElementById('settings-cancel').addEventListener('click', () =>
        closeModal(settingsBackdrop));

    // Integrations modal
    integrationsBtn.addEventListener('click', openIntegrations);
    document.getElementById('integrations-close').addEventListener('click', () =>
        closeModal(integrationsBackdrop));

    scroller.addEventListener('scroll', () => {
        scrollDownBtn.classList.toggle('hidden', nearBottom());
    });
    scrollDownBtn.addEventListener('click', () => scrollToBottom(true));

    input.focus();
}
