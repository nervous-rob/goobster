/**
 * YAML campaign loader for the Tavern's quest board.
 *
 * Campaigns are directories of YAML files - easy for humans to hand-author,
 * and easy for Goobster (or an AI) to generate or alter, because producing a
 * new campaign is just writing files that match this structure:
 *
 *   campaigns/<quest-id>/            built-in, ships with the repo
 *     quest.yaml                     metadata, players, clocks, start scene
 *     endings.yaml                   list of endings (title, text, trophy?)
 *     scenes/<scene-id>.yaml         one scene per file: text + options
 *
 *   data/tavern/campaigns/<id>/      custom/generated (gitignored); a custom
 *                                    campaign with a built-in's id overrides it
 *
 * Every file is validated on load: unknown stats, dangling scene/clock/ending
 * references, and malformed effects are reported with the file path. Invalid
 * CUSTOM campaigns are warned about and skipped - never a startup crash.
 * Invalid BUILT-IN campaigns throw (they are covered by tests and must load).
 *
 * Effects vocabulary (closed set, keeps the engine deterministic):
 *   clock: {id, delta} | damage: n | heal: n | item: "name" | spark: n |
 *   goto: "sceneId" | flag: {key, value} | end: "endingId" |
 *   npc: {key, delta}  (NPC relationship change for the acting player)
 *
 * Phase 2 fields:
 *   quest.yaml  `requires: <quest-id>` - chapter gating: the party can only
 *               post this quest after the required one has been completed in
 *               the guild.
 *   endings     `world:` - a list of lore entries `{kind, name, text}`
 *               recorded into the guild's shared world when that ending
 *               lands (kinds: location, faction, event, artifact, character).
 *
 * Phase 3 fields:
 *   quest.yaml  `items:` - usable-item definitions: name -> {use: {heal?,
 *               spark?, text?}}; consumed via /character inventory use.
 *               `hidden: true` - quest resolvable by id but never listed on
 *               the board (used by story-twist forks).
 *               `canonicalId:` - the original quest a twist fork descends
 *               from (satisfies `requires` gates and lore attribution).
 *   scenes      `encounter:` - combat: enemies with health, a defense DC,
 *               damage, cycling telegraphed `intents`, optional `onDefeat`
 *               effects (loot), plus a scene-level `onVictory` block fired
 *               when the last enemy falls.
 */

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { STAT_KEYS, DIFFICULTY, NPCS } = require('./content');

const LORE_KINDS = ['location', 'faction', 'event', 'artifact', 'character'];

const BUILTIN_DIR = require('../../runtimePaths').campaignsDir;
// Env override exists so tests can forge campaigns into a throwaway dir
const CUSTOM_DIR = process.env.GOOBSTER_TAVERN_CAMPAIGNS_DIR
    || path.join(require('../../runtimePaths').dataDir, 'tavern', 'campaigns');

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_OPTIONS_PER_SCENE = 8;
const MAX_CLOCK_SIZE = 12;
const MAX_ENEMIES_PER_SCENE = 4;
const MAX_ENEMY_HEALTH = 20;
const MAX_ENEMY_DAMAGE = 5;

let cache = null;

/**
 * Parse one YAML file; returns undefined when the file doesn't exist.
 * @param {string} filePath
 * @returns {*}
 */
