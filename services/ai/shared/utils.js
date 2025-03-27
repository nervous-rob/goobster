function validateMessages(messages) {
    if (!Array.isArray(messages)) {
        throw new Error('Messages must be an array');
    }

    if (messages.length === 0) {
        throw new Error('Messages array cannot be empty');
    }

    messages.forEach((msg, index) => {
        if (!msg.role || !msg.content) {
            throw new Error(`Invalid message at index ${index}: missing role or content`);
        }

        if (!['system', 'user', 'model', 'assistant'].includes(msg.role)) {
            throw new Error(`Invalid message role at index ${index}: ${msg.role}`);
        }
    });
}

function formatResponse(content, model, latency, usage) {
    return {
        content,
        model,
        latency,
        usage,
        timestamp: new Date().toISOString()
    };
}

module.exports = {
    validateMessages,
    formatResponse
}; 