/**
 * Let It Ride renderer: the two community cards up top (face down until
 * their reveals), three-card hands per seat (own face up, others hidden
 * until showdown), and a bet / let-it-ride-or-pull-back action bar.
 */

import { $, cardEl, button, betAmountControls, spectatorHint, resetActionBar } from '../ui.js';
import { chipPileEl } from '../chips.js';

export function render(view, { send }) {
    renderCommunity(view);
    renderStatusLine(view);
    renderSeats(view, send);
    renderActionBar(view, send);
}

function renderCommunity(view) {
    const holder = $('letride-community');
    holder.replaceChildren();
    for (const card of view.community) holder.appendChild(cardEl(card));
    for (let i = view.community.length; i < view.communityCount; i++) {
        holder.appendChild(cardEl(null, { back: true }));
    }
    if (view.communityCount === 0) {
        for (let i = 0; i < 2; i++) {
            const placeholder = document.createElement('div');
            placeholder.className = 'card placeholder';
            holder.appendChild(placeholder);
        }
    }

    const note = $('letride-note');
    note.textContent = view.phase === 'ride1'
        ? 'decision 1 of 2: let your first bet ride?'
        : view.phase === 'ride2'
            ? 'decision 2 of 2: let your second bet ride?'
            : '';
}

function renderStatusLine(view) {
    const status = $('table-status');
    const seated = view.seats.filter(Boolean).length;
    if (view.phase === 'waiting') {
        status.textContent = seated === 0
            ? 'Take a seat to play!'
            : 'Ante up - your bet goes down three times.';
    } else if (view.phase === 'betting') {
        status.textContent = 'Bets are open…';
    } else if (view.phase === 'ride1' || view.phase === 'ride2') {
        const mine = view.yourSeat !== null ? view.seats[view.yourSeat] : null;
        status.textContent = mine && mine.bet > 0 && !mine.decided
            ? '👉 Let it ride, or pull one bet back?'
            : 'Waiting on the other decisions…';
    } else if (view.phase === 'settled' && view.results) {
        const mine = view.results.entries.find(e => e.seat === view.yourSeat);
        status.textContent = mine
            ? mine.outcome === 'win'
                ? `🎉 ${mine.handName} - you win +${(mine.payout - mine.wagered).toLocaleString()}!`
                : `💀 ${mine.handName} - not enough (tens or better to pay).`
            : 'Hand over.';
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
        if ((view.phase === 'ride1' || view.phase === 'ride2') && seat.bet > 0 && !seat.decided) {
            el.classList.add('turn');
        }

        const cards = document.createElement('div');
        cards.className = 'cards';
        if (seat.cards) {
            for (const card of seat.cards) cards.appendChild(cardEl(card));
        } else if (seat.cardCount > 0) {
            for (let c = 0; c < seat.cardCount; c++) cards.appendChild(cardEl(null, { back: true }));
        }
        el.appendChild(cards);

        const name = document.createElement('div');
        name.className = 'seat-name';
        name.textContent = (i === view.yourSeat ? '⭐ ' : '') + (seat.isBot ? '🤖 ' : '') + seat.name;
        el.appendChild(name);

        const bet = document.createElement('div');
        bet.className = 'seat-bet';
        const pile = chipPileEl(seat.totalWagered);
        if (pile) {
            bet.appendChild(pile);
            if (seat.spots > 0) bet.appendChild(document.createTextNode(`${seat.spots} riding`));
        }
        el.appendChild(bet);

        const status = document.createElement('div');
        status.className = 'seat-status';
        if (seat.outcome === 'win') {
            status.classList.add('win');
            status.textContent = `${seat.handName?.toUpperCase() || 'WIN'} +${(seat.payout - seat.totalWagered).toLocaleString()}`;
        } else if (seat.outcome === 'lose') {
            status.classList.add('lose');
            status.textContent = seat.handName ? seat.handName.toUpperCase() : 'LOSE';
        } else if ((view.phase === 'ride1' || view.phase === 'ride2') && seat.bet > 0) {
            status.textContent = seat.decided ? 'decided' : 'deciding…';
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
        const { controls, readAmount } = betAmountControls(view, 'last-letride-bet');
        controls.appendChild(button('Ante up (x3)', 'btn gold', () => {
            send({ type: 'action', action: 'bet', amount: readAmount() });
        }));
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = 'escrows 3 bets of this size';
        controls.appendChild(hint);
        bar.appendChild(controls);
    }

    if (view.phase === 'betting' && mySeat.bet > 0) {
        bar.appendChild(button('Deal now', 'btn primary', () => send({ type: 'action', action: 'deal' })));
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = 'waiting for other bets…';
        bar.appendChild(hint);
    }

    if ((view.phase === 'ride1' || view.phase === 'ride2') && mySeat.bet > 0 && !mySeat.decided) {
        bar.appendChild(button('🏇 Let it ride', 'btn green', () => send({ type: 'action', action: 'ride' })));
        bar.appendChild(button(`Pull back ${mySeat.bet.toLocaleString()}`, 'btn danger', () => send({ type: 'action', action: 'pull' })));
    }

    bar.appendChild(button('Leave seat', 'btn', () => send({ type: 'leave-seat' })));
}
