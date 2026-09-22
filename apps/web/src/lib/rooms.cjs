/**
 * The portal's room registry: the one place that says which destinations
 * exist, what they are called, where they live, and which older URLs still
 * mean the same thing.
 *
 * The sidebar, active-room resolution, atmosphere, Home shortcuts, the Tools
 * cards, the Settings "Back to …" link, the start-page preference, and the
 * legacy `#room/id` hash scheme all read from here instead of keeping their
 * own copies. TanStack route definitions stay explicitly typed in main.tsx;
 * this file only decides names and path equivalences, never route params.
 *
 * Seven primary destinations (Home, Chat, Knowledge, Projects, Discussions,
 * Activity, Tools) plus an account area (Usage, Settings, Host). Specialist
 * rooms (Music Lab, Trading game, Card decks) keep their own URLs and light
 * up the Tools entry. Internal ids such as `observatory`, `spitball`,
 * `parlor`, API paths, and database names are deliberately unchanged.
 *
 * CommonJS so Jest can require() it; Vite interops the same file.
 * Contract: documentation/portal_navigation.md.
 */

const ROOMS = [
    {
        id: 'home',
        name: 'Home',
        icon: '🏠',
        path: '/',
        group: 'primary',
        atmosphere: 'room-home',
        tutorials: ['home.orientation']
    },
    {
        id: 'chat',
        name: 'Chat',
        secondaryName: 'the Study',
        icon: '💬',
        path: '/chat',
        group: 'primary',
        atmosphere: 'room-study',
        legacyIds: ['study'],
        tutorials: ['chat.basics']
    },
    {
        id: 'knowledge',
        name: 'Knowledge',
        secondaryName: 'Spitball',
        icon: '🧠',
        path: '/knowledge',
        group: 'primary',
        atmosphere: 'room-library',
        legacyIds: ['spitball', 'library', 'memory'],
        tutorials: ['knowledge.basics', 'knowledge.research'],
        // Knowledge opens on Notes; Map is the same projection drawn as a
        // graph; Research is where expeditions are launched and read. The
        // personal-memory views (About you / Facts / Memories) moved to
        // Settings → Memory & privacy - see documentation/knowledge_and_memory.md.
        views: [
            { id: 'notes', name: 'Notes', icon: '📝', path: '/knowledge/notes' },
            { id: 'map', name: 'Map', icon: '🕸️', path: '/knowledge/map' },
            { id: 'research', name: 'Research', secondaryName: 'Expeditions', icon: '🧭', path: '/knowledge/research', legacyIds: ['expeditions'] }
        ]
    },
    {
        id: 'projects',
        name: 'Projects',
        secondaryName: 'the Observatory',
        icon: '🔭',
        path: '/projects',
        group: 'primary',
        atmosphere: 'room-observatory',
        // Organizing projects is its own capability; running code in them
        // (`features.observatory`) is gated per control - ADR 0009.
        requires: { feature: 'projects' },
        legacyIds: ['observatory', 'workshop'],
        tutorials: ['projects.basics', 'projects.plans', 'projects.runs', 'projects.apps'],
        // Views live under a per-project path: /projects/:owner/:slug/<view>.
        // The owner is part of the address because two owners may share a
        // slug. `/projects/:slug` alone is a resolver (unique match redirects,
        // several show a chooser) - see documentation/projects.md.
        detail: { params: ['owner', 'slug'], defaultView: 'overview' },
        views: [
            { id: 'overview', name: 'Overview', icon: '🔭', segment: 'overview' },
            { id: 'plan', name: 'Plan', secondaryName: 'Mission', icon: '🎯', segment: 'plan', legacyIds: ['mission'] },
            { id: 'conversation', name: 'Conversation', icon: '💬', segment: 'conversation' },
            { id: 'knowledge', name: 'Knowledge', icon: '🧠', segment: 'knowledge' },
            { id: 'files', name: 'Files', secondaryName: 'Explorer', icon: '📁', segment: 'files', legacyIds: ['explorer'] },
            { id: 'apps', name: 'Apps', icon: '🧩', segment: 'apps' },
            { id: 'runs', name: 'Runs', secondaryName: 'Jobs', icon: '▶️', segment: 'runs', legacyIds: ['jobs'] },
            { id: 'people', name: 'People', icon: '👥', segment: 'people' },
            { id: 'automations', name: 'Automations', icon: '⏱️', segment: 'automations' }
        ]
    },
    {
        id: 'discussions',
        name: 'Discussions',
        secondaryName: 'the Parlor',
        icon: '🛋️',
        path: '/discussions',
        group: 'primary',
        atmosphere: 'room-parlor',
        legacyIds: ['parlor'],
        tutorials: ['discussions.basics']
    },
    {
        id: 'activity',
        name: 'Activity',
        icon: '📥',
        path: '/activity/inbox',
        group: 'primary',
        atmosphere: 'room-noticed',
        // The sidebar badge is the Inbox's unread count alone. Attention
        // notices that were also delivered to the Inbox are the same item;
        // never add the two sources together.
        count: 'inbox',
        legacyIds: ['inbox', 'noticed', 'attention', 'tasks'],
        tutorials: ['activity.inbox', 'activity.scheduled'],
        views: [
            { id: 'inbox', name: 'Inbox', icon: '📥', path: '/activity/inbox', legacyIds: ['inbox'] },
            { id: 'attention', name: 'Attention', secondaryName: 'Noticed', icon: '🧭', path: '/activity/attention', legacyIds: ['noticed', 'attention'] },
            { id: 'scheduled', name: 'Scheduled', secondaryName: 'Tasks', icon: '🗓️', path: '/activity/scheduled', legacyIds: ['tasks'] }
        ]
    },
    {
        id: 'tools',
        name: 'Tools',
        icon: '🧰',
        path: '/tools',
        group: 'primary',
        atmosphere: 'room-home',
        tutorials: ['tools.overview']
    },
    {
        id: 'music',
        name: 'Music Lab',
        secondaryName: 'the Conservatory',
        icon: '🎹',
        path: '/conservatory',
        group: 'tools',
        parent: 'tools',
        atmosphere: 'room-conservatory',
        legacyIds: ['conservatory'],
        blurb: 'Intervals, chords, rhythm, harmony, space, melody, stage, and a studio. Everything you make stays on this device unless you export it.',
        tutorials: ['music.overview', 'music.intervals', 'music.chords', 'music.rhythm', 'music.harmony', 'music.space', 'music.melody', 'music.stage', 'music.studio']
    },
    {
        id: 'trading',
        name: 'Trading game',
        secondaryName: 'the Exchange',
        icon: '📊',
        path: '/exchange',
        group: 'tools',
        parent: 'tools',
        atmosphere: 'room-exchange',
        requires: { discord: true },
        legacyIds: ['exchange'],
        blurb: 'A simulated market in a Discord server\u2019s game currency: quotes, positions, options, and the leaderboard. No real money.',
        unavailable: 'Needs a connected Discord server. This installation is not connected to Discord.',
        tutorials: ['trading.basics']
    },
    {
        id: 'decks',
        name: 'Card decks',
        secondaryName: 'Magic: The Gathering Arena',
        icon: '🃏',
        path: '/decks',
        group: 'tools',
        parent: 'tools',
        atmosphere: 'room-decks',
        legacyIds: ['decks', 'mtga'],
        blurb: 'Import, organise, and export MTG Arena deck lists. These are card decks, not slide decks.',
        tutorials: ['decks.basics']
    },
    {
        id: 'usage',
        name: 'Usage & limits',
        icon: '📈',
        path: '/usage',
        group: 'account',
        atmosphere: 'room-usage',
        tutorials: ['usage.basics']
    },
    {
        id: 'settings',
        name: 'Settings',
        icon: '⚙️',
        path: '/settings',
        group: 'account',
        atmosphere: 'room-usage',
        tutorials: ['settings.basics', 'memory.basics', 'connections.basics']
    },
    {
        id: 'host',
        name: 'Host',
        icon: '🗝️',
        path: '/host',
        group: 'account',
        atmosphere: 'room-usage',
        requires: { operator: true },
        tutorials: ['admin.instance']
    },
    {
        id: 'share',
        name: 'Shared conversation',
        icon: '🔗',
        path: '/share',
        group: 'public',
        atmosphere: 'room-study',
        tutorials: []
    }
];

