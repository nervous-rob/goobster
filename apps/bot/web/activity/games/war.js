/**
 * Casino War renderer: the dealer's communal card up top (war card beside
 * it during a war), one card per seat, and a bet / war-or-surrender action
 * bar for tied seats.
 */

import { $, cardEl, button, betAmountControls, spectatorHint, resetActionBar } from '../ui.js';
import { chipPileEl } from '../chips.js';

export function render(view, { send }) {
    renderDealer(view);
    renderStatusLine(view);
    renderSeats(view, send);
    renderActionBar(view, send);
}

function renderDealer(view) {
    const holder = $('war-dealer-cards');
    holder.replaceChildren();
    if (view.dealerCard) holder.appendChild(cardEl(view.dealerCard));
    if (view.warDealerCard) {
        const vs = document.createElement('span');
        vs.className = 'war-vs';
        vs.textContent = 'WAR →';
        holder.appendChild(vs);
        holder.appendChild(cardEl(view.warDealerCard));
    }

    const note = $('war-dealer-note');
    note.textContent = view.phase === 'war' ? 'tied seats: go to war or surrender' : '';
}

function renderStatusLine(view) {
    const status = $('table-status');
    const seated = view.seats.filter(Boolean).length;
    if (view.phase === 'waiting') {
        status.textContent = seated === 0
            ? 'Take a seat to play!'
            : 'Place a bet - high card wins.';
    } else if (view.phase === 'betting') {
        status.textContent = 'Bets are open…';
    } else if (view.phase === 'war') {
        const mine = view.yourSeat !== null ? view.seats[view.yourSeat] : null;
        status.textContent = mine?.atWar && !mine.decided
            ? '⚔️ You tied the dealer - go to war or surrender!'
            : 'Waiting on the tied seats…';
    } else if (view.phase === 'settled' && view.results) {
        const mine = view.results.entries.find(e => e.seat === view.yourSeat);
        status.textContent = mine
            ? { win: `🎉 You win +${(mine.payout - mine.wagered).toLocaleString()}!`,
                surrender: '🏳️ Surrendered - half your bet back.',
                lose: '💀 The dealer takes it.' }[mine.outcome]
            : `Round over - dealer showed ${view.results.dealerCard}.`;
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
        if (view.phase === 'war' && seat.atWar && !seat.decided) el.classList.add('turn');

        const cards = document.createElement('div');
        cards.className = 'cards';
        if (seat.card) cards.appendChild(cardEl(seat.card));
        if (seat.warCard) cards.appendChild(cardEl(seat.warCard));
        el.appendChild(cards);

        const name = document.createElement('div');
        name.className = 'seat-name';
        name.textContent = (i === view.yourSeat ? '⭐ ' : '') + (seat.isBot ? '🤖 ' : '') + seat.name;
        el.appendChild(name);

        const bet = document.createElement('div');
        bet.className = 'seat-bet';
        const pile = chipPileEl(seat.totalWagered);
        if (pile) bet.appendChild(pile);
        el.appendChild(bet);

        const status = document.createElement('div');
        status.className = 'seat-status';
        if (seat.outcome === 'win') {
            status.classList.add('win');
            status.textContent = `WIN +${(seat.payout - seat.totalWagered).toLocaleString()}`;
        } else if (seat.outcome === 'surrender') {
            status.classList.add('push');
            status.textContent = 'SURRENDER';
        } else if (seat.outcome === 'lose') {
            status.classList.add('lose');
            status.textContent = 'LOSE';
        } else if (view.phase === 'war' && seat.atWar) {
            status.classList.add(seat.decided ? 'push' : 'win');
            status.textContent = seat.decided ? 'DECIDED' : '⚔️ AT WAR';
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
        const { controls, readAmount } = betAmountControls(view, 'last-war-bet');
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

    if (view.phase === 'war' && mySeat.atWar && !mySeat.decided) {
        bar.appendChild(button(`⚔️ Go to war (+${mySeat.bet.toLocaleString()})`, 'btn danger', () =>
            send({ type: 'action', action: 'war' })));
        bar.appendChild(button('🏳️ Surrender (half back)', 'btn', () =>
            send({ type: 'action', action: 'surrender' })));
    }

    bar.appendChild(button('Leave seat', 'btn', () => send({ type: 'leave-seat' })));
}
