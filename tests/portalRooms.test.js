/**
 * The portal room registry (apps/web/src/lib/rooms.cjs): the navigation
 * contract behind the seven primary destinations. Legacy URLs must keep
 * their meaning, specific paths must beat broad prefixes, and the
 * start-page preference must accept the same values on both sides of the
 * API. Browser wiring is covered by e2e/navigation.spec.js.
 */
const rooms = require('../apps/web/src/lib/rooms.cjs');
const { START_PAGES } = require('../packages/core/config/userSettingsSchema');

describe('room registry shape', () => {
    test('exposes exactly the seven primary destinations, in order', () => {
        expect(rooms.PRIMARY_ROOMS.map((room) => room.id)).toEqual([
            'home', 'chat', 'knowledge', 'projects', 'discussions', 'activity', 'tools'
        ]);
    });

    test('keeps Usage, Settings and Host in the account area and specialist rooms under Tools', () => {
        expect(rooms.ACCOUNT_ROOMS.map((room) => room.id)).toEqual(['usage', 'settings', 'host']);
        expect(rooms.TOOL_ROOMS.map((room) => room.id)).toEqual(['music', 'trading', 'decks']);
        for (const tool of rooms.TOOL_ROOMS) expect(rooms.parentRoom(tool.id)).toBe('tools');
        expect(rooms.parentRoom('chat')).toBe('chat');
    });

    test('every room has a unique id, a unique canonical path and an atmosphere class', () => {
        const ids = rooms.ROOMS.map((room) => room.id);
        const paths = rooms.ROOMS.map((room) => room.path);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(paths).size).toBe(paths.length);
        for (const room of rooms.ROOMS) {
            expect(room.atmosphere).toMatch(/^room-/);
            expect(Array.isArray(room.tutorials)).toBe(true);
        }
    });

    test('lists all 28 planned tutorial ids exactly once across rooms', () => {
        const all = rooms.ROOMS.flatMap((room) => room.tutorials);
        expect(new Set(all).size).toBe(all.length);
        expect(all).toHaveLength(28);
        expect(all).toEqual(expect.arrayContaining([
            'home.orientation', 'chat.basics', 'knowledge.basics', 'knowledge.research',
            'projects.basics', 'projects.plans', 'projects.runs', 'projects.apps',
            'discussions.basics', 'activity.inbox', 'activity.scheduled', 'tools.overview',
            'music.overview', 'music.intervals', 'music.chords', 'music.rhythm', 'music.harmony',
            'music.space', 'music.melody', 'music.stage', 'music.studio',
            'trading.basics', 'decks.basics', 'usage.basics', 'settings.basics',
            'memory.basics', 'connections.basics', 'admin.instance'
        ]));
    });
});

describe('canonicalPath', () => {
    test.each([
        ['/study', '/chat'],
        ['/study/123', '/chat/123'],
        ['/spitball', '/knowledge'],
        ['/library', '/knowledge'],
        ['/observatory', '/projects'],
        ['/workshop', '/projects'],
        ['/parlor', '/discussions'],
        ['/parlor/77', '/discussions/77'],
        ['/inbox', '/activity/inbox'],
        ['/noticed', '/activity/attention'],
        ['/attention', '/activity/attention'],
        ['/tasks', '/activity/scheduled']
    ])('rewrites %s → %s and keeps the rest of the path', (legacy, canonical) => {
        expect(rooms.canonicalPath(legacy)).toBe(canonical);
        expect(rooms.isLegacyPath(legacy)).toBe(true);
    });

    test('legacy Observatory sub-pages land on Projects (they rendered the same landing page)', () => {
        for (const sub of ['graph', 'search', 'people', 'events']) {
            expect(rooms.canonicalPath(`/observatory/${sub}`)).toBe('/projects');
        }
    });

    test('never swallows a server-handled public project share', () => {
        expect(rooms.canonicalPath('/observatory/share/abc123')).toBe('/observatory/share/abc123');
        expect(rooms.isLegacyPath('/observatory/share/abc123')).toBe(false);
    });

    test('leaves canonical, public and account paths alone', () => {
        for (const path of ['/', '/chat', '/chat/9', '/knowledge', '/projects', '/discussions/4',
            '/activity/inbox', '/activity/attention', '/activity/scheduled', '/tools',
            '/conservatory', '/conservatory/rhythm', '/exchange', '/decks', '/usage', '/host',
            '/settings', '/settings/memory', '/share/tok']) {
            expect(rooms.canonicalPath(path)).toBe(path);
            expect(rooms.isLegacyPath(path)).toBe(false);
        }
    });

    test('tolerates the /app base and trailing slashes', () => {
        expect(rooms.canonicalPath('/app/study/5/')).toBe('/chat/5');
        expect(rooms.canonicalPath('/app')).toBe('/');
        expect(rooms.canonicalPath('/app/')).toBe('/');
    });

    test('does not treat a lookalike prefix as an alias', () => {
        expect(rooms.canonicalPath('/studying')).toBe('/studying');
        expect(rooms.canonicalPath('/inboxes')).toBe('/inboxes');
    });
});

