/**
 * Unified User Settings Service (spec §7, §8, §9, §10).
 *
 * Typed facade over Goobster's personal preference stores:
 *  - dm:<userId> guild_settings (AI overrides, voice, speed, bot alias, directive, retention)
 *  - user_nicknames (per-scope / DM human name)
 *  - UserPreferences (custom instructions, meme mode)
 *  - attention_policies (enrollment, initiative, boundaries, quiet hours, budgets)
 *  - user_integrations (connected services summary)
 *  - user_settings (synced appearance / user preferences)
 *  - user_setting_revisions (per-section optimistic concurrency)
 *
 * Enforces atomic section validation, optimistic concurrency via revisions,
 * safe attention editing (preserving enabled status), and cross-process
 * cache invalidation via the event bus.
 */

const db = require('../db');
const { dmScopeId } = require('../utils/dmScope');
const guildSettings = require('../utils/guildSettings');
const userInstructions = require('../utils/userInstructions');
const memeMode = require('../utils/memeMode');
const attentionPolicyService = require('./attentionPolicyService');
const userIntegrationService = require('./userIntegrationService');
const aiService = require('./aiService');
const eventBusService = require('./eventBusService');
const {
    SECTIONS,
    EDITABLE_SECTIONS,
    SCOPES,
    SECTION_METADATA,
    REASONING_EFFORTS,
    INITIATIVE_LEVELS,
    THEMES,
    LIMITS
} = require('../config/userSettingsSchema');

