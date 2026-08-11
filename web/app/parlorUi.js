/**
 * Shared Parlor UI helpers: safe text, the form modal, persona glyphs.
 * (Kept separate so parlor.js and parlorWorkspace.js can both use them
 * without importing each other.)
 */

export function escapeText(text) {
    const span = document.createElement('span');
    span.textContent = String(text ?? '');
    return span.innerHTML;
}

export function el(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
}

export function timeLabel(iso) {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Default palette cycled for personas without an explicit color. */
export const PERSONA_PALETTE = [
    '#7c8cff', '#59d18c', '#ffb454', '#ff7ac8', '#54c2ff', '#b18aff', '#ffd166', '#8fe388'
];

export function personaColor(persona) {
    return persona?.color || PERSONA_PALETTE[(Number(persona?.id) || 0) % PERSONA_PALETTE.length];
}

export function personaGlyph(persona) {
    return persona?.emoji || (persona?.name ? [...persona.name][0].toUpperCase() : '?');
}

/**
 * Open the parlor form modal. build(body, close) fills the dialog and wires
 * its own buttons; close() hides the modal. Escape and backdrop clicks close.
 */
export function openModal(build) {
    const backdrop = document.getElementById('parlor-modal-backdrop');
    const dialog = document.getElementById('parlor-modal');
    dialog.replaceChildren();
    backdrop.classList.remove('hidden');

    const close = () => {
        backdrop.classList.add('hidden');
        dialog.replaceChildren();
        backdrop.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
    };
    const onBackdrop = (event) => {
        if (event.target === backdrop) close();
    };
    const onKey = (event) => {
        if (event.key === 'Escape') close();
    };
    backdrop.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);

    build(dialog, close);
    return close;
}
