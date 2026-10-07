/**
 * Feature ownership inventory (P1.1 of the installer plan, issue #316).
 *
 * Every optional surface of Goobster (slash commands, runtime steps, AI
 * tools, MCP tools, HTTP routes, tables, portal rooms, tutorials, ...) is
 * claimed here by exactly one feature id. The P1.2 catalog is generated from
 * this data and `tests/featureInventory.test.js` enumerates the code and
 * fails when a surface is unclaimed, a claim is stale, or a route rule never
 * matches.
 *
 * This file is plain data: it requires nothing, reads no config and touches
 * no database, so any process (including a bare `node -e`) can load it.
 * Add the item you introduced to the right section; `core` is the owner of
 * anything that must stay available with every optional feature off.
 *
 * A value is either an owner id or `{ owner, alsoRequires: [ids] }`.
 * `alsoRequires` records soft requirements of one surface; the hard graph
 * lives in `FEATURES[id].dependsOn`.
 */

const FEATURE_IDS = [
    'core',
    'discord',
    'push',
    'mail',
    'music',
    'voice',
    'tavern',
    'economy',
    'exchange',
    'gambling',
    'gba',
    'projects',
    'observatory',
    'sandbox',
    'mcp',
    'knowledge',
    'expeditions',
    'github',
    'cursor',
    'screenVision',
    'discordActivity'
];

const FEATURES = {
    core: { kind: 'pseudo-owner', dependsOn: [], freshDefault: 'always' },
    discord: { kind: 'adapter', dependsOn: [], legacySwitch: 'discord.enabled', freshDefault: 'on' },
    push: { kind: 'adapter', dependsOn: [], legacySwitch: 'webapp.push.enabled', freshDefault: 'on' },
    mail: { kind: 'adapter', dependsOn: [], legacySwitch: 'mail.provider', freshDefault: 'on' },
    music: { kind: 'feature', dependsOn: [], freshDefault: 'on' },
    voice: { kind: 'feature', dependsOn: [], freshDefault: 'on' },
    tavern: { kind: 'feature', dependsOn: [], freshDefault: 'on' },
    economy: { kind: 'feature', dependsOn: [], freshDefault: 'off' },
    exchange: { kind: 'feature', dependsOn: ['economy'], freshDefault: 'off' },
    gambling: { kind: 'feature', dependsOn: ['economy'], freshDefault: 'off' },
    gba: {
        kind: 'feature',
        dependsOn: [],
        legacySwitch: 'gbaRun.enabled',
        freshDefault: 'on',
        note: 'Fresh default follows #261 (on) but the legacy switch defaults off today; owner confirmation pending.'
    },
    projects: { kind: 'feature', dependsOn: [], legacySwitch: 'projects.enabled', freshDefault: 'on' },
    observatory: {
        kind: 'feature',
        dependsOn: ['projects', 'sandbox'],
        legacySwitch: 'observatory.enabled',
        freshDefault: 'on'
    },
    sandbox: { kind: 'feature', dependsOn: [], legacySwitch: 'sandbox.enabled', freshDefault: 'on' },
    mcp: { kind: 'feature', dependsOn: [], legacySwitch: 'mcp.enabled', freshDefault: 'on' },
    knowledge: { kind: 'feature', dependsOn: [], freshDefault: 'on' },
    expeditions: { kind: 'feature', dependsOn: ['knowledge'], legacySwitch: 'spitball.enabled', freshDefault: 'on' },
    github: { kind: 'feature', dependsOn: [], legacySwitch: 'github.token', freshDefault: 'on' },
    cursor: { kind: 'feature', dependsOn: ['github'], legacySwitch: 'cursor.apiKey', freshDefault: 'on' },
    screenVision: { kind: 'feature', dependsOn: [], legacySwitch: 'screenVision.enabled', freshDefault: 'on' },
    discordActivity: { kind: 'feature', dependsOn: ['discord'], legacySwitch: 'activity.enabled', freshDefault: 'on' }
};

const PLAYBACK = { owner: 'music', alsoRequires: ['voice', 'discord'] };
const WHEEL_OR_PREDICTIONS = { owner: 'gambling', alsoRequires: ['exchange'] };
const VOICE_IN_DISCORD = { owner: 'voice', alsoRequires: ['discord'] };

