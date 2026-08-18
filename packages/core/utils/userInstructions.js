/**
 * Per-user custom instructions - the ChatGPT-style "how should Goobster
 * respond" text. Stored on UserPreferences.custom_instructions (one row per
 * Discord user, deleted whole by /forget-me), set from the web portal's
 * settings dialog, and applied to every chat surface: web, DMs, and guild
 * chat (guild personality directives still take precedence - they are
 * appended later in the prompt with an explicit override clause).
 */

const db = require('../db');

const MAX_INSTRUCTIONS_LENGTH = 2000;

/**
 * The user's custom instructions, or null when unset.
 * @param {string} userId - Discord user snowflake
 * @returns {string|null}
 */
function getUserInstructions(userId) {
    const row = db.get(
        'SELECT custom_instructions FROM UserPreferences WHERE userId = @userId',
        { userId }
    );
    const text = row?.custom_instructions;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
}

/**
 * Set (or clear, with null/empty) the user's custom instructions.
 * @param {string} userId
 * @param {string|null} instructions
 * @returns {string|null} the stored value
 * @throws {Error} when the text exceeds MAX_INSTRUCTIONS_LENGTH
 */
function setUserInstructions(userId, instructions) {
    const clean = typeof instructions === 'string' ? instructions.trim() : '';
    if (clean.length > MAX_INSTRUCTIONS_LENGTH) {
        const error = new Error(`Custom instructions must be at most ${MAX_INSTRUCTIONS_LENGTH} characters.`);
        error.code = 'INSTRUCTIONS_TOO_LONG';
        throw error;
    }
    db.run(
        `INSERT INTO UserPreferences (userId, custom_instructions, updatedAt)
         VALUES (@userId, @instructions, datetime('now'))
         ON CONFLICT(userId) DO UPDATE SET
             custom_instructions = @instructions,
             updatedAt = datetime('now')`,
        { userId, instructions: clean || null }
    );
    return clean || null;
}

/**
 * The system-prompt block for a user's instructions, or null when unset.
 * @param {string} userId
 * @returns {string|null}
 */
function buildInstructionsBlock(userId) {
    const instructions = getUserInstructions(userId);
    if (!instructions) return null;
    return 'USER CUSTOM INSTRUCTIONS (set by this user - follow them when replying to them, ' +
        'unless they conflict with a server directive or safety):\n' + instructions;
}

module.exports = {
    MAX_INSTRUCTIONS_LENGTH,
    getUserInstructions,
    setUserInstructions,
    buildInstructionsBlock
};
