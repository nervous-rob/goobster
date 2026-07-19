/**
 * Goobster Casino - Activity client bootstrap, lobby, and game dispatch.
 *
 * Two modes, detected by the `frame_id` query param Discord adds to the
 * embedded iframe:
 *  - Discord mode: full Embedded App SDK handshake (authorize -> token
 *    exchange on our backend -> authenticate), guild/channel from the SDK,
 *    and all HTTP/WS through Discord's `/.proxy/` path.
 *  - Dev mode: plain browser, identity minted by /api/activity/dev-session
 *    (only when the server has activity.devMode enabled).
 *
 * After login the lobby offers one game per card (blackjack, roulette,
 * baccarat); rendering is dispatched to games/<type>.js by the gameType the
 * server reports. A channel runs one live table at a time, so joining a
 * busy channel lands in whatever game is already going.
 */

import {
    sounds, playForEvents, isMuted, toggleMuted,
    isMusicMuted, toggleMusicMuted, armMusicAutostart
} from './sounds.js';
import { $, appendBotControls } from './ui.js';
import * as blackjack from './games/blackjack.js';
import * as roulette from './games/roulette.js';
import * as baccarat from './games/baccarat.js';
import * as holdem from './games/holdem.js';

const GAMES = { blackjack, roulette, baccarat, holdem };
const GAME_NAMES = { blackjack: 'Blackjack', roulette: 'Roulette', baccarat: 'Baccarat', holdem: "Texas Hold'em" };

const params = new URLSearchParams(location.search);
const inDiscord = params.has('frame_id');
const apiBase = inDiscord ? '/.proxy/api/activity' : '/api/activity';

const connectStatus = $('connect-status');

let ws = null;
let me = null;            // { id, name }
let context = null;       // { sessionToken, guildId, channelId }
let currentGame = null;   // gameType of the joined table
let requestedGame = null; // gameType the lobby asked for
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
    $('lobby-btn').addEventListener('click', () => send({ type: 'leave-table' }));
    for (const card of document.querySelectorAll('.game-card')) {
        card.addEventListener('click', () => {
            sounds.chip();
            joinGame(card.dataset.game);
        });
    }

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

    if (!tokenResponse.ok) {
        // No client secret configured on the server. When the server runs in
        // dev mode, fall back to an anonymous guest session so the table is
        // still playable; otherwise surface the configuration problem.
        const devResponse = await fetch(`${apiBase}/dev-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: String(Date.now()) + String(Math.floor(Math.random() * 1000)),
                name: `Guest-${Math.random().toString(36).slice(2, 6)}`
            })
        });
        if (!devResponse.ok) {
            throw new Error('Login failed - is the OAuth client secret configured on the server?');
        }
        const { session_token: devToken, user: devUser } = await devResponse.json();
        me = devUser;
        connect(devToken, sdk.guildId, sdk.channelId);
        setTimeout(() => toast(`Playing as ${devUser.name} (dev mode - no Discord login)`), 800);
        return;
    }

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
// WebSocket + lobby
// ---------------------------------------------------------------------------

function connect(sessionToken, guildId, channelId) {
    context = { sessionToken, guildId, channelId };
    setStatus('Entering the casino…');
    const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsPath = inDiscord ? '/.proxy/api/activity/ws' : '/api/activity/ws';
    ws = new WebSocket(`${wsProtocol}://${location.host}${wsPath}`);

    ws.addEventListener('open', () => {
        showLobby();
        const wanted = params.get('game');
        if (wanted && GAMES[wanted]) joinGame(wanted);
    });

    ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        handleMessage(message);
    });

    ws.addEventListener('close', () => {
        $('screen-table').hidden = true;
        $('screen-lobby').hidden = true;
        $('lobby-btn').hidden = true;
        $('screen-connect').hidden = false;
        setStatus('Disconnected. Reload to rejoin.');
    });
}

function send(message) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function joinGame(gameType) {
    if (!context || ws?.readyState !== WebSocket.OPEN) return;
    requestedGame = gameType;
    send({
        type: 'join',
        session: context.sessionToken,
        guildId: context.guildId,
        channelId: context.channelId,
        gameType
    });
}

function showLobby() {
    currentGame = null;
    $('screen-connect').hidden = true;
    $('screen-table').hidden = true;
    $('screen-lobby').hidden = false;
    $('lobby-btn').hidden = true;
    $('game-name').textContent = '';
}

function showTable(gameType) {
    currentGame = gameType;
    $('screen-connect').hidden = true;
    $('screen-lobby').hidden = true;
    $('screen-table').hidden = false;
    $('lobby-btn').hidden = false;
    $('game-name').textContent = GAME_NAMES[gameType] || gameType;
    for (const type of Object.keys(GAMES)) {
        $(`game-${type}`).hidden = type !== gameType;
    }
}

function handleMessage(message) {
    if (message.balance !== undefined) {
        $('balance').hidden = false;
        $('balance').textContent = `${Number(message.balance).toLocaleString()} ${currencyName}`;
    }

    switch (message.type) {
        case 'joined':
            currencyName = message.currencyName || 'points';
            showTable(message.gameType);
            if (requestedGame && message.gameType !== requestedGame) {
                toast(`This channel is already playing ${GAME_NAMES[message.gameType]} - joining that table.`);
            }
            // Lounge music starts once a table is joined (fetched lazily;
            // silently absent when the server has no ElevenLabs key)
            armMusicAutostart(`${apiBase}/music/casino`);
            break;
        case 'left':
            showLobby();
            break;
        case 'state':
            renderView(message.view);
            break;
        case 'update':
            handleUpdate(message);
            break;
        case 'chat':
            showChat(message);
            break;
        case 'error':
            toast(message.message);
            break;
    }
}

let chatTimer = null;

/** Table talk (e.g. Goobster's commentary) as a speech bubble. */
function showChat(message) {
    const el = $('table-chat');
    el.textContent = `${message.bot ? '🤖 ' : ''}${message.from}: ${message.text}`;
    el.hidden = false;
    el.classList.add('show');
    sounds.chip();
    clearTimeout(chatTimer);
    chatTimer = setTimeout(() => el.classList.remove('show'), 8000);
}

function handleUpdate(message) {
    const view = message.view;
    // A fresh roulette spin gets a suspense animation before the result
    // (and its win/lose sounds) lands
    if (view.gameType === 'roulette' && message.events?.some(e => e.type === 'spin')) {
        roulette.animateSpin(view, { send }, () => {
            playForEvents(message.events.filter(e => e.type !== 'spin'), me?.id);
            renderView(view);
        });
        return;
    }
    playForEvents(message.events, me?.id);
    renderView(view);
}

function renderView(view) {
    const game = GAMES[view.gameType];
    if (!game) return;
    if (currentGame && currentGame !== view.gameType) {
        // The channel's table switched games (e.g. someone re-picked while
        // the table was empty) - swap the layout to match
        showTable(view.gameType);
    }
    game.render(view, { send });
    appendBotControls(view, send);
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
