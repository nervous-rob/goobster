// TODO: Add proper handling for message chunking edge cases
// TODO: Add proper handling for message formatting validation
// TODO: Add proper handling for message size limits
// TODO: Add proper handling for message content sanitization
// TODO: Add proper handling for message encoding issues
// TODO: Add proper handling for message prefix validation
// TODO: Add proper handling for message splitting errors
// TODO: Add proper handling for message part numbering
// TODO: Add proper handling for message formatting preservation
// TODO: Add proper handling for message chunk optimization

/**
 * Utility function to chunk messages for Discord's character limit
 * @param {string} message - The message to chunk
 * @param {string} prefix - Optional prefix to add to each chunk
 * @returns {string[]} Array of message chunks
 */
function chunkMessage(message, prefix = '') {
    if (!message) return ['No content available'];
    
    // Convert non-string messages to strings
    if (typeof message !== 'string') {
        message = String(message);
    }

    // Discord's max message length is 2000, but leave some room for formatting
    const maxLength = 1900 - prefix.length;
    
    // If message is already short enough, return as single chunk
    if (message.length <= maxLength) {
        return [prefix + message];
    }
    
    const chunks = [];
    let currentChunk = prefix;
    
    // Split by double newlines to preserve paragraph structure
    const paragraphs = message.split(/\n\n+/);
    
    for (const paragraph of paragraphs) {
        // If adding this paragraph would exceed the limit
        if (currentChunk.length + paragraph.length + 2 > maxLength) {
            // If current chunk has content, push it
            if (currentChunk !== prefix) {
                chunks.push(currentChunk);
                currentChunk = prefix;
            }
            
            // If the paragraph itself is too long, split it
            if (paragraph.length > maxLength) {
                // First try to split by sentences
                const sentences = paragraph.split(/(?<=[.!?])\s+/);
                
                for (const sentence of sentences) {
                    if (currentChunk.length + sentence.length + 1 > maxLength) {
                        // If current chunk has content, push it
                        if (currentChunk !== prefix) {
                            chunks.push(currentChunk);
                            currentChunk = prefix;
                        }
                        
                        // If the sentence itself is too long, split it into chunks
                        if (sentence.length > maxLength) {
                            let remainingSentence = sentence;
                            while (remainingSentence.length > 0) {
                                const chunkSize = Math.min(remainingSentence.length, maxLength - currentChunk.length);
                                const splitPoint = chunkSize < remainingSentence.length ? 
                                    remainingSentence.lastIndexOf(' ', chunkSize) || chunkSize : 
                                    chunkSize;
                                
                                currentChunk += remainingSentence.substring(0, splitPoint);
                                
                                if (currentChunk.length > 0) {
                                    chunks.push(currentChunk);
                                    currentChunk = prefix;
                                }
                                
                                remainingSentence = remainingSentence.substring(splitPoint).trim();
                            }
                        } else {
                            currentChunk = prefix + sentence;
                        }
                    } else {
                        if (currentChunk !== prefix) {
                            currentChunk += ' ';
                        }
                        currentChunk += sentence;
                    }
                }
            } else {
                currentChunk = prefix + paragraph;
            }
        } else {
            // Add paragraph to current chunk
            if (currentChunk !== prefix) {
                currentChunk += '\n\n';
            }
            currentChunk += paragraph;
        }
    }
    
    // Push final chunk if it has content
    if (currentChunk !== prefix) {
        chunks.push(currentChunk);
    }
    
    // Add validation for chunk size
    return chunks.map((chunk, index) => {
        let finalChunk = chunk;
        if (chunks.length > 1) {
            finalChunk = `${chunk}\n\n[Part ${index + 1}/${chunks.length}]`;
        }
        
        // Ensure chunk doesn't exceed Discord's limit
        if (finalChunk.length > 2000) {
            console.warn(`Chunk exceeds Discord's limit, truncating...`);
            return finalChunk.substring(0, 1997) + '...';
        }
        
        return finalChunk;
    });
}

