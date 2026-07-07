/**
 * Thread lifecycle helpers: race-free thread creation (per-channel locks so
 * concurrent messages can't create duplicate threads) and AI-generated
 * thread names.
 */
const { ThreadAutoArchiveDuration } = require('discord.js');
const aiService = require('../../services/aiService');

const threadLocks = new Map();

async function getOrCreateThreadSafely(channel, threadName) {
    // If the channel is already a thread, just return it
    if (channel.isThread()) {
        return channel;
    }
    
    const lockKey = `${channel.id}-${threadName}`;
    if (threadLocks.has(lockKey)) {
        return await threadLocks.get(lockKey);
    }

    const lockPromise = (async () => {
        try {
            const threads = await channel.threads.fetch();
            let thread = threads.threads.find(t => t.name === threadName);
            
            if (!thread) {
                console.log(`Creating new thread "${threadName}" in channel ${channel.name}`);
                thread = await channel.threads.create({
                    name: threadName,
                    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
                    reason: 'New Goobster chat thread'
                });
            } else {
                console.log(`Found existing thread "${threadName}" in channel ${channel.name}`);
            }

            // Make sure thread is unarchived
            if (thread.archived) {
                console.log(`Unarchiving thread "${threadName}"`);
                await thread.setArchived(false);
            }

            return thread;
        } catch (error) {
            console.error('Error in thread creation:', error);
            // Return the original channel as fallback
            return channel;
        }
    })();

    threadLocks.set(lockKey, lockPromise);
    try {
        return await lockPromise;
    } finally {
        threadLocks.delete(lockKey);
    }
}

/**
 * Generate a thread name based on the user
 * @param {Object} user - The Discord user object
 * @returns {string} - A thread name
 */
async function getThreadName(user) {
    try {
        // Generate thread name using the AI provider
        const prompt = `
Generate a short, creative, and friendly thread name for a conversation with a user named ${user.username}.
The name should be related to having a chat or conversation in a fun way.
Keep it under 30 characters (including spaces) and make it appropriate for all ages.
Return ONLY the thread name without any quotation marks or additional text.
`;

        let threadName = (await aiService.chatText([
            { role: 'user', content: prompt }
        ], {
            preset: 'chat',
            max_tokens: 20
        })).trim();
        
        // Ensure thread name meets Discord requirements
        if (threadName.length > 100) {
            threadName = threadName.substring(0, 97) + '...';
        }
        
        // Fall back to a basic name if generation fails or is empty
        if (!threadName) {
            threadName = `Chat with ${user.username}`;
        }
        
        return threadName;
    } catch (error) {
        console.error('Error generating thread name:', error);
        return `Chat with ${user.username}`;
    }
}

module.exports = {
    getOrCreateThreadSafely,
    getThreadName
};
