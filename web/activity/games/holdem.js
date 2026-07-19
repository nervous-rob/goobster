/**
 * Texas Hold'em renderer: community cards + pot in the middle, seat pods
 * with hole cards (own face up, others face down until showdown), and a
 * fold/check/call/raise action bar. Includes the "Invite Goobster" control
 * that seats the house bot.
 */

import { $, cardEl, button, spectatorHint } from '../ui.js';

export function render(view, { send }) {
    renderBoard(view);
    renderStatusLine(view);
    renderSeats(view, send);
    renderActionBar(view, send);
}

function renderBoard(view) {
    const holder = $('holdem-community');
    holder.replaceChildren();
    for (const card of view.community) holder.appendChild(cardEl(card));
    for (let i = view.community.length; i < 5; i++) {
        const placeholder = document.createElement('div');
        placeholder.className = 'card placeholder';
        holder.appendChild(placeholder);
    }

    const pot = $('holdem-pot');
    pot.textContent = view.pot > 0 ? `Pot: 🪙 ${view.pot.toLocaleString()}` : '';

    const street = $('holdem-street');
    street.textContent = view.phase === 'acting' && view.street ? view.street.toUpperCase() : '';
}

function renderStatusLine(view) {
    const status = $('table-status');
    const seated = view.seats.filter(Boolean).length;
    if (view.phase === 'waiting') {
        status.textContent = seated === 0
            ? 'Take a seat to play!'
            : seated < 2
                ? 'Waiting for a second player (or invite Goobster)…'
                : 'Next hand is about to be dealt…';
    } else if (view.phase === 'acting') {
        const turnSeat = view.seats[view.activeSeat];
        status.textContent = view.activeSeat === view.yourSeat
            ? view.toCall > 0
                ? `👉 Your turn - ${view.toCall.toLocaleString()} to call`
                : '👉 Your turn!'
            : turnSeat ? `${turnSeat.name}'s turn…` : '';
    } else if (view.phase === 'settled' && view.results) {
        const r = view.results;
        const winners = r.entries.filter(e => e.outcome === 'win');
        const mine = r.entries.find(e => e.seat === view.yourSeat);
        if (mine?.outcome === 'win') {
            status.textContent = `🎉 You take the ${r.pot.toLocaleString()} pot` +
                (mine.handName ? ` with ${mine.handName}!` : '!');
        } else if (r.uncontested) {
            status.textContent = `${winners[0].name} takes the pot - everyone folded.`;
        } else {
            const w = winners.map(e => `${e.name} (${e.handName})`).join(', ');
            status.textContent = `💰 ${r.pot.toLocaleString()} pot goes to ${w}.`;
        }
    }
}

function renderSeats(view, send) {
    const holder = $('seats');
    holder.replaceChildren();

    // Showdown reveals: seat -> revealed hole cards
    const revealed = new Map();
    if (view.phase === 'settled' && view.results && !view.results.uncontested) {
        for (const entry of view.results.entries) {
            if (entry.holeCards) revealed.set(entry.seat, entry.holeCards);
        }
    }

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

        if (seat.isTurn) el.classList.add('turn');
        if (i === view.yourSeat) el.classList.add('you');
        if (seat.folded) el.classList.add('folded');

        const cards = document.createElement('div');
        cards.className = 'cards';
        const hole = seat.cards || revealed.get(i);
        if (hole) {
            for (const card of hole) cards.appendChild(cardEl(card));
        } else if (seat.cardCount > 0 && !seat.folded) {
            for (let c = 0; c < seat.cardCount; c++) cards.appendChild(cardEl(null, { back: true }));
        }
        el.appendChild(cards);

        const name = document.createElement('div');
        name.className = 'seat-name';
        name.textContent =
            (i === view.yourSeat ? '⭐ ' : '') +
            (seat.isBot ? '🤖 ' : '') +
            seat.name +
            (seat.isButton ? ' Ⓓ' : '');
        el.appendChild(name);

        const bet = document.createElement('div');
        bet.className = 'seat-bet';
        bet.textContent = seat.totalWagered > 0
            ? `🪙 ${seat.totalWagered.toLocaleString()}${seat.streetBet > 0 ? ` (${seat.streetBet.toLocaleString()} in)` : ''}`
            : '';
        el.appendChild(bet);

        const status = document.createElement('div');
        status.className = 'seat-status';
        if (seat.folded) {
            status.classList.add('lose');
            status.textContent = 'FOLDED';
        } else if (seat.outcome === 'win') {
            status.classList.add('win');
            status.textContent = `WIN +${(seat.payout - seat.totalWagered).toLocaleString()}`;
        } else if (seat.outcome === 'lose') {
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
    const botSeated = view.seats.some(s => s && s.isBot);

    if (!mySeat) {
        spectatorHint(bar);
        return;
    }

    if (view.phase === 'waiting') {
        const seated = view.seats.filter(Boolean).length;
        if (seated >= 2) {
            bar.appendChild(button('Deal now', 'btn primary', () => send({ type: 'action', action: 'deal' })));
        }
    }

    if (view.phase === 'acting' && view.activeSeat === view.yourSeat) {
        if (view.toCall > 0) {
            bar.appendChild(button('Fold', 'btn danger', () => send({ type: 'action', action: 'fold' })));
            bar.appendChild(button(`Call ${view.toCall.toLocaleString()}`, 'btn green', () => send({ type: 'action', action: 'call' })));
        } else {
            bar.appendChild(button('Check', 'btn green', () => send({ type: 'action', action: 'check' })));
        }

        const minRaiseTo = view.currentBet === 0 ? view.minBet : view.currentBet + view.minBet;
        if (minRaiseTo <= view.maxBet) {
            const raiseWrap = document.createElement('div');
            raiseWrap.className = 'bet-controls';
            const input = document.createElement('input');
            input.className = 'bet-input';
            input.type = 'number';
            input.min = minRaiseTo;
            input.max = view.maxBet;
            input.value = String(Math.min(view.maxBet, Math.max(minRaiseTo, view.currentBet * 2 || view.minBet * 3)));
            raiseWrap.appendChild(input);
            raiseWrap.appendChild(button(view.currentBet > 0 ? 'Raise to' : 'Bet', 'btn gold', () => {
                send({ type: 'action', action: 'bet', amount: Math.floor(Number(input.value)) });
            }));
            bar.appendChild(raiseWrap);
        }
    }

    bar.appendChild(button('Leave seat', 'btn', () => send({ type: 'leave-seat' })));

    // Last so it never occupies the spot a betting button just vacated
    // (an update can re-render the bar between aim and click)
    if (view.phase !== 'acting' || mySeat.folded) {
        bar.appendChild(button(
            botSeated ? 'Kick Goobster' : '🤖 Invite Goobster',
            'btn',
            () => send({ type: botSeated ? 'dismiss-bot' : 'invite-bot' })
        ));
    }
}
