const aiService = require('../aiService');
const { STAT_KEYS, DIFFICULTY } = require('./content');

const NARRATION_TIMEOUT_MS = 20_000;
const NARRATION_MAX_TOKENS = 350;

/**
 * Optional AI narration for the Tavern. Every function here degrades
 * gracefully: on any failure (no provider, timeout, unusable JSON) it
 * returns null and the caller falls back to the campaign's pre-authored
 * prose and the deterministic keyword interpreter. The AI never decides
 * mechanics - stat/DC suggestions are clamped, and state changes stay in
 * the engine.
 */

const GM_STYLE =
    'You are the narrator of the Goobster Tavern, a cozy heroic-fantasy tabletop game on Discord ' +
    'with room for absurdity and occasional darkness. Voice: warm, wry, vivid, concise. ' +
    'Never say "invalid action" - fold whatever the player tries into the fiction.';

/**
 * Race a promise against a timeout (narration must never stall a turn).
 */
function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('narration timeout')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Ask the model to map a freeform action to a stat and difficulty band.
 * @param {string} actionText
 * @param {{scene: Object, character: Object}} context
 * @param {{guildId: string, userId: string}} usageContext
 * @returns {Promise<{stat: string, dc: number}|null>}
 */
async function interpretAction(actionText, { scene, character }, usageContext) {
    try {
        const prompt =
            `${GM_STYLE}\n\n` +
            `Scene: ${scene.title}. ${String(scene.text).slice(0, 400)}\n` +
            `Character: ${character.name} (${character.origin}).\n` +
            `The player says: "${actionText}"\n\n` +
            'Which stat does this action test, and how hard is it?\n' +
            `Stats: ${STAT_KEYS.join(', ')}. Difficulty: routine=10, challenging=13, difficult=16, heroic=19.\n` +
            'Answer with ONLY JSON: {"stat": "<stat>", "dc": <number>}';
        const text = await withTimeout(
            aiService.generateText(prompt, { max_tokens: 60, temperature: 0.2, usageContext }),
            NARRATION_TIMEOUT_MS
        );
        const match = String(text).match(/\{[\s\S]*\}/);
        if (!match) return null;
        const parsed = JSON.parse(match[0]);
        if (!STAT_KEYS.includes(parsed.stat)) return null;
        const dc = Number(parsed.dc);
        if (!Number.isFinite(dc)) return null;
        // Clamp to the sane band range - the model does not set legend-making DCs
        return { stat: parsed.stat, dc: Math.max(DIFFICULTY.routine, Math.min(DIFFICULTY.heroic, Math.round(dc))) };
    } catch {
        return null;
    }
}

/**
 * Narrate the outcome of a freeform action (listed options carry their own
 * pre-authored prose and skip this).
 * @param {Object} params - { quest, scene, character, actionText, stat, dc, roll, total, success, happenings }
 * @param {{guildId: string, userId: string}} usageContext
 * @returns {Promise<string|null>}
 */
async function narrateOutcome({ quest, scene, character, actionText, stat, dc, roll, total, success, happenings }, usageContext) {
    try {
        const prompt =
            `${GM_STYLE}\n\n` +
            `Adventure: ${quest.title}.\n` +
            `Scene: ${scene.title}. ${String(scene.text).slice(0, 500)}\n` +
            `${character.name} (${character.origin}, complication: "${character.complication}") tried: "${actionText}"\n` +
            `Check: d20(${roll}) + ${stat} = ${total} vs DC ${dc} -> ${success ? 'SUCCESS' : 'FAILURE'}.\n` +
            (happenings?.length ? `Mechanical consequences already decided: ${happenings.join('; ')}\n` : '') +
            'Narrate this beat in 2-4 sentences, second person. ' +
            (success
                ? 'Let the attempt work, with style.'
                : 'Failure creates complications, costs, or new paths - never a dead "nothing happens".') +
            ' Do not invent items, damage, or scene changes beyond the consequences listed, and do not' +
            ' restate the consequence lines themselves (clocks, damage numbers) - they are displayed separately.';
        const text = await withTimeout(
            aiService.generateText(prompt, { max_tokens: NARRATION_MAX_TOKENS, temperature: 0.8, usageContext }),
            NARRATION_TIMEOUT_MS
        );
        // Belt and braces: drop any mechanical line the model echoed anyway
        const echoed = new Set((happenings || []).map(line => line.trim()));
        const clean = String(text || '')
            .split('\n')
            .filter(line => !echoed.has(line.trim()))
            .join('\n')
            .trim();
        return clean.length > 0 && clean.length < 1500 ? clean : null;
    } catch {
        return null;
    }
}

/**
 * Polish a deterministic recap into a short tavern-tale paragraph. The
 * structured recap is already stored; this is display flavor only.
 * @param {string} recapText
 * @param {{guildId: string, userId: string|null}} usageContext
 * @returns {Promise<string|null>}
 */
async function polishRecap(recapText, usageContext) {
    try {
        const prompt =
            `${GM_STYLE}\n\n` +
            'Retell this adventure log as one short, lively recap paragraph (4-6 sentences), ' +
            'past tense, as if told across the tavern bar. Keep every proper noun accurate. ' +
            'Do not add events that are not in the log.\n\n' +
            recapText;
        const text = await withTimeout(
            aiService.generateText(prompt, { max_tokens: NARRATION_MAX_TOKENS, temperature: 0.8, usageContext }),
            NARRATION_TIMEOUT_MS
        );
        const clean = String(text || '').trim();
        return clean.length > 0 && clean.length < 2000 ? clean : null;
    } catch {
        return null;
    }
}

module.exports = { interpretAction, narrateOutcome, polishRecap };
