/**
 * Chip visuals: bet amounts rendered as stacked chip piles, and flying-chip
 * animations that carry wagers to the table and payouts back to the seats
 * at the end of every round.
 *
 * Piles are pure DOM (no assets): each denomination is a colored disc,
 * stacked with a small vertical offset. Flights live in a fixed overlay so
 * they survive the full re-render every broadcast triggers.
 */

import { sounds } from './sounds.js';

// Denomination -> chip color class, largest first (greedy decomposition)
const DENOMS = [
    [1000, 'gold'],
    [500, 'purple'],
    [100, 'black'],
    [50, 'red'],
    [10, 'blue'],
    [1, 'white']
];

const MAX_CHIPS_PER_STACK = 5;

function denomsFor(amount) {
    const stacks = [];
    let remaining = Math.max(0, Math.floor(amount));
    for (const [denom, color] of DENOMS) {
        if (remaining < denom) continue;
        const count = Math.min(MAX_CHIPS_PER_STACK, Math.floor(remaining / denom));
        remaining -= count * denom;
        stacks.push({ denom, color, count });
    }
    return stacks;
}

/**
 * A chip pile representing `amount`, with the total printed underneath.
 * Returns null for non-positive amounts so callers can skip empty piles.
 */
export function chipPileEl(amount, { label = true } = {}) {
    if (!amount || amount <= 0) return null;
    const pile = document.createElement('div');
    pile.className = 'chip-pile';

    const stacksEl = document.createElement('div');
    stacksEl.className = 'chip-stacks';
    for (const { color, count } of denomsFor(amount)) {
        const stack = document.createElement('div');
        stack.className = 'chip-stack';
        for (let i = 0; i < count; i++) {
            const chip = document.createElement('span');
            chip.className = `pile-chip ${color}`;
            stack.appendChild(chip);
        }
        stacksEl.appendChild(stack);
    }
    pile.appendChild(stacksEl);

    if (label) {
        const text = document.createElement('span');
        text.className = 'chip-pile-label';
        text.textContent = amount.toLocaleString();
        pile.appendChild(text);
    }
    return pile;
}

function flyLayer() {
    let layer = document.getElementById('fly-layer');
    if (!layer) {
        layer = document.createElement('div');
        layer.id = 'fly-layer';
        document.body.appendChild(layer);
    }
    return layer;
}

function centerOf(el) {
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** How many chips to send flying for a given amount (log-ish, bounded). */
function flightSize(amount) {
    if (amount >= 2000) return 8;
    if (amount >= 500) return 6;
    if (amount >= 100) return 5;
    if (amount >= 50) return 4;
    return 3;
}

/**
 * Animate chips flying from one element to another (payouts to a seat,
 * lost bets to the dealer, fresh wagers onto the felt). Both elements must
 * be in the document; the flight itself lives in a fixed overlay so it is
 * unaffected by re-renders.
 */
export function flyChips(fromEl, toEl, amount, { color = null, silent = false } = {}) {
    if (!fromEl || !toEl || !amount || amount <= 0) return;
    const layer = flyLayer();
    const from = centerOf(fromEl);
    const to = centerOf(toEl);
    const count = flightSize(amount);
    const colors = color ? [color] : denomsFor(amount).map(s => s.color);

    if (!silent) sounds.chip();
    for (let i = 0; i < count; i++) {
        const chip = document.createElement('span');
        chip.className = `pile-chip fly ${colors[i % colors.length] || 'gold'}`;
        const jx = (Math.random() - 0.5) * 26;
        const jy = (Math.random() - 0.5) * 18;
        chip.style.left = `${from.x + jx}px`;
        chip.style.top = `${from.y + jy}px`;
        layer.appendChild(chip);

        setTimeout(() => {
            chip.style.transform =
                `translate(${to.x - from.x - jx}px, ${to.y - from.y - jy}px) rotate(${Math.random() * 300 - 150}deg)`;
            chip.style.opacity = '0.25';
        }, 30 + i * 70);
        setTimeout(() => chip.remove(), 900 + i * 70);
    }
}

/**
 * The current game's chip anchor - where wagers land, lost bets fly to,
 * and payouts fly from. A game can mark its own anchor (e.g. the hold'em
 * pot) with `data-chip-bank`; otherwise the visible dealer avatar is used,
 * then the game area itself.
 */
export function chipBankEl() {
    return document.querySelector('.game-area:not([hidden]) [data-chip-bank]')
        || document.querySelector('.game-area:not([hidden]) .dealer-avatar')
        || document.querySelector('.game-area:not([hidden])')
        || document.getElementById('table-status');
}

/**
 * Play the chip movements for a broadcast's events: fresh wagers fly to
 * the seat (hold'em raises/calls fly on to the pot), and at settlement
 * payouts fly from the bank to the winners while lost bets are raked in.
 * Seat pods are looked up by index in the freshly rendered #seats.
 */
export function animateChipEvents(events, { skipSettles = false } = {}) {
    const seats = document.getElementById('seats');
    const bank = chipBankEl();
    if (!seats || !bank) return;
    const seatEl = (i) => (Number.isInteger(i) ? seats.children[i] : null) || null;

    let delay = 0;
    for (const event of events || []) {
        const el = seatEl(event.seat);
        if (!el) continue;
        if (event.type === 'bet' && event.amount > 0) {
            const bar = document.getElementById('action-bar');
            flyChips(bar || bank, el, event.amount, { silent: true });
        } else if ((event.type === 'raise' || event.type === 'call') && event.amount > 0) {
            flyChips(el, bank, event.amount, { silent: true });
        } else if (skipSettles) {
            continue;
        } else if ((event.type === 'win' || event.type === 'blackjack') && event.payout > 0) {
            setTimeout(() => flyChips(bank, el, event.payout), delay);
            delay += 180;
        } else if (event.type === 'lose') {
            setTimeout(() => flyChips(el, bank, event.wagered || 60, { silent: true }), delay);
            delay += 180;
        }
    }
}