/** Keyed by path relative to apps/bot/commands/. */
const commands = {
    'chat/chat.js': 'core',
    'chat/joke.js': 'core',
    'chat/poem.js': 'core',
    'chat/recall.js': 'core',
    'chat/speak.js': VOICE_IN_DISCORD,
    'chat/voicechat.js': VOICE_IN_DISCORD,
    'economy/exchange.js': 'exchange',
    'economy/futures.js': 'exchange',
    'economy/gamble.js': 'gambling',
    'economy/margin.js': 'exchange',
    'economy/options.js': 'exchange',
    'economy/orders.js': 'exchange',
    'economy/points.js': 'economy',
    'economy/predict.js': WHEEL_OR_PREDICTIONS,
    'economy/stocks.js': 'exchange',
    'economy/wheel.js': WHEEL_OR_PREDICTIONS,
    'image/generate.js': 'core',
    'music/aidj.js': PLAYBACK,
    'music/generateallambience.js': 'music',
    'music/generateallmusic.js': 'music',
    'music/generateambience.js': 'music',
    'music/generatemusic.js': 'music',
    'music/music.js': PLAYBACK,
    'music/play.js': PLAYBACK,
    'music/playambience.js': PLAYBACK,
    'music/playmusic.js': PLAYBACK,
    'music/playtrack.js': PLAYBACK,
    'music/spotdl.js': 'music',
    'music/stopambience.js': PLAYBACK,
    'music/stopmusic.js': PLAYBACK,
    'settings/aisettings.js': 'core',
    'settings/dynamicresponse.js': 'core',
    'settings/instructions.js': 'core',
    'settings/integrations.js': 'core',
    'settings/memory.js': 'core',
    'settings/monologue.js': 'core',
    'settings/nickname.js': 'core',
    'settings/personalitydirective.js': 'core',
    'settings/privacy.js': 'core',
    'settings/proactive.js': 'core',
    'settings/replydetection.js': 'core',
    'settings/requiresearchapproval.js': 'core',
    'settings/thoughtfulmode.js': 'core',
    'settings/threadpreference.js': 'core',
    'tavern/adventure.js': 'tavern',
    'tavern/character.js': 'tavern',
    'tavern/roll.js': 'tavern',
    'tavern/tavern.js': 'tavern',
    'tavern/world.js': 'tavern',
    'utility/agent.js': 'cursor',
    'utility/attention.js': 'core',
    'utility/automation.js': 'core',
    'utility/cleanup.js': 'core',
    'utility/createUser.js': 'core',
    'utility/diagdb.js': 'core',
    'utility/digest.js': 'core',
    'utility/forgetMe.js': 'core',
    'utility/gbarun.js': 'gba',
    'utility/github.js': 'github',
    'utility/help.js': 'core',
    'utility/memeMode.js': 'core',
    'utility/ping.js': 'core',
    'utility/resetChatData.js': 'core',
    'utility/screenvision.js': 'screenVision',
    'utility/search.js': 'core',
    'utility/server.js': 'core',
    'utility/systemstatus.js': 'core',
    'utility/usage.js': 'core',
    'utility/user.js': 'core',
    'utility/whatDoYouKnowAboutMe.js': 'core',
    'utility/whatsnew.js': 'core',
    'utility/wrapped.js': 'core',
    'voice/setvoice.js': VOICE_IN_DISCORD
};

const contextMenus = {
    'music/contextMenu.js': PLAYBACK
};

/** Keyed by the name passed to step() in runtime/coreRuntime.js. */
const runtimeSteps = {
    eventBus: 'core',
    chatHistoryRetention: 'core',
    accountExports: 'core',
    paused: 'core',
    selfDocs: 'core',
    workshopPinMigration: 'projects',
    observatoryResume: 'observatory',
    missionReconcile: 'projects',
    projectTriggerCatchUp: 'projects',
    automation: 'core',
    followupDelivery: 'core',
    personalHeartbeat: 'core',
    spitballExpeditions: 'expeditions',
    memoryConsolidation: 'core',
    knowledgeReflection: 'core',
    ledgerRetention: 'core',
    heartbeat: 'core',
    agentTracker: 'cursor',
    monologue: 'core',
    exchangeRiskEngine: 'exchange'
};

