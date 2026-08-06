/**
 * Chat pane: history, streaming turns, markdown bubbles, attachments.
 */
import { api, streamChat } from './api.js';
import { renderMarkdown } from './markdown.js';

const log = document.getElementById('chat-log');
const scroller = document.getElementById('chat-scroll');
const input = document.getElementById('chat-input');
const sendBtn = document.getElementById('chat-send');

let sending = false;
let showToast = () => {};

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

/**
 * Append a message bubble.
 * @returns {{ bubble: HTMLElement, el: HTMLElement }}
 */
function addMessage(role, { content = '', meta = '', isError = false } = {}) {
    const el = document.createElement('div');
    el.className = `msg ${role}${isError ? ' error' : ''}`;
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    if (role === 'assistant') bubble.innerHTML = renderMarkdown(content);
    else bubble.textContent = content;
    el.appendChild(bubble);
    if (meta) {
        const metaEl = document.createElement('div');
        metaEl.className = 'msg-meta';
        metaEl.textContent = meta;
        el.appendChild(metaEl);
    }
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

function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
}

async function sendMessage() {
    const text = input.value.trim();
    if (!text || sending) return;

    sending = true;
    sendBtn.disabled = true;
    input.value = '';
    autosize();

    addMessage('user', { content: text });
    let pending = typingIndicator();
    let draft = null;       // streaming bubble
    let draftText = '';
    let gotFinal = false;

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
        await streamChat(text, {
            onTyping: () => {
                // A new round started - if a stream was in progress it was a
                // tool round's preamble; keep it, the next deltas overwrite.
                if (!draft && !pending) pending = typingIndicator();
            },
            onDelta: (delta) => {
                const target = ensureDraft();
                draftText += delta;
                target.bubble.innerHTML = renderMarkdown(draftText) + '<span class="cursor-caret">&nbsp;</span>';
                scrollToBottom();
            },
            onMessage: ({ content, attachments, isError }) => {
                clearPending();
                gotFinal = true;
                if (draft) {
                    // The final text replaces the streamed draft (they're the
                    // same content, minus the caret)
                    draft.bubble.innerHTML = renderMarkdown(content || draftText);
                    if (isError) draft.el.classList.add('error');
                    addAttachments(draft.bubble, attachments);
                    draft = null;
                    draftText = '';
                } else {
                    const message = addMessage('assistant', { content: content || '', isError });
                    addAttachments(message.bubble, attachments);
                }
                scrollToBottom();
            },
            onError: ({ message }) => {
                clearPending();
                gotFinal = true;
                addMessage('assistant', { content: message || 'Something went wrong.', isError: true });
            }
        });

        // Stream ended without a final message event: promote the draft
        if (!gotFinal && draft && draftText) {
            draft.bubble.innerHTML = renderMarkdown(draftText);
        } else if (!gotFinal && !draft) {
            clearPending();
            addMessage('assistant', { content: 'No reply arrived - try again.', isError: true });
        }
    } catch (error) {
        clearPending();
        draft?.el?.remove();
        addMessage('assistant', { content: error.message || 'Something went wrong.', isError: true });
        if (error.status === 429 || error.status === 409) showToast(error.message, true);
    } finally {
        clearPending();
        sending = false;
        sendBtn.disabled = false;
        input.focus();
    }
}

export async function initChat({ toast }) {
    showToast = toast;

    try {
        const { messages } = await api.chatHistory(100);
        log.replaceChildren();
        if (messages.length === 0) {
            const hello = document.createElement('div');
            hello.className = 'empty';
            hello.textContent = 'Say hi - Goobster remembers your conversations here and in Discord DMs.';
            log.appendChild(hello);
        }
        for (const message of messages) {
            addMessage(message.role === 'assistant' ? 'assistant' : 'user', {
                content: message.content,
                meta: timeLabel(message.createdAt)
            });
        }
        scrollToBottom(true);
    } catch (error) {
        toast(`Couldn't load chat history: ${error.message}`, true);
    }

    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });
    input.addEventListener('input', autosize);
    input.focus();
}
