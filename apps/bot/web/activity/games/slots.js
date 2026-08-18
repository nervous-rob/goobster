/**
 * Slots renderer: a bank of per-seat 3-reel machines with the shared
 * paytable up top. A fresh spin gets a short reel-cycling animation before
 * the result (and its win/lose sounds) lands.
 */

import { $, button, betAmountControls, spectatorHint, resetActionBar } from '../ui.js';
import { chipPileEl } from '../chips.js';
import { sounds } from '../sounds.js';

const SYMBOLS = {
    cherry: '🍒',
    lemon: '🍋',
    bell: '🔔',
    star: '⭐',
    diamond: '💎',
    seven: '7️⃣'
};
const SYMBOL_LIST = Object.values(SYMBOLS);

let spinTimer = null;
let animating = false;

export function render(view, { send }) {
    renderPaytable(view);
    renderStatusLine(view);
    renderSeats(view, send);
    renderActionBar(view, send);
}

/**
 * Reveal a fresh spin with suspense: every betting seat's reels cycle
 * random symbols for a moment, then land on the real result and `onDone`
 * plays the win/lose sounds and finalizes the render.
 */
export function animateSpin(view, ctx, onDone) {
    clearInterval(spinTimer);
    animating = true;
    // Render a masked copy so outcomes don't spoil before the reels stop
    const masked = structuredClone(view);
    masked.results = null;
    for (const s of masked.seats) {
        if (s) { s.outcome = null; s.payout = null; s.lineName = null; }
    }
    render(masked, ctx);
    $('table-status').textContent = '🎰 The reels are spinning…';

    let ticks = 0;
    sounds.spin();
    spinTimer = setInterval(() => {
        ticks++;
        if (ticks >= 14) {
            clearInterval(spinTimer);
            spinTimer = null;
            animating = false;
            onDone();
            return;
        }
        for (const reel of document.querySelectorAll('#seats .slot-reel:not(.idle)')) {
            reel.textContent = SYMBOL_LIST[Math.floor(Math.random() * SYMBOL_LIST.length)];
        }
    }, 90);
}

export function isAnimating() {
    return animating;
}

function renderPaytable(view) {
    const holder = $('slots-paytable');
    holder.replaceChildren();
    for (const line of (view.paytable || []).slice(0, 6)) {
        const el = document.createElement('span');
        el.className = 'payline';
        el.innerHTML = `${line.name} <b>${line.pays}x</b>`;
        holder.appendChild(el);
    }
}

function renderStatusLine(view) {
    const status = $('table-status');
    const seated = view.seats.filter(Boolean).length;
    if (view.phase === 'waiting') {
        status.textContent = seated === 0
            ? 'Pick a machine to play!'
            : 'Drop some coins in to spin.';
    } else if (view.phase === 'betting') {
        status.textContent = 'Coins are dropping - the reels spin soon…';
    } else if (view.phase === 'settled' && view.results) {
        const mine = view.results.entries.find(e => e.seat === view.yourSeat);
        if (!mine) {
            status.textContent = 'The reels stop.';
        } else if (mine.outcome === 'win') {
            status.textContent = `🎉 ${mine.line} - you win +${(mine.payout - mine.wagered).toLocaleString()}!`;
        } else if (mine.outcome === 'push') {
            status.textContent = `🤝 ${mine.line} - money back.`;
        } else {
            status.textContent = '💀 No luck - the machine keeps your coins.';
        }
    }
}

function renderSeats(view, send) {
    const holder = $('seats');
    holder.replaceChildren();

    view.seats.forEach((seat, i) => {
        const el = document.createElement('div');
        el.className = 'seat';
        if (!seat) {
            el.classList.add('empty');
            if (view.yourSeat === null) {
                el.appendChild(button('Sit here', 'sit-btn', () => send({ type: 'sit', seat: i })));
            } else {
                el.innerHTML = '<span class="hint">empty</span>';
            }
            holder.appendChild(el);
            return;
        }

        if (i === view.yourSeat) el.classList.add('you');

        const reels = document.createElement('div');
        reels.className = 'slot-reels';
        const spinning = view.phase === 'betting' && seat.bet > 0;
        for (let r = 0; r < 3; r++) {
            const reel = document.createElement('div');
            reel.className = 'slot-reel';
            if (seat.reels) {
                reel.textContent = SYMBOLS[seat.reels[r]] || '?';
            } else if (spinning) {
                reel.classList.add('spinning');
                reel.textContent = SYMBOL_LIST[Math.floor(Math.random() * SYMBOL_LIST.length)];
            } else {
                reel.classList.add('idle');
                reel.textContent = '·';
            }
            reels.appendChild(reel);
        }
        el.appendChild(reels);

        const line = document.createElement('div');
        line.className = 'slot-line';
        line.textContent = seat.lineName || '';
        el.appendChild(line);

        const name = document.createElement('div');
        name.className = 'seat-name';
        name.textContent = (i === view.yourSeat ? '⭐ ' : '') + (seat.isBot ? '🤖 ' : '') + seat.name;
        el.appendChild(name);

        const bet = document.createElement('div');
        bet.className = 'seat-bet';
        const pile = chipPileEl(seat.bet);
        if (pile) bet.appendChild(pile);
        el.appendChild(bet);

        const status = document.createElement('div');
        status.className = 'seat-status';
        if (seat.outcome === 'win') {
            status.classList.add('win');
            status.textContent = `WIN +${(seat.payout - seat.bet).toLocaleString()}`;
        } else if (seat.outcome === 'push') {
            status.classList.add('push');
            status.textContent = 'MONEY BACK';
        } else if (seat.outcome === 'lose') {
            status.classList.add('lose');
            status.textContent = 'MISS';
        } else if (view.phase === 'betting' && seat.bet === 0) {
            status.textContent = 'betting…';
        }
        el.appendChild(status);

        holder.appendChild(el);
    });
}

function renderActionBar(view, send) {
    const bar = resetActionBar();

    const mySeat = view.yourSeat !== null ? view.seats[view.yourSeat] : null;

    if (!mySeat) {
        spectatorHint(bar);
        return;
    }

    const canBet = (view.phase === 'waiting' || view.phase === 'betting') && mySeat.bet === 0;
    if (canBet) {
        const { controls, readAmount } = betAmountControls(view, 'last-slots-bet');
        controls.appendChild(button('Drop coins', 'btn gold', () => {
            send({ type: 'action', action: 'bet', amount: readAmount() });
        }));
        bar.appendChild(controls);
    }

    if (view.phase === 'betting' && mySeat.bet > 0) {
        bar.appendChild(button('Pull the lever', 'btn primary', () => send({ type: 'action', action: 'spin' })));
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = 'waiting for other players…';
        bar.appendChild(hint);
    }

    bar.appendChild(button('Leave seat', 'btn', () => send({ type: 'leave-seat' })));
}