/**
 * Discord client listeners (apps/bot/index.js and apps/bot/events/), the
 * ordered messageCreate gates, and the other subscribers that can consume an
 * event. Gate numbers follow execution order in events/messageCreate.js.
 */
const eventGates = {
    messageCreate: 'core',
    'messageCreate#01 reply-tail record': 'core',
    'messageCreate#02 ignore bots': 'core',
    'messageCreate#03 partial resolve': 'core',
    'messageCreate#04 DM direct chat': 'core',
    'messageCreate#05 activity counters': 'core',
    'messageCreate#06 agent mission-control threads': 'cursor',
    'messageCreate#07 address detection': 'core',
    'messageCreate#08 reply-to-edit': 'core',
    'messageCreate#09 explicit address': 'core',
    'messageCreate#10 GBA advice inbox': 'gba',
    'messageCreate#11 reply detection': 'core',
    'messageCreate#12 dynamic response': 'core',
    interactionCreate: 'core',
    ClientReady: 'core',
    InteractionCreate: 'core',
    messageReactionAdd: 'core',
    'messageReactionAdd:issue-capture': 'github',
    messageReactionRemove: 'core',
    voiceStateUpdate: 'voice',
    musicTrackStarted: 'music',
    musicTrackEnded: 'music',
    error: 'core',
    warn: 'core',
    debug: 'core',
    invalidated: 'core',
    rateLimit: 'core',
    cacheSweep: 'core',
    shardError: 'core',
    'domainEventBus:attention': 'core',
    'domainEventBus:watches': 'core',
    'eventBusService:settings-cache': 'core'
};

/**
 * Button router tokens (second `_` segment of a customId, see
 * events/interactionCreate.js) and the collector-scoped ids that are not
 * routed there (keyed `collector:<customId>`).
 */
const interactionTypes = {
    tavern: 'tavern',
    parlorinvite: 'core',
    projectinvite: 'projects',
    sbxreq: 'sandbox',
    accessreq: 'core',
    friendreq: 'core',
    intaction: 'core',
    search: 'core',
    'collector:forgetme_confirm': 'core',
    'collector:forgetme_cancel': 'core',
    'collector:tavernretire_confirm': 'tavern',
    'collector:tavernretire_cancel': 'tavern',
    'collector:clear_search_button': 'music',
    'collector:pause': PLAYBACK,
    'collector:skip': PLAYBACK,
    'collector:stop': PLAYBACK,
    'collector:resume': PLAYBACK
};

/** Keyed by toolsRegistry TOOL_ORDER name, plus the provider-native web_search. */
const aiTools = {
    performSearch: 'core',
    generateImage: 'core',
    runCode: 'sandbox',
    observatory: 'observatory',
    requestPythonPackages: 'sandbox',
    findImages: 'core',
    fetchWebFile: 'core',
    showSavedFiles: 'core',
    playTrack: PLAYBACK,
    setNickname: 'discord',
    speakMessage: VOICE_IN_DISCORD,
    setSpeechAccent: 'voice',
    echoMessage: 'core',
    rememberFact: 'core',
    forgetFact: 'core',
    saveArtifact: 'core',
    lookupNotes: 'core',
    consultDocs: 'core',
    checkPoints: 'economy',
    gamblePoints: 'gambling',
    tavernInfo: 'tavern',
    tavernParty: 'tavern',
    tavernAct: 'tavern',
    tavernAttack: 'tavern',
    tavernTwist: 'tavern',
    tavernRecap: 'tavern',
    rollDice: 'tavern',
    manageParlor: 'core',
    stockQuote: 'exchange',
    tradeStock: 'exchange',
    checkPortfolio: 'exchange',
    optionChain: 'exchange',
    tradeOption: 'exchange',
    shortStock: 'exchange',
    marginAccount: 'exchange',
    exchangeOrder: 'exchange',
    eventContracts: WHEEL_OR_PREDICTIONS,
    tradeSpread: 'exchange',
    tradePerp: 'exchange',
    goblinWheel: WHEEL_OR_PREDICTIONS,
    auditAccount: 'exchange',
    auditExchange: 'exchange',
    manageAutomations: 'core',
    scheduleFollowUp: 'core',
    trackAttention: 'core',
    watchFor: 'core',
    searchGithubCode: 'github',
    readGithubFile: 'github',
    searchNotion: 'core',
    readNotionPage: 'core',
    launchCursorAgent: 'cursor',
    createGithubIssue: 'github',
    executePlan: 'core',
    web_search: 'core'
};

