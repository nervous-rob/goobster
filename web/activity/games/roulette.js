/**
 * Roulette renderer: winning-number display + history, a clickable
 * European betting board, and the spin/clear action bar. The wheel result
 * is revealed with a short number-cycling animation after each spin.
 */

import { $, button, betAmountControls, spectatorHint } from '../ui.js';
import { sounds } from '../sounds.js';

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

const colorOf = n => (n === 0 ? 'green' : RED_NUMBERS.has(n) ? 'red' : 'black');

// The action bar owns the amount input; board clicks read it through here.
let readAmount = () => 10;
let spinTimer = null;
let animating = false;

export function render(view, { send }) {
    renderResult(view);
    renderHistory(view);
    renderBoard(view, send);
    renderStatusLine(view);
    renderSeats(view, send);
    renderActionBar(view, send);
}

/**
 * Reveal a fresh spin with suspense: cycle random numbers in the result
 * slot for a moment, then land on the real one and call `onDone` (which
 * plays the win/lose sounds and finalizes the render).
 */
export function animateSpin(view, ctx, onDone) {
    clearInterval(spinTimer);
    animating = true;
    // Render a masked copy so the status line and seat outcomes don't spoil
    // the number before the wheel "stops"
    const masked = structuredClone(view);
    masked.results = null;
    for (const s of masked.seats) {
        if (s) { s.outcome = null; s.payout = null; }
    }
    render(masked, ctx);
    $('table-status').textContent = '🎡 No more bets - the wheel spins…';
    const el = $('roulette-result');

    let ticks = 0;
    sounds.spin();
    spinTimer = setInterval(() => {
        ticks++;
        if (ticks >= 16) {
            clearInterval(spinTimer);
            spinTimer = null;
            animating = false;
            renderResult(view);
            onDone();
            return;
        }
        const n = Math.floor(Math.random() * 37);
        el.innerHTML = `<span class="roulette-number spinning ${colorOf(n)}">${n}</span>`;
    }, 100);
}

function renderResult(view) {
    if (animating) return; // the animation owns the slot right now
    const el = $('roulette-result');
    if (!view.result) {
        el.innerHTML = '<span class="roulette-number none">–</span>';
        return;
    }
    el.innerHTML = `<span class="roulette-number ${view.result.color}">${view.result.number}</span>`;
}

function renderHistory(view) {
    const el = $('roulette-history');
    el.replaceChildren();
    for (const entry of view.history.slice(1)) {
        const dot = document.createElement('span');
        dot.className = `history-dot ${entry.color}`;
        dot.textContent = String(entry.number);
        el.appendChild(dot);
    }
}

function renderBoard(view, send) {
    const board = $('roulette-board');
    board.replaceChildren();

    const mySeat = view.yourSeat !== null ? view.seats[view.yourSeat] : null;
    const canBet = mySeat && (view.phase === 'waiting' || view.phase === 'betting');

    // My chips on the felt, aggregated per cell
    const stakes = new Map();
    for (const bet of mySeat?.bets || []) {
        const key = `${bet.kind}:${bet.target ?? ''}`;
        stakes.set(key, (stakes.get(key) || 0) + bet.amount);
    }

    const cell = (label, kind, target, className) => {
        const el = document.createElement('button');
        el.className = `board-cell ${className || ''}`;
        el.textContent = label;
        const stake = stakes.get(`${kind}:${target ?? ''}`);
        if (stake) {
            const marker = document.createElement('span');
            marker.className = 'stake';
            marker.textContent = stake >= 1000 ? `${(stake / 1000).toFixed(stake % 1000 ? 1 : 0)}k` : String(stake);
            el.appendChild(marker);
        }
        el.disabled = !canBet;
        el.addEventListener('click', () => {
            send({ type: 'action', action: 'bet', amount: readAmount(), kind, target });
        });
        return el;
    };

    // Zero + the 3x12 number grid (top row 3..36, bottom row 1..34) with
    // the 2:1 column bets on the right
    const grid = document.createElement('div');
    grid.className = 'board-grid';
    grid.appendChild(cell('0', 'straight', 0, 'num green zero'));
    for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 12; col++) {
            const n = col * 3 + (3 - row);
            grid.appendChild(cell(String(n), 'straight', n, `num ${colorOf(n)}`));
        }
        grid.appendChild(cell('2:1', 'column', 3 - row, 'outside'));
    }
    board.appendChild(grid);

    const dozens = document.createElement('div');
    dozens.className = 'board-row';
    dozens.appendChild(cell('1st 12', 'dozen', 1, 'outside'));
    dozens.appendChild(cell('2nd 12', 'dozen', 2, 'outside'));
    dozens.appendChild(cell('3rd 12', 'dozen', 3, 'outside'));
    board.appendChild(dozens);

    const evens = document.createElement('div');
    evens.className = 'board-row';
    evens.appendChild(cell('1-18', 'low', null, 'outside'));
    evens.appendChild(cell('EVEN', 'even', null, 'outside'));
    evens.appendChild(cell('RED', 'red', null, 'outside red-cell'));
    evens.appendChild(cell('BLACK', 'black', null, 'outside black-cell'));
    evens.appendChild(cell('ODD', 'odd', null, 'outside'));
    evens.appendChild(cell('19-36', 'high', null, 'outside'));
    board.appendChild(evens);
}

