/**
 * Presence checks for optional live-integration credentials.
 *
 * Reports names and status only — never values. Empty or whitespace-only
 * values count as absent. Fork PRs normally have no repository secrets,
 * so skips are expected there.
 */
'use strict';

const PROVIDERS = [
    { id: 'openai', env: 'OPENAI_API_KEY', label: 'OpenAI' },
    { id: 'anthropic', env: 'ANTHROPIC_API_KEY', label: 'Anthropic' },
    { id: 'gemini', env: 'GEMINI_API_KEY', label: 'Gemini' },
    { id: 'perplexity', env: 'PERPLEXITY_API_KEY', label: 'Perplexity' },
    { id: 'elevenlabs', env: 'ELEVENLABS_API_KEY', label: 'ElevenLabs' }
];

function isCredentialPresent(name, env = process.env) {
    const value = env[name];
    return typeof value === 'string' && value.trim().length > 0;
}

function skipReasonFor(providerId, env = process.env) {
    const provider = PROVIDERS.find((entry) => entry.id === providerId);
    if (!provider) {
        throw new Error(`Unknown live provider: ${providerId}`);
    }
    if (isCredentialPresent(provider.env, env)) return null;
    return `${provider.env} is not set`;
}

function inventory(env = process.env) {
    return PROVIDERS.map((provider) => {
        const present = isCredentialPresent(provider.env, env);
        return {
            id: provider.id,
            env: provider.env,
            label: provider.label,
            present,
            skipReason: present ? null : `${provider.env} is not set`
        };
    });
}

function formatInventory(rows = inventory()) {
    const lines = [
        'Live credentials (names and status only; values are never printed)'
    ];
    for (const row of rows) {
        lines.push(`  ${row.env}: ${row.present ? 'present' : 'absent'}`);
    }
    return lines.join('\n');
}

module.exports = {
    PROVIDERS,
    formatInventory,
    inventory,
    isCredentialPresent,
    skipReasonFor
};
