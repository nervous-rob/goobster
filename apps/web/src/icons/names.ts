/**
 * The portal's glyph registry: one name per thing the navigation, room
 * views and Settings sections point at, with the emoji it replaces. Every
 * icon language in this folder must draw every name (the `Record<GlyphName,
 * …>` types make a missing glyph a type error), and `<Icon>` falls back to
 * the emoji for the `emoji` style. Contract: documentation/portal_icons.md.
 */

export const GLYPH_NAMES = [
    // rooms
    'home', 'chat', 'knowledge', 'projects', 'discussions', 'people', 'activity', 'tools',
    'music', 'trading', 'decks', 'usage', 'settings', 'host', 'docs', 'share',
    // room views
    'notes', 'map', 'compass', 'target', 'folder', 'puzzle', 'play', 'timer', 'heart', 'mail', 'calendar',
    // settings sections and shell
    'idcard', 'mic', 'palette', 'person', 'gradcap', 'moon', 'sun', 'plug', 'code', 'notebook'
] as const;

export type GlyphName = typeof GLYPH_NAMES[number];

export const GLYPH_EMOJI: Record<GlyphName, string> = {
    home: '🏠', chat: '💬', knowledge: '🧠', projects: '🔭', discussions: '🛋️', people: '👥', activity: '📥', tools: '🧰',
    music: '🎹', trading: '📊', decks: '🃏', usage: '📈', settings: '⚙️', host: '🗝️', docs: '📖', share: '🔗',
    notes: '📝', map: '🕸️', compass: '🧭', target: '🎯', folder: '📁', puzzle: '🧩', play: '▶️', timer: '⏱️', heart: '🤝', mail: '✉️', calendar: '🗓️',
    idcard: '🪪', mic: '🎙️', palette: '🎨', person: '👤', gradcap: '🎓', moon: '🌙', sun: '☀️', plug: '🔌', code: '🐙', notebook: '📓'
};

/** Room id (lib/rooms.cjs) → glyph. */
export const ROOM_GLYPH: Record<string, GlyphName> = {
    home: 'home', chat: 'chat', knowledge: 'knowledge', projects: 'projects', discussions: 'discussions', people: 'people',
    activity: 'activity', tools: 'tools', music: 'music', trading: 'trading', decks: 'decks', usage: 'usage',
    settings: 'settings', host: 'host', docs: 'docs', share: 'share'
};

/** Room view id → glyph. Views that reuse a room's icon reuse its glyph. */
export const VIEW_GLYPH: Record<string, GlyphName> = {
    notes: 'notes', map: 'map', research: 'compass',
    overview: 'projects', plan: 'target', conversation: 'chat', knowledge: 'knowledge', files: 'folder', apps: 'puzzle',
    runs: 'play', people: 'people', automations: 'timer',
    friends: 'heart', messages: 'mail',
    inbox: 'activity', attention: 'compass', scheduled: 'calendar'
};

/** Settings section id → glyph. */
export const SECTION_GLYPH: Record<string, GlyphName> = {
    profile: 'idcard', chat: 'chat', voice: 'mic', initiative: 'compass', memory: 'knowledge',
    connections: 'share', appearance: 'palette', account: 'person', tutorials: 'gradcap'
};

/** Connection provider → glyph (Settings → Connections cards). */
export const PROVIDER_GLYPH: Record<string, GlyphName> = { github: 'code', notion: 'notebook' };