function readYaml(filePath) {
    if (!fs.existsSync(filePath)) return undefined;
    return YAML.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Resolve a DC that may be a difficulty band name ('challenging') or number.
 * @param {string|number} dc
 * @returns {number|null} null when unresolvable
 */
function resolveDc(dc) {
    if (typeof dc === 'number' && Number.isInteger(dc) && dc >= 2 && dc <= 30) return dc;
    if (typeof dc === 'string' && DIFFICULTY[dc]) return DIFFICULTY[dc];
    return null;
}

/**
 * Validate a structured effects object against the closed vocabulary.
 * @param {Object} effects
 * @param {{clockIds: Set, sceneIds: Set, endingIds: Set}} refs
 * @param {string} where - human-readable location for error messages
 * @param {string[]} errors - accumulator
 */
function validateEffects(effects, refs, where, errors) {
    if (effects === undefined || effects === null) return;
    if (typeof effects !== 'object' || Array.isArray(effects)) {
        errors.push(`${where}: effects must be a mapping`);
        return;
    }
    const known = new Set(['clock', 'damage', 'heal', 'item', 'spark', 'goto', 'flag', 'end', 'npc']);
    for (const key of Object.keys(effects)) {
        if (!known.has(key)) errors.push(`${where}: unknown effect '${key}' (allowed: ${[...known].join(', ')})`);
    }
    if (effects.npc !== undefined) {
        const npc = effects.npc;
        if (!npc || typeof npc !== 'object' || !NPCS[npc.key] || !Number.isInteger(npc.delta)) {
            errors.push(`${where}: npc effect needs {key: <one of ${Object.keys(NPCS).join('|')}>, delta: <integer>}`);
        }
    }
    if (effects.clock !== undefined) {
        const clock = effects.clock;
        if (!clock || typeof clock !== 'object' || !refs.clockIds.has(clock.id) || !Number.isInteger(clock.delta)) {
            errors.push(`${where}: clock effect needs {id: <declared clock>, delta: <integer>}`);
        }
    }
    for (const numeric of ['damage', 'heal', 'spark']) {
        if (effects[numeric] !== undefined && (!Number.isInteger(effects[numeric]) || effects[numeric] < 0)) {
            errors.push(`${where}: '${numeric}' must be a non-negative integer`);
        }
    }
    if (effects.item !== undefined && (typeof effects.item !== 'string' || !effects.item.trim())) {
        errors.push(`${where}: 'item' must be a non-empty string`);
    }
    if (effects.goto !== undefined && !refs.sceneIds.has(effects.goto)) {
        errors.push(`${where}: goto points at unknown scene '${effects.goto}'`);
    }
    if (effects.end !== undefined && !refs.endingIds.has(effects.end)) {
        errors.push(`${where}: end points at unknown ending '${effects.end}'`);
    }
    if (effects.flag !== undefined) {
        const flag = effects.flag;
        if (!flag || typeof flag !== 'object' || typeof flag.key !== 'string' || !flag.key.trim()) {
            errors.push(`${where}: flag effect needs {key: <string>, value: <scalar>}`);
        }
    }
    if (effects.goto !== undefined && effects.end !== undefined) {
        errors.push(`${where}: an effect cannot both 'goto' and 'end'`);
    }
}

/**
 * Validate a fully assembled quest object.
 * @param {Object} quest
 * @returns {string[]} errors (empty when valid)
 */
function validateQuest(quest) {
    const errors = [];
    const where = (part) => `${quest.id || '?'}/${part}`;

    if (!quest.id || !ID_PATTERN.test(quest.id)) errors.push('quest.yaml: id must be a lowercase slug (a-z, 0-9, hyphens)');
    if (!quest.title || typeof quest.title !== 'string') errors.push('quest.yaml: title is required');
    if (!quest.hook || typeof quest.hook !== 'string') errors.push('quest.yaml: hook is required');
    if (quest.requires !== undefined && (typeof quest.requires !== 'string' || !ID_PATTERN.test(quest.requires))) {
        errors.push('quest.yaml: requires must be a quest id slug');
    }
    if (quest.requires === quest.id) errors.push('quest.yaml: a quest cannot require itself');
    if (quest.hidden !== undefined && typeof quest.hidden !== 'boolean') {
        errors.push('quest.yaml: hidden must be true/false');
    }
    if (quest.canonicalId !== undefined && (typeof quest.canonicalId !== 'string' || !ID_PATTERN.test(quest.canonicalId))) {
        errors.push('quest.yaml: canonicalId must be a quest id slug');
    }

    // Usable-item definitions
    if (quest.items !== undefined) {
        if (!quest.items || typeof quest.items !== 'object' || Array.isArray(quest.items)) {
            errors.push('quest.yaml: items must be a mapping of item name -> {use: {...}}');
        } else {
            for (const [itemName, def] of Object.entries(quest.items)) {
                const iWhere = `quest.yaml item '${itemName}'`;
                if (!itemName.trim()) errors.push(`${iWhere}: name must be non-empty`);
                const use = def?.use;
                if (!use || typeof use !== 'object') {
                    errors.push(`${iWhere}: needs a use block ({heal?, spark?, text?})`);
                    continue;
                }
                for (const numeric of ['heal', 'spark']) {
                    if (use[numeric] !== undefined && (!Number.isInteger(use[numeric]) || use[numeric] < 0)) {
                        errors.push(`${iWhere}: use.${numeric} must be a non-negative integer`);
                    }
                }
                if (use.text !== undefined && (typeof use.text !== 'string' || !use.text.trim())) {
                    errors.push(`${iWhere}: use.text must be a non-empty string when present`);
                }
                if (use.heal === undefined && use.spark === undefined && use.text === undefined) {
                    errors.push(`${iWhere}: use must contain at least one of heal, spark, text`);
                }
            }
        }
    }

    const players = quest.players || {};
    if (!Number.isInteger(players.min) || !Number.isInteger(players.max) || players.min < 1 || players.max < players.min) {
        errors.push('quest.yaml: players needs integer min >= 1 and max >= min');
    }

    const clockIds = new Set();
    for (const clock of quest.clocks || []) {
        if (!clock.id || !ID_PATTERN.test(clock.id) || clockIds.has(clock.id)) {
            errors.push(`quest.yaml: clock ids must be unique slugs (got '${clock.id}')`);
            continue;
        }
        clockIds.add(clock.id);
        if (!clock.name) errors.push(`quest.yaml: clock '${clock.id}' needs a name`);
        if (!Number.isInteger(clock.size) || clock.size < 1 || clock.size > MAX_CLOCK_SIZE) {
            errors.push(`quest.yaml: clock '${clock.id}' size must be 1-${MAX_CLOCK_SIZE}`);
        }
        if (clock.kind !== 'progress' && clock.kind !== 'danger') {
            errors.push(`quest.yaml: clock '${clock.id}' kind must be progress|danger`);
        }
    }

    const sceneIds = new Set(Object.keys(quest.scenes || {}));
    const endingIds = new Set(Object.keys(quest.endings || {}));
    const refs = { clockIds, sceneIds, endingIds };

    if (sceneIds.size === 0) errors.push('scenes/: at least one scene is required');
    if (endingIds.size === 0) errors.push('endings.yaml: at least one ending is required');
    if (!quest.start || !sceneIds.has(quest.start)) errors.push(`quest.yaml: start must name an existing scene (got '${quest.start}')`);

    // Clock onFull triggers
    for (const clock of quest.clocks || []) {
        if (clock.onFull === undefined || clock.onFull === null) continue;
        validateEffects(clock.onFull, refs, where(`quest.yaml clock '${clock.id}' onFull`), errors);
    }

    for (const [sceneId, scene] of Object.entries(quest.scenes || {})) {
        const sWhere = where(`scenes/${sceneId}.yaml`);
        if (!ID_PATTERN.test(sceneId)) errors.push(`${sWhere}: scene id must be a lowercase slug`);
        if (!scene.title) errors.push(`${sWhere}: title is required`);
        if (!scene.text || typeof scene.text !== 'string') errors.push(`${sWhere}: text is required`);

        const options = scene.options || [];
        if (!Array.isArray(options) || options.length === 0) {
            errors.push(`${sWhere}: at least one option is required`);
            continue;
        }
        if (options.length > MAX_OPTIONS_PER_SCENE) {
            errors.push(`${sWhere}: at most ${MAX_OPTIONS_PER_SCENE} options per scene`);
        }
        const optionKeys = new Set();
        for (const option of options) {
            const oWhere = `${sWhere} option '${option.key}'`;
            if (!option.key || !ID_PATTERN.test(option.key) || option.key.includes('_') || optionKeys.has(option.key)) {
                errors.push(`${sWhere}: option keys must be unique lowercase slugs without underscores (got '${option.key}')`);
                continue;
            }
            optionKeys.add(option.key);
            if (!option.label) errors.push(`${oWhere}: label is required`);

            const isTravel = option.goto !== undefined || option.end !== undefined;
            const isCheck = option.stat !== undefined;
            if (isTravel && isCheck) {
                errors.push(`${oWhere}: an option is either a check (stat/dc) or a direct goto/end, not both`);
            } else if (isTravel) {
                if (option.goto !== undefined && !sceneIds.has(option.goto)) errors.push(`${oWhere}: goto points at unknown scene '${option.goto}'`);
                if (option.end !== undefined && !endingIds.has(option.end)) errors.push(`${oWhere}: end points at unknown ending '${option.end}'`);
                // Travel options may carry side effects (e.g. an ending choice
                // that moves an NPC relationship) - but never a second hop.
                if (option.effects !== undefined) {
                    validateEffects(option.effects, refs, `${oWhere} effects`, errors);
                    if (option.effects && (option.effects.goto !== undefined || option.effects.end !== undefined)) {
                        errors.push(`${oWhere}: a travel option's effects cannot contain goto/end (the option itself travels)`);
                    }
                }
            } else if (isCheck) {
                if (!STAT_KEYS.includes(option.stat)) errors.push(`${oWhere}: stat must be one of ${STAT_KEYS.join(', ')}`);
                if (resolveDc(option.dc) === null) {
                    errors.push(`${oWhere}: dc must be 2-30 or a band name (${Object.keys(DIFFICULTY).join(', ')})`);
                }
                for (const branch of ['success', 'failure']) {
                    const outcome = option[branch];
                    if (!outcome || typeof outcome.text !== 'string' || !outcome.text.trim()) {
                        errors.push(`${oWhere}: ${branch} needs at least a text`);
                        continue;
                    }
                    validateEffects(outcome.effects, refs, `${oWhere} ${branch}`, errors);
                }
                if (option.bonus !== undefined) {
                    const bonus = option.bonus;
                    if (!bonus || typeof bonus.item !== 'string' || !Number.isInteger(bonus.value)) {
                        errors.push(`${oWhere}: bonus needs {item: <name>, value: <integer>}`);
                    }
                }
            } else {
                errors.push(`${oWhere}: needs either stat+dc+success/failure or goto/end`);
            }
        }

        if (scene.freeform !== undefined && scene.freeform !== null) {
            const freeform = scene.freeform;
            if (typeof freeform !== 'object') {
                errors.push(`${sWhere}: freeform must be a mapping (success/failure texts, progressClock, dangerClock)`);
            } else {
                if (freeform.progressClock !== undefined && !clockIds.has(freeform.progressClock)) {
                    errors.push(`${sWhere}: freeform.progressClock '${freeform.progressClock}' is not a declared clock`);
                }
                if (freeform.dangerClock !== undefined && !clockIds.has(freeform.dangerClock)) {
                    errors.push(`${sWhere}: freeform.dangerClock '${freeform.dangerClock}' is not a declared clock`);
                }
            }
        }

        if (scene.encounter !== undefined && scene.encounter !== null) {
            const encounter = scene.encounter;
            if (typeof encounter !== 'object' || !Array.isArray(encounter.enemies) || encounter.enemies.length === 0) {
                errors.push(`${sWhere}: encounter needs an enemies list`);
            } else {
                if (encounter.enemies.length > MAX_ENEMIES_PER_SCENE) {
                    errors.push(`${sWhere}: at most ${MAX_ENEMIES_PER_SCENE} enemies per encounter`);
                }
                const enemyIds = new Set();
                for (const enemy of encounter.enemies) {
                    const eWhere = `${sWhere} enemy '${enemy?.id}'`;
                    if (!enemy?.id || !ID_PATTERN.test(enemy.id) || enemy.id.includes('_') || enemyIds.has(enemy.id)) {
                        errors.push(`${sWhere}: enemy ids must be unique lowercase slugs without underscores (got '${enemy?.id}')`);
                        continue;
                    }
                    enemyIds.add(enemy.id);
                    if (!enemy.name) errors.push(`${eWhere}: name is required`);
                    if (!Number.isInteger(enemy.health) || enemy.health < 1 || enemy.health > MAX_ENEMY_HEALTH) {
                        errors.push(`${eWhere}: health must be 1-${MAX_ENEMY_HEALTH}`);
                    }
                    if (resolveDc(enemy.defense) === null) {
                        errors.push(`${eWhere}: defense must be 2-30 or a band name (${Object.keys(DIFFICULTY).join(', ')})`);
                    }
                    if (!Number.isInteger(enemy.damage) || enemy.damage < 0 || enemy.damage > MAX_ENEMY_DAMAGE) {
                        errors.push(`${eWhere}: damage must be 0-${MAX_ENEMY_DAMAGE}`);
                    }
                    if (!Array.isArray(enemy.intents) || enemy.intents.length === 0
                        || enemy.intents.some(intent => typeof intent !== 'string' || !intent.trim())) {
                        errors.push(`${eWhere}: intents must be a non-empty list of telegraphed-threat strings`);
                    }
                    if (enemy.onDefeat !== undefined) {
                        if (enemy.onDefeat.text !== undefined && typeof enemy.onDefeat.text !== 'string') {
                            errors.push(`${eWhere}: onDefeat.text must be a string`);
                        }
                        validateEffects(enemy.onDefeat.effects, refs, `${eWhere} onDefeat`, errors);
                    }
                }
                if (encounter.onVictory !== undefined) {
                    if (encounter.onVictory.text !== undefined && typeof encounter.onVictory.text !== 'string') {
                        errors.push(`${sWhere}: encounter.onVictory.text must be a string`);
                    }
                    validateEffects(encounter.onVictory.effects, refs, `${sWhere} encounter.onVictory`, errors);
                }
            }
        }
    }

    for (const [endingId, ending] of Object.entries(quest.endings || {})) {
        const eWhere = where(`endings.yaml '${endingId}'`);
        if (!ID_PATTERN.test(endingId)) errors.push(`${eWhere}: ending id must be a lowercase slug`);
        if (!ending.title) errors.push(`${eWhere}: title is required`);
        if (!ending.text) errors.push(`${eWhere}: text is required`);
        if (ending.trophy !== undefined && (typeof ending.trophy !== 'string' || !ending.trophy.trim())) {
            errors.push(`${eWhere}: trophy must be a non-empty string when present`);
        }
        if (ending.world !== undefined) {
            if (!Array.isArray(ending.world)) {
                errors.push(`${eWhere}: world must be a list of {kind, name, text} lore entries`);
            } else {
                for (const entry of ending.world) {
                    if (!entry || !LORE_KINDS.includes(entry.kind) || typeof entry.name !== 'string' || !entry.name.trim()
                        || typeof entry.text !== 'string' || !entry.text.trim()) {
                        errors.push(`${eWhere}: each world entry needs kind (${LORE_KINDS.join('|')}), name, and text`);
                    }
                }
            }
        }
    }

    return errors;
}

/**
 * Load one campaign directory into a quest object (not yet validated).
 * @param {string} dir - absolute path to the campaign directory
 * @returns {Object} quest
 */
function loadCampaignDir(dir) {
    const quest = readYaml(path.join(dir, 'quest.yaml'));
    if (!quest || typeof quest !== 'object') {
        throw new Error(`${dir}: quest.yaml is missing or empty`);
    }
    quest.id = quest.id || path.basename(dir);
    quest.clocks = quest.clocks || [];
    quest.tags = quest.tags || [];

    quest.scenes = {};
    const scenesDir = path.join(dir, 'scenes');
    if (fs.existsSync(scenesDir)) {
        for (const file of fs.readdirSync(scenesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).sort()) {
            const scene = readYaml(path.join(scenesDir, file));
            if (!scene || typeof scene !== 'object') continue;
            const sceneId = scene.id || file.replace(/\.ya?ml$/, '');
            scene.id = sceneId;
            quest.scenes[sceneId] = scene;
        }
    }

    quest.endings = {};
    const endings = readYaml(path.join(dir, 'endings.yaml'));
    for (const ending of Array.isArray(endings) ? endings : []) {
        if (ending && ending.id) quest.endings[ending.id] = ending;
    }

    return quest;
}

/**
 * Scan a root directory for campaign subdirectories.
 * @param {string} root
 * @returns {string[]} absolute campaign directory paths
 */
function listCampaignDirs(root) {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(root, entry.name))
        .filter(dir => fs.existsSync(path.join(dir, 'quest.yaml')))
        .sort();
}

