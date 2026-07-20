/**
 * Baccarat renderer: the two communal hands (player / banker), seat rows
 * showing who backed what, and the bet-target action bar.
 */

import { $, cardEl, button, betAmountControls, spectatorHint, resetActionBar } from '../ui.js';
import { chipPileEl } from '../chips.js';

const TARGET_LABELS = { player: 'Player', banker: 'Banker', tie: 'Tie' };

export function render(view, { send }) {
    renderHand(view.playerHand, 'baccarat-player-cards', 'baccarat-player-total', view, 'player');
    renderHand(view.bankerHand, 'baccarat-banker-cards', 'baccarat-banker-total', view, 'banker');
    renderStatusLine(view);
    renderSeats(view, send);
    renderActionBar(view, send);
}

function renderHand(hand, cardsId, totalId, view, side) {
    const holder = $(cardsId);
    holder.replaceChildren();
    for (const card of hand.cards) holder.appendChild(cardEl(card));

    const total = $(totalId);
    if (hand.total === null) {
        total.textContent = '';
    } else if (view.phase === 'settled' && view.results?.winner === side) {
        total.innerHTML = `<span class="bj">${hand.total} · WINS</span>`;
    } else {
        total.textContent = String(hand.total);
    }
}

function renderStatusLine(view) {
    const status = $('table-status');
    const seated = view.seats.filter(Boolean).length;
    if (view.phase === 'waiting') {
        status.textContent = seated === 0
            ? 'Take a seat to play!'
            : 'Back the player, the banker, or a tie.';
    } else if (view.phase === 'betting') {
        status.textContent = 'Bets are open…';
    } else if (view.phase === 'settled' && view.results) {
        const r = view.results;
        const headline = r.winner === 'tie'
            ? `🤝 Tie at ${r.playerTotal}!`
            : `${TARGET_LABELS[r.winner]} wins ${r.winner === 'player' ? r.playerTotal : r.bankerTotal} to ${r.winner === 'player' ? r.bankerTotal : r.playerTotal}${r.natural ? ' - natural' : ''}.`;
        const mine = r.entries.find(e => e.seat === view.yourSeat);
        status.textContent = mine
            ? mine.outcome === 'win'
                ? `🎉 ${headline} You win +${(mine.payout - mine.wagered).toLocaleString()}!`
                : mine.outcome === 'push'
                    ? `🤝 ${headline} Your bet is returned.`
                    : `💀 ${headline}`
            : headline;
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

        const bet = document.createElement('div');
        bet.className = 'seat-bet';
        if (seat.bet > 0) {
            bet.appendChild(document.createTextNode(`${TARGET_LABELS[seat.target]} `));
            bet.appendChild(chipPileEl(seat.bet));
        } else if (view.phase === 'betting') {
            bet.textContent = 'betting…';
        }
        el.appendChild(bet);

        const status = document.createElement('div');
        status.className = 'seat-status';
        if (seat.outcome) {
            status.classList.add(seat.outcome);
            status.textContent = seat.outcome === 'win'
                ? `WIN +${(seat.payout - seat.bet).toLocaleString()}`
                : seat.outcome === 'push' ? 'PUSH' : 'LOSE';
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
        const { controls, readAmount } = betAmountControls(view, 'last-baccarat-bet');
        const place = target => send({ type: 'action', action: 'bet', amount: readAmount(), target });
        controls.appendChild(button('Player 1:1', 'btn primary', () => place('player')));
        controls.appendChild(button('Banker 19:20', 'btn danger', () => place('banker')));
        controls.appendChild(button('Tie 8:1', 'btn gold', () => place('tie')));
        bar.appendChild(controls);
    }

    if (view.phase === 'betting' && mySeat.bet > 0) {
        bar.appendChild(button('Deal now', 'btn primary', () => send({ type: 'action', action: 'deal' })));
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = 'waiting for other bets…';
        bar.appendChild(hint);
    }

    bar.appendChild(button('Leave seat', 'btn', () => send({ type: 'leave-seat' })));
}
