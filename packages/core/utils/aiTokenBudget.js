/**
 * Shared token budgeting for providers with hidden reasoning.
 *
 * Callers throughout the codebase size max_tokens for the *visible* reply
 * (e.g. 1000 for chat, 220 for voice turns). On reasoning models the same
 * cap also has to cover hidden thinking tokens (OpenAI reasoning, Claude
 * adaptive thinking, Gemini thinking all count against the output cap), so
 * each provider adds a thinking allowance on top of the requested budget
 * whenever reasoning is active. The cap is a ceiling, not a spend target -
 * unused headroom costs nothing.
 */

const THINKING_TOKEN_ALLOWANCE = {
    minimal: 1024,
    low: 4096,
    medium: 8192,
    high: 24576
};

/**
 * Add thinking headroom to a visible-output token budget.
 * @param {number} maxTokens - the caller's visible-output budget
 * @param {string|null} effort - effective reasoning effort/thinking level
 * @returns {number} total output cap (visible + thinking allowance)
 */
function withThinkingHeadroom(maxTokens, effort) {
    const allowance = THINKING_TOKEN_ALLOWANCE[effort];
    if (!allowance) return maxTokens;
    return maxTokens + allowance;
}

module.exports = { withThinkingHeadroom, THINKING_TOKEN_ALLOWANCE };
