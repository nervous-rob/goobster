/**
 * In-app on-screen touch keyboard for the kiosk panel.
 *
 * The Wayland OS keyboard (Squeekboard) cannot rise above a fullscreen
 * Chromium kiosk window, so the panel ships its own: a fixed overlay that
 * appears whenever a text-capable field gains focus. Keys use pointerdown
 * with preventDefault so the field never loses focus while typing.
 */

const LETTER_ROWS = [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['{shift}', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '{bksp}'],
    ['{sym}', '{space}', '.', '{enter}', '{hide}']
];

const SYMBOL_ROWS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['-', '_', '/', ':', ';', '(', ')', '$', '&', '@'],
    ['!', '?', ',', "'", '"', '#', '+', '=', '{bksp}'],
    ['{abc}', '{space}', '.', '{enter}', '{hide}']
];

const NUMBER_ROWS = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['{bksp}', '0', '{hide}']
];

const SPECIAL_LABELS = {
    '{shift}': '⇧',
    '{bksp}': '⌫',
    '{sym}': '?123',
    '{abc}': 'ABC',
    '{space}': ' ',
    '{enter}': '↵',
    '{hide}': '⌄'
};

let root = null;       // keyboard container element
let target = null;     // currently focused input/textarea
let layer = 'letters'; // 'letters' | 'symbols' | 'numbers'
let shifted = false;

function isEditable(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return ['text', 'search', 'number', 'url', 'email', 'tel'].includes(el.type);
}

function isNumeric(el) {
    return el.tagName === 'INPUT' && (el.type === 'number' || el.inputMode === 'numeric');
}

function fireInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Insert text at the caret. Number inputs don't support selection APIs. */
function insertText(text) {
    if (!target) return;
    if (isNumeric(target)) {
        if (/^[0-9]$/.test(text)) {
            target.value += text;
            fireInput(target);
        }
        return;
    }
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    target.setRangeText(text, start, end, 'end');
    fireInput(target);
}

function backspace() {
    if (!target) return;
    if (isNumeric(target)) {
        target.value = target.value.slice(0, -1);
        fireInput(target);
        return;
    }
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    if (start !== end) {
        target.setRangeText('', start, end, 'end');
    } else if (start > 0) {
        target.setRangeText('', start - 1, start, 'end');
    }
    fireInput(target);
}

function pressEnter() {
    if (!target) return;
    if (target.tagName === 'TEXTAREA') {
        insertText('\n');
    } else {
        hide(); // "Done" for single-line fields
    }
}

function currentRows() {
    if (layer === 'numbers') return NUMBER_ROWS;
    if (layer === 'symbols') return SYMBOL_ROWS;
    return LETTER_ROWS;
}

function render() {
    root.innerHTML = '';
    root.classList.toggle('kb-numeric', layer === 'numbers');
    for (const row of currentRows()) {
        const rowEl = document.createElement('div');
        rowEl.className = 'kb-row';
        for (const key of row) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'kb-key';
            const special = key.startsWith('{');
            if (special) {
                btn.classList.add('kb-special', `kb-${key.slice(1, -1)}`);
                btn.textContent = SPECIAL_LABELS[key] ?? key;
                if (key === '{shift}' && shifted) btn.classList.add('kb-active');
            } else {
                btn.textContent = shifted && layer === 'letters' ? key.toUpperCase() : key;
            }
            btn.dataset.key = key;
            rowEl.appendChild(btn);
        }
        root.appendChild(rowEl);
    }
}

function onKeyPointerDown(event) {
    const btn = event.target.closest('.kb-key');
    if (!btn) return;
    // Keep focus on the input; the keyboard must never steal it.
    event.preventDefault();
    const key = btn.dataset.key;

    switch (key) {
        case '{shift}':
            shifted = !shifted;
            render();
            return;
        case '{bksp}':
            backspace();
            return;
        case '{sym}':
            layer = 'symbols';
            render();
            return;
        case '{abc}':
            layer = 'letters';
            render();
            return;
        case '{space}':
            insertText(' ');
            return;
        case '{enter}':
            pressEnter();
            return;
        case '{hide}':
            hide();
            return;
        default: {
            const char = shifted && layer === 'letters' ? key.toUpperCase() : key;
            insertText(char);
            if (shifted) {
                shifted = false;
                render();
            }
        }
    }
}

function show(el) {
    target = el;
    layer = isNumeric(el) ? 'numbers' : 'letters';
    shifted = false;
    render();
    root.classList.add('kb-open');
    document.body.classList.add('kb-visible');
    // Keep the focused field visible above the keyboard.
    setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
}

function hide() {
    const el = target;
    target = null; // clear first so the blur's focusout is a no-op
    root.classList.remove('kb-open');
    document.body.classList.remove('kb-visible');
    el?.blur();
}

/** Wire the keyboard to every current and future editable field. */
export function initKeyboard() {
    root = document.createElement('div');
    root.id = 'kb';
    root.setAttribute('aria-hidden', 'true');
    document.body.appendChild(root);

    root.addEventListener('pointerdown', onKeyPointerDown);

    document.addEventListener('focusin', (event) => {
        if (isEditable(event.target)) {
            show(event.target);
        }
    });

    document.addEventListener('focusout', (event) => {
        // Ignore blur caused by pressing keyboard keys (focus stays put
        // thanks to preventDefault, but be safe about programmatic blurs).
        if (event.target === target && !root.contains(event.relatedTarget)) {
            // Delay so a tap moving focus to another input keeps it open.
            setTimeout(() => {
                if (document.activeElement === document.body || !isEditable(document.activeElement)) {
                    hide();
                }
            }, 100);
        }
    });
}
