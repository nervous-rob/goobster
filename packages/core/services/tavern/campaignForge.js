const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const aiService = require('../aiService');
const questLoader = require('./questLoader');
const { TavernError } = require('./tavernError');
const { STAT_KEYS, NPCS } = require('./content');

const FORGE_TIMEOUT_MS = 90_000;
const FORGE_MAX_TOKENS = 4000;
const TWIST_MAX_TOKENS = 2500;
const MAX_FORGED_SCENES = 6;
const MAX_TWIST_SCENES = 3;
const MAX_FORGED_ENDINGS = 4;

/**
 * The campaign forge: Goobster writes campaign YAML himself.
 *
 * Two capabilities, both writing into the custom campaigns directory
 * (data/tavern/campaigns/) that the loader already treats as first-class:
 *
 *  - forgeCampaign: a whole new campaign from a prompt (admin-triggered).
 *  - forgeTwist: mid-adventure story surgery. When the players' actions bend
 *    the story off-script, the model writes NEW scenes that pick the thread
 *    up - and a deterministic reachability check guarantees every new branch
 *    ties back into the ORIGINAL campaign's scenes/endings. The fork is
 *    written as a hidden override campaign (`<id>--twist-<adventureId>`,
 *    `canonicalId` pointing home) so the original stays untouched for other
 *    tables and future runs.
 *
 * The model proposes; the validator disposes: everything generated goes
 * through questLoader.validateQuest (plus the ties-back check) before a
 * single file is written, with one repair round on validation errors.
 */

const FORMAT_SPEC =
    'Campaign JSON format (all fields required unless noted):\n' +
    '{\n' +
    '  "id": "<lowercase-slug>", "title": "...", "type": "one-shot",\n' +
    '  "hook": "<2-4 sentences for the quest board>",\n' +
    '  "players": {"min": 1, "max": 4, "recommended": "1-4"},\n' +
    '  "duration": "20-40 min", "difficulty": "routine|challenging|difficult",\n' +
    '  "tags": ["..."], "affectsWorld": true|false, "reward": "...",\n' +
    '  "start": "<scene-id>",\n' +
    '  "clocks": [{"id": "<slug>", "name": "...", "size": 3-6, "kind": "progress"|"danger", "onFull": {"end": "<ending-id>"} (danger clocks only)}],\n' +
    '  "items": {"<Item Name>": {"use": {"heal": n, "spark": n, "text": "..."}}} (optional),\n' +
    '  "scenes": [ {scene}, ... ],\n' +
    '  "endings": [{"id": "<slug>", "title": "...", "text": "<epilogue paragraph>", "trophy": "<item name>" (optional),\n' +
    '               "world": [{"kind": "location|faction|event|artifact|character", "name": "...", "text": "..."}] (optional)}]\n' +
    '}\n' +
    'Scene format:\n' +
    '{\n' +
    '  "id": "<slug>", "title": "...", "text": "<the scene, 2-5 sentences>",\n' +
    '  "freeform": {"success": "...", "failure": "..."} (optional),\n' +
    '  "encounter": {"enemies": [{"id": "<slug>", "name": "...", "health": 4-10, "defense": "routine|challenging|difficult",\n' +
    '                "damage": 1-3, "intents": ["<telegraphed threat>", ...],\n' +
    '                "onDefeat": {"text": "...", "effects": {...}} (optional)}],\n' +
    '                "onVictory": {"text": "...", "effects": {"goto": "<scene>"}}} (optional; at most one encounter scene),\n' +
    '  "options": [\n' +
    '    {"key": "<slug-no-underscores>", "label": "<button label>", "emoji": "<one emoji>",\n' +
    '     "stat": "' + STAT_KEYS.join('|') + '", "dc": "routine|challenging|difficult", "once": true (optional),\n' +
    '     "success": {"text": "...", "effects": {...}}, "failure": {"text": "...", "effects": {...}}}\n' +
    '    OR travel options: {"key", "label", "emoji", "goto": "<scene-id>" or "end": "<ending-id>",\n' +
    '                        "effects": {...} (optional, no goto/end inside), "text": "..."}\n' +
    '  ]\n' +
    '}\n' +
    'Effects vocabulary (closed set): {"clock": {"id", "delta"}, "damage": n, "heal": n, "item": "name",\n' +
    '"spark": n, "flag": {"key", "value"}, "npc": {"key": "' + Object.keys(NPCS).join('|') + '", "delta": ±1}, "goto": "<scene>", "end": "<ending>"}.\n' +
    'Rules: every scene needs 2-4 options; failure text must open a new path, never a dead end; ' +
    'option keys and all ids are lowercase slugs WITHOUT underscores; keep the tone cozy-heroic with room for absurdity.';

