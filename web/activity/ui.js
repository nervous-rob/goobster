/**
 * Shared DOM helpers for the game renderers: element lookup, playing-card
 * elements, and the chip-input bet controls every game's action bar uses.
 */

import { sounds } from './sounds.js';

export const $ = (id) => document.getElementById(id);

const SUIT_GLYPHS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_NAMES = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

/** A rendered playing card (or a face-down back). */
export function cardEl(card, { back = false } = {}) {
    const el = document.importNode($('card-template').content, true).firstElementChild;
    if (back) {
        el.classList.add('back');
        return el;
    }
    el.querySelector('.card-rank').textContent = RANK_NAMES[card.rank] || String(card.rank);
    el.querySelector('.card-suit').textContent = SUIT_GLYPHS[card.suit] || card.suit;
    if (card.suit === 'H' || card.suit === 'D') el.classList.add('red');
    return el;
}

/** A plain button for the action bar. */
export function button(label, className, onClick) {
    const el = document.createElement('button');
    el.className = className;
    el.textContent = label;
    el.addEventListener('click', onClick);
    return el;
}

// ---------------------------------------------------------------------------
// Bet amount controls.
//
// Every broadcast triggers a full re-render that destroys and rebuilds the
// action bar, so the amount input must survive that: while the player is
// editing, the in-progress value (and focus) is kept in a module-level draft
// keyed by the input's storage key and restored into the rebuilt input.
// Without this, another player's bet would wipe whatever was being typed.
// ---------------------------------------------------------------------------

const CHIP_STEPS = [10, 50, 100, 500];

// storageKey -> string the player is currently typing (cleared on submit)
const betDrafts = new Map();
// Which bet input owned focus when the action bar was last torn down
let pendingFocusKey = null;

/**
 * Wipe the action bar for a re-render, remembering which bet input (if any)
 * held focus so `betAmountControls` can restore it. All game renderers must
 * clear the bar through this helper instead of `replaceChildren()`.
 */
export function resetActionBar() {
    const bar = $('action-bar');
    const active = document.activeElement;
    pendingFocusKey = active && bar.contains(active) && active.dataset.betKey
        ? active.dataset.betKey
        : null;
    bar.replaceChildren();
    return bar;
}

/**
 * The amount input + quick add/subtract chips shared by every game's betting
 * UI. Green chips on the right raise the amount, red chips on the left lower
 * it (never below the minimum). Remembers the last bet per game in
 * localStorage and keeps unsubmitted edits across re-renders. `readAmount()`
 * returns the current whole-number amount (and persists it).
 */
export function betAmountControls(view, storageKey, { min = view.minBet, max = view.maxBet, defaultValue = null } = {}) {
    const controls = document.createElement('div');
    controls.className = 'bet-controls';

    const input = document.createElement('input');
    input.className = 'bet-input';
    input.type = 'number';
    input.min = min;
    input.max = max;
    input.dataset.betKey = storageKey;
    input.value = betDrafts.has(storageKey)
        ? betDrafts.get(storageKey)
        : (defaultValue ?? localStorage.getItem(storageKey) ?? min);
    input.addEventListener('input', () => {
        betDrafts.set(storageKey, input.value);
    });

    const chipButton = (amount) => {
        const chip = document.createElement('button');
        chip.className = amount < 0 ? 'chip minus' : 'chip';
        const magnitude = Math.abs(amount);
        chip.textContent = (amount < 0 ? '\u2212' : '+') + (magnitude >= 1000 ? `${magnitude / 1000}k` : String(magnitude));
        chip.title = `${amount < 0 ? 'Remove' : 'Add'} ${magnitude}`;
        chip.addEventListener('click', () => {
            const next = Math.max(Number(min) || 0, (Number(input.value) || 0) + amount);
            input.value = String(next);
            betDrafts.set(storageKey, input.value);
            sounds.chip();
        });
        return chip;
    };

    // Red subtract chips to the left (largest outermost), the input in the
    // middle, green add chips to the right (smallest innermost).
    for (const amount of [...CHIP_STEPS].reverse()) controls.appendChild(chipButton(-amount));
    controls.appendChild(input);
    for (const amount of CHIP_STEPS) controls.appendChild(chipButton(amount));

    if (pendingFocusKey === storageKey) {
        pendingFocusKey = null;
        // The input joins the document after this returns; focus then.
        requestAnimationFrame(() => input.focus());
    }

    const readAmount = () => {
        const amount = Math.floor(Number(input.value));
        betDrafts.delete(storageKey);
        localStorage.setItem(storageKey, String(amount));
        return amount;
    };
    return { controls, input, readAmount };
}

/** The hint shown to spectators under every game. */
export function spectatorHint(bar) {
    bar.innerHTML = '<span class="hint">Pick a seat to join the game — spectating until then.</span>';
}

/**
 * The Invite/Kick Goobster control, appended after each render for every
 * game (the bot can play them all). Last in the bar so it never occupies a
 * spot a betting button just vacated between aim and click.
 */
export function appendBotControls(view, send) {
    const mySeat = view.yourSeat !== null && view.seats ? view.seats[view.yourSeat] : null;
    if (!mySeat) return;
    const botSeated = view.seats.some(s => s && s.isBot);
    $('action-bar').appendChild(button(
        botSeated ? 'Kick Goobster' : '🤖 Invite Goobster',
        'btn',
        () => send({ type: botSeated ? 'dismiss-bot' : 'invite-bot' })
    ));
}
