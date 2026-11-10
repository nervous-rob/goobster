/**
 * Named Jest groups for CI. Local `npm test` still runs the full suite;
 * CI runs each group as its own step via `--runTestsByPath`.
 *
 * Every `tests/*.test.js` file must appear in exactly one group. The
 * inventory check (`scripts/check-test-groups.js` and `tests/ciGroups.test.js`)
 * fails if a file is missing, duplicated, or listed but not discovered.
 *
 * Each engine job in `.github/workflows/ci.yml` is a matrix of shards, and a
 * shard runs the groups in its `groups` list. The same check fails if a group
 * is in no shard of an engine, or in two. Which shard a group runs in is a
 * timing decision (ADR 0007) and lives in the workflow, not here.
 */
'use strict';

const GROUPS = [
    {
        id: 'core',
        name: 'Core infrastructure',
        description: 'Database, migrations, gateways, locks, configuration, feature gating',
        files: files([
            'activityGatewayAccess',
            'accessRequests',
            'operatorSchedules',
            'scheduledWorkRegistry',
            'activityService',
            'backupRestore',
            'postgresToolConnection',
            'ciGroups',
            'cliResolver',
            'configFieldCatalog',
            'configFile',
            'providerProbes',
            'instanceDefaults',
            'effectiveConfig',
            'configJson',
            'cursorAgentService',
            'dbSchemaUpgrade',
            'dialectForeignKeys',
            'dmCommands',
            'postgresConnectRetry',
            'executionLease',
            'featureCatalog',
            'featureConformance',
            'featureGatingCommands',
            'featureGatingMcp',
            'featureGatingRuntime',
            'featureGatingServices',
            'featureGatingTools',
            'featureInventory',
            'featureState',
            'gatewaySeam',
            'githubService',
            'globalCommandPayload',
            'identityService',
            'nativeAuth',
            'emailAuth',
            'integrationActions',
            'integrationsWebhooks',
            'issueCaptureAndBridges',
            'commandDeployHash',
            'workInterruption',
            'maintenanceBarrier',
            'maintenanceFence',
            'dbMigrationInspect',
            'dbMigration',
            'dbMigrationCli',
            'dbConnectionProbe',
            'backupOperations',
            'maintenanceCli',
            'presenceService',
            'reportIntegrations',
            'safeFetch',
            'singletonLock',
            'sharedInstanceSafety',
            'slidingWindowLimit',
            'tableManager',
            'userIntegrationService',
            'workLedger',
            'capabilityGaps',
            'usageBudgets',
            'workshopPinMigration',
            'wrappedService'
        ])
    },
    {
        id: 'install',
        name: 'Installer and lifecycle',
        description: 'Manager, installer, payloads, service adapters, managed Postgres, releases, updates',
        files: files([
            'autoUpdate',
            'macosCodeSign',
            'managerConfig',
            'packagePayloadRules',
            'payloadManifest',
            'payloadReduced',
            'payloadStage',
            'payloadApply',
            'managerAuth',
            'managerBoot',
            'managerBridge',
            'managerEngine',
            'managerSupervisor',
            'managerLifecycle',
            'lifecycleAdapters',
            'installEngine',
            'installCli',
            'installRoutes',
            'managerServer',
            'managerStatic',
            'managerEnvironmentOverlay',
            'databaseKinds',
            'databaseRoutes',
            'privilegedHelper',
            'linuxService',
            'serviceKinds',
            'bootstrapStage',
            'bootstrapCli',
            'dockerDaemon',
            'dockerPostgresKinds',
            'nativePostgresAdapters',
            'nativePostgresHelper',
            'nativePostgresKinds',
            'launchdService',
            'darwinHelper',
            'darwinBootstrapCli',
            'darwinBootstrapStage',
            'windowsService',
            'windowsHelper',
            'windowsBootstrapCli',
            'packageBootstrapWin32',
            'bootstrapTools',
            'releaseIndex',
            'releaseArtifacts',
            'releaseManagerTrust',
            'releaseWorkflow',
            'releaseAcceptanceReport',
            'releaseAcceptanceWorkflow',
            'updateCheck',
            'updateStage',
            'updateApply',
            'updateHandoff',
            'updateRoutes',
            'updateHostRoutes',
            'updateService'
        ])
    },
    {
        id: 'chat',
        name: 'Chat and AI',
        description: 'Providers, prompts, tools, conversations, message queues',
        files: files([
            'agentLoopObservatory',
            'agentOrchestrator',
            'aiModelListing',
            'personalAiService',
            'anthropicService',
            'chatHandlerAgentTurn',
            'dmChat',
            'dmSettings',
            'geminiService',
            'imageSearchService',
            'openaiService',
            'modelInference',
            'modelProfileGuessService',
            'modelRegistry',
            'promptContext',
            'promptFragments',
            'replyDetection',
            'screenVisionService',
            'toolResultWindow',
            'toolsRegistryEconomy',
            'toolsRegistryExchange',
            'toolsRegistryFiles',
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
            'directMessageService',
            'featureGatingRoutes',
            'featureGatingWebsocket',
            'featureGatingPortal',
            'hostRoutes',
            'maintenanceRoutes',
            'dockerPostgresRoutes',
            'nativePostgresRoutes',
            'frontendChunks',
            'friendService',
            'markdownRenderer',
            'documentationWiki',
            'panelServer',
            'panelService',
            'parlorLiveService',
            'parlorMentions',
            'parlorService',
            'parlorSharing',
            'parlorTool',
            'activityCorrelation',
            'tutorialFramework',
            'portalRooms',
            'projectParlor',
            'pushService',
            'toolChipLabel',
            'userSettingsApi',
            'userSettingsService',
            'settingsRuntimePolicy',
            'studioSongEdit',
            'studioSongPatch',
            'studioSongService',
            'independentRuntime',
            'inboxPagination',
            'inboxAsk',
            'mcpServer',
            'webAppApi',
            'noteAttachments',
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
            'expeditionBrief',
            'fileDiscoveryService',
            'graphClusters',
            'graphFilter',
            'kgArtifactService',
            'researchEvaluation',
            'knowledgeCuration',
            'knowledgeGraphService',
            'knowledgeReflectionService',
            'knowledgeTransfers',
            'lookupNotesArtifacts',
            'memoryVecIndex',
            'monologueService',
            'operatorRunbooksDocs',
            'projectKnowledge',
            'researchBrief',
            'selfDocs',
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
            'followedSources',
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
            'outputContract',
            'projectAssetApi',
            'appTemplates',
            'projectAssetService',
            'projectChat',
            'projectCollaboration',
            'projectHistoryApi',
            'projectHistoryService',
            'projectMissionApi',
            'projectMissionService',
            'projectOrganization',
            'projectRepoApi',
            'projectRepoService',
            'projectWorkbench',
            'liveOutput',
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
            'assistantConversationRequests',
            'assistantControlService',
            'assistantEvaluation',
            'assistantGateDecisions', 'assistantConversation',
            'assistantHomeService',
            'assistantIncidentService',
            'assistantInitiativeService',
            'assistantProjectAudience',
            'assistantPlanStep',
            'assistantProcessAssessment',
            'assistantProcessService',
            'assistantProjectBoard',
            'assistantRepoTools',
            'assistantResponsibilityService',
            'assistantRunService',
            'assistantSpokenBriefing',
            'assistantStewardService',
            'assistantUpdateService',
            'dmPrivacy',
            'exchangePrivacy',
            'featureDormantData',
            'memoryPrivacy',
            'privacyService',
            'accountExport',
            'dataReset',
            'resetInventory',
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
        errors.push(...auditEngineShards({ groups, workflowSource }));
    }

    return errors;
}

const ENGINE_JOBS = ['test-sqlite', 'test-postgres'];
const AGGREGATOR_JOB = 'both-engines';

/**
 * Check the shard matrix of each engine job: every group in exactly one
 * shard, every group step gated on its own id, the shard's result decided by
 * `require-test-groups.js`, and the aggregator waiting on both engine jobs.
 * A shard matrix that drops a group would otherwise pass with that group
 * never run.
 *
 * @param {object} opts
 * @param {object[]} opts.groups
 * @param {string} opts.workflowSource - `.github/workflows/ci.yml` text
 */
function auditEngineShards({ groups = GROUPS, workflowSource }) {
    const errors = [];
    const workflowPath = '.github/workflows/ci.yml';
    let jobs;
    try {
        jobs = require('yaml').parse(workflowSource).jobs;
    } catch (err) {
        return [`${workflowPath} is not valid YAML: ${err.message}`];
    }
    if (!jobs || typeof jobs !== 'object') {
        return [`${workflowPath} has no jobs`];
    }

    const known = new Set(groups.map((group) => group.id));
    for (const jobId of ENGINE_JOBS) {
        const job = jobs[jobId];
        if (!job) {
            errors.push(`${workflowPath} has no ${jobId} job`);
            continue;
        }
        const shards = job.strategy && job.strategy.matrix && job.strategy.matrix.include;
        if (!Array.isArray(shards) || !shards.length) {
            errors.push(`${jobId} has no shard matrix (strategy.matrix.include)`);
            continue;
        }
        if (job.strategy['fail-fast'] !== false) {
            errors.push(`${jobId} must set strategy.fail-fast: false so one failed shard does not cancel the others`);
        }

        const shardsOf = new Map();
        for (const shard of shards) {
            const label = shard.shard || JSON.stringify(shard);
            if (!Array.isArray(shard.groups) || !shard.groups.length) {
                errors.push(`${jobId} shard "${label}" lists no groups`);
                continue;
            }
            for (const id of shard.groups) {
                if (!shardsOf.has(id)) shardsOf.set(id, []);
                shardsOf.get(id).push(label);
            }
        }
        for (const group of groups) {
            const owners = shardsOf.get(group.id) || [];
            if (owners.length === 0) {
                errors.push(`group id "${group.id}" is in no shard of ${jobId}; it would never run on that engine`);
            } else if (owners.length > 1) {
                errors.push(`group id "${group.id}" is in ${owners.length} shards of ${jobId} (${owners.join(', ')})`);
            }
        }
        for (const id of [...shardsOf.keys()].sort()) {
            if (!known.has(id)) {
                errors.push(`${jobId} shard matrix references unknown group id "${id}"`);
            }
        }

        const steps = Array.isArray(job.steps) ? job.steps : [];
        for (const group of groups) {
            const step = steps.find((candidate) =>
                new RegExp(`run-test-group\\.js\\s+${group.id}\\s*$`).test(String(candidate.run || '').trim()));
            if (!step) {
                errors.push(`${jobId} has no step for group id "${group.id}"`);
                continue;
            }
            const expected = `contains(matrix.groups, '${group.id}')`;
            if (String(step.if || '').trim() !== expected) {
                errors.push(`${jobId} step for group id "${group.id}" must have \`if: ${expected}\``);
            }
        }
        const verdict = steps.find((candidate) => /require-test-groups\.js/.test(String(candidate.run || '')));
        if (!verdict) {
            errors.push(`${jobId} has no require-test-groups.js step; a failed group would not fail the shard`);
        } else {
            if (String(verdict.if || '').trim() !== 'always()') {
                errors.push(`${jobId} require-test-groups.js step must have \`if: always()\``);
            }
            if (!/require-test-groups\.js\s+\$\{\{\s*join\(matrix\.groups,\s*' '\)\s*\}\}/.test(String(verdict.run))) {
                errors.push(`${jobId} require-test-groups.js step must be given \${{ join(matrix.groups, ' ') }}`);
            }
        }
    }

    const aggregator = jobs[AGGREGATOR_JOB];
    const needs = aggregator ? [].concat(aggregator.needs || []) : [];
    for (const jobId of ENGINE_JOBS) {
        if (!needs.includes(jobId)) {
            errors.push(`${AGGREGATOR_JOB} must need ${jobId}`);
        }
    }

    return errors;
}

function resolveEngine(env = process.env) {
    return env.GOOBSTER_DB_URL ? 'postgres' : 'sqlite';
}

module.exports = {
    GROUPS,
    auditEngineShards,
    auditTestGroups,
    groupById,
    listedFiles,
    resolveEngine,
    toRepoPosix
};
