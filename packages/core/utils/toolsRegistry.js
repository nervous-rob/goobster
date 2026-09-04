// A lightweight registry that exposes internal capabilities as "functions" to OpenAI function-calling.
// Each entry includes an OpenAI-style definition and a runtime execute() helper.
// Implementations live under utils/tools/ by capability; this file is the facade.

const sandboxService = require('../services/sandboxService');
const sandboxConfig = require('../config/sandboxConfig');
const observatoryService = require('../services/observatoryService');
const observatoryConfig = require('../config/observatoryConfig');
const { registerCommandAdapters } = require('./tools/helpers');

const observatoryTools = require('./tools/observatory');
const exchangeTools = require('./tools/exchange');
const tavernTools = require('./tools/tavern');
const parlorTools = require('./tools/parlor');
const attentionTools = require('./tools/attention');
const integrationTools = require('./tools/integrations');

const catalog = {
    ...observatoryTools,
    ...exchangeTools,
    ...tavernTools,
    ...parlorTools,
    ...attentionTools,
    ...integrationTools
};

const TOOL_ORDER = [
    'performSearch',
    'generateImage',
    'runCode',
    'observatory',
    'requestPythonPackages',
    'playTrack',
    'setNickname',
    'speakMessage',
    'echoMessage',
    'rememberFact',
    'forgetFact',
    'saveArtifact',
    'lookupNotes',
    'checkPoints',
    'gamblePoints',
    'tavernInfo',
    'tavernParty',
    'tavernAct',
    'tavernAttack',
    'tavernTwist',
    'tavernRecap',
    'rollDice',
    'manageParlor',
    'stockQuote',
    'tradeStock',
    'checkPortfolio',
    'optionChain',
    'tradeOption',
    'shortStock',
    'marginAccount',
    'exchangeOrder',
    'eventContracts',
    'tradeSpread',
    'tradePerp',
    'goblinWheel',
    'auditAccount',
    'auditExchange',
    'manageAutomations',
    'scheduleFollowUp',
    'trackAttention',
    'watchFor',
    'searchGithubCode',
    'readGithubFile',
    'searchNotion',
    'readNotionPage',
    'launchCursorAgent',
    'createGithubIssue',
    'executePlan'
];

const tools = {};
for (const name of TOOL_ORDER) {
    if (!catalog[name]) throw new Error(`toolsRegistry: missing implementation for ${name}`);
    tools[name] = catalog[name];
}

module.exports = {
    TOOL_ORDER,

    /**
     * Return array of OpenAI function definitions.
     * @param {string[]} [names] - optional allowlist; when provided, only
     *   definitions for these tool names are returned (e.g. the voice-safe
     *   subset used by live voice sessions).
     * @param {Object} [context]
     * @param {boolean} [context.isWeb] - authenticated web app turn
     * @param {boolean} [context.isAutomation] - unattended automation turn.
     *   Automations are server-created (their prompts were authored through
     *   an already-gated surface), so they count as a trusted surface for
     *   web-scoped tools - otherwise an automation created in the web app
     *   to drive an Observatory project could never touch it at run time.
     */
    async getDefinitions(names, { isWeb = false, isAutomation = false } = {}) {
        let definitions = TOOL_ORDER.map(name => tools[name].definition);
        const trustedSurface = isWeb || isAutomation;
        const sandboxOffered = sandboxService.enabled
            && (sandboxConfig.scope === 'everywhere' || trustedSurface);
        if (!sandboxOffered) {
            definitions = definitions.filter(def => def.name !== 'runCode');
        }
        if (!sandboxOffered || sandboxConfig.approverUserIds.length === 0) {
            definitions = definitions.filter(def => def.name !== 'requestPythonPackages');
        }
        const observatoryOffered = observatoryService.enabled
            && (observatoryConfig.scope === 'everywhere' || trustedSurface);
        if (!observatoryOffered) {
            definitions = definitions.filter(def => def.name !== 'observatory');
        }
        if (sandboxOffered || observatoryOffered) {
            const note = ` ${await sandboxService.pythonEnvironmentNote()}`;
            definitions = definitions.map(def =>
                (def.name === 'runCode' || def.name === 'observatory')
                    ? { ...def, description: def.description + note }
                    : def);
        }
        if (!Array.isArray(names)) return definitions;
        const allowed = new Set(names);
        return definitions.filter(def => allowed.has(def.name));
    },

    async execute(name, args) {
        if (!tools[name]) throw new Error(`Unknown tool: ${name}`);
        return tools[name].execute(args || {});
    },

    registerCommandAdapters
};
