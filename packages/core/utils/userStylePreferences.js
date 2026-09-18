/**
 * Account-wide conversation-style preferences (spec ID03, ID09–ID14).
 *
 * Stored in user_settings.preferencesJson and consumed as a delimited
 * system-prompt block. Soft defaults: an explicit request in the current
 * turn wins; server directives and safety still take precedence. These
 * are never tool permissions.
 */

const { PREFERENCE_DEFAULTS } = require('../config/userSettingsSchema');

async function loadPreferences(userId) {
    if (!userId) return { ...PREFERENCE_DEFAULTS };
    const userSettingsService = require('../services/userSettingsService');
    return userSettingsService.getPreferences(userId);
}

/**
 * Account-wide preferred-name fallback (ID03). Used when no explicit
 * scope nickname exists. Does not rename the Discord account.
 */
async function getAccountPreferredName(userId) {
    if (!userId) return null;
    const prefs = await loadPreferences(userId);
    return prefs.accountPreferredName || null;
}

function describeHumorVsMeme(prefs, memeOn) {
    if (memeOn) {
        return 'Humor and emoji: meme mode is on, so it wins over the structured humor preference.';
    }
    if (prefs.humor === 'off') return 'Humor and emoji: keep jokes and emoji rare unless the user asks.';
    if (prefs.humor === 'playful') return 'Humor and emoji: a playful register is welcome; still stay kind.';
    return null;
}

/**
 * Soft style/locale block, or null when every field is still the default.
 * @param {string} userId
 * @param {{ memeMode?: boolean }} [opts]
 * @returns {Promise<string|null>}
 */
async function buildUserStyleBlock(userId, opts = {}) {
    const prefs = await loadPreferences(userId);
    const lines = [];

    if (prefs.answerLength && prefs.answerLength !== PREFERENCE_DEFAULTS.answerLength) {
        lines.push(`Preferred answer length: ${prefs.answerLength} (a soft preference, not a token budget).`);
    }
    if (prefs.tone && prefs.tone !== PREFERENCE_DEFAULTS.tone) {
        lines.push(`Preferred tone: ${prefs.tone}.`);
    }
    const humorLine = describeHumorVsMeme(prefs, Boolean(opts.memeMode));
    if (humorLine) lines.push(humorLine);
    else if (prefs.humor && prefs.humor !== PREFERENCE_DEFAULTS.humor) {
        lines.push(`Humor and emoji: ${prefs.humor}.`);
    }
    if (prefs.responseLanguage) {
        lines.push(`Preferred response language: ${prefs.responseLanguage}. Follow the conversation if they write in another language.`);
    }
    if (prefs.timezone) {
        lines.push(`The user's timezone is ${prefs.timezone}. Use it when stating local times.`);
    }
    if (prefs.measurementSystem && prefs.measurementSystem !== 'follow-locale') {
        lines.push(`Preferred units: ${prefs.measurementSystem}. Persist timestamps in UTC.`);
    }
    if (prefs.timeFormat && prefs.timeFormat !== 'follow-locale') {
        lines.push(`Preferred clock: ${prefs.timeFormat}-hour.`);
    }
    if (prefs.dateLocale) {
        lines.push(`Preferred date locale: ${prefs.dateLocale}.`);
    }

    if (lines.length === 0) return null;
    return 'USER PREFERENCES (soft defaults for this person — an explicit request in the current turn wins; '
        + 'server directives and safety still take precedence; these are not tool permissions):\n'
        + lines.join('\n');
}

module.exports = {
    loadPreferences,
    getAccountPreferredName,
    buildUserStyleBlock
};