/** Extract and parse the first JSON object in a model reply. */
function parseModelJson(text) {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

/** Slugify a title into a quest id. */
function slugify(text) {
    return String(text).toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-')
        .slice(0, 60) || 'forged-quest';
}

/** Convert a generated quest (scenes/endings as arrays) into loader shape. */
function toQuestShape(generated) {
    const quest = { ...generated };
    quest.scenes = {};
    for (const scene of Array.isArray(generated.scenes) ? generated.scenes : []) {
        if (scene?.id) quest.scenes[scene.id] = scene;
    }
    quest.endings = {};
    for (const ending of Array.isArray(generated.endings) ? generated.endings : []) {
        if (ending?.id) quest.endings[ending.id] = ending;
    }
    quest.clocks = quest.clocks || [];
    quest.tags = quest.tags || [];
    return quest;
}

/**
 * Write a quest object to a campaign directory (quest.yaml, endings.yaml,
 * scenes/*.yaml) under the custom campaigns dir.
 * @param {Object} quest - loader-shaped quest
 * @returns {string} the directory written
 */
function writeCampaignDir(quest) {
    const dir = path.join(questLoader.CUSTOM_DIR, quest.id);
    fs.mkdirSync(path.join(dir, 'scenes'), { recursive: true });

    const { scenes, endings, source, ...meta } = quest;
    fs.writeFileSync(path.join(dir, 'quest.yaml'), YAML.stringify(meta));
    fs.writeFileSync(path.join(dir, 'endings.yaml'), YAML.stringify(Object.values(endings)));
    for (const scene of Object.values(scenes)) {
        fs.writeFileSync(path.join(dir, 'scenes', `${scene.id}.yaml`), YAML.stringify(scene));
    }
    return dir;
}

/**
 * Deterministic ties-back check: starting from the twist's entry scene and
 * walking every goto/end edge through the NEW scenes, at least one path must
 * reach an original scene or original ending - and no new scene may be a
 * dead end (every new scene needs at least one outgoing edge).
 * @param {Object} mergedQuest
 * @param {Set<string>} newSceneIds
 * @param {string} entrySceneId
 * @returns {string[]} errors
 */
function checkTiesBack(mergedQuest, newSceneIds, entrySceneId) {
    const errors = [];
    const edgesOf = (scene) => {
        const edges = [];
        const collect = (effects) => {
            if (!effects) return;
            if (effects.goto) edges.push({ type: 'scene', id: effects.goto });
            if (effects.end !== undefined) edges.push({ type: 'ending', id: effects.end });
        };
        for (const option of scene.options || []) {
            if (option.goto) edges.push({ type: 'scene', id: option.goto });
            if (option.end !== undefined) edges.push({ type: 'ending', id: option.end });
            collect(option.success?.effects);
            collect(option.failure?.effects);
        }
        for (const enemy of scene.encounter?.enemies || []) collect(enemy.onDefeat?.effects);
        collect(scene.encounter?.onVictory?.effects);
        return edges;
    };

    let tiesBack = false;
    const seen = new Set();
    const queue = [entrySceneId];
    while (queue.length > 0) {
        const sceneId = queue.shift();
        if (seen.has(sceneId)) continue;
        seen.add(sceneId);
        if (!newSceneIds.has(sceneId)) {
            // Reached an original scene - the thread rejoined the campaign
            tiesBack = true;
            continue;
        }
        const scene = mergedQuest.scenes[sceneId];
        const edges = edgesOf(scene);
        if (edges.length === 0) {
            errors.push(`new scene '${sceneId}' is a dead end (no goto/end anywhere)`);
        }
        for (const edge of edges) {
            if (edge.type === 'ending') tiesBack = true;
            else queue.push(edge.id);
        }
    }
    if (!tiesBack) {
        errors.push('no path from the twist leads back to an existing scene or ending - the story must tie back');
    }
    return errors;
}

/** One model call with a timeout (timer cleared either way). */
async function callModel(prompt, maxTokens, usageContext) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('forge timeout')), FORGE_TIMEOUT_MS);
        timer.unref?.();
    });
    return Promise.race([
        aiService.generateText(prompt, { max_tokens: maxTokens, temperature: 0.8, usageContext }),
        timeout
    ]).finally(() => clearTimeout(timer));
}

