// A lightweight registry that exposes internal capabilities as "functions" to OpenAI function-calling.
// Each entry includes an OpenAI-style definition and a runtime execute() helper.
// Implementations live under utils/tools/ by capability; this file is the facade.

const sandboxConfig = require('../config/sandboxConfig');
const observatoryConfig = require('../config/observatoryConfig');
const { registerCommandAdapters } = require('./tools/helpers');
const requireOptional = require('./optionalModule').forModule(module);
const { inventory } = require('../features/catalog');

/**
 * Tool modules owned by one optional feature. A payload without the feature
 * does not carry the module; its tools are then neither offered nor run.
 */
const optionalTools = {
    sandbox: requireOptional('./tools/sandbox', { feature: 'sandbox' }),
    observatory: requireOptional('./tools/observatory', { feature: 'observatory' }),
    economy: requireOptional('./tools/economy', { feature: 'economy' }),
    gambling: requireOptional('./tools/gambling', { feature: 'gambling' }),
    exchange: requireOptional('./tools/exchange', { feature: 'exchange' }),
    tavern: requireOptional('./tools/tavern', { feature: 'tavern' })
};
const absentToolFeatures = new Set(Object.keys(optionalTools).filter(feature => !optionalTools[feature]));
const parlorTools = require('./tools/parlor');
const attentionTools = require('./tools/attention');
const integrationTools = require('./tools/integrations');
const fileTools = require('./tools/files');
const selfDocsTools = require('./tools/selfDocs');
const selfDocsConfig = require('../config/selfDocsConfig');
const { isIncognitoToolBlocked } = require('./toolPrivacy');
const { surfaceActive, requireSurface, GateError, FEATURE_UNAVAILABLE } = require('../features/gate');

const catalog = {
    ...optionalTools.sandbox,
    ...optionalTools.observatory,
    ...optionalTools.economy,
    ...optionalTools.gambling,
    ...optionalTools.exchange,
    ...optionalTools.tavern,
    ...parlorTools,
    ...attentionTools,
    ...integrationTools,
    ...fileTools,
    ...selfDocsTools
};

