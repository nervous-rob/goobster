/**
 * Guided-tutorial catalog (Increments F1–F2).
 *
 * Stable tutorial ids, room ownership, version, and steps live here so both
 * the portal API and the Jest parity check can see them. Core must never
 * import apps/web; tests/portalRooms.test.js fails when this list drifts from
 * the tutorials arrays on apps/web/src/lib/rooms.cjs.
 *
 * F1 shipped the framework. F2 authors the E2/E4 demonstration tours
 * (home.orientation, chat.basics, knowledge.basics, projects.apps) with
 * isolated sample content from tutorialSamples.js. Other catalog entries
 * remain empty until a later package. Clients cannot invent tutorial or
 * step ids — unknown ids are rejected by tutorialService.
 *
 * Contract: documentation/guided_tutorials_spec.md.
 */

/** @typedef {{
 *   id: string,
 *   title?: string,
 *   body?: string,
 *   anchorId?: string|null,
 *   path?: string|null,
 *   demo?: string|null,
 *   keepablePieceId?: string|null,
 *   requires?: object|null
 * }} TutorialStep */
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
    {
        id: 'home.orientation',
        roomId: 'home',
        version: 2,
        title: 'Home orientation',
        steps: [
            {
                id: 'doors',
                title: 'Three doors',
                body: 'Chat works through a question. Knowledge keeps what you chose to save. Projects carry work that has a goal. Start from these three.',
                anchorId: 'home-create',
                path: '/'
            },
            {
                id: 'private-audience',
                title: 'Private by default',
                body: 'Your chats, notes, and projects start Private — only you. Sharing is an explicit later choice, never an automatic side effect.',
                anchorId: 'home-private',
                path: '/'
            },
            {
                id: 'chat-to-note',
                title: 'From chat to a note',
                body: 'In the Weekend field notebook example, an answer about the coastal walk becomes a saved note. The note is knowledge you kept — not personal memory Goobster distilled.',
                path: '/',
                demo: 'chat-to-note'
            },
            {
                id: 'note-to-project',
                title: 'Into a project',
                body: 'The same note can be referenced from a private project you own, or published as a copy into shared work. The example project stays Private and sample-only until you Keep it.',
                path: '/',
                demo: 'note-to-project'
            },
            {
                id: 'activity',
                title: 'Activity',
                body: 'Reminders, task results, and notices land in Activity → Inbox. One delivery is named once — here and in Discord when connected.',
                anchorId: 'home-activity',
                path: '/'
            },
            {
                id: 'settings-tutorials',
                title: 'Settings and tutorials',
                body: 'Personal settings and every tour live under Settings. Pause, skip, resume, or reset a tour anytime — resetting never changes your notes or tools.',
                anchorId: 'nav-settings',
                path: '/'
            }
        ]
    },
    {
        id: 'chat.basics',
        roomId: 'chat',
        version: 2,
        title: 'Chat basics',
        steps: [
            {
                id: 'sample-answer',
                title: 'A sample answer',
                body: 'Here is a finished sample turn about the coastal walk — no model call runs in a tour. Look at the answer, then see where it can go next.',
                path: '/chat',
                demo: 'sample-answer',
                anchorId: 'chat-composer'
            },
            {
                id: 'save-as-note',
                title: 'Save as note',
                body: 'Save as note keeps the answer under Knowledge → Notes with curation “saved”. It never appears under Personal memory. Incognito chats do not offer it.',
                path: '/chat',
                demo: 'save-as-note',
                anchorId: 'chat-save-as-note',
                keepablePieceId: 'note-anemones'
            },
            {
                id: 'add-to-project',
                title: 'Add to a project',
                body: 'From the note you can Add to project… — a reference into a private project you own, or a published copy when others can read. The tour only shows the sample; nothing is filed until you Keep an example.',
                path: '/chat',
                demo: 'add-to-project'
            }
        ]
    },
    {
        id: 'knowledge.basics',
        roomId: 'knowledge',
        version: 2,
        title: 'Knowledge basics',
        steps: [
            {
                id: 'create-note',
                title: 'A kept note',
                body: 'A sample observation about the field trip appears with a title, body, and Private label. This is knowledge you keep — separate from what Goobster remembers about you.',
                path: '/knowledge/notes',
                demo: 'create-note',
                anchorId: 'knowledge-new-note',
                keepablePieceId: 'note-anemones'
            },
            {
                id: 'connect-tags',
                title: 'Shared tags',
                body: 'Two sample notes share the tag “observation”. On the Map, that tag is the link between them — Notes and Map always show the same projection.',
                path: '/knowledge/map',
                demo: 'connect-tags',
                anchorId: 'knowledge-map'
            },
            {
                id: 'reuse-in-project',
                title: 'Add to a project',
                body: 'Add selected knowledge to the sample private project as a reference. A collaborator added later still cannot see a private reference — only a published copy would travel.',
                path: '/knowledge/notes',
                demo: 'reuse-in-project',
                anchorId: 'knowledge-notes'
            },
            {
                id: 'research-door',
                title: 'Research',
                body: 'Research (Expeditions) is where longer investigations run. It has its own tutorial; opening this door does not complete that tour.',
                path: '/knowledge/research',
                anchorId: 'knowledge-view-research'
            },
            {
                id: 'memory-boundary',
                title: 'Personal memory stays separate',
                body: 'Personal memory lives in Settings → Memory & privacy. Deleting a note does not erase the raw memories it came from, and forgetting a memory does not delete a note you kept.',
                path: '/knowledge/notes',
                anchorId: 'knowledge-personal-memory'
            }
        ]
    },
    { id: 'knowledge.research', roomId: 'knowledge', version: 1, title: 'Research', steps: [] },
    { id: 'projects.basics', roomId: 'projects', version: 1, title: 'Projects basics', requires: { feature: 'projects' }, steps: [] },
    { id: 'projects.plans', roomId: 'projects', version: 1, title: 'Plans', requires: { feature: 'projects' }, steps: [] },
    { id: 'projects.runs', roomId: 'projects', version: 1, title: 'Runs', requires: { feature: 'projects' }, steps: [] },
    {
        id: 'projects.apps',
        roomId: 'projects',
        version: 2,
        title: 'Apps',
        requires: { feature: 'projects' },
        steps: [
            {
                id: 'open-unfiled',
                title: 'Unfiled apps',
                body: 'Mini-apps built in Chat that do not live in a project yet appear under Unfiled apps on the Projects list.',
                path: '/projects',
                demo: 'open-unfiled',
                anchorId: 'project-unfiled-apps'
            },
            {
                id: 'inspect-origin',
                title: 'Where it came from',
                body: 'The sample Tide-pool counter was generated in a Chat turn. Inspecting origin never re-runs the model in a tour.',
                path: '/projects',
                demo: 'inspect-origin'
            },
            {
                id: 'add-to-sample-project',
                title: 'Into the sample project',
                body: 'Add the unfiled app to the Weekend field notebook sample project. The tour shows the hop; your real Unfiled list is untouched unless you Keep an example later.',
                path: '/projects',
                demo: 'add-to-sample-project'
            },
            {
                id: 'inspect-audience',
                title: 'Audience',
                body: 'The sample project is Private — only you. Publishing or inviting someone is a separate, explicit action outside the tour.',
                path: '/projects',
                demo: 'inspect-audience'
            }
        ]
    },
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
