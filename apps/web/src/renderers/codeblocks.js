/**
 * Rich reply chrome shared by the chat and the Parlor: every assistant
 * <pre> gets a header bar (language + copy), html/svg blocks become
 * live mini-apps - a sandboxed iframe (opaque origin: `sandbox` without
 * allow-same-origin, so generated code can never reach the session
 * cookie, the API, or this page's DOM) with Preview/Code tabs, restart,
 * fullscreen, and download - and tool-generated file attachments render
 * as inline images or download chips. There is deliberately no "open in
 * new tab" blob URL for mini-apps - a blob document would inherit the
 * app origin.
 */

const APPLET_LANGS = new Set(['html', 'svg']);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)$/i;

async function copyText(text, notify, label) {
    try {
        await navigator.clipboard.writeText(text);
        notify(label);
    } catch {
        notify('Copy failed - browser blocked clipboard access.', true);
    }
}

function appletButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
}

/** Turn an html/svg <pre> into a runnable mini-app card. */
function buildApplet(pre, notify, { onPin, pinned } = {}) {
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
        appletButton('⧉', 'Copy source', () => copyText(source, notify, 'Source copied.')),
        appletButton('⬇', 'Download as .html', () => {
            const blob = new Blob([source], { type: 'text/html' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'goobster-app.html';
            link.click();
            URL.revokeObjectURL(link.href);
        })
    );
    if (typeof onPin === 'function') {
        actions.appendChild(appletButton(pinned ? '📌' : '📌', pinned ? 'Already pinned' : 'Pin to the Workshop', () => {
            onPin({
                source,
                language: (pre.dataset.lang || 'html').toLowerCase(),
                title: null
            });
        }));
    }
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

/**
 * Wrap each <pre> under root in a header bar with its language and a copy
 * button; html/svg blocks become live mini-apps instead.
 * @param {HTMLElement} root
 * @param {(message: string, isError?: boolean) => void} [notify] - toast
 * @param {{ onPin?: Function, pinned?: boolean }} [options]
 */
export function decorateCodeBlocks(root, notify = () => {}, options = {}) {
    for (const pre of [...root.querySelectorAll('pre')]) {
        if (pre.parentElement?.classList.contains('codewrap') || pre.closest('.applet')) continue;
        if (APPLET_LANGS.has((pre.dataset.lang || '').toLowerCase())) {
            buildApplet(pre, notify, options);
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
        copyBtn.addEventListener('click', () => copyText(pre.textContent, notify, 'Code copied.'));
        head.append(lang, copyBtn);
        pre.replaceWith(wrap);
        wrap.append(head, pre);
    }
}

/**
 * Render tool-generated attachments ({ url, name }) into a bubble:
 * images inline, everything else (e.g. an .html file a persona's sandbox
 * run wrote) as a download chip instead of a broken <img>.
 * @param {HTMLElement} bubble
 * @param {Array<{url: string, name?: string}>} attachments
 */
export function renderAttachments(bubble, attachments = []) {
    for (const file of attachments) {
        if (!file?.url) continue;
        // No name means an older registration - assume image (the only
        // kind that existed before download chips).
        if (!file.name || IMAGE_EXT.test(file.name)) {
            const img = document.createElement('img');
            img.className = 'attachment';
            img.src = file.url;
            img.alt = file.name || 'attachment';
            img.loading = 'lazy';
            bubble.appendChild(img);
        } else {
            const link = document.createElement('a');
            link.className = 'file-chip';
            link.href = file.url;
            link.download = file.name;
            link.textContent = `⬇ ${file.name}`;
            bubble.appendChild(link);
        }
    }
}

/**
 * Render a stored applet into an empty container (the Workshop preview).
 * @param {HTMLElement} container
 * @param {{ source: string, language?: string, notify?: Function }} params
 */
export function renderApplet(container, { source, language = 'html', notify = () => {} } = {}) {
    const pre = document.createElement('pre');
    pre.dataset.lang = language;
    pre.textContent = source;
    container.replaceChildren(pre);
    buildApplet(pre, notify);
}
