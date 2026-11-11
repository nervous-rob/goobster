const aiConfig = require('../config/aiConfig');
const workContext = require('./workContext');

const DELEGATED_KINDS = new Set(['assistant_run', 'assistant_classification', 'automation', 'watch', 'job', 'expedition']);

/** Apply before selecting a provider so neither personal routing nor caller overrides bypass policy. */
function applyDelegationPolicy(opts = {}) {
    if (!opts.background && !DELEGATED_KINDS.has(workContext.current()?.kind)) return opts;
    const policy = aiConfig.delegation;
    // Fail closed for malformed hand-edited config rather than silently dropping a cap.
    if (!Number.isInteger(policy.maxOutputTokens) || policy.maxOutputTokens < 16 || policy.maxOutputTokens > 131072) {
        throw new Error('ai.delegation.maxOutputTokens must be an integer from 16 to 131072.');
    }
    const outputLimit = Math.min(opts.max_output_tokens_limit ?? Infinity, policy.maxOutputTokens);
    return {
        ...opts,
        ...(policy.provider ? { provider: policy.provider, model: policy.model || undefined } : policy.model ? { model: policy.model } : {}),
        personalAiDisabled: Boolean(opts.personalAiDisabled || policy.provider || policy.model),
        max_tokens: Math.min(opts.max_tokens ?? 4096, outputLimit),
        // Registry clips AFTER adding reasoning headroom; all provider adapters use it.
        max_output_tokens_limit: outputLimit
    };
}

module.exports = { applyDelegationPolicy };