/**
 * Forge a brand-new campaign from a prompt. Validates before writing; one
 * repair round on errors.
 * @param {Object} params - { prompt, guildId, userId }
 * @returns {Promise<Object>} the loaded quest
 * @throws {TavernError} FORGE_FAILED with details when generation is unusable
 */
async function forgeCampaign({ prompt, guildId, userId }) {
    const usageContext = { guildId, userId };
    const basePrompt =
        'You are Goobster, writing a new playable campaign for the Goobster Tavern tabletop system.\n\n' +
        `${FORMAT_SPEC}\n\n` +
        `Write a campaign (at most ${MAX_FORGED_SCENES} scenes, at most ${MAX_FORGED_ENDINGS} endings, ` +
        '1-2 clocks, optionally ONE encounter scene) based on this request:\n' +
        `"${String(prompt).trim().slice(0, 600)}"\n\n` +
        'Answer with ONLY the JSON object.';

    let quest = null;
    let errors = ['model produced no JSON'];
    for (let attempt = 0; attempt < 2; attempt++) {
        const ask = attempt === 0
            ? basePrompt
            : `${basePrompt}\n\nYour previous attempt failed validation:\n- ${errors.join('\n- ')}\nFix these and answer with ONLY the corrected JSON.`;
        const parsed = parseModelJson(await callModel(ask, FORGE_MAX_TOKENS, usageContext).catch(() => null));
        if (!parsed) {
            errors = ['model produced no parseable JSON'];
            continue;
        }
        const candidate = toQuestShape(parsed);
        candidate.id = slugify(candidate.id || candidate.title || 'forged-quest');
        // Never overwrite an existing campaign by accident
        if (questLoader.getQuest(candidate.id)) candidate.id = `${candidate.id}-${Date.now() % 100000}`;
        if (Object.keys(candidate.scenes).length > MAX_FORGED_SCENES) {
            errors = [`too many scenes (max ${MAX_FORGED_SCENES})`];
            continue;
        }
        errors = questLoader.validateQuest(candidate);
        if (errors.length === 0) {
            quest = candidate;
            break;
        }
    }
    if (!quest) {
        const error = new TavernError('FORGE_FAILED', 'The forge sputtered - the generated campaign did not validate. Try a more specific prompt.');
        error.details = errors;
        throw error;
    }

    writeCampaignDir(quest);
    questLoader.reload();
    return questLoader.getQuest(quest.id);
}

/**
 * Forge a mid-adventure story twist: new scenes grafted onto a hidden fork
 * of the running campaign, guaranteed (deterministically) to tie back into
 * the original scenes/endings.
 * @param {Object} params - { adventure, quest, scene, recentLog, twist, guildId, userId }
 * @returns {Promise<{forkQuestId: string, entrySceneId: string, note: string}>}
 * @throws {TavernError} FORGE_FAILED when generation is unusable
 */
