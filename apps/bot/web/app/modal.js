/**
 * Accessible modal helper: focus management for the app's dialog backdrops.
 *
 * openModal() shows a backdrop, moves focus into the dialog, traps Tab
 * inside it, closes on Escape or a backdrop click, and returns focus to
 * whatever was focused before it opened. Plain DOM, no framework - the
 * dialogs themselves stay ordinary markup.
 */

const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
    'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
].join(', ');

/** @type {Map<HTMLElement, { restoreFocus: Element|null, onKeydown: Function, onClick: Function, onClose: Function|null }>} */
const openModals = new Map();

function focusables(dialog) {
    return [...dialog.querySelectorAll(FOCUSABLE)]
        .filter(el => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Show a modal backdrop with focus management.
 * @param {HTMLElement} backdrop - the .backdrop element (dialog inside)
 * @param {Object} [options]
 * @param {HTMLElement|null} [options.initialFocus] - element to focus first
 * @param {Function|null} [options.onClose] - called when the modal closes
 */
export function openModal(backdrop, { initialFocus = null, onClose = null } = {}) {
    if (openModals.has(backdrop)) return;
    const dialog = backdrop.querySelector('.dialog') || backdrop;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    const entry = {
        restoreFocus: document.activeElement,
        onClose,
        onKeydown: (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeModal(backdrop);
                return;
            }
            if (event.key !== 'Tab') return;
            const items = focusables(dialog);
            if (items.length === 0) {
                event.preventDefault();
                return;
            }
            const first = items[0];
            const last = items[items.length - 1];
            if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        },
        onClick: (event) => {
            if (event.target === backdrop) closeModal(backdrop);
        }
    };

    backdrop.classList.remove('hidden');
    backdrop.addEventListener('keydown', entry.onKeydown);
    backdrop.addEventListener('click', entry.onClick);
    openModals.set(backdrop, entry);

    const target = initialFocus || focusables(dialog)[0] || dialog;
    if (target === dialog) dialog.setAttribute('tabindex', '-1');
    target.focus?.();
}

/**
 * Hide a modal backdrop and restore focus to the opener.
 * @param {HTMLElement} backdrop
 */
export function closeModal(backdrop) {
    const entry = openModals.get(backdrop);
    backdrop.classList.add('hidden');
    if (!entry) return;
    openModals.delete(backdrop);
    backdrop.removeEventListener('keydown', entry.onKeydown);
    backdrop.removeEventListener('click', entry.onClick);
    entry.restoreFocus?.focus?.();
    entry.onClose?.();
}

/** Whether a modal backdrop is currently open. */
export function isModalOpen(backdrop) {
    return openModals.has(backdrop);
}