describe('resolveRoom', () => {
    test.each([
        ['/', 'home'],
        ['/chat', 'chat'], ['/chat/12', 'chat'], ['/study/12', 'chat'],
        ['/knowledge', 'knowledge'], ['/spitball', 'knowledge'], ['/library', 'knowledge'],
        ['/projects', 'projects'], ['/observatory', 'projects'], ['/observatory/graph', 'projects'], ['/workshop', 'projects'],
        ['/discussions/3', 'discussions'], ['/parlor', 'discussions'],
        ['/activity', 'activity'], ['/activity/inbox', 'activity'], ['/activity/attention', 'activity'],
        ['/activity/scheduled', 'activity'], ['/inbox', 'activity'], ['/noticed', 'activity'], ['/tasks', 'activity'], ['/attention', 'activity'],
        ['/tools', 'tools'],
        ['/conservatory', 'music'], ['/conservatory/studio', 'music'],
        ['/exchange', 'trading'], ['/decks', 'decks'],
        ['/usage', 'usage'], ['/settings', 'settings'], ['/settings/appearance', 'settings'], ['/host', 'host'],
        ['/share/tok', 'share']
    ])('%s → %s', (path, room) => {
        expect(rooms.resolveRoom(path)).toBe(room);
    });

    test('names the Activity view for a path', () => {
        expect(rooms.resolveActivityView('/activity/inbox')).toBe('inbox');
        expect(rooms.resolveActivityView('/noticed')).toBe('attention');
        expect(rooms.resolveActivityView('/tasks')).toBe('scheduled');
        expect(rooms.resolveActivityView('/chat')).toBeNull();
    });

    test('atmosphere follows the room and falls back to Home', () => {
        expect(rooms.atmosphereFor('knowledge')).toBe('room-library');
        expect(rooms.atmosphereFor('music')).toBe('room-conservatory');
        expect(rooms.atmosphereFor('nope')).toBe('room-home');
    });
});

describe('roomDisplayName (settings return links)', () => {
    test.each([
        ['/study', 'Chat'], ['/chat/4?x=1', 'Chat'],
        ['/knowledge', 'Knowledge'], ['/spitball', 'Knowledge'],
        ['/observatory', 'Projects'], ['/parlor/2', 'Discussions'],
        ['/noticed', 'Activity · Attention'], ['/activity/inbox', 'Activity · Inbox'], ['/tasks', 'Activity · Scheduled'],
        ['/conservatory/rhythm', 'Music Lab'], ['/exchange', 'Trading game'],
        ['/', 'Home']
    ])('%s → %s', (path, name) => {
        expect(rooms.roomDisplayName(path)).toBe(name);
    });
});

