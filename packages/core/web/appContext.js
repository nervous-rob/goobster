/**
 * Web app backend context. Wired once at startup and handed to every
 * route module. Discord access goes through the gateway seam (reactive
 * port spec §6): the bot app passes its live client (LocalGateway), the
 * api app passes a RemoteGateway.
 */

const path = require('node:path');
const { toGateway } = require('../gateway');
const eventBusService = require('../services/eventBusService');
const webSessionService = require('../services/webSessionService');
const identityService = require('../services/identityService');
const nativeAuthService = require('../services/nativeAuthService');
const mailService = require('../services/mailService');
const identityConfig = require('../config/identityConfig');
const discordConfig = require('../config/discordConfig');
const assistantIdentity = require('../services/assistantIdentity');
const inboxService = require('../services/inboxService');
const accessRequestService = require('../services/accessRequestService');
const webChatService = require('../services/webChatService');
const webDashboardService = require('../services/webDashboardService');
const parlorService = require('../services/parlorService');
const parlorLiveService = require('../services/parlorLiveService');
const studioSongService = require('../services/studioSongService');
const friendService = require('../services/friendService');
const directMessageService = require('../services/directMessageService');
const presenceService = require('../services/presenceService');
const userIntegrationService = require('../services/userIntegrationService');
const webTaskService = require('../services/webTaskService');
const mtgaService = require('../services/mtgaService');
const webAppletService = require('../services/webAppletService');
const webSuggestionService = require('../services/webSuggestionService');
const webAttentionService = require('../services/webAttentionService');
const knowledgeTransferService = require('../services/knowledgeTransferService');
const instanceStateService = require('../services/instanceStateService');
const { features: featureState } = require('../features/featureState');
const { workspaceRoot } = require('../runtimePaths');
const requireOptional = require('../utils/optionalModule').forModule(module);

/**
 * The portal's service handles. A service owned by an optional feature is
 * null when this payload does not carry it (documentation/packaging.md);
 * core readers check before use, feature routes are not mounted or are
 * refused by the feature gate.
 */
function createWebAppContext({ client = null, gateway = null, config, logger = console, deps = {} }) {
    const webappConfig = config.webapp || {};
    const publicUrl = typeof webappConfig.publicUrl === 'string'
        ? webappConfig.publicUrl.replace(/\/+$/, '')
        : null;
    return {
        client,
        gateway: deps.gateway || toGateway(gateway || client),
        config,
        logger,
        devMode: webappConfig.devMode === true,
        // Where the built React client lives. Tests point this at a
        // throwaway directory so parallel suites never share (or delete)
        // one another's index.html fixture.
        webDistDir: deps.webDistDir || path.join(workspaceRoot, 'apps/web/dist'),
        clientId: config.clientId,
        // Shared with the Activity: one Discord application, one secret.
        clientSecret: process.env.DISCORD_CLIENT_SECRET
            || webappConfig.clientSecret
            || config.activity?.clientSecret
            || null,
        publicUrl,
        secureCookies: Boolean(publicUrl && publicUrl.startsWith('https://')),
        sessions: deps.sessions || webSessionService,
        identity: deps.identity || identityService,
        nativeAuth: deps.nativeAuth || nativeAuthService,
        mail: deps.mail || mailService,
        identityConfig: deps.identityConfig || identityConfig,
        discordConfig: deps.discordConfig || discordConfig,
        assistantIdentity: deps.assistantIdentity || assistantIdentity,
        inbox: deps.inbox || inboxService,
        accessRequests: deps.accessRequests || accessRequestService,
        chat: deps.chat || webChatService,
        dashboard: deps.dashboard || webDashboardService,
        parlor: deps.parlor || parlorService,
        parlorLive: deps.parlorLive || parlorLiveService,
        studioSongs: deps.studioSongs || studioSongService,
        studioLive: deps.studioLive || requireOptional('../services/studioLiveService', { feature: 'music' }),
        friends: deps.friends || friendService,
        dm: deps.dm || directMessageService,
        presence: deps.presence || presenceService,
        integrations: deps.integrations || userIntegrationService,
        voice: deps.voice || requireOptional('../services/webVoiceService', { feature: 'voice' }),
        voiceLive: deps.voiceLive || requireOptional('../services/voiceLiveService', { feature: 'voice' }),
        tasks: deps.tasks || webTaskService,
        exchange: deps.exchange || requireOptional('../services/webExchangeService', { feature: 'exchange' }),
        observatory: deps.observatory || requireOptional('../services/observatoryService', { feature: 'projects' }),
        projectAssets: deps.projectAssets || requireOptional('../services/projectAssetService', { feature: 'projects' }),
        projectTriggers: deps.projectTriggers || requireOptional('../services/projectTriggerService', { feature: 'projects' }),
        projectMissions: deps.projectMissions || requireOptional('../services/projectMissionService', { feature: 'projects' }),
        spitball: deps.spitball || requireOptional('../services/spitballExpeditionService', { feature: 'expeditions' }),
        spitballRunner: deps.spitballRunner || requireOptional('../services/spitballExpeditionRunner', { feature: 'expeditions' }),
        briefs: deps.briefs || requireOptional('../services/expeditionBriefService', { feature: 'expeditions' }),
        transfers: deps.transfers || knowledgeTransferService,
        mtga: deps.mtga || mtgaService,
        applets: deps.applets || webAppletService,
        suggestions: deps.suggestions || webSuggestionService,
        attention: deps.attention || webAttentionService,
        followedSources: deps.followedSources || require('../services/followedSourceService'),
        accountExports: deps.accountExports || require('../services/accountExportService'),
        instanceState: deps.instanceState || instanceStateService,
        features: deps.features || featureState,
        hostManager: deps.hostManager || null,
        push: deps.push || require('../services/pushService'),
        events: deps.events || eventBusService
    };
}

module.exports = { createWebAppContext };
