const fs = require('node:fs');
const path = require('node:path');
const openaiService = require('../openaiService');

/**
 * Generated Tavern art, stored as static files under data/tavern/assets/
 * (like data/music and data/images - local disk, easily accessed, survives
 * restarts, never regenerated once present):
 *
 *   data/tavern/assets/scenes/<quest-id>/<scene-id>.png
 *
 * Generation is optional (needs an OpenAI key) and admin-triggered
 * (`/tavern generate-art`), so there are never surprise image-API costs.
 * Views attach art whenever the file exists and stay text-only otherwise.
 */

const ASSETS_DIR = path.join(require('../../runtimePaths').dataDir, 'tavern', 'assets');

const ART_STYLE =
    'Storybook fantasy illustration, warm painterly style, cozy heroic fantasy ' +
    'with room for absurdity, soft lantern light, no text or lettering.';

/**
 * Absolute path where a scene's art lives (whether or not it exists yet).
 * @param {string} questId
 * @param {string} sceneId
 * @returns {string}
 */
function sceneArtPath(questId, sceneId) {
    return path.join(ASSETS_DIR, 'scenes', questId, `${sceneId}.png`);
}

/**
 * The scene's art file path when it exists on disk, else null.
 * @param {string} questId
 * @param {string} sceneId
 * @returns {string|null}
 */
function getSceneArt(questId, sceneId) {
    const filePath = sceneArtPath(questId, sceneId);
    return fs.existsSync(filePath) ? filePath : null;
}

/**
 * Whether art generation is possible (OpenAI images configured).
 * @returns {boolean}
 */
function canGenerate() {
    return typeof openaiService.isConfigured === 'function' && openaiService.isConfigured();
}

/**
 * Generate (and cache) art for every scene of a quest. Existing files are
 * kept unless `force`; per-scene failures are reported, never thrown.
 * @param {Object} quest - a loaded quest object
 * @param {Object} [opts] - { force?: boolean, usageContext?: {guildId, userId} }
 * @returns {Promise<{generated: string[], skipped: string[], failed: Array<{sceneId: string, error: string}>}>}
 */
async function generateQuestArt(quest, { force = false, usageContext = {} } = {}) {
    const result = { generated: [], skipped: [], failed: [] };
    if (!canGenerate()) {
        result.failed.push({ sceneId: '*', error: 'No OpenAI key configured - image generation unavailable.' });
        return result;
    }

    for (const scene of Object.values(quest.scenes)) {
        const filePath = sceneArtPath(quest.id, scene.id);
        if (!force && fs.existsSync(filePath)) {
            result.skipped.push(scene.id);
            continue;
        }
        try {
            const prompt =
                `${ART_STYLE}\n` +
                `Adventure: "${quest.title}". Scene: "${scene.title}".\n` +
                String(scene.text).trim().slice(0, 700);
            const buffer = await openaiService.generateImage(prompt, {
                size: '1536x1024',
                quality: 'medium',
                usageContext
            });
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, buffer);
            result.generated.push(scene.id);
        } catch (error) {
            result.failed.push({ sceneId: scene.id, error: error.message });
        }
    }
    return result;
}

module.exports = {
    ASSETS_DIR,
    sceneArtPath,
    getSceneArt,
    canGenerate,
    generateQuestArt
};
