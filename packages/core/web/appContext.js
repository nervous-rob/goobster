/**
 * Web app backend context. Wired once at startup and handed to every
 * route module. Discord access goes through the gateway seam (reactive
 * port spec §6): the bot app passes its live client (LocalGateway), the
 * api app passes a RemoteGateway.
 */

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
const webChatService = require('../services/webChatService');
const webDashboardService = require('../services/webDashboardService');
const parlorService = require('../services/parlorService');
const parlorLiveService = require('../services/parlorLiveService');
const friendService = require('../services/friendService');
const presenceService = require('../services/presenceService');
const userIntegrationService = require('../services/userIntegrationService');
const webVoiceService = require('../services/webVoiceService');
const voiceLiveService = require('../services/voiceLiveService');
const webTaskService = require('../services/webTaskService');
const webExchangeService = require('../services/webExchangeService');
const observatoryService = require('../services/observatoryService');
const projectAssetService = require('../services/projectAssetService');
const projectTriggerService = require('../services/projectTriggerService');
const projectMissionService = require('../services/projectMissionService');
const mtgaService = require('../services/mtgaService');
const webAppletService = require('../services/webAppletService');
const webSuggestionService = require('../services/webSuggestionService');
const webAttentionService = require('../services/webAttentionService');
const spitballExpeditionService = require('../services/spitballExpeditionService');
const spitballExpeditionRunner = require('../services/spitballExpeditionRunner');
const knowledgeTransferService = require('../services/knowledgeTransferService');

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
        chat: deps.chat || webChatService,
        dashboard: deps.dashboard || webDashboardService,
        parlor: deps.parlor || parlorService,
        parlorLive: deps.parlorLive || parlorLiveService,
        friends: deps.friends || friendService,
        presence: deps.presence || presenceService,
        integrations: deps.integrations || userIntegrationService,
        voice: deps.voice || webVoiceService,
        voiceLive: deps.voiceLive || voiceLiveService,
        tasks: deps.tasks || webTaskService,
        exchange: deps.exchange || webExchangeService,
        observatory: deps.observatory || observatoryService,
        projectAssets: deps.projectAssets || projectAssetService,
        projectTriggers: deps.projectTriggers || projectTriggerService,
        projectMissions: deps.projectMissions || projectMissionService,
        spitball: deps.spitball || spitballExpeditionService,
        spitballRunner: deps.spitballRunner || spitballExpeditionRunner,
        transfers: deps.transfers || knowledgeTransferService,
        mtga: deps.mtga || mtgaService,
        applets: deps.applets || webAppletService,
        suggestions: deps.suggestions || webSuggestionService,
        attention: deps.attention || webAttentionService,
        events: deps.events || eventBusService
    };
}

module.exports = { createWebAppContext };
