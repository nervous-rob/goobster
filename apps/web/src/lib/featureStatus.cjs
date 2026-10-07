/**
 * What this installation can do, as the portal reads it (#321).
 *
 * The server reports sanitized feature state at `GET /api/app/features`
 * (`{ features: { [id]: { active, reasons: [{ code, dependency? }], ... } } }`).
 * The rooms registry, the Tools cards, the nested views and the tutorial
 * list ask the helpers here instead of reading `me.features` directly.
 *
 * The *reported* value drives the interface: `active` is what the
 * installation can do. With no `data/features.json` it equals today's legacy
 * switches, so a default install renders as it always has. When the status
 * could not be fetched (an older server, a failed request) the legacy
 * `me.features` booleans keep working, so navigation never blanks.
 *
 * Three states stay apart everywhere: available, host-unavailable (this
 * file) and user-hidden (`appearance.hiddenToolRooms`, a preference).
 *
 * Titles and doc pages below are data copied from the catalog; Jest
 * (tests/featureGatingPortal.test.js) fails when they drift.
 * CommonJS so Jest can require() it; Vite interops the same file.
 */

/** Feature id to its catalog title, the portal docs page that explains it (or null) and its first catalog doc. */
const FEATURE_META = {
    core: { title: 'Core', docSlug: 'architecture', docPath: 'documentation/architecture.md' },
    discord: { title: 'Discord', docSlug: 'discord', docPath: 'documentation/discord_setup.md' },
    push: { title: 'Web Push', docSlug: 'pwa', docPath: 'documentation/pwa.md' },
    mail: { title: 'Mail', docSlug: 'accounts', docPath: 'documentation/identity.md' },
    music: { title: 'Music', docSlug: 'music-lab', docPath: 'documentation/music_lab.md' },
    voice: { title: 'Voice', docSlug: 'voice', docPath: 'documentation/voice_commands.md' },
    tavern: { title: 'Tavern', docSlug: null, docPath: 'documentation/tavern_adventure_mode.md' },
    economy: { title: 'Economy', docSlug: 'trading', docPath: 'documentation/jimbucks_exchange.md' },
    exchange: { title: 'Exchange', docSlug: 'trading', docPath: 'documentation/jimbucks_exchange.md' },
    gambling: { title: 'Gambling', docSlug: 'trading', docPath: 'documentation/jimbucks_exchange.md' },
    gba: { title: 'GBA', docSlug: null, docPath: 'documentation/goobster_plays_pokemon.md' },
    projects: { title: 'Projects', docSlug: 'projects', docPath: 'documentation/projects.md' },
    observatory: { title: 'Observatory', docSlug: 'projects', docPath: 'documentation/projects.md' },
    sandbox: { title: 'Sandbox', docSlug: 'sandbox', docPath: 'documentation/code_sandbox.md' },
    mcp: { title: 'MCP server', docSlug: null, docPath: 'documentation/mcp.md' },
    knowledge: { title: 'Knowledge', docSlug: 'research', docPath: 'documentation/user_knowledge_graph.md' },
    expeditions: { title: 'Expeditions', docSlug: 'research', docPath: 'documentation/spitball_expeditions.md' },
    github: { title: 'GitHub', docSlug: null, docPath: 'documentation/github_cursor_integration.md' },
    cursor: { title: 'Cursor agents', docSlug: null, docPath: 'documentation/github_cursor_integration.md' },
    screenVision: { title: 'Screen Vision', docSlug: null, docPath: 'documentation/screen_vision_setup.md' },
    discordActivity: { title: 'Discord Activity', docSlug: null, docPath: 'documentation/activity_setup.md' }
};

/**
 * The legacy `me.features` / `me.discord` switch a feature id maps onto,
 * used only when the status could not be fetched. `strict` ids are off when
 * the flag is missing; `discord` is off only when the server said so
 * (older /me payloads without a discord block are not "disconnected").
 */