// Add new utility function for handling chunked replies
async function sendChunkedReply(interaction, content, options = {}) {
    const chunks = chunkMessage(content);
    
    // Send first chunk as main reply
    if (options.edit) {
        await interaction.editReply({
            content: chunks[0],
            ...options
        });
    } else {
        await interaction.reply({
            content: chunks[0],
            ...options
        });
    }
    
    // Send additional chunks as follow-ups
    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({
            content: chunks[i],
            ...options
        });
    }
}

/**
 * A class for tracking and displaying progress for content generation commands
 * 
 * @class ProgressTracker
 */
class ProgressTracker {
    /**
     * Create a new progress tracker
     * 
     * @param {Object} options - Configuration options
     * @param {Object} options.interaction - Discord interaction object
     * @param {String} options.type - Type of content being generated (e.g., 'music', 'ambience')
     * @param {String} options.itemName - Name of the specific item being generated (e.g., 'battle', 'forest')
     * @param {Boolean} options.exists - Whether the item already exists
     * @param {Boolean} options.force - Whether to force regeneration if exists
     * @param {Object} options.emoji - Emoji to use for the item
     * @param {Number} options.updateInterval - How often to update the progress in ms (default: 3000ms)
     * @param {Boolean} options.useTable - Whether to use table format for single items
     * @param {Function} options.customFormatter - Optional custom formatter function
     */
    constructor(options) {
        // Required options
        this.interaction = options.interaction;
        this.type = options.type || 'content';
        this.itemName = options.itemName;
        
        // Optional settings with defaults
        this.exists = options.exists || false;
        this.force = options.force || false;
        this.emoji = options.emoji || '🔄';
        this.updateInterval = options.updateInterval || 3000;
        this.useTable = options.useTable !== undefined ? options.useTable : true;
        this.customFormatter = options.customFormatter;
        
        // Internal state
        this.status = 'initializing';
        this.startTime = Date.now();
        this.updateCount = 0;
        this.isMultiItem = Array.isArray(this.itemName);
        this.progressInterval = null;
        this.itemStatus = {};
        this.stats = {
            total: this.isMultiItem ? this.itemName.length : 1,
            completed: 0,
            skipped: 0,
            failed: 0,
            inProgress: []
        };
        
        // Register status types
        this.statusTypes = {
            initializing: { symbol: '⏳', label: 'Initializing' },
            preparing: { symbol: '🔄', label: 'Preparing' },
            checking: { symbol: '🔍', label: 'Checking' },
            generating: { symbol: '🔄', label: 'Generating' },
            regenerating: { symbol: '🔄', label: 'Regenerating' },
            processing: { symbol: '🔄', label: 'Processing' },
            done: { symbol: '✅', label: 'Done' },
            skipped: { symbol: '⏭️', label: 'Skipped' },
            failed: { symbol: '❌', label: 'Failed' },
            completed: { symbol: '✅', label: 'Completed' },
            playing: { symbol: '▶️', label: 'Playing' }
        };
        
        // Initialize item status for multi-item tracking
        if (this.isMultiItem) {
            this.itemName.forEach(item => {
                this.itemStatus[item] = 'initializing';
            });
        }
        
        // Debug info
        console.log(`ProgressTracker initialized for ${this.type}:${this.isMultiItem ? 'multiple items' : this.itemName}`);
    }
    
    /**
     * Get action text based on item status
     * @private
     */
    _getActionText(itemName = this.itemName) {
        const item = Array.isArray(itemName) ? itemName[0] : itemName;
        
        if (this.status === 'skipped') {
            return `${item} ${this.type} already exists`;
        } else if (this.status === 'generating') {
            return `Generating ${item} ${this.type}`;
        } else if (this.status === 'regenerating') {
            return `Regenerating ${item} ${this.type}`;
        } else if (this.status === 'processing') {
            return `Processing ${item} ${this.type}`;
        } else if (this.status === 'failed') {
            return `Failed to generate ${item} ${this.type}`;
        } else if (this.status === 'completed' || this.status === 'done') {
            return `Successfully ${this.exists && this.force ? 'regenerated' : 'generated'} ${item} ${this.type}`;
        } else {
            return `${this.statusTypes[this.status].label} ${item} ${this.type}`;
        }
    }
    
