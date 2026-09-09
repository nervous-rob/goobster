/**
 * Named Jest groups for CI. Local `npm test` still runs the full suite;
 * CI runs each group as its own step via `--runTestsByPath`.
 *
 * Every `tests/*.test.js` file must appear in exactly one group. The
 * inventory check (`scripts/check-test-groups.js` and `tests/ciGroups.test.js`)
 * fails if a file is missing, duplicated, or listed but not discovered.
 */
'use strict';

const GROUPS = [
    {
        id: 'core',
        name: 'Core infrastructure',
        description: 'Database, migrations, gateways, locks, configuration',
        files: files([
            'activityGatewayAccess',
            'activityService',
            'autoUpdate',
            'ciGroups',
            'cliResolver',
            'cursorAgentService',
            'dbSchemaUpgrade',
            'dialectForeignKeys',
            'dmCommands',
            'executionLease',
            'gatewaySeam',
            'githubService',
            'globalCommandPayload',
            'integrationActions',
            'integrationsWebhooks',
            'issueCaptureAndBridges',
            'presenceService',
            'reportIntegrations',
            'safeFetch',
            'singletonLock',
            'slidingWindowLimit',
            'tableManager',
            'userIntegrationService',
            'workshopPinMigration',
            'wrappedService'
        ])
    },
    {
        id: 'chat',
        name: 'Chat and AI',
        description: 'Providers, prompts, tools, conversations, message queues',
        files: files([
            'agentOrchestrator',
            'aiModelListing',
            'anthropicService',
            'dmChat',
            'dmSettings',
            'geminiService',
            'promptContext',
            'promptFragments',
            'replyDetection',
            'screenVisionService',
            'toolResultWindow',
            'toolsRegistryEconomy',
            'toolsRegistryExchange',
            'toolsRegistryFollowup',
            'toolsRegistryObservatory',
            'toolsRegistryOrder',
            'toolsRegistryRunCode',
            'toolsRegistryVoiceChannel'
        ])
    },
    {
        id: 'portal',
        name: 'Portal and collaboration',
        description: 'Web APIs, sessions, applets, Parlor, sharing',
        files: files([
            'appletCapabilities',
            'appletCapabilityApi',
            'appStream',
            'friendService',
            'panelServer',
            'panelService',
            'parlorLiveService',
            'parlorMentions',
            'parlorService',
            'parlorSharing',
            'parlorTool',
            'projectParlor',
            'webAppApi',
            'webAppletService',
            'webChatBranchShare',
            'webChatService',
            'webClientServing',
            'webDashboardUsageRetention',
            'webExchangeService',
            'webPortalHome',
            'webServersShutdown',
            'webSessionService',
            'webSuggestionService',
            'webTaskService',
            'webTurnProgress',
            'workshopPromoteApi'
        ])
    },
    {
        id: 'knowledge',
        name: 'Knowledge and memory',
        description: 'Spitball, graphs, memory, research expeditions',
        files: files([
            'graphClusters',
            'graphFilter',
            'kgArtifactService',
            'knowledgeGraphService',
            'knowledgeReflectionService',
            'memoryVecIndex',
            'monologueService',
            'projectKnowledge',
            'researchBrief',
            'spitballAttention',
            'spitballExpeditionService',
            'spitballResearchPipeline',
            'userKnowledgeGraph'
        ])
    },
    {
        id: 'projects',
        name: 'Projects and autonomy',
        description: 'Observatory, missions, triggers, automation, attention',
        files: files([
            'attentionLedger',
            'attentionScore',
            'attentionService',
            'automationCronUtc',
            'automationDurability',
            'automationManagerService',
            'automationService',
            'cognitiveLoopJourneys',
            'cronFromNaturalLanguage',
            'followupService',
            'heartbeatState',
            'manageAutomationsTool',
            'observatoryConfig',
            'observatoryService',
            'projectAssetApi',
            'projectAssetService',
            'projectChat',
            'projectCollaboration',
            'projectMissionApi',
            'projectMissionService',
            'projectService',
            'projectSetupAudit',
            'projectSetupContract',
            'projectTriggerApi',
            'projectTriggerService',
            'projectWorkspaceApi',
            'projectWorkspaceWrite'
        ])
    },
    {
        id: 'voice',
        name: 'Voice and media',
        description: 'Speech, realtime audio, playback, music',
        files: files([
            'elevenLabsTTSPlayback',
            'elevenLabsTTSSanitize',
            'elevenLabsVoiceResolution',
            'ensureMusicCli',
            'guildSettingsTtsVoice',
            'multiContextTTS',
            'notificationSounds',
            'parlorLiveAudio',
            'pcmUtils',
            'realtimeVoiceEngine',
            'scribeRealtime',
            'speechText',
            'ttsAccent',
            'spotdlService',
            'spotifyWebApi',
            'urlPlayService',
            'voiceLiveService',
            'voicePlaybackCoordinator',
            'voiceToolCalls',
            'webVoiceService'
        ])
    },
    {
        id: 'games',
        name: 'Games and economy',
        description: 'Casino, exchange, Tavern, GBA',
        files: files([
            'baccaratEngine',
            'blackjackEngine',
            'botPlayer',
            'crapsEngine',
            'economyService',
            'exchangeAudit',
            'exchangeMargin',
            'exchangeOptions',
            'exchangeOptionsMath',
            'exchangeOrders',
            'exchangePerps',
            'exchangePredictions',
            'exchangeSpreads',
            'exchangeWheel',
            'exchangeWriting',
            'gamblingService',
            'gbaAgent',
            'gbaExperience',
            'gbaGameState',
            'gbaMcp',
            'gbaRunService',
            'holdemEngine',
            'letRideEngine',
            'mtgaLogImport',
            'mtgaService',
            'rouletteEngine',
            'slotsEngine',
            'stockPortfolioService',
            'tavernAdventureService',
            'tavernBotAdventurer',
            'tavernCharacterService',
            'tavernCombat',
            'tavernForge',
            'tavernQuestLoader',
            'tavernTools',
            'tavernWorld',
            'warEngine'
        ])
    },
    {
        id: 'privacy',
        name: 'Privacy and execution safety',
        description: 'Erasure, permissions, approvals, sandbox',
        files: files([
            'approvalExecutor',
            'dmPrivacy',
            'exchangePrivacy',
            'memoryPrivacy',
            'privacyService',
            'sandboxConfig',
            'sandboxPackages',
            'sandboxPython',
            'sandboxRequests',
            'sandboxRequestTool',
            'sandboxRunner',
            'sandboxService',
            'searchApproval',
            'tavernPrivacy'
        ])
    }
];