/**
 * Load and validate every campaign. Built-ins that fail validation throw;
 * custom campaigns that fail are warned about and skipped.
 * @returns {{quests: Object<string, Object>, problems: string[]}}
 */
function loadAll() {
    const quests = {};
    const problems = [];

    for (const dir of listCampaignDirs(BUILTIN_DIR)) {
        const quest = loadCampaignDir(dir);
        const errors = validateQuest(quest);
        if (errors.length > 0) {
            throw new Error(`Built-in campaign '${quest.id}' is invalid:\n- ${errors.join('\n- ')}`);
        }
        quest.source = 'built-in';
        quests[quest.id] = quest;
    }

    for (const dir of listCampaignDirs(CUSTOM_DIR)) {
        try {
            const quest = loadCampaignDir(dir);
            const errors = validateQuest(quest);
            if (errors.length > 0) {
                problems.push(`Custom campaign '${quest.id}' skipped:\n- ${errors.join('\n- ')}`);
                continue;
            }
            quest.source = 'custom';
            // Same id as a built-in = deliberate override (the "alter a module" path)
            quests[quest.id] = quest;
        } catch (error) {
            problems.push(`Custom campaign at ${dir} skipped: ${error.message}`);
        }
    }

    for (const problem of problems) {
        console.warn(`[Tavern] ${problem}`);
    }

    return { quests, problems };
}

/**
 * All loaded quests, cached after the first call.
 * @returns {Object<string, Object>} questId -> quest
 */
function getQuests() {
    if (!cache) cache = loadAll();
    return cache.quests;
}

/**
 * One quest by id (or undefined).
 * @param {string} questId
 * @returns {Object|undefined}
 */
function getQuest(questId) {
    return getQuests()[questId];
}

/**
 * Quests for boards, browse, and autocomplete - hidden quests (story-twist
 * forks bound to one table) are resolvable by id but never listed.
 * @returns {Object[]}
 */
function getVisibleQuests() {
    return Object.values(getQuests()).filter(quest => !quest.hidden);
}

/**
 * Clear the cache and reload from disk (picks up new/edited campaign files
 * without a restart). Returns any custom-campaign problems for display.
 * @returns {{count: number, problems: string[]}}
 */
function reload() {
    cache = loadAll();
    return { count: Object.keys(cache.quests).length, problems: cache.problems };
}

module.exports = {
    getQuests,
    getQuest,
    getVisibleQuests,
    reload,
    validateQuest,
    resolveDc,
    loadCampaignDir,
    CUSTOM_DIR,
    BUILTIN_DIR,
    LORE_KINDS
};
