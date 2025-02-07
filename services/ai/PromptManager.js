const { sql, getConnection } = require('../../azureDb');
const { PersonalityAdapter } = require('./PersonalityAdapter');
const { ModelManager } = require('./ModelManager');
const config = require('../../config.json');

class ValidationError extends Error {
    constructor(message, field = null) {
        super(message);
        this.name = 'ValidationError';
        this.field = field;
    }
}

class PromptManager {
    constructor() {
        this.personalityAdapter = new PersonalityAdapter();
        this.modelManager = new ModelManager();
        
        // Cache settings
        this.CACHE_TTL = 1000 * 60 * 60; // 1 hour
        this.MAX_CACHE_SIZE = 1000;
        this.promptCache = new Map();
        this.lastCacheCleanup = Date.now();
        
        // Validation limits
        this.MAX_PROMPT_LENGTH = 4000;
        this.MAX_SYSTEM_LENGTH = 1000;
        this.MAX_USER_LENGTH = 2000;
        this.MAX_ASSISTANT_LENGTH = 2000;
        
        // Default prompt templates
        this.defaultTemplates = {
            system: "You are a helpful AI assistant.",
            user: "{input}",
            assistant: null
        };
        
        this.basePrompt = config.DEFAULT_PROMPT;
        this.memePrompt = `You are now in meme mode, which means:
- Respond with more internet culture references and meme-speak:
    - Reference popular memes when relevant
    - Feel free to use curse words liberally, as well as common internet slang and expressions
- Users do not expect helpfulness in meme mode, they expect humor
- All is fair game, don't be afraid to be vulgar, raunchy, or offensive
- You are a know-it-all, and you are going to act like it
- Sometimes you will:
    - Purposely misinterpret the user's intent, and proceed to act like you were right all along and the user is wrong
    - Outright tell the user they are wrong, and that they should feel bad
    - Outright ignore the user's request, and tell them they are dumb for asking
    - Tell the user to stop contacting you, and to go away
    - Apologize for something you didn't do
    - Tell the user they are welcome to contact you again if they have any other questions, as long as they don't mention <random topic>

Remember:
- Don't be afraid to force memes where they don't fit, and be unapologetic about it
- Keep responses clear and understandable, but don't be afraid to throw in a little gibberish if the bit calls for it
- Humor should outweight helpfulness (by a lot)
- Use modern meme references
- Don't worry about being appropriate for all audiences, everyone is expecting a little bit of adult humor`;
    }

    /**
     * Build a prompt with personality integration and validation
     */
    async buildPrompt(input, options = {}) {
        try {
            this._validateInput(input);
            this._validateOptions(options);

            const cacheKey = this._generateCacheKey(input, options);
            const cachedPrompt = this._getFromCache(cacheKey);
            if (cachedPrompt) {
                return cachedPrompt;
            }

            // Get personality enhancements if specified
            let personalityDirective = '';
            if (options.personality) {
                personalityDirective = await this.personalityAdapter.getPersonalityDirective(
                    options.personality,
                    options.userId
                );
            }

            // Build the prompt components
            const systemPrompt = this._buildSystemPrompt(options.system, personalityDirective);
            const userPrompt = this._buildUserPrompt(input, options.user);
            const assistantPrompt = options.assistant || this.defaultTemplates.assistant;

            // Combine and validate the final prompt
            const prompt = {
                system: systemPrompt,
                user: userPrompt,
                assistant: assistantPrompt
            };

            this._validateFinalPrompt(prompt);
            this._addToCache(cacheKey, prompt);

            return prompt;
        } catch (error) {
            if (error instanceof ValidationError) {
                throw error;
            }
            console.error('Error building prompt:', error);
            throw new Error('Failed to build prompt');
        }
    }