    /**
     * Format a progress message for a single item
     * @private
     */
    _formatSingleItemMessage(status = this.status, itemName = this.itemName) {
        const emoji = this.emoji;
        const dots = '.'.repeat(this.updateCount % 4);
        const statusObj = this.statusTypes[status] || this.statusTypes.processing;
        const needsDots = ['generating', 'regenerating', 'processing'].includes(status);
        
        let message = `${emoji} ${this._getActionText(itemName)}${needsDots ? dots : ''}`;
        
        if (this.useTable) {
            const displayStatus = needsDots ? `${statusObj.label}${dots}` : statusObj.label;
            message += `\n\n\`\`\`\n${this.type.toUpperCase()}: ${itemName} | STATUS: ${displayStatus} | ${emoji}\n\`\`\``;
        }
        
        if (needsDots) {
            message += `\n\nThis may take a few minutes...`;
        }
        
        return message;
    }
    
    /**
     * Create a table display for multi-item progress
     * @private
     */
    _createProgressTable(inProgressItems = []) {
        let table = '```\n';
        const headerType = this.type.toUpperCase();
        
        table += `${headerType.padEnd(12)}| STATUS      | EMOJI\n`;
        table += '--------------|-------------|------\n';
        
        for (const item of this.itemName) {
            const emoji = this.emoji;
            let itemStatus = this.itemStatus[item] || 'initializing';
            const statusObj = this.statusTypes[itemStatus];
            const isInProgress = inProgressItems.includes(item);
            
            // Add dots to in-progress items
            const displayStatus = isInProgress && ['generating', 'regenerating', 'processing'].includes(itemStatus) ? 
                `${statusObj.label}${'.'.repeat(this.updateCount % 4)}` : statusObj.label;
            
            table += `${isInProgress ? '→ ' : '  '}${item.padEnd(12)}| ${displayStatus.padEnd(11)}| ${emoji}\n`;
        }
        
        table += '```';
        return table;
    }
    
    /**
     * Format a progress message for multiple items
     * @private
     */
    _formatMultiItemMessage() {
        const { total, completed, skipped, failed, inProgress } = this.stats;
        const processed = completed + skipped + failed;
        let message = '';
        
        // Main status line
        message += `${this.emoji} Generating ${this.type} tracks... (${processed}/${total})\n`;
        message += `✅ Completed: ${completed}  ⏭️ Skipped: ${skipped}  ❌ Failed: ${failed}\n\n`;
        
        // Progress table
        message += this._createProgressTable(inProgress);
        
        return message;
    }
    
    /**
     * Start tracking progress
     * This initializes the progress display and starts the update interval
     */
    async start() {
        try {
            this.status = 'preparing';
            
            // Initial update
            await this.update('checking');
            
            // Start automatic updates
            this.progressInterval = setInterval(async () => {
                this.updateCount++;
                await this.update();
            }, this.updateInterval);
            
            return true;
        } catch (error) {
            console.error('Error starting progress tracker:', error);
            return false;
        }
    }
    
    /**
     * Stop tracking progress and clear the update interval
     */
    stop() {
        if (this.progressInterval) {
            clearInterval(this.progressInterval);
            this.progressInterval = null;
        }
    }
    