const TOOL_ORDER = [
    'performSearch',
    'generateImage',
    'runCode',
    'observatory',
    'requestPythonPackages',
    'findImages',
    'fetchWebFile',
    'showSavedFiles',
    'playTrack',
    'setNickname',
    'speakMessage',
    'setSpeechAccent',
    'echoMessage',
    'rememberFact',
    'forgetFact',
    'saveArtifact',
    'lookupNotes',
    'consultDocs',
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

/** The feature whose absent tool module explains a missing implementation, or null. */
function absentOwner(name) {
    const claim = inventory.ownerOf('aiTool', name);
    if (!claim) return null;
    return [claim.owner, ...claim.alsoRequires].find(feature => absentToolFeatures.has(feature)) || null;
}

const tools = {};
for (const name of TOOL_ORDER) {
    if (!catalog[name]) {
        if (absentOwner(name)) continue;
        throw new Error(`toolsRegistry: missing implementation for ${name}`);
    }
    tools[name] = catalog[name];
}

const warnedUnclaimed = new Set();

/**
 * Whether the installation's feature state lets the model see (and call)
 * this tool. A tool with no inventory claim fails closed with one warning
 * instead of taking every chat turn down with it; the inventory spec is
 * what normally catches the missing claim.
 */
function featureAllows(name) {
    try {
        return surfaceActive('aiTool', name);
    } catch (error) {
        if (!(error instanceof GateError)) throw error;
        if (!warnedUnclaimed.has(name)) {
            warnedUnclaimed.add(name);
            console.warn(`[tools] ${name} is hidden: no feature owns it (packages/core/features/inventory.js).`);
        }
        return false;
    }
}

/** The unavailable result for a tool, or null when its feature state allows it. Never throws for a claimed tool. */
function featureRefusal(name) {
    try {
        return requireSurface('aiTool', name);
    } catch (error) {
        if (!(error instanceof GateError)) throw error;
        return { ok: false, code: FEATURE_UNAVAILABLE, feature: null, reasons: [{ code: 'UNCLAIMED_SURFACE' }] };
    }
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
        // Feature state first: a tool whose owning feature (or a feature it
        // also requires) is off is never offered. The filters below are the
        // operational checks that still apply to an active feature (the
        // sandbox/observatory enable switch and the web-only scope).
        let definitions = TOOL_ORDER.filter(name => tools[name] && featureAllows(name)).map(name => tools[name].definition);
        const trustedSurface = isWeb || isAutomation;
        const sandboxService = optionalTools.sandbox && requireOptional('../services/sandboxService', { feature: 'sandbox' });
        const observatoryService = optionalTools.observatory && requireOptional('../services/observatoryService', { feature: 'projects' });
        const sandboxOffered = Boolean(sandboxService?.enabled)
            && (sandboxConfig.scope === 'everywhere' || trustedSurface);
        if (!sandboxOffered) {
            definitions = definitions.filter(def => def.name !== 'runCode');
        }
        if (!sandboxOffered || sandboxConfig.approverUserIds.length === 0) {
            definitions = definitions.filter(def => def.name !== 'requestPythonPackages');
        }
        const observatoryOffered = Boolean(observatoryService?.enabled)
            && (observatoryConfig.scope === 'everywhere' || trustedSurface);
        if (!observatoryOffered) {
            definitions = definitions.filter(def => def.name !== 'observatory');
        }
        // Self-documentation is on by default and needs no credentials; an
        // operator can still switch the corpus (and the tool) off entirely.
        if (!selfDocsConfig.enabled) {
            definitions = definitions.filter(def => def.name !== 'consultDocs');
        }
        if (sandboxService && (sandboxOffered || observatoryOffered)) {
            const note = ` ${await sandboxService.pythonEnvironmentNote()}`;
            definitions = definitions.map(def =>
                (def.name === 'runCode' || def.name === 'observatory')
                    ? { ...def, description: def.description + note }
                    : def);
        }
        // speakMessage / playTrack join a Discord voice channel. The web
        // portal (and automations) have none — offering them makes accent /
        // "use a voice" requests call speakMessage with extra voice/style
        // settings, which then crash on a null member.
        if (isWeb || isAutomation) {
            definitions = definitions.filter(def =>
                def.name !== 'speakMessage' && def.name !== 'playTrack');
        }
        // setSpeechAccent writes portal TTS settings (ElevenLabs v3 audio
        // tags). Discord /voicechat stays on Flash, which ignores those tags.
        if (!isWeb) {
            definitions = definitions.filter(def => def.name !== 'setSpeechAccent');
        }
        if (!Array.isArray(names)) return definitions;
        const allowed = new Set(names);
        return definitions.filter(def => allowed.has(def.name));
    },

    async execute(name, args) {
        if (!tools[name]) {
            const feature = TOOL_ORDER.includes(name) ? absentOwner(name) : null;
            if (feature) return { ok: false, code: FEATURE_UNAVAILABLE, feature, reasons: [{ code: 'NOT_INSTALLED' }] };
            throw new Error(`Unknown tool: ${name}`);
        }
        // Independent of discovery: a stale name from a model response, a
        // saved plan or a direct caller is refused before any side effect,
        // approval or admission.
        const refusal = featureRefusal(name);
        if (refusal) return refusal;
        if (isIncognitoToolBlocked(name, args?.interactionContext)) {
            return '❌ Saving memories and files is disabled in incognito. Use a regular chat to save this content.';
        }
        const policy = await require('../services/personalPolicyService').toolPolicy(args?.interactionContext);
        if (!policy.allows(name)) return '❌ This tool is disabled by your personal settings.';
        return tools[name].execute(args || {});
    },

    registerCommandAdapters
};