class UserSettingsError extends Error {
    constructor(status, code, message, details = null) {
        super(message);
        this.name = 'UserSettingsError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

class UserSettingsService {
    get sections() {
        return SECTIONS;
    }

    get editableSections() {
        return EDITABLE_SECTIONS;
    }

    /**
     * Get the current revision number for a user and section.
     * @param {string} userId
     * @param {string} section
     * @returns {Promise<number>}
     */
    async getRevision(userId, section) {
        if (!userId || !section) return 1;
        const row = await db.get(
            'SELECT revision FROM user_setting_revisions WHERE userId = @userId AND section = @section',
            { userId, section }
        );
        return row?.revision ? Number(row.revision) : 1;
    }

    /**
     * Get all revisions for a user keyed by section name.
     * @param {string} userId
     * @returns {Promise<Record<string, number>>}
     */
    async getAllRevisions(userId) {
        const rows = await db.all(
            'SELECT section, revision FROM user_setting_revisions WHERE userId = @userId',
            { userId }
        );
        const map = {};
        for (const s of SECTIONS) map[s] = 1;
        for (const row of rows) {
            if (row.section) map[row.section] = Number(row.revision) || 1;
        }
        return map;
    }

    /**
     * Read aggregated settings for a user.
     * @param {Object} params - { userId, gateway }
     * @returns {Promise<Object>}
     */
    async getSettings({ userId, gateway = null }) {
        if (!userId) {
            throw new UserSettingsError(400, 'BAD_USER', 'User ID is required.');
        }

        const dmScope = dmScopeId(userId);
        const revisions = await this.getAllRevisions(userId);

        // Fetch independent data sources concurrently, with graceful fallbacks
        const [
            aiCurrent,
            botNickname,
            userNickname,
            instructions,
            personalityDirective,
            isMeme,
            voiceCurrent,
            policy,
            retentionDays,
            integrationsList,
            userSettingsRow,
            userAccountRow
        ] = await Promise.all([
            guildSettings.getGuildAI(dmScope).catch(() => ({})),
            guildSettings.getBotNickname(dmScope).catch(() => null),
            guildSettings.getUserNickname(userId, dmScope).catch(() => null),
            userInstructions.getUserInstructions(userId).catch(() => null),
            guildSettings.getPersonalityDirective(dmScope).catch(() => null),
            memeMode.isMemeModeEnabled(userId).catch(() => false),
            guildSettings.getTtsVoice(dmScope).catch(() => ({ voiceId: null, voiceName: null, speed: 1.0 })),
            attentionPolicyService.get(userId).catch(() => null),
            guildSettings.getMemoryRetentionDays(dmScope).catch(() => null),
            userIntegrationService.list(userId).catch(() => []),
            db.get('SELECT preferencesJson FROM user_settings WHERE userId = @userId', { userId }).catch(() => null),
            db.get('SELECT discordUsername, username, avatar FROM users WHERE discordId = @userId', { userId }).catch(() => null)
        ]);

        let customPrefs = {};
        if (userSettingsRow?.preferencesJson) {
            try {
                customPrefs = JSON.parse(userSettingsRow.preferencesJson) || {};
            } catch {
                customPrefs = {};
            }
        }

        // --- 1. Profile Section ---
        const effectiveCallGoobster = botNickname || 'Goobster';
        const effectiveCallUser = userNickname || userAccountRow?.discordUsername || userAccountRow?.username || 'You';
        const profileSection = {
            revision: revisions.profile || 1,
            scope: SCOPES.PRIVATE,
            values: {
                callGoobster: botNickname || null,
                callUser: userNickname || null,
                customInstructions: instructions || null,
                personalityDirective: personalityDirective || null,
                memeMode: Boolean(isMeme)
            },
            effective: {
                callGoobster: effectiveCallGoobster,
                callUser: effectiveCallUser,
                customInstructions: instructions || null,
                personalityDirective: personalityDirective || null,
                memeMode: Boolean(isMeme)
            },
            sources: {
                callGoobster: botNickname ? 'user-preference' : 'system-default',
                callUser: userNickname ? 'user-preference' : 'discord-account',
                customInstructions: instructions ? 'user-preference' : 'unset',
                personalityDirective: personalityDirective ? 'user-preference' : 'unset',
                memeMode: isMeme ? 'user-preference' : 'default-disabled'
            },
            appliesTo: SECTION_METADATA.profile.appliesTo
        };

        // --- 2. Chat Section ---
        const providers = aiService.listProviders();
        const preset = aiService.getThoughtfulPreset(aiCurrent.provider || undefined);
        const isThoughtful = Boolean(preset)
            && aiCurrent.model === preset.model
            && aiCurrent.reasoningEffort === 'high';

        const effectiveProviderKey = aiCurrent.provider || aiService.getProvider();
        const effectiveProviderEntry = providers.find(p => p.key === effectiveProviderKey) || null;
        const effectiveModel = aiCurrent.model || effectiveProviderEntry?.chatModel || aiService.getDefaultModel();
        const effectiveReasoning = aiCurrent.reasoningEffort || null;

        const chatSection = {
            revision: revisions.chat || 1,
            scope: SCOPES.PRIVATE,
            values: {
                provider: aiCurrent.provider || null,
                model: aiCurrent.model || null,
                reasoningEffort: aiCurrent.reasoningEffort || null,
                thoughtful: isThoughtful
            },
            effective: {
                provider: effectiveProviderKey,
                providerName: effectiveProviderEntry?.name || effectiveProviderKey,
                model: effectiveModel,
                reasoningEffort: effectiveReasoning,
                thoughtful: isThoughtful
            },
            sources: {
                provider: aiCurrent.provider ? 'user-override' : 'host-default',
                model: aiCurrent.model ? 'user-override' : 'provider-default',
                reasoningEffort: aiCurrent.reasoningEffort ? 'user-override' : 'default'
            },
            appliesTo: SECTION_METADATA.chat.appliesTo,
            providers,
            thoughtfulAvailable: Boolean(preset)
        };

        // --- 3. Voice Section ---
        const voiceSpeed = voiceCurrent.speed != null ? Number(voiceCurrent.speed) : 1.0;
        const voiceSection = {
            revision: revisions.voice || 1,
            scope: SCOPES.PRIVATE,
            values: {
                voiceId: voiceCurrent.voiceId || null,
                voiceName: voiceCurrent.voiceName || null,
                speed: voiceSpeed
            },
            effective: {
                voiceId: voiceCurrent.voiceId || null,
                voiceName: voiceCurrent.voiceName || '(Host default voice)',
                speed: voiceSpeed
            },
            sources: {
                voice: voiceCurrent.voiceId ? 'user-preference' : 'host-default',
                speed: voiceCurrent.speed != null ? 'user-preference' : 'default'
            },
            appliesTo: SECTION_METADATA.voice.appliesTo
        };

        // --- 4. Initiative Section ---
        const initiativeEnabled = policy ? Boolean(policy.enabled) : false;
        const initiativeLevel = policy?.initiative || 'nudge';
        const boundaries = {};
        for (const cat of attentionPolicyService.categories) {
            boundaries[cat] = attentionPolicyService.boundariesFor(policy, cat);
        }

        const initiativeSection = {
            revision: revisions.initiative || 1,
            scope: SCOPES.ACCOUNT,
            values: {
                enabled: initiativeEnabled,
                initiative: initiativeLevel,
                maxContactsPerDay: policy?.maxContactsPerDay ?? 3,
                contactCooldownMinutes: policy?.contactCooldownMinutes ?? 120,
                quietStartMinute: policy?.quietStartMinute ?? null,
                quietEndMinute: policy?.quietEndMinute ?? null,
                boundaries: policy?.boundaries || {}
            },
            effective: {
                enabled: initiativeEnabled,
                initiative: initiativeLevel,
                maxContactsPerDay: policy?.maxContactsPerDay ?? 3,
                contactCooldownMinutes: policy?.contactCooldownMinutes ?? 120,
                quietStartMinute: policy?.quietStartMinute ?? null,
                quietEndMinute: policy?.quietEndMinute ?? null,
                boundaries
            },
            sources: {
                enabled: policy ? 'user-preference' : 'default-disabled',
                initiative: policy?.initiative ? 'user-preference' : 'default',
                budget: (policy?.maxContactsPerDay != null) ? 'user-preference' : 'default',
                quietHours: (policy?.quietStartMinute != null) ? 'user-preference' : 'unset'
            },
            appliesTo: SECTION_METADATA.initiative.appliesTo,
            categories: attentionPolicyService.categories,
            initiativeLevels: attentionPolicyService.initiativeLevels
        };

        // --- 5. Memory & Privacy Section ---
        const memorySection = {
            revision: revisions.memory || 1,
            scope: SCOPES.PRIVATE,
            values: {
                retentionDays: retentionDays ?? null
            },
            effective: {
                retentionDays: retentionDays ?? null
            },
            sources: {
                retention: retentionDays ? 'user-retention-window' : 'forever'
            },
            appliesTo: SECTION_METADATA.memory.appliesTo
        };

        // --- 6. Appearance Section ---
        const themeVal = customPrefs.theme && THEMES.includes(customPrefs.theme) ? customPrefs.theme : 'dark';
        const linkByTagVal = typeof customPrefs.linkByTag === 'boolean' ? customPrefs.linkByTag : true;
        const appearanceSection = {
            revision: revisions.appearance || 1,
            scope: SCOPES.DEVICE,
            values: {
                theme: themeVal,
                linkByTag: linkByTagVal
            },
            effective: {
                theme: themeVal,
                linkByTag: linkByTagVal
            },
            sources: {
                theme: customPrefs.theme ? 'account-preference' : 'default',
                linkByTag: typeof customPrefs.linkByTag === 'boolean' ? 'account-preference' : 'default'
            },
            appliesTo: SECTION_METADATA.appearance.appliesTo
        };

        // --- 7. Connections Section ---
        const connectionsMap = {
            github: { connected: false, verifiedAccount: null },
            notion: { connected: false, verifiedAccount: null }
        };
        for (const item of integrationsList) {
            if (connectionsMap[item.provider]) {
                connectionsMap[item.provider] = {
                    connected: Boolean(item.connected),
                    verifiedAccount: item.verifiedAccount || null
                };
            }
        }
        const connectionsSection = {
            revision: revisions.connections || 1,
            scope: SCOPES.ACCOUNT,
            values: connectionsMap,
            effective: connectionsMap,
            sources: {
                github: connectionsMap.github.connected ? 'user-integration' : 'disconnected',
                notion: connectionsMap.notion.connected ? 'user-integration' : 'disconnected'
            },
            appliesTo: SECTION_METADATA.connections.appliesTo
        };

        // --- 8. Account Section ---
        const accountSection = {
            revision: revisions.account || 1,
            scope: SCOPES.ACCOUNT,
            values: {
                userId,
                username: userAccountRow?.discordUsername || userAccountRow?.username || userId,
                avatar: userAccountRow?.avatar || null
            },
            effective: {
                userId,
                username: userAccountRow?.discordUsername || userAccountRow?.username || userId,
                avatar: userAccountRow?.avatar || null
            },
            sources: {
                account: 'discord-identity'
            },
            appliesTo: SECTION_METADATA.account.appliesTo
        };

        // Capabilities
        let voiceCaps = { stt: false, tts: false, liveVoice: false };
        try {
            const { voiceService } = require('./serviceManager');
            const hasElevenLabs = Boolean(require('../config/aiConfig').elevenlabs?.apiKey);
            const hasOpenAi = Boolean(require('../config/aiConfig').openai?.apiKey);
            voiceCaps = {
                tts: hasElevenLabs && Boolean(voiceService?.tts && !voiceService.tts.disabled),
                stt: hasOpenAi || hasElevenLabs,
                liveVoice: Boolean(voiceService?.hasLiveSupport?.())
            };
        } catch { /* best effort */ }

        return {
            schemaVersion: 1,
            sections: {
                profile: profileSection,
                chat: chatSection,
                voice: voiceSection,
                initiative: initiativeSection,
                memory: memorySection,
                appearance: appearanceSection,
                connections: connectionsSection,
                account: accountSection
            },
            capabilities: voiceCaps
        };
    }

    /**
     * Atomically validate, update, increment revision, and invalidate caches
     * for a settings section.
     * @param {Object} params - { userId, section, changes, expectedRevision }
     * @returns {Promise<Object>} updated section and new revision
     */
    async updateSection({ userId, section, changes = {}, expectedRevision = null }) {
        if (!userId) {
            throw new UserSettingsError(400, 'BAD_USER', 'User ID is required.');
        }
        if (!SECTIONS.includes(section)) {
            throw new UserSettingsError(404, 'UNKNOWN_SECTION', `Unknown settings section: ${section}`);
        }
        if (!EDITABLE_SECTIONS.includes(section)) {
            throw new UserSettingsError(400, 'NOT_EDITABLE', `The ${section} section is managed via dedicated endpoints and cannot be updated directly.`);
        }
        if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
            throw new UserSettingsError(400, 'BAD_REQUEST', 'Changes must be an object.');
        }

        const currentRevision = await this.getRevision(userId, section);
        if (expectedRevision !== null && expectedRevision !== undefined) {
            const exp = Number(expectedRevision);
            if (exp !== currentRevision) {
                throw new UserSettingsError(409, 'SETTINGS_CONFLICT',
                    'Settings were modified elsewhere. Please review and try again.',
                    { currentRevision, expectedRevision: exp, section }
                );
            }
        }

        // Validate changes and stage updates per section BEFORE entering the transaction
        const dmScope = dmScopeId(userId);
        let commitFn = null;

        if (section === 'profile') {
            commitFn = await this._prepareProfileChanges(userId, dmScope, changes);
        } else if (section === 'chat') {
            commitFn = await this._prepareChatChanges(userId, dmScope, changes);
        } else if (section === 'voice') {
            commitFn = await this._prepareVoiceChanges(userId, dmScope, changes);
        } else if (section === 'initiative') {
            commitFn = await this._prepareInitiativeChanges(userId, changes);
        } else if (section === 'memory') {
            commitFn = await this._prepareMemoryChanges(userId, dmScope, changes);
        } else if (section === 'appearance') {
            commitFn = await this._prepareAppearanceChanges(userId, changes);
        }

        // Run updates and revision increment atomically
        let newRevision = currentRevision + 1;
        await db.transaction(async (tx) => {
            // Re-check revision inside transaction if expectedRevision was provided
            if (expectedRevision !== null && expectedRevision !== undefined) {
                const fresh = await (tx || db).get(
                    'SELECT revision FROM user_setting_revisions WHERE userId = @userId AND section = @section',
                    { userId, section }
                );
                const freshRev = fresh?.revision ? Number(fresh.revision) : 1;
                if (freshRev !== Number(expectedRevision)) {
                    throw new UserSettingsError(409, 'SETTINGS_CONFLICT',
                        'Settings were modified elsewhere. Please review and try again.',
                        { currentRevision: freshRev, expectedRevision: Number(expectedRevision), section }
                    );
                }
            }

            if (commitFn) {
                await commitFn(tx || db);
            }

            // Increment revision record
            const revRow = await (tx || db).get(
                `INSERT INTO user_setting_revisions (userId, section, revision, updatedAt)
                 VALUES (@userId, @section, 2, CURRENT_TIMESTAMP)
                 ON CONFLICT(userId, section) DO UPDATE SET
                     revision = user_setting_revisions.revision + 1,
                     updatedAt = CURRENT_TIMESTAMP
                 RETURNING revision`,
                { userId, section }
            );
            newRevision = revRow?.revision ? Number(revRow.revision) : newRevision;
        });

        // Post-commit cache invalidation & event publishing
        guildSettings.clearGuildSettingsCache(dmScope);
        memeMode.clearMemeModeCache(userId);

        eventBusService.publish('settings-changed', {
            userId,
            section,
            revision: newRevision,
            timestamp: new Date().toISOString()
        });

        // Return updated section
        const freshSettings = await this.getSettings({ userId });
        return {
            section,
            revision: newRevision,
            data: freshSettings.sections[section]
        };
    }

    /**
     * Preview the exact diff of resetting a section to defaults.
     * @param {Object} params - { userId, section }
     * @returns {Promise<Object>}
     */
    async resetPreview({ userId, section }) {
        if (!SECTIONS.includes(section)) {
            throw new UserSettingsError(404, 'UNKNOWN_SECTION', `Unknown settings section: ${section}`);
        }
        if (!EDITABLE_SECTIONS.includes(section)) {
            throw new UserSettingsError(400, 'NOT_EDITABLE', `The ${section} section cannot be reset.`);
        }

        const settings = await this.getSettings({ userId });
        const current = settings.sections[section].values;
        const defaults = this._getSectionDefaults(section);

        const changes = {};
        for (const [k, v] of Object.entries(defaults)) {
            if (JSON.stringify(current[k]) !== JSON.stringify(v)) {
                changes[k] = v;
            }
        }

        return {
            section,
            currentRevision: settings.sections[section].revision,
            currentValues: current,
            proposedValues: { ...current, ...defaults },
            changes
        };
    }

    /**
     * Apply confirmed reset of a section to defaults.
     * @param {Object} params - { userId, section, expectedRevision }
     * @returns {Promise<Object>}
     */
    async resetSection({ userId, section, expectedRevision = null }) {
        const defaults = this._getSectionDefaults(section);
        return await this.updateSection({
            userId,
            section,
            changes: defaults,
            expectedRevision
        });
    }

    /**
     * Read-only estimate of what a retention change would purge (spec §10).
     * Never mutates; the actual purge happens only in applyRetention.
     * @param {Object} params - { userId, days }
     * @returns {Promise<Object>}
     */
    async retentionPreview({ userId, days }) {
        if (!userId) {
            throw new UserSettingsError(400, 'BAD_USER', 'User ID is required.');
        }
        const proposed = this._normalizeRetentionDays(days);
        const dmScope = dmScopeId(userId);
        const [current, revision, total] = await Promise.all([
            guildSettings.getMemoryRetentionDays(dmScope).catch(() => null),
            this.getRevision(userId, 'memory'),
            db.get('SELECT COUNT(*) AS c FROM memory_embeddings WHERE guildId = @scope', { scope: dmScope })
        ]);

        let affected = 0;
        if (proposed) {
            const cutoff = new Date(Date.now() - proposed * 24 * 60 * 60 * 1000)
                .toISOString().slice(0, 19).replace('T', ' ');
            const row = await db.get(
                'SELECT COUNT(*) AS c FROM memory_embeddings WHERE guildId = @scope AND createdAt < @cutoff',
                { scope: dmScope, cutoff }
            );
            affected = Number(row?.c || 0);
        }

        return {
            section: 'memory',
            currentRevision: revision,
            currentRetentionDays: current ?? null,
            proposedRetentionDays: proposed,
            memoryCount: Number(total?.c || 0),
            affectedCount: affected,
            dataClasses: ['memories']
        };
    }

    /**
     * Save a retention window and purge immediately, reporting the real count.
     * This is the only settings path that deletes content; a plain section
     * save never triggers it.
     * @param {Object} params - { userId, days, expectedRevision }
     * @returns {Promise<Object>}
     */
    async applyRetention({ userId, days, expectedRevision = null }) {
        const proposed = this._normalizeRetentionDays(days);
        const result = await this.updateSection({
            userId,
            section: 'memory',
            changes: { retentionDays: proposed },
            expectedRevision
        });

        let purged = 0;
        if (proposed) {
            const memoryService = require('./memoryService');
            purged = await memoryService.applyRetention(dmScopeId(userId));
            if (purged > 0) await memoryService.cleanupVecIndex();
        }
        return { ...result, purged };
    }

    _normalizeRetentionDays(days) {
        if (days === null || days === undefined || days === '' || Number(days) === 0) return null;
        const value = Number(days);
        if (!Number.isInteger(value) || value < LIMITS.RETENTION_DAYS_MIN || value > LIMITS.RETENTION_DAYS_MAX) {
            throw new UserSettingsError(400, 'BAD_RETENTION',
                `retentionDays must be an integer between ${LIMITS.RETENTION_DAYS_MIN} and ${LIMITS.RETENTION_DAYS_MAX}, or null for forever.`);
        }
        return value;
    }

    // --- Private Section Validators and Updaters ----------------------------

    _getSectionDefaults(section) {
        switch (section) {
            case 'profile':
                return {
                    callGoobster: null,
                    callUser: null,
                    customInstructions: null,
                    personalityDirective: null,
                    memeMode: false
                };
            case 'chat':
                return {
                    provider: null,
                    model: null,
                    reasoningEffort: null
                };
            case 'voice':
                return {
                    voiceId: null,
                    speed: 1.0
                };
            case 'initiative':
                return {
                    enabled: false,
                    initiative: 'nudge',
                    maxContactsPerDay: 3,
                    contactCooldownMinutes: 120,
                    quietStartMinute: null,
                    quietEndMinute: null,
                    boundaries: {}
                };
            case 'memory':
                return {
                    retentionDays: null
                };
            case 'appearance':
                return {
                    theme: 'dark',
                    linkByTag: true
                };
            default:
                return {};
        }
    }

    async _prepareProfileChanges(userId, dmScope, changes) {
        const writes = [];

        if ('callGoobster' in changes) {
            const val = changes.callGoobster;
            if (val !== null && val !== undefined) {
                const clean = String(val).trim();
                if (clean.length > LIMITS.NAME_MAX_LENGTH) {
                    throw new UserSettingsError(400, 'BAD_NAME', `Bot nickname must be at most ${LIMITS.NAME_MAX_LENGTH} characters.`);
                }
                writes.push((tx) => guildSettings.setBotNickname(dmScope, clean || null));
            } else {
                writes.push((tx) => guildSettings.setBotNickname(dmScope, null));
            }
        }

        if ('callUser' in changes) {
            const val = changes.callUser;
            if (val !== null && val !== undefined) {
                const clean = String(val).trim();
                if (clean.length > LIMITS.NAME_MAX_LENGTH) {
                    throw new UserSettingsError(400, 'BAD_NAME', `Your nickname must be at most ${LIMITS.NAME_MAX_LENGTH} characters.`);
                }
                writes.push((tx) => guildSettings.setUserNickname(userId, dmScope, clean || null));
            } else {
                writes.push((tx) => guildSettings.setUserNickname(userId, dmScope, null));
            }
        }

        if ('customInstructions' in changes) {
            const val = changes.customInstructions;
            if (val !== null && val !== undefined) {
                const clean = String(val).trim();
                if (clean.length > LIMITS.INSTRUCTIONS_MAX_LENGTH) {
                    throw new UserSettingsError(400, 'INSTRUCTIONS_TOO_LONG',
                        `Custom instructions must be at most ${LIMITS.INSTRUCTIONS_MAX_LENGTH} characters.`);
                }
                writes.push((tx) => userInstructions.setUserInstructions(userId, clean || null));
            } else {
                writes.push((tx) => userInstructions.setUserInstructions(userId, null));
            }
        }

        if ('personalityDirective' in changes) {
            const val = changes.personalityDirective;
            if (val !== null && val !== undefined) {
                const clean = String(val).trim();
                if (clean.length > LIMITS.DIRECTIVE_MAX_LENGTH) {
                    throw new UserSettingsError(400, 'DIRECTIVE_TOO_LONG',
                        `Personality directive must be at most ${LIMITS.DIRECTIVE_MAX_LENGTH} characters.`);
                }
                writes.push((tx) => guildSettings.setPersonalityDirective(dmScope, clean || null));
            } else {
                writes.push((tx) => guildSettings.setPersonalityDirective(dmScope, null));
            }
        }

        if ('memeMode' in changes) {
            const val = changes.memeMode;
            if (typeof val !== 'boolean') {
                throw new UserSettingsError(400, 'BAD_MEME_MODE', 'memeMode must be a boolean.');
            }
            writes.push((tx) => memeMode.setMemeMode(userId, val));
        }

        // Optional server nickname update
        if (changes.serverNickname && typeof changes.serverNickname === 'object') {
            const { guildId, nickname } = changes.serverNickname;
            if (!guildId || typeof guildId !== 'string') {
                throw new UserSettingsError(400, 'BAD_GUILD_ID', 'serverNickname requires a guildId.');
            }
            const cleanNick = (nickname != null) ? String(nickname).trim() : null;
            if (cleanNick && cleanNick.length > LIMITS.NAME_MAX_LENGTH) {
                throw new UserSettingsError(400, 'BAD_NICKNAME', `Nickname must be at most ${LIMITS.NAME_MAX_LENGTH} characters.`);
            }
            writes.push((tx) => guildSettings.setUserNickname(userId, guildId, cleanNick || null));
        }

        return async (tx) => {
            for (const fn of writes) await fn(tx);
        };
    }

    async _prepareChatChanges(userId, dmScope, changes) {
        let provider = changes.provider;
        let model = changes.model;
        let reasoningEffort = changes.reasoningEffort;
        const thoughtful = changes.thoughtful;

        // Thoughtful preset handling: normalize model + reasoning effort
        if (typeof thoughtful === 'boolean') {
            if (thoughtful) {
                const currentAi = await guildSettings.getGuildAI(dmScope);
                const targetProvider = provider !== undefined ? provider : currentAi.provider;
                const preset = aiService.getThoughtfulPreset(targetProvider || undefined);
                if (!preset) {
                    throw new UserSettingsError(400, 'NO_THOUGHTFUL_TIER',
                        'Thoughtful Mode needs a cloud AI provider (OpenAI, Anthropic, or Gemini).');
                }
                model = preset.model;
                reasoningEffort = 'high';
            } else if (model === undefined && reasoningEffort === undefined) {
                model = null;
                reasoningEffort = null;
            }
        }

        const updates = {};

        if (provider !== undefined) {
            if (provider !== null && provider !== '') {
                const provStr = String(provider).trim();
                const entry = aiService.listProviders().find(p => p.key === provStr);
                if (!entry) {
                    throw new UserSettingsError(400, 'BAD_PROVIDER',
                        `Provider must be one of: ${aiService.listProviders().map(p => p.key).join(', ')}, or null for default.`);
                }
                if (!entry.configured) {
                    throw new UserSettingsError(400, 'PROVIDER_NOT_CONFIGURED',
                        `${entry.name} isn't configured on this server (missing API key).`);
                }
                updates.provider = provStr;
            } else {
                updates.provider = null;
            }
        }

        if (model !== undefined) {
            if (model !== null && model !== '') {
                const modelStr = String(model).trim();
                if (modelStr.length > LIMITS.MODEL_MAX_LENGTH) {
                    throw new UserSettingsError(400, 'BAD_MODEL', `Model must be at most ${LIMITS.MODEL_MAX_LENGTH} characters.`);
                }
                updates.model = modelStr;
            } else {
                updates.model = null;
            }
        }

        if (reasoningEffort !== undefined) {
            if (reasoningEffort !== null && reasoningEffort !== '') {
                const rStr = String(reasoningEffort).trim();
                if (!REASONING_EFFORTS.includes(rStr)) {
                    throw new UserSettingsError(400, 'BAD_REASONING',
                        `reasoningEffort must be one of: ${REASONING_EFFORTS.join(', ')}, or null.`);
                }
                updates.reasoningEffort = rStr;
            } else {
                updates.reasoningEffort = null;
            }
        }

        return async (tx) => {
            if (Object.keys(updates).length > 0) {
                await guildSettings.setGuildAI(dmScope, updates);
            }
        };
    }

    async _prepareVoiceChanges(userId, dmScope, changes) {
        const update = {};

        if ('voiceId' in changes) {
            const vId = changes.voiceId;
            if (vId === null || vId === '') {
                update.voiceId = null;
                update.voiceName = null;
            } else {
                const { voiceService } = require('./serviceManager');
                const tts = voiceService?.tts && !voiceService.tts.disabled ? voiceService.tts : null;
                if (!tts) {
                    throw new UserSettingsError(503, 'TTS_UNAVAILABLE',
                        'Voice selection needs an ElevenLabs API key on this server.');
                }
                let resolved;
                try {
                    resolved = await tts.resolveVoice(String(vId));
                } catch (error) {
                    throw new UserSettingsError(400, 'BAD_VOICE', error.message || 'Invalid voice selection.');
                }
                update.voiceId = resolved.id;
                update.voiceName = resolved.name;
            }
        }

        if ('speed' in changes) {
            const sVal = Number(changes.speed);
            if (!Number.isFinite(sVal) || sVal < 0.5 || sVal > 2.0) {
                throw new UserSettingsError(400, 'BAD_SPEED', 'Playback speed must be a number between 0.5 and 2.0.');
            }
            update.speed = sVal === 1 ? null : sVal;
        }

        return async (tx) => {
            if (Object.keys(update).length > 0) {
                await guildSettings.setTtsVoice(dmScope, update);
            }
        };
    }

    async _prepareInitiativeChanges(userId, changes) {
        const existing = await attentionPolicyService.get(userId);
        const willEnable = ('enabled' in changes) ? Boolean(changes.enabled) : (existing ? Boolean(existing.enabled) : false);

        if ('initiative' in changes) {
            const lvl = changes.initiative;
            if (!INITIATIVE_LEVELS.includes(lvl)) {
                throw new UserSettingsError(400, 'BAD_INITIATIVE',
                    `Initiative must be one of: ${INITIATIVE_LEVELS.join(', ')}.`);
            }
        }

        if ('maxContactsPerDay' in changes && changes.maxContactsPerDay !== null) {
            const m = Number(changes.maxContactsPerDay);
            if (!Number.isInteger(m) || m < LIMITS.MAX_CONTACTS_MIN || m > LIMITS.MAX_CONTACTS_MAX) {
                throw new UserSettingsError(400, 'BAD_BUDGET',
                    `maxContactsPerDay must be an integer between ${LIMITS.MAX_CONTACTS_MIN} and ${LIMITS.MAX_CONTACTS_MAX}.`);
            }
        }

        if ('contactCooldownMinutes' in changes && changes.contactCooldownMinutes !== null) {
            const c = Number(changes.contactCooldownMinutes);
            if (!Number.isInteger(c) || c < LIMITS.CONTACT_COOLDOWN_MIN || c > LIMITS.CONTACT_COOLDOWN_MAX) {
                throw new UserSettingsError(400, 'BAD_BUDGET',
                    `contactCooldownMinutes must be an integer between ${LIMITS.CONTACT_COOLDOWN_MIN} and ${LIMITS.CONTACT_COOLDOWN_MAX}.`);
            }
        }

        if (('quietStartMinute' in changes) || ('quietEndMinute' in changes)) {
            const start = changes.quietStartMinute;
            const end = changes.quietEndMinute;
            if ((start === null || start === undefined) !== (end === null || end === undefined)) {
                throw new UserSettingsError(400, 'BAD_QUIET_HOURS',
                    'Quiet hours need both a start and an end minute (or null for both to clear).');
            }
            if (start !== null && start !== undefined) {
                const s = Number(start);
                const e = Number(end);
                if (!Number.isInteger(s) || s < 0 || s > 1439 || !Number.isInteger(e) || e < 0 || e > 1439) {
                    throw new UserSettingsError(400, 'BAD_QUIET_HOURS',
                        'Quiet hours start and end must be integers between 0 and 1439 (minutes from UTC midnight).');
                }
            }
        }

        if ('boundaries' in changes && changes.boundaries !== null) {
            if (typeof changes.boundaries !== 'object' || Array.isArray(changes.boundaries)) {
                throw new UserSettingsError(400, 'BAD_BOUNDARY', 'Boundaries must be an object keyed by category.');
            }
            for (const [cat, b] of Object.entries(changes.boundaries)) {
                if (!attentionPolicyService.categories.includes(cat)) {
                    throw new UserSettingsError(400, 'BAD_CATEGORY', `Unknown category: ${cat}`);
                }
                if (b && typeof b === 'object') {
                    if (b.externalWrite !== undefined && ![true, false, 'confirm', 'never'].includes(b.externalWrite)) {
                        throw new UserSettingsError(400, 'BAD_BOUNDARY',
                            'externalWrite must be true, false, "confirm", or "never".');
                    }
                }
            }
        }

        return async (tx) => {
            // Apply fields without turning attention on if disabled
            if ('initiative' in changes) {
                await attentionPolicyService.setInitiative(userId, changes.initiative);
            }
            if ('maxContactsPerDay' in changes || 'contactCooldownMinutes' in changes) {
                await attentionPolicyService.setBudget({
                    userId,
                    maxContactsPerDay: changes.maxContactsPerDay,
                    contactCooldownMinutes: changes.contactCooldownMinutes
                });
            }
            if ('quietStartMinute' in changes || 'quietEndMinute' in changes) {
                await attentionPolicyService.setQuietHours({
                    userId,
                    startMinute: changes.quietStartMinute ?? null,
                    endMinute: changes.quietEndMinute ?? null
                });
            }
            if ('boundaries' in changes && changes.boundaries) {
                for (const [category, boundary] of Object.entries(changes.boundaries)) {
                    await attentionPolicyService.setBoundary({
                        userId,
                        category,
                        proactiveRead: boundary.proactiveRead,
                        proactiveCompute: boundary.proactiveCompute,
                        externalWrite: boundary.externalWrite
                    });
                }
            }

            // Explicitly set enabled status
            if ('enabled' in changes) {
                if (changes.enabled) {
                    await attentionPolicyService.enroll({ userId });
                } else {
                    await attentionPolicyService.disable(userId);
                }
            } else if (existing && !existing.enabled) {
                // If it was already disabled, ensure it stays disabled
                await attentionPolicyService.disable(userId);
            }
        };
    }

    async _prepareMemoryChanges(userId, dmScope, changes) {
        if ('retentionDays' in changes) {
            const val = changes.retentionDays;
            if (val !== null && val !== undefined) {
                const days = Number(val);
                if (!Number.isInteger(days) || days < LIMITS.RETENTION_DAYS_MIN || days > LIMITS.RETENTION_DAYS_MAX) {
                    throw new UserSettingsError(400, 'BAD_RETENTION',
                        `retentionDays must be an integer between ${LIMITS.RETENTION_DAYS_MIN} and ${LIMITS.RETENTION_DAYS_MAX}, or null for forever.`);
                }
            }
        }

        return async (tx) => {
            if ('retentionDays' in changes) {
                const days = changes.retentionDays === null ? null : Number(changes.retentionDays);
                await guildSettings.setMemoryRetentionDays(dmScope, days);
            }
        };
    }

    async _prepareAppearanceChanges(userId, changes) {
        if ('theme' in changes) {
            if (!THEMES.includes(changes.theme)) {
                throw new UserSettingsError(400, 'BAD_THEME', `theme must be one of: ${THEMES.join(', ')}.`);
            }
        }
        if ('linkByTag' in changes && typeof changes.linkByTag !== 'boolean') {
            throw new UserSettingsError(400, 'BAD_REQUEST', 'linkByTag must be a boolean.');
        }

        return async (tx) => {
            const row = await (tx || db).get(
                'SELECT preferencesJson FROM user_settings WHERE userId = @userId',
                { userId }
            );
            let prefs = {};
            if (row?.preferencesJson) {
                try { prefs = JSON.parse(row.preferencesJson) || {}; } catch { prefs = {}; }
            }
            if ('theme' in changes) prefs.theme = changes.theme;
            if ('linkByTag' in changes) prefs.linkByTag = changes.linkByTag;

            await (tx || db).run(
                `INSERT INTO user_settings (userId, schemaVersion, preferencesJson, updatedAt)
                 VALUES (@userId, 1, @preferencesJson, CURRENT_TIMESTAMP)
                 ON CONFLICT(userId) DO UPDATE SET
                     preferencesJson = @preferencesJson,
                     updatedAt = CURRENT_TIMESTAMP`,
                { userId, preferencesJson: JSON.stringify(prefs) }
            );
        };
    }
}

module.exports = new UserSettingsService();
module.exports.UserSettingsService = UserSettingsService;
module.exports.UserSettingsError = UserSettingsError;