const ROOM_BY_ID = Object.fromEntries(ROOMS.map((room) => [room.id, room]));

/**
 * Older URL prefixes and where they now live. The matched prefix is
 * replaced and the rest of the path (ids, sub-paths) is kept, unless
 * `landing` is set, in which case the alias always lands on `to` (used for
 * legacy sub-paths that rendered the same landing page anyway).
 *
 * `/observatory/share/:token` is served by the server, never by the SPA,
 * and is excluded on purpose so a public project share is never swallowed
 * by the Projects route.
 */
const ALIASES = [
    { from: '/study', to: '/chat' },
    { from: '/spitball', to: '/knowledge' },
    { from: '/library', to: '/knowledge' },
    { from: '/observatory/graph', to: '/projects', landing: true },
    { from: '/observatory/search', to: '/projects', landing: true },
    { from: '/observatory/people', to: '/projects', landing: true },
    { from: '/observatory/events', to: '/projects', landing: true },
    { from: '/observatory', to: '/projects' },
    { from: '/workshop', to: '/projects' },
    { from: '/parlor', to: '/discussions' },
    { from: '/inbox', to: '/activity/inbox' },
    { from: '/noticed', to: '/activity/attention' },
    { from: '/attention', to: '/activity/attention' },
    { from: '/tasks', to: '/activity/scheduled' }
];

