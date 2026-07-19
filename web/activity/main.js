/**
 * Goobster Casino - Activity client bootstrap + blackjack UI.
 *
 * Two modes, detected by the `frame_id` query param Discord adds to the
 * embedded iframe:
 *  - Discord mode: full Embedded App SDK handshake (authorize -> token
 *    exchange on our backend -> authenticate), guild/channel from the SDK,
 *    and all HTTP/WS through Discord's `/.proxy/` path.
 *  - Dev mode: plain browser, identity minted by /api/activity/dev-session
 *    (only when the server has activity.devMode enabled).
 */

import {
    sounds, playForEvents, isMuted, toggleMuted,
    isMusicMuted, toggleMusicMuted, armMusicAutostart
} from './sounds.js';

const params = new URLSearchParams(location.search);
const inDiscord = params.has('frame_id');
const apiBase = inDiscord ? '/.proxy/api/activity' : '/api/activity';

const $ = (id) => document.getElementById(id);
const connectStatus = $('connect-status');

let ws = null;
let me = null;            // { id, name }
let currencyName = 'points';

let toastTimer = null;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

init().catch(err => {
    console.error(err);
    setStatus(`❌ ${err.message}`);
});

async function init() {
    $('sound-toggle').classList.toggle('muted', isMuted());
    $('sound-toggle').addEventListener('click', () => {
        $('sound-toggle').classList.toggle('muted', toggleMuted());
        sounds.chip();
    });
    $('music-toggle').classList.toggle('muted', isMusicMuted());
    $('music-toggle').addEventListener('click', () => {
        $('music-toggle').classList.toggle('muted', toggleMusicMuted());
    });

    if (inDiscord) {
        setStatus('Connecting to Discord…');
        await initDiscordMode();
    } else {
        await initDevMode();
    }
}

async function initDiscordMode() {
    const configResponse = await fetch(`${apiBase}/config`);
    const { clientId } = await configResponse.json();

    const { DiscordSDK } = await import('../activity/vendor/embedded-app-sdk/index.mjs');
    const sdk = new DiscordSDK(clientId);
    await sdk.ready();

    setStatus('Authorizing…');
    const { code } = await sdk.commands.authorize({
        client_id: clientId,
        response_type: 'code',
        state: '',
        prompt: 'none',
        scope: ['identify', 'guilds']
    });

    const tokenResponse = await fetch(`${apiBase}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
    });
    if (!tokenResponse.ok) throw new Error('Login with the game server failed.');
    const { access_token: accessToken, session_token: sessionToken, user } = await tokenResponse.json();

    await sdk.commands.authenticate({ access_token: accessToken });

    me = user;
    connect(sessionToken, sdk.guildId, sdk.channelId);
}

async function initDevMode() {
    const configResponse = await fetch(`${apiBase}/config`);
    const { devMode } = await configResponse.json();
    if (!devMode) {
        setStatus('This page only works inside Discord (or with dev mode enabled on the server).');
        return;
    }

    setStatus('');
    const form = $('dev-form');
    form.hidden = false;
    $('dev-name').value = params.get('name') || localStorage.getItem('dev-name') || '';
    $('dev-user').value = params.get('user') || localStorage.getItem('dev-user') || '';
    $('dev-guild').value = params.get('guild') || localStorage.getItem('dev-guild') || '';
    $('dev-channel').value = params.get('channel') || localStorage.getItem('dev-channel') || '';

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = $('dev-name').value.trim() || 'dev player';
        const userId = $('dev-user').value.trim() || String(Date.now()) + String(Math.floor(Math.random() * 1000));
        const guildId = $('dev-guild').value.trim();
        const channelId = $('dev-channel').value.trim();
        localStorage.setItem('dev-name', name);
        localStorage.setItem('dev-user', userId);
        localStorage.setItem('dev-guild', guildId);
        localStorage.setItem('dev-channel', channelId);

        const response = await fetch(`${apiBase}/dev-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, name })
        });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            setStatus(`❌ ${body.error || 'Dev session refused.'}`);
            return;
        }
        const { session_token: sessionToken, user } = await response.json();
        me = user;
        form.hidden = true;
        connect(sessionToken, guildId, channelId);
    });

    if (params.get('autojoin') === '1') form.requestSubmit();
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function connect(sessionToken, guildId, channelId) {
    setStatus('Joining the table…');
    const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsPath = inDiscord ? '/.proxy/api/activity/ws' : '/api/activity/ws';
    ws = new WebSocket(`${wsProtocol}://${location.host}${wsPath}`);

    ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'join', session: sessionToken, guildId, channelId }));
    });

    ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        handleMessage(message);
    });

    ws.addEventListener('close', () => {
        $('screen-table').hidden = true;
        $('screen-connect').hidden = false;
        setStatus('Disconnected. Reload to rejoin.');
    });
}