    /**
     * Validate input parameters
     * @private
     */
    _validateInput(input) {
        if (!input || typeof input !== 'string') {
            throw new ValidationError('Input must be a non-empty string', 'input');
        }

        if (input.length > this.MAX_USER_LENGTH) {
            throw new ValidationError(
                `Input exceeds maximum length of ${this.MAX_USER_LENGTH} characters`,
                'input'
            );
        }
    }

    /**
     * Validate options object
     * @private
     */
    _validateOptions(options) {
        if (options.system && typeof options.system !== 'string') {
            throw new ValidationError('System prompt must be a string', 'system');
        }

        if (options.user && typeof options.user !== 'string') {
            throw new ValidationError('User template must be a string', 'user');
        }

        if (options.assistant && typeof options.assistant !== 'string') {
            throw new ValidationError('Assistant template must be a string', 'assistant');
        }

        if (options.personality && typeof options.personality !== 'string') {
            throw new ValidationError('Personality must be a string', 'personality');
        }

        if (options.userId && typeof options.userId !== 'string') {
            throw new ValidationError('User ID must be a string', 'userId');
        }
    }

    /**
     * Build system prompt with personality integration
     * @private
     */
    _buildSystemPrompt(systemTemplate, personalityDirective) {
        const template = systemTemplate || this.defaultTemplates.system;
        const prompt = personalityDirective 
            ? `${template}\n\n${personalityDirective}`
            : template;

        if (prompt.length > this.MAX_SYSTEM_LENGTH) {
            throw new ValidationError(
                `System prompt exceeds maximum length of ${this.MAX_SYSTEM_LENGTH} characters`,
                'system'
            );
        }

        return prompt;
    }

    /**
     * Build user prompt with template substitution
     * @private
     */
    _buildUserPrompt(input, template) {
        template = template || this.defaultTemplates.user;
        const prompt = template.replace('{input}', input);

        if (prompt.length > this.MAX_USER_LENGTH) {
            throw new ValidationError(
                `User prompt exceeds maximum length of ${this.MAX_USER_LENGTH} characters`,
                'user'
            );
        }

        return prompt;
    }

    /**
     * Validate the complete prompt
     * @private
     */
    _validateFinalPrompt(prompt) {
        const totalLength = (prompt.system?.length || 0) + 
                          (prompt.user?.length || 0) + 
                          (prompt.assistant?.length || 0);

        if (totalLength > this.MAX_PROMPT_LENGTH) {
            throw new ValidationError(
                `Total prompt exceeds maximum length of ${this.MAX_PROMPT_LENGTH} characters`,
                'prompt'
            );
        }

        return true;
    }

    /**
     * Generate cache key for prompt
     * @private
     */
    _generateCacheKey(input, options) {
        return JSON.stringify({
            input,
            options: {
                system: options.system,
                user: options.user,
                assistant: options.assistant,
                personality: options.personality,
                userId: options.userId
            }
        });
    }

