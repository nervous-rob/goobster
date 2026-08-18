/**
 * Read-only share viewer: renders one shared conversation from its public
 * token (/app/share/<token>). No session, no API access beyond the single
 * share endpoint - markdown, math, and code highlighting reuse the app's
 * own renderer modules.
 */
import { renderMarkdown } from './markdown.js';
import { renderMathIn } from './math.js';
import { decorateCodeBlocks } from './codeblocks.js';

const log = document.getElementById('share-log');
const statusEl = document.getElementById('share-status');
const titleEl = document.getElementById('share-title');
const metaEl = document.getElementById('share-meta');

/** The stored attachment-block markers on user messages, split back out. */
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

function timeLabel(iso) {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function addMessage(message) {
    const el = document.createElement('div');
    el.className = `msg ${message.role === 'assistant' ? 'assistant' : 'user'}`;
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    if (message.role === 'assistant') {
        bubble.innerHTML = renderMarkdown(message.content);
        decorateCodeBlocks(bubble, () => {});
        renderMathIn(bubble);
    } else {
        const parsed = splitAttachments(message.content);
        bubble.textContent = parsed.text || message.content;
        for (const file of parsed.files) {
            const details = document.createElement('details');
            details.className = 'file-chip';
            const summary = document.createElement('summary');
            summary.textContent = `📄 ${file.name}`;
            const pre = document.createElement('pre');
            pre.textContent = file.content.length > 4000
                ? `${file.content.slice(0, 4000)}\n…(truncated preview)`
                : file.content;
            details.append(summary, pre);
            bubble.appendChild(details);
        }
    }
    el.appendChild(bubble);
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = `${message.role === 'assistant' ? 'Goobster' : 'User'} · ${timeLabel(message.createdAt)}`;
    el.appendChild(meta);
    log.appendChild(el);
}

async function boot() {
    const token = window.location.pathname.split('/').filter(Boolean).pop();
    try {
        const res = await fetch(`/api/app/share/${encodeURIComponent(token)}`);
        const json = await res.json().catch(() => null);
        if (!res.ok) {
            throw new Error(json?.error?.message || 'This share link does not exist (or was revoked).');
        }
        titleEl.textContent = json.title;
        document.title = `${json.title} — Goobster`;
        metaEl.textContent = `Shared ${timeLabel(json.sharedAt)}`;
        statusEl.remove();
        for (const message of json.messages) addMessage(message);
        if (json.messages.length === 0) {
            log.appendChild(Object.assign(document.createElement('div'), {
                className: 'empty', textContent: 'This conversation has no messages yet.'
            }));
        }
    } catch (error) {
        statusEl.textContent = error.message;
    }
}

boot();