function send(message) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function handleMessage(message) {
    if (message.balance !== undefined) {
        $('balance').hidden = false;
        $('balance').textContent = `${Number(message.balance).toLocaleString()} ${currencyName}`;
    }

    switch (message.type) {
        case 'joined':
            currencyName = message.currencyName || 'points';
            $('screen-connect').hidden = true;
            $('screen-table').hidden = false;
            // Lounge music starts once the table is joined (fetched lazily;
            // silently absent when the server has no ElevenLabs key)
            armMusicAutostart(`${apiBase}/music/casino`);
            break;
        case 'state':

            render(message.view);
            break;
        case 'update':

            playForEvents(message.events, me?.id);
            render(message.view);
            break;
        case 'error':
            toast(message.message);
            break;
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SUIT_GLYPHS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_NAMES = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

function cardEl(card, { back = false } = {}) {
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

function render(view) {
    renderDealer(view);
    renderStatusLine(view);
    renderSeats(view);
    renderActionBar(view);
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

function renderSeats(view) {
    const holder = $('seats');
    holder.replaceChildren();

    view.seats.forEach((seat, i) => {
        const el = document.createElement('div');
        el.className = 'seat';
        if (!seat) {
            el.classList.add('empty');
            const canSit = view.yourSeat === null;
            if (canSit) {
                const btn = document.createElement('button');
                btn.className = 'sit-btn';
                btn.textContent = 'Sit here';
                btn.addEventListener('click', () => send({ type: 'sit', seat: i }));
                el.appendChild(btn);
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

function renderActionBar(view) {
    const bar = $('action-bar');
    bar.replaceChildren();

    const mySeat = view.yourSeat !== null ? view.seats[view.yourSeat] : null;

    if (!mySeat) {
        bar.innerHTML = '<span class="hint">Pick a seat to join the game — spectating until then.</span>';
        return;
    }

    const canBet = (view.phase === 'waiting' || view.phase === 'betting') && mySeat.bet === 0;
    if (canBet) {
        const controls = document.createElement('div');
        controls.className = 'bet-controls';

        const input = document.createElement('input');
        input.className = 'bet-input';
        input.type = 'number';
        input.min = view.minBet;
        input.max = view.maxBet;
        input.value = localStorage.getItem('last-bet') || view.minBet;
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

        const betBtn = document.createElement('button');
        betBtn.className = 'btn gold';
        betBtn.textContent = 'Place bet';
        betBtn.addEventListener('click', () => {
            const amount = Math.floor(Number(input.value));
            localStorage.setItem('last-bet', String(amount));
            send({ type: 'action', action: 'bet', amount });
        });
        controls.appendChild(betBtn);
        bar.appendChild(controls);
    }

    if (view.phase === 'betting' && mySeat.bet > 0) {
        const dealBtn = document.createElement('button');
        dealBtn.className = 'btn primary';
        dealBtn.textContent = 'Deal now';
        dealBtn.addEventListener('click', () => send({ type: 'action', action: 'deal' }));
        bar.appendChild(dealBtn);
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = 'waiting for other bets…';
        bar.appendChild(hint);
    }

    if (view.phase === 'acting' && mySeat.isTurn) {
        const hit = document.createElement('button');
        hit.className = 'btn green';
        hit.textContent = 'Hit';
        hit.addEventListener('click', () => send({ type: 'action', action: 'hit' }));
        bar.appendChild(hit);

        const stand = document.createElement('button');
        stand.className = 'btn danger';
        stand.textContent = 'Stand';
        stand.addEventListener('click', () => send({ type: 'action', action: 'stand' }));
        bar.appendChild(stand);

        if (mySeat.cards.length === 2 && !mySeat.doubled) {
            const dbl = document.createElement('button');
            dbl.className = 'btn gold';
            dbl.textContent = 'Double';
            dbl.addEventListener('click', () => send({ type: 'action', action: 'double' }));
            bar.appendChild(dbl);
        }
    }

    const leave = document.createElement('button');
    leave.className = 'btn';
    leave.textContent = 'Leave seat';
    leave.addEventListener('click', () => send({ type: 'leave-seat' }));
    bar.appendChild(leave);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setStatus(text) {
    connectStatus.textContent = text;
}

function toast(message) {
    let el = $('toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
