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

module.exports = {
    chunkMessage,
    sendChunkedReply
}; 