const SERVER_HANDLED = ['/observatory/share/'];

function normalize(pathname) {
    let path = String(pathname || '/');
    if (path.startsWith('/app/')) path = path.slice(4);
    else if (path === '/app') path = '/';
    if (!path.startsWith('/')) path = `/${path}`;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return path;
}

function matchesPrefix(path, prefix) {
    return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Canonical path for a pathname: the same path when it is already canonical,
 * the rewritten one for a legacy alias. Search and hash are not part of the
 * path and are preserved by the caller.
 */
function canonicalPath(pathname) {
    const path = normalize(pathname);
    if (SERVER_HANDLED.some((prefix) => path.startsWith(prefix))) return path;
    const alias = ALIASES
        .filter((entry) => matchesPrefix(path, entry.from))
        .sort((a, b) => b.from.length - a.from.length)[0];
    if (!alias) return path;
    if (alias.landing) return alias.to;
    return `${alias.to}${path.slice(alias.from.length)}`;
}

function isLegacyPath(pathname) {
    return canonicalPath(pathname) !== normalize(pathname);
}

/**
 * The room a pathname belongs to (canonical or legacy). Specific paths win
 * over broad prefixes; specialist rooms report themselves, and `parentRoom`
 * tells the sidebar which primary entry to light up.
 */
function resolveRoom(pathname) {
    const path = canonicalPath(pathname);
    if (path === '/') return 'home';
    const candidates = [];
    for (const room of ROOMS) {
        if (room.path !== '/' && matchesPrefix(path, room.path)) candidates.push({ id: room.id, len: room.path.length });
        for (const view of room.views || []) {
            if (view.path && matchesPrefix(path, view.path)) candidates.push({ id: room.id, len: view.path.length });
        }
    }
    if (path.startsWith('/activity')) return 'activity';
    candidates.sort((a, b) => b.len - a.len);
    return candidates[0]?.id || 'home';
}

/** The primary sidebar entry to highlight for a room (Tools for specialist rooms). */
function parentRoom(roomId) {
    const room = ROOM_BY_ID[roomId];
    return room?.parent || roomId;
}

/**
 * For a room whose views live under a per-item path (Projects:
 * `/projects/:owner/:slug/<view>`), the item the pathname names and the
 * view it is on - the default view when the segment is absent - or null
 * when the path is the room's list, a resolver path (`/projects/:slug`),
 * or outside the room. Params are decoded route segments; the view id is
 * null for an unknown segment so the caller can redirect to the default.
 */
function resolveRoomDetail(roomId, pathname) {
    const room = ROOM_BY_ID[roomId];
    if (!room?.detail) return null;
    const path = canonicalPath(pathname);
    if (!matchesPrefix(path, room.path) || path === room.path) return null;
    const segments = path.slice(room.path.length + 1).split('/').map((part) => {
        try { return decodeURIComponent(part); } catch { return part; }
    });
    const arity = room.detail.params.length;
    if (segments.length < arity || segments.length > arity + 1) return null;
    const params = Object.fromEntries(room.detail.params.map((name, index) => [name, segments[index]]));
    const segment = segments[arity];
    if (segment === undefined) return { params, view: room.detail.defaultView };
    const view = (room.views || []).find((entry) => entry.segment === segment || (entry.legacyIds || []).includes(segment));
    return { params, view: view?.id || null };
}

/** The canonical path of one view of one item: `/projects/<owner>/<slug>/<segment>`. */
function detailPath(roomId, params, viewId = null) {
    const room = ROOM_BY_ID[roomId];
    if (!room?.detail) return room?.path || '/';
    const view = (room.views || []).find((entry) => entry.id === (viewId || room.detail.defaultView));
    const parts = room.detail.params.map((name) => encodeURIComponent(String(params?.[name] ?? '')));
    return `${room.path}/${parts.join('/')}/${view?.segment || room.detail.defaultView}`;
}

/**
 * The view of a room (Activity, Knowledge, Projects) a pathname points at,
 * or null when the path is outside that room or on its bare landing path.
 */
function resolveRoomView(roomId, pathname) {
    const room = ROOM_BY_ID[roomId];
    if (room?.detail) return resolveRoomDetail(roomId, pathname)?.view || null;
    const path = canonicalPath(pathname);
    const views = room?.views || [];
    return views
        .filter((view) => view.path && matchesPrefix(path, view.path))
        .sort((a, b) => b.path.length - a.path.length)[0]?.id || null;
}

/** The Activity view a pathname points at, or null outside Activity. */
function resolveActivityView(pathname) {
    return resolveRoomView('activity', pathname);
}

/** The Knowledge view a pathname points at (`/knowledge` itself is null: it opens on Notes). */
function resolveKnowledgeView(pathname) {
    return resolveRoomView('knowledge', pathname);
}

function atmosphereFor(roomId) {
    return ROOM_BY_ID[roomId]?.atmosphere || 'room-home';
}

/** "Chat", "Knowledge · Map", "Activity · Attention" - what a settings return link says it goes back to. */
function roomDisplayName(pathname) {
    const id = resolveRoom(pathname);
    const room = ROOM_BY_ID[id];
    if (!room) return 'where you were';
    if (room.views) {
        const view = resolveRoomView(id, pathname);
        const meta = room.views.find((entry) => entry.id === view);
        return meta ? `${room.name} · ${meta.name}` : room.name;
    }
    return room.name;
}

/**
 * Whether the signed-in person can see a room right now: a feature flag
 * (Projects), the Discord adapter (Trading game), or the operator role
 * (Host). Availability is about *this installation and account*; a hidden
 * room is not a forbidden one - direct URLs still resolve and explain
 * themselves.
 */
function isRoomAvailable(room, me) {
    const req = room.requires;
    if (!req) return true;
    if (!me) return false;
    if (req.feature && !me.features?.[req.feature]) return false;
    if (req.operator && !me.identity?.operator) return false;
    if (req.discord && me.discord?.enabled === false) return false;
    return true;
}

/** Why a room is unavailable, in words a person can act on. */
function unavailableReason(room, me) {
    if (isRoomAvailable(room, me)) return null;
    if (room.unavailable) return room.unavailable;
    if (room.requires?.operator) return 'Only the host can open this.';
    if (room.requires?.feature) return 'This is not enabled on this installation.';
    return 'Not available right now.';
}

const PRIMARY_ROOMS = ROOMS.filter((room) => room.group === 'primary');
const ACCOUNT_ROOMS = ROOMS.filter((room) => room.group === 'account');
const TOOL_ROOMS = ROOMS.filter((room) => room.group === 'tools');

/**
 * Tool rooms still offered in the catalog and in navigation. `hiddenIds`
 * is the person's `appearance.hiddenToolRooms` preference. Hiding is not
 * availability (`isRoomAvailable`) and not a permission: a direct URL still
 * resolves. Unknown ids are ignored here; the settings write rejects them.
 */
function catalogTools(hiddenIds) {
    const hidden = new Set(Array.isArray(hiddenIds) ? hiddenIds.map((id) => String(id)) : []);
    return TOOL_ROOMS.filter((room) => !hidden.has(room.id));
}

/**
 * Start-page preference. New values are room ids; the older room names
 * that people already saved (`study`, `noticed`, …) keep meaning what they
 * meant. `packages/core/config/userSettingsSchema.js` accepts the same set
 * - tests/portalRooms.test.js keeps the two lists in step.
 */
const START_PAGE_OPTIONS = [
    { value: 'home', label: 'Home' },
    { value: 'chat', label: 'Chat' },
    { value: 'knowledge', label: 'Knowledge' },
    { value: 'projects', label: 'Projects' },
    { value: 'discussions', label: 'Discussions' },
    { value: 'activity', label: 'Activity' },
    { value: 'tools', label: 'Tools' }
];

const LEGACY_START_PAGES = {
    study: '/chat',
    spitball: '/knowledge',
    parlor: '/discussions',
    noticed: '/activity/attention',
    inbox: '/activity/inbox',
    exchange: '/exchange',
    conservatory: '/conservatory'
};

const START_PAGES = [
    ...START_PAGE_OPTIONS.map((option) => option.value),
    ...Object.keys(LEGACY_START_PAGES)
];

/** Where a saved start-page value opens, or null for Home/unknown (stay put). */
function startPageTarget(value) {
    if (!value || value === 'home') return null;
    if (LEGACY_START_PAGES[value]) return LEGACY_START_PAGES[value];
    const room = ROOM_BY_ID[value];
    if (!room || room.path === '/') return null;
    return room.path;
}

/** The select value to show for a saved start page (legacy values map onto the new option that means the same thing). */
function startPageOptionFor(value) {
    if (!value) return 'home';
    if (START_PAGE_OPTIONS.some((option) => option.value === value)) return value;
    const target = LEGACY_START_PAGES[value];
    if (!target) return 'home';
    const view = ROOM_BY_ID.activity.views.find((entry) => entry.path === target);
    if (view) return 'activity';
    const room = ROOMS.find((entry) => entry.path === target);
    return room ? (room.parent || room.id) : 'home';
}

/**
 * The pre-router `#room/id` hash scheme. Every legacy id and every room id
 * resolves; numeric ids and Music Lab mode names become a sub-path.
 */
function legacyHashTarget(hash) {
    const raw = String(hash || '').replace(/^#/, '');
    if (!raw) return null;
    const [name, id] = raw.split('/');
    let base = null;
    for (const room of ROOMS) {
        // A view name (`noticed`, `tasks`) is more specific than its room.
        const view = (room.views || []).find((entry) => entry.path && (entry.id === name || (entry.legacyIds || []).includes(name)));
        if (view) { base = view.path; break; }
        if (room.id === name || (room.legacyIds || []).includes(name)) { base = room.path; break; }
    }
    if (!base) return null;
    if (id && (/^\d+$/.test(id) || base === '/conservatory')) return `${base}/${id}`;
    return base;
}

module.exports = {
    ROOMS,
    ROOM_BY_ID,
    ALIASES,
    PRIMARY_ROOMS,
    ACCOUNT_ROOMS,
    TOOL_ROOMS,
    catalogTools,
    START_PAGE_OPTIONS,
    START_PAGES,
    LEGACY_START_PAGES,
    normalize,
    canonicalPath,
    isLegacyPath,
    resolveRoom,
    parentRoom,
    resolveRoomView,
    resolveRoomDetail,
    detailPath,
    resolveActivityView,
    resolveKnowledgeView,
    atmosphereFor,
    roomDisplayName,
    isRoomAvailable,
    unavailableReason,
    startPageTarget,
    startPageOptionFor,
    legacyHashTarget
};
