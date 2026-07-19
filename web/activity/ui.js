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

/**
 * The amount input + quick-add chips shared by every game's betting UI.
 * Remembers the last bet per game in localStorage. `readAmount()` returns
 * the current whole-number amount (and persists it).
 */
export function betAmountControls(view, storageKey) {
    const controls = document.createElement('div');
    controls.className = 'bet-controls';

    const input = document.createElement('input');
    input.className = 'bet-input';
    input.type = 'number';
    input.min = view.minBet;
    input.max = view.maxBet;
    input.value = localStorage.getItem(storageKey) || view.minBet;
    controls.appendChild(input);

    for (const amount of [10, 50, 100, 500]) {
        const chip = document.createElement('button');
        chip.className = 'chip';
        chip.textContent = amount >= 1000 ? `${amount / 1000}k` : String(amount);
        chip.addEventListener('click', () => {
            input.value = String((Number(input.value) || 0) + amount);
            sounds.chip();
        });
        controls.appendChild(chip);
    }

    const readAmount = () => {
        const amount = Math.floor(Number(input.value));
        localStorage.setItem(storageKey, String(amount));
        return amount;
    };
    return { controls, input, readAmount };
}

/** The hint shown to spectators under every game. */
export function spectatorHint(bar) {
    bar.innerHTML = '<span class="hint">Pick a seat to join the game — spectating until then.</span>';
}
