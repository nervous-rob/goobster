/**
 * Craps renderer: big dice + the point puck up top, roll history, and a
 * pass / don't pass / field betting bar. Each throw gets a short
 * dice-tumbling animation before the result lands.
 */

import { $, button, betAmountControls, spectatorHint, resetActionBar } from '../ui.js';
import { chipPileEl } from '../chips.js';
import { sounds } from '../sounds.js';

const DIE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

let rollTimer = null;
let animating = false;

export function render(view, { send }) {
    renderDice(view);
    renderStatusLine(view);
    renderSeats(view, send);
    renderActionBar(view, send);
}

/**
 * Reveal a fresh throw with suspense: the dice tumble for a moment, then
 * land on the real roll and `onDone` plays the outcome sounds and
 * finalizes the render.
 */
export function animateRoll(view, ctx, onDone) {
    clearInterval(rollTimer);
    animating = true;
    // Render a masked copy so the point/outcomes don't spoil early
    const masked = structuredClone(view);
    masked.results = null;
    for (const s of masked.seats) {
        if (s) { s.outcome = null; s.payout = null; }
    }
    render(masked, ctx);
    $('table-status').textContent = '🎲 The dice are rolling…';
    const holder = $('craps-dice');

    let ticks = 0;
    sounds.dice();
    rollTimer = setInterval(() => {
        ticks++;
        if (ticks >= 10) {
            clearInterval(rollTimer);
            rollTimer = null;
            animating = false;
            onDone();
            return;
        }
        holder.textContent =
            DIE_FACES[Math.floor(Math.random() * 6)] + DIE_FACES[Math.floor(Math.random() * 6)];
    }, 90);
}

function renderDice(view) {
    if (!animating) {
        const holder = $('craps-dice');
        holder.textContent = view.dice
            ? DIE_FACES[view.dice[0] - 1] + DIE_FACES[view.dice[1] - 1]
            : '⚀⚀';
        holder.classList.toggle('idle', !view.dice);
    }

    const puck = $('craps-point');
    if (view.point) {
        puck.textContent = `POINT ${view.point}`;
        puck.classList.add('on');
    } else {
        puck.textContent = 'COME OUT';
        puck.classList.remove('on');
    }

    const history = $('craps-history');
    history.replaceChildren();
    for (const total of view.history.slice(1)) {
        const dot = document.createElement('span');
        dot.className = 'history-dot ' + (total === 7 ? 'red' : 'black');
        dot.textContent = String(total);
        history.appendChild(dot);
    }
}

function renderStatusLine(view) {
    const status = $('table-status');
    const seated = view.seats.filter(Boolean).length;
    if (view.phase === 'waiting') {
        status.textContent = seated === 0
            ? 'Step up to the rail to play!'
            : 'Put your chips on the line - pass, don\'t pass, or the field.';
    } else if (view.phase === 'betting') {
        status.textContent = view.point
            ? `Point is ${view.point} - roll a ${view.point} before a 7! (field bets welcome)`
            : 'Come-out roll is coming up…';
    } else if (view.phase === 'settled' && view.results) {
        const mine = view.results.entries.find(e => e.seat === view.yourSeat);
        const total = view.dice ? view.dice[0] + view.dice[1] : 0;
        if (!mine) {
            status.textContent = `The round ends on ${total}.`;
        } else {
            const net = mine.payout - mine.wagered;
            status.textContent = mine.outcome === 'win'
                ? `🎉 You come out ahead +${net.toLocaleString()}!`
                : mine.outcome === 'push'
                    ? '🤝 A wash - bets returned.'
                    : `💀 The dice take ${(-net).toLocaleString()}.`;
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
        name.textContent = (i === view.yourSeat ? '⭐ ' : '') + (seat.isBot ? '🤖 ' : '') + seat.name;
        el.appendChild(name);

        const bets = document.createElement('div');
        bets.className = 'seat-bets';
        bets.textContent = seat.bets.length > 0
            ? seat.bets.map(b => b.label).join(', ')
            : '';
        el.appendChild(bets);

        const bet = document.createElement('div');
        bet.className = 'seat-bet';
        const pile = chipPileEl(seat.totalWagered);
        if (pile) bet.appendChild(pile);
        el.appendChild(bet);

        const status = document.createElement('div');
        status.className = 'seat-status';
        if (seat.outcome === 'win') {
            status.classList.add('win');
            status.textContent = `WIN +${(seat.payout - seat.resolved.reduce((s, r) => s + r.wagered, 0)).toLocaleString()}`;
        } else if (seat.outcome === 'push') {
            status.classList.add('push');
            status.textContent = 'PUSH';
        } else if (seat.outcome === 'lose') {
            status.classList.add('lose');
            status.textContent = 'LOSE';
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

    if (view.phase === 'waiting' || view.phase === 'betting') {
        const { controls, readAmount } = betAmountControls(view, 'last-craps-bet');
        const place = kind => send({ type: 'action', action: 'bet', amount: readAmount(), kind });
        const has = kind => mySeat.bets.some(b => b.kind === kind);

        if (!view.point) {
            if (!has('pass')) controls.appendChild(button('Pass line', 'btn green', () => place('pass')));
            if (!has('dont')) controls.appendChild(button("Don't pass", 'btn danger', () => place('dont')));
        }
        if (!has('field')) controls.appendChild(button('Field', 'btn gold', () => place('field')));
        bar.appendChild(controls);
    }

    if (view.phase === 'betting' && mySeat.bets.length > 0) {
        bar.appendChild(button('🎲 Roll the dice', 'btn primary', () => send({ type: 'action', action: 'roll' })));
    }

    bar.appendChild(button('Leave table', 'btn', () => send({ type: 'leave-seat' })));
}
