/**
 * Guided-tutorial catalog (Increment F1).
 *
 * Stable tutorial ids, room ownership, version, and (later) steps live here so
 * both the portal API and the Jest parity check can see them. Core must never
 * import apps/web; tests/portalRooms.test.js fails when this list drifts from
 * the tutorials arrays on apps/web/src/lib/rooms.cjs.
 *
 * F1 ships the framework with empty step lists. F2 authors the chat → note →
 * project curriculum (and the rest). Clients cannot invent tutorial or step
 * ids — unknown ids are rejected by tutorialService.
 *
 * Contract: documentation/guided_tutorials_spec.md.
 */

/** @typedef {{ id: string, anchorId?: string|null, requires?: object|null }} TutorialStep */
/** @typedef {{
 *   id: string,
 *   roomId: string,
 *   version: number,
 *   title: string,
 *   hostOnly?: boolean,
 *   requires?: object|null,
 *   steps: TutorialStep[]
 * }} TutorialDef */

/** @type {TutorialDef[]} */
const TUTORIALS = [
    { id: 'home.orientation', roomId: 'home', version: 1, title: 'Home orientation', steps: [] },
    { id: 'chat.basics', roomId: 'chat', version: 1, title: 'Chat basics', steps: [] },
    { id: 'knowledge.basics', roomId: 'knowledge', version: 1, title: 'Knowledge basics', steps: [] },
    { id: 'knowledge.research', roomId: 'knowledge', version: 1, title: 'Research', steps: [] },
    { id: 'projects.basics', roomId: 'projects', version: 1, title: 'Projects basics', requires: { feature: 'projects' }, steps: [] },
    { id: 'projects.plans', roomId: 'projects', version: 1, title: 'Plans', requires: { feature: 'projects' }, steps: [] },
    { id: 'projects.runs', roomId: 'projects', version: 1, title: 'Runs', requires: { feature: 'projects' }, steps: [] },
    { id: 'projects.apps', roomId: 'projects', version: 1, title: 'Apps', requires: { feature: 'projects' }, steps: [] },
    { id: 'discussions.basics', roomId: 'discussions', version: 1, title: 'Discussions basics', steps: [] },
    { id: 'activity.inbox', roomId: 'activity', version: 1, title: 'Inbox', steps: [] },
    { id: 'activity.scheduled', roomId: 'activity', version: 1, title: 'Scheduled', steps: [] },
    { id: 'tools.overview', roomId: 'tools', version: 1, title: 'Tools overview', steps: [] },
    { id: 'music.overview', roomId: 'music', version: 1, title: 'Music Lab overview', steps: [] },
    { id: 'music.intervals', roomId: 'music', version: 1, title: 'Intervals', steps: [] },
    { id: 'music.chords', roomId: 'music', version: 1, title: 'Chords', steps: [] },
    { id: 'music.rhythm', roomId: 'music', version: 1, title: 'Rhythm', steps: [] },
    { id: 'music.harmony', roomId: 'music', version: 1, title: 'Harmony', steps: [] },
    { id: 'music.space', roomId: 'music', version: 1, title: 'Space', steps: [] },
    { id: 'music.melody', roomId: 'music', version: 1, title: 'Melody', steps: [] },
    { id: 'music.stage', roomId: 'music', version: 1, title: 'Stage', steps: [] },
    { id: 'music.studio', roomId: 'music', version: 1, title: 'Studio', steps: [] },
    { id: 'trading.basics', roomId: 'trading', version: 1, title: 'Trading basics', requires: { discord: true }, steps: [] },
    { id: 'decks.basics', roomId: 'decks', version: 1, title: 'Decks basics', steps: [] },
    { id: 'usage.basics', roomId: 'usage', version: 1, title: 'Usage basics', steps: [] },
    { id: 'settings.basics', roomId: 'settings', version: 1, title: 'Settings basics', steps: [] },
    { id: 'memory.basics', roomId: 'settings', version: 1, title: 'Memory basics', steps: [] },
    { id: 'connections.basics', roomId: 'settings', version: 1, title: 'Connections basics', steps: [] },
    { id: 'admin.instance', roomId: 'host', version: 1, title: 'Host administration', hostOnly: true, requires: { operator: true }, steps: [] }
];

const TUTORIAL_IDS = TUTORIALS.map((t) => t.id);
const TUTORIAL_BY_ID = Object.fromEntries(TUTORIALS.map((t) => [t.id, t]));

const STATUSES = [
    'not_started',
    'in_progress',
    'paused',
    'skipped',
    'completed',
    'finished_with_skips'
];

const ACTIONS = [
    'start',
    'complete_step',
    'skip_step',
    'pause',
    'skip_tutorial',
    'finish'
];

/**
 * Whether a requires/capability gate is satisfied.
 * @param {object|null|undefined} requires
 * @param {{ features?: object, discordEnabled?: boolean, isOperator?: boolean }} caps
 */
function capabilityMet(requires, caps = {}) {
    if (!requires || typeof requires !== 'object') return true;
    if (requires.operator && !caps.isOperator) return false;
    if (requires.discord && !caps.discordEnabled) return false;
    if (requires.feature) {
        const features = caps.features || {};
        if (!features[requires.feature]) return false;
    }
    return true;
}

/**
 * A tutorial is permitted for this account when it is not host-only (or the
 * caller is an operator) and its own capability gate passes.
 */
function isTutorialPermitted(tutorial, caps = {}) {
    if (!tutorial) return false;
    if (tutorial.hostOnly && !caps.isOperator) return false;
    return capabilityMet(tutorial.requires, caps);
}

module.exports = {
    TUTORIALS,
    TUTORIAL_IDS,
    TUTORIAL_BY_ID,
    STATUSES,
    ACTIONS,
    capabilityMet,
    isTutorialPermitted
};
