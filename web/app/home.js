/**
 * Companion Home: what Goobster knows, what he is watching, and where
 * to pick up. Chat is a verb from here, not the landing page.
 */
import { api } from './api.js';

const content = document.getElementById('home-content');

let showToast = () => {};
let goTo = () => {};
let openForget = () => {};
let me = null;

function escapeText(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function whenLabel(iso) {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    const now = Date.now();
    const delta = now - date.getTime();
    if (delta < 60 * 60 * 1000) return 'just now';
    if (delta < 24 * 60 * 60 * 1000) {
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function greeting(name) {
    const hour = new Date().getHours();
    const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    return name ? `${hello}, ${name}.` : `${hello}.`;
}

function el(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
}

function roomCard({ title, body, action, onClick, extraClass = '' }) {
    const card = el(`<button type="button" class="home-card ${extraClass}">
      <div class="home-card-kicker">${title}</div>
      <div class="home-card-body">${body}</div>
      ${action ? `<div class="home-card-action">${action}</div>` : ''}
    </button>`);
    card.addEventListener('click', onClick);
    return card;
}

function listItems(items, empty) {
    if (!items.length) return `<div class="hint">${empty}</div>`;
    return `<ul class="home-list">${items.join('')}</ul>`;
}

async function render() {
    content.innerHTML = '<div class="empty">Looking around&hellip;</div>';
    let home;
    try {
        home = await api.home();
    } catch (error) {
        content.innerHTML = `<div class="empty">${escapeText(error.message)}</div>`;
        return;
    }

    const name = me?.user?.name || '';
    const you = home.you || {};
    const watching = home.watching || { followups: [], automations: [] };
    const pickup = home.pickup || { conversations: [], parlor: [] };
    const workshop = home.workshop || { pinned: [], discoveredCount: 0 };
    const servers = home.servers || [];

    const root = el('<div class="home-shell"></div>');

    const hero = el(`<header class="home-hero">
      <img class="home-berry" src="icons/goobster.svg" alt="" width="72" height="72">
      <div>
        <h1 class="home-hello">${escapeText(greeting(name))}</h1>
        <p class="home-sub">Same brain as Discord. Chat is one of the rooms.</p>
      </div>
    </header>`);
    root.appendChild(hero);

    const talk = el('<div class="home-talk"></div>');
    talk.appendChild(el(`<button type="button" class="btn primary big" id="home-talk">Talk to Goobster</button>`));
    talk.appendChild(el(`<button type="button" class="btn" id="home-continue">Pick up the last chat</button>`));
    root.appendChild(talk);
    talk.querySelector('#home-talk').addEventListener('click', () => goTo('chat', { newChat: true }));
    talk.querySelector('#home-continue').addEventListener('click', () => {
        const last = pickup.conversations?.[0];
        if (last) goTo('chat', { conversationId: last.id });
        else goTo('chat', { newChat: true });
    });

    const facts = (you.facts || []).slice(0, 5);
    const factChips = facts.length
        ? facts.map(f => `<li>${escapeText(f)}</li>`).join('')
        : '<li class="hint">Nothing distilled yet — talk in the Study.</li>';
    const youCard = roomCard({
        extraClass: 'home-card-you',
        title: 'What I know about you',
        body: `
          <div class="home-counts">
            <span><strong>${you.factCount || 0}</strong> facts</span>
            <span><strong>${you.memoryCount || 0}</strong> memories</span>
            ${you.nickname ? `<span>calls you <strong>${escapeText(you.nickname)}</strong></span>` : ''}
          </div>
          <ul class="home-facts">${factChips}</ul>`,
        action: 'Open the Library →',
        onClick: () => goTo('memory')
    });

    const followups = watching.followups || [];
    const automations = watching.automations || [];
    const watchItems = [
        ...followups.slice(0, 3).map(f =>
            `<li>⏰ ${escapeText(f.note)} <span class="when">due ${escapeText(whenLabel(f.dueAt))}</span></li>`),
        ...automations.slice(0, 3).map(a =>
            `<li>${a.enabled ? '▶' : '⏸'} ${escapeText(a.name)} <span class="when">${escapeText(a.schedule || '')}</span></li>`)
    ];
    const watchCard = roomCard({
        title: 'What I\'m watching',
        body: listItems(watchItems, 'No follow-ups or automations right now.'),
        action: 'Open Tasks →',
        onClick: () => goTo('tasks')
    });

    const pickupItems = [
        ...(pickup.conversations || []).slice(0, 4).map(c =>
            `<li data-kind="chat" data-id="${c.id}"><span>💬 ${escapeText(c.title)}</span> <span class="when">${escapeText(whenLabel(c.lastMessageAt))}</span></li>`),
        ...(pickup.parlor || []).slice(0, 3).map(c =>
            `<li data-kind="parlor" data-id="${c.id}"><span>🛋️ ${escapeText(c.title)}</span> <span class="when">${escapeText(whenLabel(c.lastMessageAt))}</span></li>`)
    ];
    const pickupCard = el(`<div class="home-card">
      <div class="home-card-kicker">Pick up where we left off</div>
      <div class="home-card-body">${
          pickupItems.length
              ? `<ul class="home-list home-pickup">${pickupItems.join('')}</ul>`
              : '<div class="hint">No conversations yet. The Study is empty and waiting.</div>'
      }</div>
    </div>`);
    pickupCard.querySelectorAll('li[data-id]').forEach(item => {
        item.addEventListener('click', () => {
            const id = Number(item.dataset.id);
            if (item.dataset.kind === 'parlor') goTo('parlor', { conversationId: id });
            else goTo('chat', { conversationId: id });
        });
    });

    const pinPreview = (workshop.pinned || []).slice(0, 3)
        .map(a => `<li>${escapeText(a.title)}</li>`).join('');
    const workshopCard = roomCard({
        title: 'Tools I built you',
        body: pinPreview
            ? `<ul class="home-list">${pinPreview}</ul>`
            : `<div class="hint">${workshop.discoveredCount
                ? `${workshop.discoveredCount} mini-app${workshop.discoveredCount === 1 ? '' : 's'} waiting in chat — pin them in the Workshop.`
                : 'Ask in the Study: “build me a …” and it lands here.'}</div>`,
        action: 'Open the Workshop →',
        onClick: () => goTo('workshop')
    });

    const grid = el('<div class="home-grid"></div>');
    grid.append(youCard, watchCard, pickupCard, workshopCard);
    root.appendChild(grid);

    const doors = el('<div class="home-doors"></div>');
    const door = (label, room, hide = false) => {
        if (hide) return;
        const btn = el(`<button type="button" class="home-door">${label}</button>`);
        btn.addEventListener('click', () => goTo(room));
        doors.appendChild(btn);
    };
    door('🛋️ Parlor', 'parlor');
    door('🔭 Observatory', 'observatory', !me?.features?.observatory);
    door('📊 Exchange', 'exchange');
    door('🃏 Decks', 'mtga');
    door('📈 Usage', 'usage');
    root.appendChild(el('<div class="home-doors-label">Other rooms</div>'));
    root.appendChild(doors);

    if (servers.length) {
        const list = servers.map(s => `<li>${escapeText(s.name)}</li>`).join('');
        root.appendChild(el(`<div class="home-servers hint">Servers we share: <ul class="home-inline">${list}</ul></div>`));
    }

    const privacy = el(`<div class="home-privacy">
      <p>You can inspect every row and watch it disappear.</p>
      <button type="button" class="btn danger" id="home-forget">Forget me</button>
    </div>`);
    privacy.querySelector('#home-forget').addEventListener('click', () => openForget());
    root.appendChild(privacy);

    content.replaceChildren(root);
}

export function initHome({ me: who, toast, navigate, forget }) {
    me = who;
    showToast = typeof toast === 'function' ? toast : showToast;
    goTo = navigate;
    openForget = forget;
    return render().catch((error) => showToast(error.message, true));
}