async function forgeTwist({ adventure, quest, scene, recentLog, twist, guildId, userId }) {
    const usageContext = { guildId, userId };
    const existingScenes = Object.values(quest.scenes)
        .map(s => `- "${s.id}": ${s.title}`).join('\n');
    const existingEndings = Object.values(quest.endings)
        .map(e => `- "${e.id}": ${e.title}`).join('\n');
    const clocks = (quest.clocks || []).map(c => `- "${c.id}": ${c.name} (${c.kind})`).join('\n');

    const basePrompt =
        'You are Goobster, the narrator of a live Tavern adventure. The players have bent the story ' +
        'off-script, and you must write NEW scenes that honor their idea AND tie the thread back into ' +
        'the campaign as written - a detour, not a different book.\n\n' +
        `Campaign: ${quest.title}\nHook: ${quest.hook.trim().slice(0, 400)}\n` +
        `Existing scenes (do NOT rewrite them; you may goto them):\n${existingScenes}\n` +
        `Existing endings (your detour must ultimately lead to these; you may NOT invent new endings):\n${existingEndings}\n` +
        `Existing clocks (the only clocks you may reference):\n${clocks || '- none'}\n` +
        `The party is currently in scene "${scene.id}" (${scene.title}).\n` +
        `Recent story beats:\n${recentLog}\n\n` +
        `THE TWIST the players want: "${String(twist).trim().slice(0, 400)}"\n\n` +
        `${FORMAT_SPEC}\n\n` +
        `Answer with ONLY JSON: {"note": "<one-line summary of the twist>", "entrySceneId": "<id of the first new scene>", ` +
        `"scenes": [<1-${MAX_TWIST_SCENES} NEW scene objects with NEW ids that do not collide with existing scene ids>]}. ` +
        'Every new scene must eventually goto an existing scene or end at an existing ending.';

    let fork = null;
    let entrySceneId = null;
    let note = null;
    let errors = ['model produced no JSON'];

    for (let attempt = 0; attempt < 2; attempt++) {
        const ask = attempt === 0
            ? basePrompt
            : `${basePrompt}\n\nYour previous attempt failed validation:\n- ${errors.join('\n- ')}\nFix these and answer with ONLY the corrected JSON.`;
        const parsed = parseModelJson(await callModel(ask, TWIST_MAX_TOKENS, usageContext).catch(() => null));
        if (!parsed || !Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
            errors = ['answer must be JSON with a non-empty scenes list'];
            continue;
        }
        if (parsed.scenes.length > MAX_TWIST_SCENES) {
            errors = [`too many new scenes (max ${MAX_TWIST_SCENES})`];
            continue;
        }

        const newSceneIds = new Set();
        errors = [];
        for (const newScene of parsed.scenes) {
            if (!newScene?.id) {
                errors.push('every new scene needs an id');
            } else if (quest.scenes[newScene.id]) {
                errors.push(`scene id '${newScene.id}' already exists in the campaign - new scenes need new ids`);
            } else {
                newSceneIds.add(newScene.id);
            }
        }
        if (!parsed.entrySceneId || !newSceneIds.has(parsed.entrySceneId)) {
            errors.push('entrySceneId must be one of the new scenes');
        }
        if (errors.length > 0) continue;

        // Build the hidden fork: original campaign + new scenes, same endings
        const candidate = JSON.parse(JSON.stringify({ ...quest, scenes: quest.scenes, endings: quest.endings }));
        candidate.id = `${quest.canonicalId || quest.id}--twist-${adventure.id}`;
        candidate.canonicalId = quest.canonicalId || quest.id;
        candidate.hidden = true;
        delete candidate.source;
        for (const newScene of parsed.scenes) candidate.scenes[newScene.id] = newScene;

        errors = [
            ...questLoader.validateQuest(candidate),
            ...checkTiesBack(candidate, newSceneIds, parsed.entrySceneId)
        ];
        if (errors.length === 0) {
            fork = candidate;
            entrySceneId = parsed.entrySceneId;
            note = String(parsed.note || twist).trim().slice(0, 200);
            break;
        }
    }

    if (!fork) {
        const error = new TavernError('FORGE_FAILED', 'The story resisted that twist - the generated scenes did not validate. Try phrasing it differently.');
        error.details = errors;
        throw error;
    }

    writeCampaignDir(fork);
    questLoader.reload();
    return { forkQuestId: fork.id, entrySceneId, note };
}

module.exports = {
    forgeCampaign,
    forgeTwist,
    checkTiesBack,
    writeCampaignDir,
    toQuestShape,
    parseModelJson,
    slugify
};