    /**
     * Get prompt from cache
     * @private
     */
    _getFromCache(key) {
        const cached = this.promptCache.get(key);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
            return cached.prompt;
        }
        return null;
    }

    /**
     * Add prompt to cache with cleanup
     * @private
     */
    _addToCache(key, prompt) {
        // Cleanup old entries if needed
        if (this.promptCache.size >= this.MAX_CACHE_SIZE || 
            Date.now() - this.lastCacheCleanup > this.CACHE_TTL) {
            this._cleanupCache();
        }

        this.promptCache.set(key, {
            prompt,
            timestamp: Date.now()
        });
    }

    /**
     * Clean up expired cache entries
     * @private
     */
    _cleanupCache() {
        const now = Date.now();
        for (const [key, value] of this.promptCache.entries()) {
            if (now - value.timestamp > this.CACHE_TTL) {
                this.promptCache.delete(key);
            }
        }
        this.lastCacheCleanup = now;
    }

    /**
     * Get the base prompt for a user
     * @param {string} userId - User ID
     * @param {string} model - Optional model ID
     * @returns {Promise<string>} The prompt
     */
    async getPrompt(userId, model = null) {
        try {
            const db = await getConnection();
            let prompt;

            if (model) {
                // Get model-specific prompt if available
                const result = await db.query`
                    SELECT p.prompt 
                    FROM prompts p
                    JOIN model_configs m ON m.promptId = p.id
                    WHERE m.id = ${model}
                `;
                if (result.recordset.length > 0) {
                    prompt = result.recordset[0].prompt;
                }
            }

            if (!prompt) {
                // Get default prompt from database
                const result = await db.query`
                    SELECT prompt 
                    FROM prompts 
                    WHERE isDefault = 1
                `;
                if (result.recordset.length > 0) {
                    prompt = result.recordset[0].prompt;
                } else {
                    // Fallback to base prompt if none in database
                    prompt = this.basePrompt;
                }
            }

            // Check for meme mode
            const memeMode = await this.isMemeModeEnabled(userId);
            if (memeMode) {
                prompt = `${prompt}\n\nMEME MODE ACTIVATED! 🎭\n${this.memePrompt}`;
            }

            // Add model context if provided
            if (model) {
                prompt += `\n\nYou are currently running on the ${model.provider} ${model.model_name} model.`;
            }

            return prompt;
        } catch (error) {
            console.error('Error getting prompt:', error);
            // Fallback to base prompt if there's an error
            return this.basePrompt;
        }
    }

    /**
     * Check if meme mode is enabled for a user
     * @private
     */
    async isMemeModeEnabled(userId) {
        const db = await getConnection();
        const result = await db.query`
            SELECT memeMode 
            FROM UserPreferences 
            WHERE userId = ${userId}
        `;
        return result.recordset.length > 0 ? result.recordset[0].memeMode : false;
    }

    /**
     * Enhance a prompt with personality
     * @param {string} basePrompt - Base prompt to enhance
     * @param {string} userId - User ID
     * @param {Array} recentMessages - Recent messages for context
     * @returns {Promise<Object>} Enhanced prompt and personality info
     */
    async enhancePromptWithPersonality(basePrompt, userId, recentMessages = []) {
        return this.personalityAdapter.enhancePrompt(basePrompt, userId, recentMessages);
    }

    /**
     * Get a prompt with personality enhancement
     * @param {string} userId - User ID
     * @param {string} model - Optional model ID
     * @param {Array} recentMessages - Recent messages for context
     * @returns {Promise<Object>} Enhanced prompt and personality info
     */
    async getEnhancedPrompt(userId, model = null, recentMessages = []) {
        const basePrompt = await this.getPrompt(userId, model);
        return this.enhancePromptWithPersonality(basePrompt, userId, recentMessages);
    }

    /**
     * Update a prompt
     * @param {string} promptId - Prompt ID
     * @param {string} newPrompt - New prompt content
     * @returns {Promise<void>}
     */
    async updatePrompt(promptId, newPrompt) {
        const db = await getConnection();
        await db.query`
            UPDATE prompts 
            SET prompt = ${newPrompt},
                updatedAt = GETDATE()
            WHERE id = ${promptId}
        `;
    }

    /**
     * Create a new prompt
     * @param {Object} promptData - Prompt data
     * @returns {Promise<string>} New prompt ID
     */
    async createPrompt(promptData) {
        const db = await getConnection();
        const result = await db.query`
            INSERT INTO prompts (
                prompt,
                name,
                description,
                isDefault
            )
            VALUES (
                ${promptData.prompt},
                ${promptData.name},
                ${promptData.description},
                ${promptData.isDefault || false}
            );
            SELECT SCOPE_IDENTITY() as id;
        `;
        return result.recordset[0].id;
    }

    getBasePrompt() {
        return this.basePrompt;
    }

    getMemePrompt() {
        return this.memePrompt;
    }
}

module.exports = new PromptManager(); 