function files(stems) {
    return stems.map((stem) => `tests/${stem}.test.js`);
}

function toRepoPosix(filePath, root) {
    const path = require('node:path');
    const relative = path.isAbsolute(filePath)
        ? path.relative(root, filePath)
        : filePath;
    return relative.split(path.sep).join('/');
}

function groupById(id, groups = GROUPS) {
    return groups.find((group) => group.id === id) || null;
}

function listedFiles(groups = GROUPS) {
    return groups.flatMap((group) => group.files);
}

/**
 * Compare the manifest against Jest's discovered files (repo-relative
 * posix paths). Returns a list of human-readable error strings.
 *
 * @param {object} opts
 * @param {string[]} opts.discovered
 * @param {object[]} [opts.groups]
 * @param {string} [opts.workflowSource] - `.github/workflows/ci.yml` text
 */
function auditTestGroups({ discovered, groups = GROUPS, workflowSource } = {}) {
    const errors = [];
    const discoveredSet = new Set(discovered);
    const owners = new Map();
    const workflowPath = '.github/workflows/ci.yml';
    const engineJobs = 2;

    for (const group of groups) {
        if (!group.id || !group.name) {
            errors.push(`group is missing id or name: ${JSON.stringify(group)}`);
            continue;
        }
        const unique = new Set();
        for (const file of group.files) {
            if (unique.has(file)) {
                errors.push(`duplicated inside ${group.id}: ${file}`);
            }
            unique.add(file);
            if (!owners.has(file)) owners.set(file, []);
            if (!owners.get(file).includes(group.id)) {
                owners.get(file).push(group.id);
            }
        }
    }

    for (const [file, groupIds] of owners) {
        if (groupIds.length > 1) {
            errors.push(`duplicated across groups: ${file} (${groupIds.join(', ')})`);
        }
        if (!discoveredSet.has(file)) {
            errors.push(`listed but not discovered by Jest: ${file}`);
        }
    }

    for (const file of [...discoveredSet].sort()) {
        if (!owners.has(file)) {
            errors.push(`missing from any group: ${file}`);
        }
    }

    if (typeof workflowSource === 'string') {
        const ids = [...workflowSource.matchAll(/run-test-group\.js\s+(\S+)/g)]
            .map((m) => m[1]);
        const counts = new Map();
        for (const id of ids) {
            counts.set(id, (counts.get(id) || 0) + 1);
        }
        for (const group of groups) {
            const n = counts.get(group.id) || 0;
            if (n === 0) {
                errors.push(`group id "${group.id}" is not a named step in ${workflowPath}`);
            } else if (n < engineJobs) {
                errors.push(
                    `group id "${group.id}" appears ${n} time(s) in ${workflowPath}; ` +
                    `expected once per engine job (${engineJobs})`
                );
            }
        }
        for (const id of [...counts.keys()].sort()) {
            if (!groups.some((group) => group.id === id)) {
                errors.push(`${workflowPath} references unknown group id "${id}"`);
            }
        }
        if (/\.\/\.github\/actions\/run-test-groups/.test(workflowSource)) {
            errors.push(
                `${workflowPath} still invokes the run-test-groups composite action; ` +
                'named groups must be ordinary job steps'
            );
        }
    }

    return errors;
}

function resolveEngine(env = process.env) {
    return env.GOOBSTER_DB_URL ? 'postgres' : 'sqlite';
}

module.exports = {
    GROUPS,
    auditTestGroups,
    groupById,
    listedFiles,
    resolveEngine,
    toRepoPosix
};
