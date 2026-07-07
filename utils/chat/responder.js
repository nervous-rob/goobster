/**
 * Response delivery: sends chunked replies through the right mechanism for
 * the interaction type (slash-command reply chain vs channel/thread sends),
 * honoring the guild's thread preference.
 */
const { getThreadPreference, THREAD_PREFERENCE } = require('../guildSettings');
const { chunkMessage } = require('../index');
const { getOrCreateThreadSafely } = require('./threadManager');

async function sendChunkedResponse(interaction, chunks, isError = false) {
    try {
        // Use existing thread if provided, otherwise check thread preference
        let thread = interaction.channel;
        
        // Only check thread preference if no thread is provided and we're not already in a thread
        if (!thread && !interaction.channel?.isThread() && interaction.guildId) {
            // Get the guild's thread preference
            const threadPreference = await getThreadPreference(interaction.guildId);
            
            // If preference is ALWAYS_THREAD, create/use a thread
            if (threadPreference === THREAD_PREFERENCE.ALWAYS_THREAD) {
                const channelName = interaction.channel.name.replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
                const threadName = `goobster-chat-${channelName}`;
                
                try {
                    thread = await getOrCreateThreadSafely(interaction.channel, threadName);
                    
                    // Send welcome message only for newly created threads
                    if (!thread.messages.cache.size) {
                        await thread.send(
                            "👋 Hi! I've created this thread for our conversation. " +
                            "You can continue chatting with me here by:\n" +
                            "1. Using `/chat` command\n" +
                            `2. Mentioning me (@${interaction.client.user.username})\n\n` +
                            "The thread will keep our conversation organized and maintain context!"
                        );
                    }
                } catch (error) {
                    console.error('Error creating/finding thread:', error);
                    // If we can't create a thread, use the channel directly
                    thread = null;
                }
            }
        } else if (interaction.channel?.isThread()) {
            thread = interaction.channel;
        }

        // For slash commands, use the interaction reply mechanism
        if (interaction.commandName === 'chat') {
            // Send first chunk as reply or edit
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(chunks[0]);
            } else {
                await interaction.reply(chunks[0]);
            }

            // Send remaining chunks as follow-ups
            for (let i = 1; i < chunks.length; i++) {
                await interaction.followUp(chunks[i]);
            }
            
            // If we created a thread, send a message to direct the user there
            if (thread && !interaction.channel.isThread()) {
                await interaction.followUp({
                    content: `I've continued our conversation in a thread: ${thread}`,
                    ephemeral: true
                });
            }
        } 
        // For mentions, send to the appropriate channel based on thread preference
        else {
            const targetChannel = thread || interaction.channel;
            
            // Send all chunks to the target channel
            for (const chunk of chunks) {
                await targetChannel.send(chunk);
            }
            
            // If we created a thread, send a message to direct the user there
            if (thread && interaction.channel !== thread) {
                await interaction.channel.send({
                    content: `I've continued our conversation in a thread: ${thread}`,
                    allowedMentions: { users: [], roles: [] }
                });
            }
        }
    } catch (error) {
        console.error('Error sending chunked response:', {
            error: error.message,
            stack: error.stack,
            isErrorResponse: isError
        });
        
        // If this is already an error response, don't try again
        if (!isError) {
            const errorChunks = chunkMessage("I encountered an error while sending my response. Please try again.");
            await sendChunkedResponse(interaction, errorChunks, true);
        }
    }
}

module.exports = { sendChunkedResponse };