function renderStatusLine(view) {
    const status = $('table-status');
    const seated = view.seats.filter(Boolean).length;
    if (view.phase === 'waiting') {
        status.textContent = seated === 0
            ? 'Take a seat to play!'
            : 'Click the board to place your chips.';
    } else if (view.phase === 'betting') {
        status.textContent = 'Bets are open - the wheel spins soon…';
    } else if (view.phase === 'settled' && view.results) {
        const mine = view.results.entries.find(e => e.seat === view.yourSeat);
        const landed = `${view.results.number} ${view.results.color}`;
        if (!mine) {
            status.textContent = `The ball lands on ${landed}.`;
        } else if (mine.outcome !== 'win') {
            status.textContent = `💀 ${landed} - the house takes it.`;
        } else {
            // A "win" only means some bet hit; the round can still be net
            // negative when other chips lost more
            const net = mine.payout - mine.wagered;
            status.textContent = net > 0
                ? `🎉 ${landed} - you win +${net.toLocaleString()}!`
                : net === 0
                    ? `🤝 ${landed} - you break even.`
                    : `😬 ${landed} - a hit, but you're down ${(-net).toLocaleString()}.`;
        }
    }
}

function renderSeats(view, send) {
    const holder = $('seats');
    holder.replaceChildren();

    view.seats.forEach((seat, i) => {
        const el = document.createElement('div');
        el.className = 'seat slim';
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

        const name = document.createElement('div');
        name.className = 'seat-name';
        name.textContent = (i === view.yourSeat ? '⭐ ' : '') + seat.name;
        el.appendChild(name);

        const bets = document.createElement('div');
        bets.className = 'seat-bets';
        bets.textContent = seat.bets.length > 0
            ? seat.bets.map(b => b.label).slice(0, 4).join(', ') + (seat.bets.length > 4 ? '…' : '')
            : '';
        el.appendChild(bets);

        const bet = document.createElement('div');
        bet.className = 'seat-bet';
        bet.textContent = seat.totalWagered > 0 ? `🪙 ${seat.totalWagered.toLocaleString()}` : '';
        el.appendChild(bet);

        const status = document.createElement('div');
        status.className = 'seat-status';
        if (seat.outcome === 'win') {
            const net = seat.payout - seat.totalWagered;
            status.classList.add(net > 0 ? 'win' : 'push');
            status.textContent = net > 0
                ? `WIN +${net.toLocaleString()}`
                : net === 0 ? 'EVEN' : `HIT ${net.toLocaleString()}`;
        } else if (seat.outcome) {
            status.classList.add('lose');
            status.textContent = 'LOSE';
        }
        el.appendChild(status);

        holder.appendChild(el);
    });
}

function renderActionBar(view, send) {
    const bar = $('action-bar');
    bar.replaceChildren();

    const mySeat = view.yourSeat !== null ? view.seats[view.yourSeat] : null;

    if (!mySeat) {
        spectatorHint(bar);
        return;
    }

    if (view.phase === 'waiting' || view.phase === 'betting') {
        const { controls, readAmount: reader } = betAmountControls(view, 'last-roulette-bet');
        readAmount = reader;
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = '← chip size, then click the board';
        controls.appendChild(hint);
        bar.appendChild(controls);
    }

    if (view.phase === 'betting' && mySeat.totalWagered > 0) {
        bar.appendChild(button('Spin now', 'btn primary', () => send({ type: 'action', action: 'spin' })));
        bar.appendChild(button('Clear bets', 'btn danger', () => send({ type: 'action', action: 'clear-bets' })));
    }

    bar.appendChild(button('Leave seat', 'btn', () => send({ type: 'leave-seat' })));
}