    /**
     * Update the progress display
     * 
     * @param {String} status - New status to display
     * @param {Object} options - Additional options
     * @param {String} options.itemName - For multi-item tracking, the specific item to update
     * @param {String} options.errorType - For failed items, the type of error
     * @param {String} options.errorMessage - For failed items, the error message
     */
    async update(status = null, options = {}) {
        try {
            // Update status if provided
            if (status) {
                this.status = status;
            }
            
            // For multi-item tracking, update specific item
            if (this.isMultiItem && options.itemName) {
                const prevStatus = this.itemStatus[options.itemName];
                this.itemStatus[options.itemName] = status || prevStatus;
                
                // Update stats based on status change
                if (status === 'completed' || status === 'done') {
                    this.stats.completed++;
                    this.stats.inProgress = this.stats.inProgress.filter(item => item !== options.itemName);
                } else if (status === 'skipped') {
                    this.stats.skipped++;
                    this.stats.inProgress = this.stats.inProgress.filter(item => item !== options.itemName);
                } else if (status === 'failed') {
                    this.stats.failed++;
                    this.stats.inProgress = this.stats.inProgress.filter(item => item !== options.itemName);
                } else if (['generating', 'regenerating', 'processing'].includes(status) && !this.stats.inProgress.includes(options.itemName)) {
                    this.stats.inProgress.push(options.itemName);
                }
            }
            
            // Format message based on single or multi-item
            const message = this.isMultiItem ? 
                this._formatMultiItemMessage() :
                this._formatSingleItemMessage(this.status);
            
            // Add error details if provided
            let finalMessage = message;
            if (options.errorType && options.errorMessage) {
                finalMessage += `\n\nError (${options.errorType}): ${options.errorMessage}`;
            }
            
            // Send the update
            await this.interaction.editReply(finalMessage);
            
            return true;
        } catch (error) {
            console.error('Error updating progress:', error);
            return false;
        }
    }
    
    /**
     * Complete the progress tracking with a final status
     * 
     * @param {String} status - Final status (completed, failed, etc.)
     * @param {Object} options - Additional options
     * @param {String} options.message - Custom completion message
     * @param {String} options.errorType - For failures, the type of error
     * @param {String} options.errorMessage - For failures, the error message
     */
    async complete(status = 'completed', options = {}) {
        try {
            this.status = status;
            this.stop();
            
            // Default completion message
            let message = options.message;
            
            if (!message) {
                if (this.isMultiItem) {
                    const { total, completed, skipped, failed } = this.stats;
                    const completionPercent = Math.round((completed / total) * 100);
                    
                    message = `${this.emoji} ${this.type} generation complete! (${completionPercent}% success rate)\n\n` +
                              `✅ Successfully generated: ${completed}\n` +
                              `⏭️ Skipped (already exists): ${skipped}\n` +
                              `❌ Failed: ${failed}\n\n` +
                              `${this._createProgressTable([])}\n` +
                              `\nUse \`/${this.type === 'music' ? 'playmusic' : 'playambience'}\` to enjoy the generated ${this.type}!`;
                } else {
                    const actionCompleted = status === 'completed' || status === 'done';
                    const verb = this.exists && this.force ? 'regenerated' : 'generated';
                    
                    message = `${this.emoji} ${actionCompleted ? `Successfully ${verb}` : 'Failed to generate'} ${this.type} for **${this.itemName}**!\n\n`;
                    
                    if (this.useTable) {
                        message += `\`\`\`\n${this.type.toUpperCase()}: ${this.itemName} | STATUS: ${this.statusTypes[status].label} | ${this.emoji}\n\`\`\`\n\n`;
                    }
                    
                    if (actionCompleted) {
                        message += `Use \`/${this.type === 'music' ? 'playmusic' : 'playambience'} ${this.type === 'music' ? 'mood' : 'type'}:${this.itemName}\` to play it.`;
                    }
                }
            }
            
            // Add error message if provided
            if (status === 'failed' && options.errorType && options.errorMessage) {
                message += `\n\nError (${options.errorType}): ${options.errorMessage}\n\nPlease try again later.`;
            }
            
            // Send final update
            await this.interaction.editReply(message);
            
            return true;
        } catch (error) {
            console.error('Error completing progress:', error);
            return false;
        }
    }
    
    /**
     * Mark specific items as complete, failed, or skipped in multi-item tracking
     * 
     * @param {String} itemName - The item to mark
     * @param {String} status - Status to set (completed, failed, skipped)
     * @param {Object} options - Additional options
     */
    markItem(itemName, status, options = {}) {
        if (!this.isMultiItem) {
            console.warn('markItem can only be used with multi-item tracking');
            return false;
        }
        
        return this.update(status, { itemName, ...options });
    }
}

module.exports = {
    chunkMessage,
    sendChunkedReply,
    ProgressTracker
}; 