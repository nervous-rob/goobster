const VoiceService = require('./voice');
const config = require('../config.json');

// Instantiate the service once
const voiceService = new VoiceService(config);

// Initialize the service asynchronously (if needed, handle potential errors)
voiceService.initialize().catch(error => {
    console.error('Failed to initialize voice service during startup:', error);
    // Depending on the application, you might want to exit or implement retry logic
});

// Export the single instance
module.exports = {
    voiceService
}; 