describe('availability', () => {
    const projects = rooms.ROOM_BY_ID.projects;
    const trading = rooms.ROOM_BY_ID.trading;
    const host = rooms.ROOM_BY_ID.host;

    test('Projects needs the observatory feature, Host needs the operator role, Trading needs Discord', () => {
        expect(rooms.isRoomAvailable(projects, { features: { observatory: true } })).toBe(true);
        expect(rooms.isRoomAvailable(projects, { features: {} })).toBe(false);
        expect(rooms.isRoomAvailable(host, { identity: { operator: true } })).toBe(true);
        expect(rooms.isRoomAvailable(host, { identity: { operator: false } })).toBe(false);
        expect(rooms.isRoomAvailable(trading, { discord: { enabled: false } })).toBe(false);
        expect(rooms.isRoomAvailable(trading, { discord: { enabled: true } })).toBe(true);
        // Older /me payloads without a discord block are not treated as disconnected.
        expect(rooms.isRoomAvailable(trading, {})).toBe(true);
    });

    test('rooms without requirements are always available; nothing gated is available to an anonymous viewer', () => {
        expect(rooms.isRoomAvailable(rooms.ROOM_BY_ID.chat, null)).toBe(true);
        expect(rooms.isRoomAvailable(projects, null)).toBe(false);
    });

    test('explains why a room is unavailable', () => {
        expect(rooms.unavailableReason(trading, { discord: { enabled: false } })).toMatch(/not connected to Discord/);
        expect(rooms.unavailableReason(host, { identity: { operator: false } })).toMatch(/host/);
        expect(rooms.unavailableReason(projects, { features: {} })).toMatch(/not enabled/);
        expect(rooms.unavailableReason(projects, { features: { observatory: true } })).toBeNull();
    });
});

describe('start page', () => {
    test('the web registry and the settings schema accept the same values', () => {
        expect([...rooms.START_PAGES].sort()).toEqual([...START_PAGES].sort());
    });

    test('new room ids open their canonical path; Home means stay put', () => {
        expect(rooms.startPageTarget('home')).toBeNull();
        expect(rooms.startPageTarget(null)).toBeNull();
        expect(rooms.startPageTarget('chat')).toBe('/chat');
        expect(rooms.startPageTarget('knowledge')).toBe('/knowledge');
        expect(rooms.startPageTarget('projects')).toBe('/projects');
        expect(rooms.startPageTarget('discussions')).toBe('/discussions');
        expect(rooms.startPageTarget('activity')).toBe('/activity/inbox');
        expect(rooms.startPageTarget('tools')).toBe('/tools');
    });

    test('values people saved before the rename keep meaning what they meant', () => {
        expect(rooms.startPageTarget('study')).toBe('/chat');
        expect(rooms.startPageTarget('spitball')).toBe('/knowledge');
        expect(rooms.startPageTarget('parlor')).toBe('/discussions');
        expect(rooms.startPageTarget('noticed')).toBe('/activity/attention');
        expect(rooms.startPageTarget('inbox')).toBe('/activity/inbox');
        expect(rooms.startPageTarget('exchange')).toBe('/exchange');
        expect(rooms.startPageTarget('conservatory')).toBe('/conservatory');
        expect(rooms.startPageTarget('bogus')).toBeNull();
    });

    test('the Appearance select shows the option that matches a saved legacy value', () => {
        expect(rooms.startPageOptionFor('study')).toBe('chat');
        expect(rooms.startPageOptionFor('noticed')).toBe('activity');
        expect(rooms.startPageOptionFor('inbox')).toBe('activity');
        expect(rooms.startPageOptionFor('exchange')).toBe('tools');
        expect(rooms.startPageOptionFor('conservatory')).toBe('tools');
        expect(rooms.startPageOptionFor('projects')).toBe('projects');
        expect(rooms.startPageOptionFor(undefined)).toBe('home');
    });
});

describe('legacy #room/id hashes', () => {
    test.each([
        ['#study', '/chat'], ['#study/42', '/chat/42'], ['#chat/42', '/chat/42'],
        ['#parlor/7', '/discussions/7'], ['#spitball', '/knowledge'], ['#library', '/knowledge'], ['#memory', '/knowledge'],
        ['#workshop', '/projects'], ['#observatory', '/projects'],
        ['#inbox', '/activity/inbox'], ['#noticed', '/activity/attention'], ['#tasks', '/activity/scheduled'],
        ['#conservatory/rhythm', '/conservatory/rhythm'], ['#exchange', '/exchange'], ['#mtga', '/decks'], ['#decks', '/decks'],
        ['#usage', '/usage'], ['#settings', '/settings'], ['#home', '/'],
        ['#study/not-an-id', '/chat'],
        ['#nothing-here', null], ['', null]
    ])('%s → %s', (hash, target) => {
        expect(rooms.legacyHashTarget(hash)).toBe(target);
    });
});
