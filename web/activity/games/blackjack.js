/**
 * Blackjack renderer: dealer hand up top, per-seat hands, and the
 * hit/stand/double action bar.
 */

import { $, cardEl, button, betAmountControls, spectatorHint } from '../ui.js';

export function render(view, { send }) {
    renderDealer(view);
    renderStatusLine(view);
    renderSeats(view, send);
    renderActionBar(view, send);
}

function renderDealer(view) {
    const holder = $('dealer-cards');
    holder.replaceChildren();
    for (const card of view.dealer.cards) holder.appendChild(cardEl(card));
    if (view.dealer.hiddenCard) holder.appendChild(cardEl(null, { back: true }));

    const total = $('dealer-total');
    if (view.dealer.cards.length === 0) {
        total.textContent = '';
    } else if (view.dealer.hiddenCard) {
        total.textContent = `showing ${view.dealer.total}`;
    } else if (view.dealer.total > 21) {
        total.innerHTML = `<span class="bust">BUST (${view.dealer.total})</span>`;
    } else {
        total.textContent = String(view.dealer.total);
    }
}

function renderStatusLine(view) {
    const status = $('table-status');
    const seated = view.seats.filter(Boolean).length;
    if (view.phase === 'waiting') {
        status.textContent = seated === 0
            ? 'Take a seat to play!'
            : 'Place a bet to start the hand.';
    } else if (view.phase === 'betting') {
        status.textContent = 'Bets are open…';
    } else if (view.phase === 'acting') {
        const turnSeat = view.seats[view.activeSeat];
        status.textContent = view.activeSeat === view.yourSeat
            ? '👉 Your turn!'
            : turnSeat ? `${turnSeat.name}'s turn…` : 'Dealer plays…';
    } else if (view.phase === 'settled' && view.results) {
        const mine = view.results.entries.find(e => e.seat === view.yourSeat);
        status.textContent = mine
            ? { blackjack: `♠️ BLACKJACK! +${(mine.payout - mine.wagered).toLocaleString()}`,
                win: `🎉 You win +${(mine.payout - mine.wagered).toLocaleString()}!`,
                push: '🤝 Push - bet returned.',
                lose: '💀 Dealer takes it.',
                bust: '💥 Busted!' }[mine.outcome]
            : `Hand over - dealer ${view.results.dealerBust ? 'busted' : `had ${view.results.dealerTotal}`}.`;
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
            const canSit = view.yourSeat === null;
            if (canSit) {
                el.appendChild(button('Sit here', 'sit-btn', () => send({ type: 'sit', seat: i })));
            } else {
                el.innerHTML = '<span class="hint">empty</span>';
            }
            holder.appendChild(el);
            return;
        }

        if (seat.isTurn) el.classList.add('turn');
        if (i === view.yourSeat) el.classList.add('you');

        const cards = document.createElement('div');
        cards.className = 'cards';
        for (const card of seat.cards) cards.appendChild(cardEl(card));
        el.appendChild(cards);

        const name = document.createElement('div');
        name.className = 'seat-name';
        name.textContent = (i === view.yourSeat ? '⭐ ' : '') + seat.name;
        el.appendChild(name);

        const bet = document.createElement('div');
        bet.className = 'seat-bet';
        bet.textContent = seat.totalWagered > 0
            ? `🪙 ${seat.totalWagered.toLocaleString()}${seat.doubled ? ' (2x)' : ''}`
            : '';
        el.appendChild(bet);

        const status = document.createElement('div');
        status.className = 'seat-status';
        if (seat.outcome) {
            status.classList.add(seat.outcome);
            status.textContent = {
                blackjack: 'BLACKJACK!', win: 'WIN', push: 'PUSH', lose: 'LOSE', bust: 'BUST'
            }[seat.outcome];
        } else if (seat.busted) {
            status.classList.add('bust');
            status.textContent = 'BUST';
        } else if (seat.cards.length > 0) {
            status.textContent = seat.total + (seat.soft ? ' (soft)' : '');
        } else if (view.phase === 'betting' && seat.bet === 0) {
            status.textContent = 'betting…';
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

    const canBet = (view.phase === 'waiting' || view.phase === 'betting') && mySeat.bet === 0;
    if (canBet) {
        const { controls, readAmount } = betAmountControls(view, 'last-bet');
        controls.appendChild(button('Place bet', 'btn gold', () => {
            send({ type: 'action', action: 'bet', amount: readAmount() });
        }));
        bar.appendChild(controls);
    }

    if (view.phase === 'betting' && mySeat.bet > 0) {
        bar.appendChild(button('Deal now', 'btn primary', () => send({ type: 'action', action: 'deal' })));
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = 'waiting for other bets…';
        bar.appendChild(hint);
    }

    if (view.phase === 'acting' && mySeat.isTurn) {
        bar.appendChild(button('Hit', 'btn green', () => send({ type: 'action', action: 'hit' })));
        bar.appendChild(button('Stand', 'btn danger', () => send({ type: 'action', action: 'stand' })));
        if (mySeat.cards.length === 2 && !mySeat.doubled) {
            bar.appendChild(button('Double', 'btn gold', () => send({ type: 'action', action: 'double' })));
        }
    }

    bar.appendChild(button('Leave seat', 'btn', () => send({ type: 'leave-seat' })));
}