const LEGACY_FLAGS = {
    projects: (viewer) => Boolean(viewer?.features?.projects),
    observatory: (viewer) => Boolean(viewer?.features?.observatory),
    expeditions: (viewer) => Boolean(viewer?.features?.spitball),
    discord: (viewer) => viewer?.discord?.enabled !== false
};

function featureTitle(id) {
    return FEATURE_META[id]?.title || String(id);
}

/** One entry of the fetched status, or null when it was not fetched or does not know the id. */
function statusEntry(viewer, id) {
    const entry = viewer?.featureStatus?.features?.[id];
    return entry && typeof entry === 'object' ? entry : null;
}

/** Whether the legacy switches say `id` is off (they can only ever veto, never switch a feature on). */
function legacyOff(viewer, id) {
    const flag = LEGACY_FLAGS[id];
    return Boolean(flag) && !flag(viewer);
}

/**
 * Whether a feature is active on this installation: the reported value from
 * the fetched status, vetoed by the legacy switch where one exists (the
 * running process may have an off switch the state file does not know), or
 * the legacy switch alone when no status was fetched. Features with no
 * legacy switch and no status are treated as active, as they always were.
 * `core` is always active.
 */
function featureActive(viewer, id) {
    if (id === 'core') return true;
    if (!viewer) return false;
    const entry = statusEntry(viewer, id);
    if (entry) return entry.active === true && !legacyOff(viewer, id);
    return !legacyOff(viewer, id);
}

/**
 * `{ active, reasons }` for one feature. Reasons are the server's codes
 * (`NOT_INSTALLED`, `DISABLED`, `ENV_OFF`, `DEPENDENCY_INACTIVE`,
 * `STATE_ERROR`); when only a legacy switch is off the reason is `DISABLED`.
 */
function featureAvailability(viewer, id) {
    if (featureActive(viewer, id)) return { id, active: true, reasons: [] };
    const entry = statusEntry(viewer, id);
    const reasons = entry && entry.active === false && Array.isArray(entry.reasons) && entry.reasons.length
        ? entry.reasons.map((reason) => ({ code: reason.code, ...(reason.dependency ? { dependency: reason.dependency } : {}) }))
        : [{ code: 'DISABLED' }];
    return { id, active: false, reasons };
}

/** The ids in `ids` that are not active, in order. */
function blockingFeatures(viewer, ids) {
    return (ids || []).filter((id) => !featureActive(viewer, id));
}

/**
 * One sentence saying why a feature is unavailable, from the first reason
 * code. Dependency reasons name the dependency by its catalog title.
 */
function reasonSentence(id, reasons) {
    const title = featureTitle(id);
    const reason = (reasons || [])[0];
    switch (reason?.code) {
    case 'NOT_INSTALLED':
        return `${title} is not installed on this installation.`;
    case 'ENV_OFF':
        return `${title} is turned off by a host setting.`;
    case 'DEPENDENCY_INACTIVE':
        return reason.dependency
            ? `${title} needs ${featureTitle(reason.dependency)}, which is not active on this installation.`
            : `${title} needs another feature that is not active on this installation.`;
    case 'STATE_ERROR':
        return `This installation's feature settings could not be read, so ${title} is unavailable.`;
    case 'DISABLED':
    default:
        return `${title} is turned off on this installation.`;
    }
}

/** The portal docs page (`/docs/<slug>`) that explains a feature, or null when none is published. */
function featureDocSlug(id) {
    return FEATURE_META[id]?.docSlug || null;
}

/** The first catalog doc path for a feature, for a plain-text pointer when no page is published. */
function featureDocPath(id) {
    return FEATURE_META[id]?.docPath || null;
}

module.exports = {
    FEATURE_META,
    LEGACY_FLAGS,
    featureTitle,
    featureActive,
    featureAvailability,
    blockingFeatures,
    reasonSentence,
    featureDocSlug,
    featureDocPath
};