/** Core MCP tools by name; the GBA harness tools are keyed `gba:<name>`. */
const mcpTools = {
    list_docs: 'core',
    search_docs: 'core',
    read_doc: 'core',
    search_memories: 'core',
    list_facts: 'core',
    search_knowledge: 'knowledge',
    list_projects: 'projects',
    get_project: 'projects',
    list_project_files: 'projects',
    list_inbox: 'core',
    get_inbox_item: 'core',
    list_expeditions: 'expeditions',
    get_expedition: 'expeditions',
    list_briefs: 'expeditions',
    get_brief: 'expeditions',
    'gba:get_screen': 'gba',
    'gba:press_buttons': 'gba',
    'gba:wait': 'gba',
    'gba:save_state': 'gba',
    'gba:load_state': 'gba',
    'gba:get_status': 'gba',
    'gba:read_memory': 'gba'
};

const mcpResources = {
    'goobster://docs/{slug}': 'core',
    'goobster://briefs/{id}': 'expeditions'
};

/**
 * Ordered, first match wins. `method` is optional (any method when omitted);
 * `pattern` is tested against the full mounted path. Paths are the Express
 * route strings (`:param`, `*`), not concrete URLs.
 */
const routeRules = [
    { method: 'POST', pattern: /^\/api\/app\/projects\/[^/]+\/chat$/, owner: 'observatory' },
    { method: 'GET', pattern: /^\/api\/app\/projects\/[^/]+\/conversation$/, owner: 'observatory' },
    { method: 'POST', pattern: /^\/api\/app\/observatory\/command$/, owner: 'observatory' },
    { method: 'POST', pattern: /^\/api\/app\/observatory\/jobs\/[^/]+\/cancel$/, owner: 'observatory' },
    { method: 'POST', pattern: /^\/api\/app\/observatory\/jobs\/[^/]+\/resume$/, owner: 'observatory' },
    { method: 'POST', pattern: /^\/api\/app\/observatory\/projects\/[^/]+\/render$/, owner: 'observatory' },
    { method: 'POST', pattern: /^\/api\/app\/projects\/[^/]+\/assets\/[^/]+\/run$/, owner: 'observatory' },
    { pattern: /^\/api\/app\/(?:projects|observatory)(?:\/|$)/, owner: 'projects' },
    { method: 'GET', pattern: /^\/app\/observatory\/share\//, owner: 'projects' },

    { pattern: /^\/api\/app\/spitball\/(?:lenses|expeditions|briefs)(?:\/|$)/, owner: 'expeditions' },
    { method: 'GET', pattern: /^\/api\/app\/spitball\/notes\/[^/]+\/evidence$/, owner: 'expeditions' },
    { pattern: /^\/api\/app\/spitball(?:\/|$)/, owner: 'knowledge' },
    { pattern: /^\/api\/app\/note-attachments(?:\/|$)/, owner: 'knowledge' },

    { pattern: /^\/api\/app\/exchange\//, owner: 'exchange' },
    { pattern: /^\/api\/app\/voice\//, owner: 'voice' },
    { pattern: /^\/api\/app\/studio\//, owner: 'music' },
    { pattern: /^\/api\/app\/push(?:\/|$)/, owner: 'push' },
    { pattern: /^\/api\/app\/mcp(?:\/|$)/, owner: 'core' },
    { method: 'GET', pattern: /^\/api\/app\/auth\/(?:login|link\/discord|callback)$/, owner: 'discord' },

    { pattern: /^\/api\/app\/(?:config|me|features|auth|account|admin|settings)(?:\/|$)/, owner: 'core' },
    { pattern: /^\/api\/app\/(?:chat|share|files|tasks)(?:\/|$)/, owner: 'core' },
    { pattern: /^\/api\/app\/(?:usage|integrations|memory|graph|home|privacy|attention|applets|mtga)(?:\/|$)/, owner: 'core' },
    { pattern: /^\/api\/app\/parlor\//, owner: 'core' },
    { pattern: /^\/api\/app\/(?:inbox|conversation-context|people|friends|dm)(?:\/|$)/, owner: 'core' },
    { pattern: /^\/api\/app\/followed-sources(?:\/|$)/, owner: 'core' },
    { pattern: /^\/api\/app\/(?:tutorials|tutorial-preferences)(?:\/|$)/, owner: 'core' },
    { method: 'GET', pattern: /^\/api\/app\/events$/, owner: 'core' },
    { pattern: /^\/app(?:\/|$)/, owner: 'core' },

    { pattern: /^\/api\/activity\//, owner: 'discordActivity' },
    { method: 'POST', pattern: /^\/api\/webhooks\/github$/, owner: 'github' },
    { method: 'POST', pattern: /^\/api\/webhooks\/cursor$/, owner: 'cursor' },
    { pattern: /^\/api\/screen\//, owner: 'screenVision' },
    { method: 'GET', pattern: /^\/companion(?:\.js)?$/, owner: 'screenVision' },
    { pattern: /^\/api\/gba-run\//, owner: 'gba' },
    { pattern: /^\/internal\/gateway\//, owner: 'discord' },
    { pattern: /^\/mcp(?:\/|$)/, owner: 'mcp' },
    { method: 'GET', pattern: /^\/health$/, owner: 'core' },
    { method: 'POST', pattern: /^\/(?:run|cancel)$/, owner: 'sandbox' },

    { pattern: /^\/api\/guilds\/[^/]+\/voicechat(?:\/|$)/, owner: 'voice' },
    { method: 'GET', pattern: /^\/api\/guilds\/[^/]+\/playlists$/, owner: 'music' },
    { pattern: /^\/api\/guilds\/[^/]+\/memory\//, owner: 'core' },
    { pattern: /^\/api\/guilds(?:\/|$)/, owner: 'discord' },
    { pattern: /^\/api\/settings\/tts-/, owner: 'voice' },
    { pattern: /^\/api\/(?:music|tracks)(?:\/|$)/, owner: 'music' },
    { method: 'GET', pattern: /^\/api\/(?:status|system|ai\/models)$/, owner: 'core' }
];

const wsPaths = {
    '/api/app/parlor/live': 'core',
    '/api/app/voice/live': 'voice',
    '/api/app/studio/live': 'music',
    '/api/activity/ws': 'discordActivity',
    '/api/screen/ws': 'screenVision',
    '/api/gba-run/ws': 'gba'
};

/**
 * URL prefix (or exact file) to owner; the longest matching key wins. Keys
 * ending in `/` match only themselves: `/` is the Activity client served at
 * the root of the public server and `panel:/` is the management panel UI.
 */
const staticAssets = {
    '/app': 'core',
    '/app/assets': 'core',
    '/app/vendor/katex': 'core',
    '/app/manifest.webmanifest': 'core',
    '/app/sw.js': 'core',
    '/app/offline.html': 'core',
    '/app/style.css': 'core',
    '/app/liveAudioWorklet.js': 'core',
    '/app/icons': 'core',
    '/app/screenshots': 'core',
    '/activity': 'discordActivity',
    '/activity/vendor/embedded-app-sdk': 'discordActivity',
    '/': 'discordActivity',
    'panel:/': 'core',
    '/companion': 'screenVision',
    '/companion.js': 'screenVision'
};

/** Portal room id to owner (apps/web/src/lib/rooms.cjs). */
const rooms = {
    home: 'core',
    chat: 'core',
    knowledge: 'knowledge',
    projects: 'projects',
    discussions: 'core',
    people: 'core',
    activity: 'core',
    tools: 'core',
    music: 'music',
    trading: { owner: 'exchange', alsoRequires: ['discord'] },
    decks: 'core',
    usage: 'core',
    settings: 'core',
    host: 'core',
    docs: 'core',
    share: 'core'
};

/** Tutorial id to `{ owner, requires }`; `requires` lists what the catalog declares today beyond the owner. */
const tutorials = {
    'projects.basics': { owner: 'projects', requires: [] },
    'projects.plans': { owner: 'projects', requires: [] },
    'projects.runs': { owner: 'projects', requires: [] },
    'projects.apps': { owner: 'projects', requires: [] },
    'activity.inbox': { owner: 'core', requires: [] },
    'activity.scheduled': { owner: 'core', requires: [] },
    'settings.basics': { owner: 'core', requires: [] },
    'memory.basics': { owner: 'core', requires: [] },
    'connections.basics': { owner: 'core', requires: [] },
    'usage.basics': { owner: 'core', requires: [] },
    'admin.instance': { owner: 'core', requires: [] },
    'home.first-task': { owner: 'core', requires: [] },
    'home.orientation': { owner: 'core', requires: [] },
    'chat.basics': { owner: 'core', requires: [] },
    'knowledge.basics': { owner: 'knowledge', requires: [] },
    'knowledge.research': { owner: 'expeditions', requires: [] },
    'discussions.basics': { owner: 'core', requires: [] },
    'tools.overview': { owner: 'core', requires: [] },
    'music.overview': { owner: 'music', requires: [] },
    'music.intervals': { owner: 'music', requires: [] },
    'music.chords': { owner: 'music', requires: [] },
    'music.rhythm': { owner: 'music', requires: [] },
    'music.harmony': { owner: 'music', requires: [] },
    'music.space': { owner: 'music', requires: [] },
    'music.melody': { owner: 'music', requires: [] },
    'music.stage': { owner: 'music', requires: [] },
    'music.studio': { owner: 'music', requires: [] },
    'trading.basics': { owner: 'exchange', requires: ['discord'] },
    'decks.basics': { owner: 'core', requires: [] }
};

/**
 * Every table in db/schema.sql resolves through `exact` first, then the
 * longest matching prefix.
 */
const tables = {
    exact: {
        users: 'core',
        prompts: 'core',
        conversations: 'core',
        messages: 'core',
        facts: 'core',
        followups: 'core',
        automations: 'core',
        UserPreferences: 'core',
        command_log: 'core',
        usage_log: 'core',
        system_logs: 'core',
        data_migrations: 'core',
        self_docs: 'core',
        principals: 'core',
        app_accounts: 'core',
        instance_state: 'core',
        inbox_items: 'core',
        access_requests: 'core',
        heartbeat_state: 'core',
        pending_search_requests: 'core',
        pending_searches: 'core',
        knowledge_transfers: 'core',
        friendships: 'core',
        followed_sources: 'core',
        followed_source_entries: 'core',
        source_fetch_hosts: 'core',
        conversation_contexts: 'core',
        admission_locks: 'core',
        execution_admissions: 'core',
        work_failures: 'core',
        resource_events: 'core',
        usage_reservations: 'core',
        operator_audit: 'core',
        auth_identities: 'core',
        password_credentials: 'core',
        recovery_tokens: 'core',
        oauth_link_states: 'core',
        email_tokens: 'core',
        pending_registrations: 'core',
        guild_activity: 'core',
        guild_conversations: 'core',
        guild_settings: 'core',
        conversation_summaries: 'core',
        monologue_thoughts: 'core',
        monologue_scratchpad: 'core',
        user_integrations: 'core',
        mtga_folders: 'core',
        mtga_decks: 'core',
        mtga_deck_cards: 'core',
        mtga_cards: 'core',
        web_applets: 'core',
        economy_settings: 'economy',
        economy_wallets: 'economy',
        economy_transactions: 'economy',
        table_games: { owner: 'gambling', alsoRequires: ['discordActivity'] },
        prediction_markets: WHEEL_OR_PREDICTIONS,
        prediction_positions: WHEEL_OR_PREDICTIONS,
        short_positions: 'exchange',
        option_positions: 'exchange',
        option_trades: 'exchange',
        perp_positions: 'exchange',
        corporate_actions: 'exchange',
        repo_watches: 'github',
        integration_audit: 'github',
        pending_integration_actions: 'github',
        agent_runs: 'cursor',
        screen_vision_clients: 'screenVision',
        push_subscriptions: 'push',
        mcp_tokens: 'mcp',
        observatory_projects: 'projects',
        observatory_share_links: 'projects',
        observatory_jobs: 'observatory',
        research_sources: 'expeditions',
        research_claims: 'expeditions',
        expedition_briefs: 'expeditions'
    },
    prefixes: [
        { prefix: 'memory_', owner: 'core' },
        { prefix: 'kg_', owner: 'core' },
        { prefix: 'user_', owner: 'core' },
        { prefix: 'web_', owner: 'core' },
        { prefix: 'dm_', owner: 'core' },
        { prefix: 'attention_', owner: 'core' },
        { prefix: 'parlor_', owner: 'core' },
        { prefix: 'tutorial_', owner: 'core' },
        { prefix: 'account_', owner: 'core' },
        { prefix: 'tavern_', owner: 'tavern' },
        { prefix: 'stock_', owner: 'exchange' },
        { prefix: 'exchange_', owner: 'exchange' },
        { prefix: 'gba_run_', owner: 'gba' },
        { prefix: 'sandbox_', owner: 'sandbox' },
        { prefix: 'project_', owner: 'projects' },
        { prefix: 'spitball_', owner: 'expeditions' },
        { prefix: 'studio_', owner: 'music' }
    ]
};

/** Legacy host switches as they behave today; features without one are absent. */
const legacySwitches = {
    discord: { configPath: 'discord.enabled', envVar: 'GOOBSTER_DISCORD_ENABLED', defaultOn: true, inferredFrom: 'token' },
    push: { configPath: 'webapp.push.enabled', envVar: 'GOOBSTER_WEB_PUSH_ENABLED', defaultOn: true },
    mail: { configPath: 'mail.provider', envVar: 'GOOBSTER_MAIL_PROVIDER', defaultOn: false, inferredFrom: 'credentials' },
    gba: { configPath: 'gbaRun.enabled', defaultOn: false },
    projects: { configPath: 'projects.enabled', envVar: 'GOOBSTER_PROJECTS_ENABLED', defaultOn: true },
    observatory: { configPath: 'observatory.enabled', envVar: 'GOOBSTER_OBSERVATORY_ENABLED', defaultOn: false },
    sandbox: { configPath: 'sandbox.enabled', envVar: 'GOOBSTER_SANDBOX_ENABLED', defaultOn: false },
    mcp: { configPath: 'mcp.enabled', envVar: 'GOOBSTER_MCP_ENABLED', defaultOn: false },
    expeditions: { configPath: 'spitball.enabled', envVar: 'GOOBSTER_SPITBALL_ENABLED', defaultOn: true },
    github: { configPath: 'github.token', envVar: 'GITHUB_TOKEN', defaultOn: false, inferredFrom: 'token or webhookSecret' },
    cursor: { configPath: 'cursor.apiKey', envVar: 'CURSOR_API_KEY', defaultOn: false, inferredFrom: 'apiKey' },
    screenVision: { configPath: 'screenVision.enabled', defaultOn: false },
    discordActivity: { configPath: 'activity.enabled', defaultOn: false }
};

const systemDependencies = {
    ffmpeg: { owner: 'voice', softConsumers: ['observatory'] },
    spotdl: 'music',
    'yt-dlp': 'music',
    'python3-venv': { owner: 'music', softConsumers: ['sandbox'] },
    bubblewrap: 'sandbox',
    mgba: 'gba',
    nodemailer: 'mail',
    'web-push': 'push',
    '@discordjs/voice': VOICE_IN_DISCORD,
    'sqlite-vec': 'core',
    sharp: 'core',
    ollama: 'core'
};

/** Defects found while taking the inventory; each is fixed under the issue named. */
const knownGaps = [
    { issue: '#318', surface: 'interactionTypes.collector:clear_search_button', note: 'The music paginator id parses as router type `search` and is deferred by the approval branch before the collector sees it; rename the id or exclude live collectors.' },
    { issue: '#318', surface: 'interactionTypes.intaction', note: 'One router token serves github and cursor actions; the owner is resolved from `pending.type` at runtime.' },
    { issue: '#318', surface: 'runtimeSteps', note: 'step() has no feature parameter; automation, heartbeat, personalHeartbeat, memoryConsolidation, followupDelivery and monologue are bundled core steps whose feature branches are gated inside them.' },
    { issue: '#318', surface: 'runtimeSteps.exchangeRiskEngine', note: 'Runs while exchange is active; prediction settlement inside it is gated on gambling.' },
    { issue: '#319', surface: 'mcpResources.goobster://briefs/{id}', note: 'MCP brief tools and resources are not guarded by the expeditions feature.' },
    { issue: '#319', surface: 'mcp', note: 'MCP enablement is read at boot only.' },
    { issue: '#319', surface: 'aiTools', note: 'toolsRegistry.execute() has no feature gating; only discovery filters tools.' },
    { issue: '#319', surface: 'aiTools.observatory', note: 'The definition needs an action-aware reduced form so project organization stays offered when only projects is active.' },
    { issue: '#321', surface: 'tutorials.knowledge.research', note: 'Declares no requirement although the Research view needs expeditions.' },
    { issue: '#321', surface: 'tutorials.projects.runs', note: 'Requires only projects although runs need observatory.' },
    { issue: '#321', surface: 'tutorials.trading.basics', note: 'Requires only discord although trading needs exchange.' },
    { issue: '#321', surface: 'tutorials', note: 'A tour whose requirement is unmet is omitted from the listing instead of being reported unavailable.' }
];

function normalize(value) {
    if (value == null) return null;
    if (typeof value === 'string') return { owner: value, alsoRequires: [] };
    return { owner: value.owner, alsoRequires: [...(value.alsoRequires || [])] };
}

function splitRoute(identifier, method) {
    if (method) return { method: String(method).toUpperCase(), path: identifier };
    const match = /^([A-Za-z]+)\s+(\S.*)$/.exec(identifier);
    return match ? { method: match[1].toUpperCase(), path: match[2] } : { method: null, path: identifier };
}

function longestPrefix(map, identifier) {
    let best = null;
    for (const key of Object.keys(map)) {
        const hit = identifier === key
            || (!key.endsWith('/') && identifier.startsWith(`${key}/`));
        if (hit && (best === null || key.length > best.length)) best = key;
    }
    return best === null ? null : map[best];
}

/**
 * Resolve a surface to `{ owner, alsoRequires }`, or null when unclaimed.
 * Routes take `ownerOf('route', 'GET /api/app/me')` or
 * `ownerOf('route', '/api/app/me', 'GET')` and use the ordered routeRules.
 */
function ownerOf(kind, identifier, method) {
    switch (kind) {
    case 'command': return normalize(commands[identifier]);
    case 'contextMenu': return normalize(contextMenus[identifier]);
    case 'runtimeStep': return normalize(runtimeSteps[identifier]);
    case 'eventGate': return normalize(eventGates[identifier]);
    case 'interactionType': return normalize(interactionTypes[identifier]);
    case 'aiTool': return normalize(aiTools[identifier]);
    case 'mcpTool': return normalize(mcpTools[identifier]);
    case 'mcpResource': return normalize(mcpResources[identifier]);
    case 'wsPath': return normalize(wsPaths[identifier]);
    case 'room': return normalize(rooms[identifier]);
    case 'systemDependency': return normalize(systemDependencies[identifier]);
    case 'tutorial': {
        const entry = tutorials[identifier];
        return entry ? { owner: entry.owner, alsoRequires: [...entry.requires] } : null;
    }
    case 'staticAsset': return normalize(longestPrefix(staticAssets, identifier));
    case 'table': {
        if (Object.prototype.hasOwnProperty.call(tables.exact, identifier)) {
            return normalize(tables.exact[identifier]);
        }
        let best = null;
        for (const entry of tables.prefixes) {
            if (identifier.startsWith(entry.prefix) && (best === null || entry.prefix.length > best.prefix.length)) {
                best = entry;
            }
        }
        return best ? normalize(best.owner) : null;
    }
    case 'route': {
        const route = splitRoute(identifier, method);
        for (const rule of routeRules) {
            if (rule.method && route.method && rule.method !== route.method) continue;
            if (rule.pattern.test(route.path)) return normalize(rule);
        }
        return null;
    }
    default:
        throw new Error(`featureInventory.ownerOf: unknown kind "${kind}"`);
    }
}

function deepFreeze(value) {
    if (value && typeof value === 'object' && !(value instanceof RegExp) && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

[
    FEATURE_IDS, FEATURES, commands, contextMenus, runtimeSteps, eventGates, interactionTypes,
    aiTools, mcpTools, mcpResources, routeRules, wsPaths, staticAssets, rooms, tutorials, tables,
    legacySwitches, systemDependencies, knownGaps
].forEach(deepFreeze);

module.exports = {
    FEATURE_IDS,
    FEATURES,
    commands,
    contextMenus,
    runtimeSteps,
    eventGates,
    interactionTypes,
    aiTools,
    mcpTools,
    mcpResources,
    routeRules,
    wsPaths,
    staticAssets,
    rooms,
    tutorials,
    tables,
    legacySwitches,
    systemDependencies,
    knownGaps,
    ownerOf
};
