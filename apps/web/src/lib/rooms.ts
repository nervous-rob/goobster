// ESM façade so Vite/TS named-import the CommonJS room registry. The data
// and resolvers live in rooms.cjs (Jest requires it directly); the types
// live here.
import registry from './rooms.cjs';

export type RoomGroup = 'primary' | 'tools' | 'account' | 'public';

export type RoomRequirement = {
    feature?: 'observatory' | 'spitball';
    operator?: boolean;
    discord?: boolean;
};

export type ActivityViewId = 'inbox' | 'attention' | 'scheduled';
export type KnowledgeViewId = 'notes' | 'map' | 'research';
export type RoomViewId = ActivityViewId | KnowledgeViewId;

/** A registered view inside a room (Activity's Inbox/Attention/Scheduled, Knowledge's Notes/Map/Research). */
export type RoomView<Id extends RoomViewId = RoomViewId> = {
    id: Id;
    name: string;
    secondaryName?: string;
    icon: string;
    path: string;
    legacyIds?: string[];
};

export type ActivityView = RoomView<ActivityViewId>;
export type KnowledgeView = RoomView<KnowledgeViewId>;

export type RoomId =
    | 'home' | 'chat' | 'knowledge' | 'projects' | 'discussions' | 'activity' | 'tools'
    | 'music' | 'trading' | 'decks'
    | 'usage' | 'settings' | 'host'
    | 'share';

export type Room = {
    id: RoomId;
    name: string;
    secondaryName?: string;
    icon: string;
    path: string;
    group: RoomGroup;
    parent?: RoomId;
    atmosphere: string;
    requires?: RoomRequirement;
    legacyIds?: string[];
    count?: 'inbox';
    blurb?: string;
    unavailable?: string;
    tutorials: string[];
    views?: RoomView[];
};

export type Alias = { from: string; to: string; landing?: boolean };

export type StartPage =
    | 'home' | 'chat' | 'knowledge' | 'projects' | 'discussions' | 'activity' | 'tools'
    | 'study' | 'spitball' | 'parlor' | 'noticed' | 'inbox' | 'exchange' | 'conservatory';

export type StartPageOption = { value: StartPage; label: string };

/** The slice of `Me` the registry needs to decide availability. */
export type RoomViewer = {
    features?: { observatory?: boolean; spitball?: boolean };
    identity?: { operator?: boolean };
    discord?: { enabled?: boolean };
} | null | undefined;

type Registry = {
    ROOMS: Room[];
    ROOM_BY_ID: Record<RoomId, Room>;
    ALIASES: Alias[];
    PRIMARY_ROOMS: Room[];
    ACCOUNT_ROOMS: Room[];
    TOOL_ROOMS: Room[];
    START_PAGE_OPTIONS: StartPageOption[];
    START_PAGES: StartPage[];
    LEGACY_START_PAGES: Record<string, string>;
    normalize: (pathname: string) => string;
    canonicalPath: (pathname: string) => string;
    isLegacyPath: (pathname: string) => boolean;
    resolveRoom: (pathname: string) => RoomId;
    parentRoom: (roomId: RoomId) => RoomId;
    resolveRoomView: (roomId: RoomId, pathname: string) => RoomViewId | null;
    resolveActivityView: (pathname: string) => ActivityViewId | null;
    resolveKnowledgeView: (pathname: string) => KnowledgeViewId | null;
    atmosphereFor: (roomId: string) => string;
    roomDisplayName: (pathname: string) => string;
    isRoomAvailable: (room: Room, me: RoomViewer) => boolean;
    unavailableReason: (room: Room, me: RoomViewer) => string | null;
    startPageTarget: (value: string | null | undefined) => string | null;
    startPageOptionFor: (value: string | null | undefined) => StartPage;
    legacyHashTarget: (hash: string) => string | null;
};

const rooms = registry as unknown as Registry;

export const ROOMS = rooms.ROOMS;
export const ROOM_BY_ID = rooms.ROOM_BY_ID;
export const ALIASES = rooms.ALIASES;
export const PRIMARY_ROOMS = rooms.PRIMARY_ROOMS;
export const ACCOUNT_ROOMS = rooms.ACCOUNT_ROOMS;
export const TOOL_ROOMS = rooms.TOOL_ROOMS;
export const START_PAGE_OPTIONS = rooms.START_PAGE_OPTIONS;
export const START_PAGES = rooms.START_PAGES;
export const normalize = rooms.normalize;
export const canonicalPath = rooms.canonicalPath;
export const isLegacyPath = rooms.isLegacyPath;
export const resolveRoom = rooms.resolveRoom;
export const parentRoom = rooms.parentRoom;
export const resolveRoomView = rooms.resolveRoomView;
export const resolveActivityView = rooms.resolveActivityView;
export const resolveKnowledgeView = rooms.resolveKnowledgeView;
export const atmosphereFor = rooms.atmosphereFor;
export const roomDisplayName = rooms.roomDisplayName;
export const isRoomAvailable = rooms.isRoomAvailable;
export const unavailableReason = rooms.unavailableReason;
export const startPageTarget = rooms.startPageTarget;
export const startPageOptionFor = rooms.startPageOptionFor;
export const legacyHashTarget = rooms.legacyHashTarget;
