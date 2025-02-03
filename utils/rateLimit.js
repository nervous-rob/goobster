const fs = require('fs').promises;
const path = require('path');

class RateLimiter {
    constructor() {
        // Store rate limit data
        this.voiceLimits = new Map();
        this.savePath = path.join(process.cwd(), 'data', 'voiceLimits.json');
        this.saveInterval = null;
        this.locks = new Map();
        
        // Configure limits
        this.limits = {
            voice: {
                // 2 hours of voice per hour per user
                maxDuration: 2 * 60 * 60 * 1000,
                // Reset window (1 hour)
                resetTime: 60 * 60 * 1000,
                // Cleanup threshold (3 hours)
                cleanupThreshold: 3 * 60 * 60 * 1000
            }
        };

        // Initialize
        this.init();
    }

    async init() {
        try {
            // Create data directory if it doesn't exist
            const dataDir = path.dirname(this.savePath);
            await fs.mkdir(dataDir, { recursive: true });

            // Load saved limits
            await this.loadLimits();

            // Start periodic saves
            this.saveInterval = setInterval(() => this.saveLimits(), 5 * 60 * 1000); // Save every 5 minutes

            // Start cleanup interval
            setInterval(() => this.cleanup(), 15 * 60 * 1000); // Cleanup every 15 minutes
        } catch (error) {
            console.error('Error initializing rate limiter:', error);
        }
    }

    async acquireLock(userId) {
        while (this.locks.get(userId)) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        this.locks.set(userId, true);
    }

    releaseLock(userId) {
        this.locks.delete(userId);
    }

    async loadLimits() {
        try {
            // Check if file exists first
            try {
                await fs.access(this.savePath);
            } catch (err) {
                // File doesn't exist, create it with empty limits
                await fs.writeFile(this.savePath, JSON.stringify({}, null, 2));
                this.voiceLimits = new Map();
                return;
            }

            // File exists, try to read it
            const data = await fs.readFile(this.savePath, 'utf8');
            
            // Handle empty file case
            if (!data.trim()) {
                await fs.writeFile(this.savePath, JSON.stringify({}, null, 2));
                this.voiceLimits = new Map();
                return;
            }

            try {
                const limits = JSON.parse(data);
                
                // Convert saved data back to Map
                this.voiceLimits = new Map(
                    Object.entries(limits).map(([userId, limit]) => [
                        userId,
                        {
                            ...limit,
                            lastReset: new Date(limit.lastReset)
                        }
                    ])
                );
            } catch (parseError) {
                console.error('Error parsing voice limits file, creating new one:', parseError);
                // JSON was invalid, create new file
                await fs.writeFile(this.savePath, JSON.stringify({}, null, 2));
                this.voiceLimits = new Map();
            }
        } catch (error) {
            console.error('Error in loadLimits:', error);
            // Ensure we have a valid Map even if everything fails
            this.voiceLimits = new Map();
        }
    }

    async saveLimits() {
        try {
            // Convert Map to object for storage
            const limits = Object.fromEntries(this.voiceLimits.entries());
            await fs.writeFile(this.savePath, JSON.stringify(limits, null, 2));
        } catch (error) {
            console.error('Error saving voice limits:', error);
        }
    }

    cleanup() {
        const now = Date.now();
        for (const [userId, limit] of this.voiceLimits.entries()) {
            if (now - limit.lastReset >= this.limits.voice.cleanupThreshold) {
                this.voiceLimits.delete(userId);
            }
        }
    }

    async canUseVoice(userId) {
        await this.acquireLock(userId);
        try {
            const now = Date.now();
            const userLimit = this.voiceLimits.get(userId);

            if (!userLimit) {
                // First time user
                this.voiceLimits.set(userId, {
                    usage: 0,
                    lastReset: now
                });
                return true;
            }

            // Check if we need to reset the window
            if (now - userLimit.lastReset >= this.limits.voice.resetTime) {
                userLimit.usage = 0;
                userLimit.lastReset = now;
                return true;
            }

            // Check if user has exceeded their limit
            return userLimit.usage < this.limits.voice.maxDuration;
        } finally {
            this.releaseLock(userId);
        }
    }

    async trackVoiceUsage(userId, duration) {
        await this.acquireLock(userId);
        try {
            const userLimit = this.voiceLimits.get(userId);
            if (userLimit) {
                userLimit.usage += duration;
                // Ensure we don't exceed max duration
                userLimit.usage = Math.min(userLimit.usage, this.limits.voice.maxDuration);
            }
        } finally {
            this.releaseLock(userId);
        }
    }

    async getRemainingVoiceTime(userId) {
        await this.acquireLock(userId);
        try {
            const userLimit = this.voiceLimits.get(userId);
            if (!userLimit) {
                return this.limits.voice.maxDuration;
            }

            const now = Date.now();
            if (now - userLimit.lastReset >= this.limits.voice.resetTime) {
                return this.limits.voice.maxDuration;
            }

            return Math.max(0, this.limits.voice.maxDuration - userLimit.usage);
        } finally {
            this.releaseLock(userId);
        }
    }

    formatTimeRemaining(ms) {
        const minutes = Math.floor(ms / (60 * 1000));
        const seconds = Math.floor((ms % (60 * 1000)) / 1000);
        return `${minutes}m ${seconds}s`;
    }

    // Cleanup on process exit
    async shutdown() {
        if (this.saveInterval) {
            clearInterval(this.saveInterval);
        }
        await this.saveLimits();
    }
}

const rateLimiter = new RateLimiter();

// Handle graceful shutdown
process.on('SIGINT', async () => {
    await rateLimiter.shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await rateLimiter.shutdown();
    process.exit(0);
});

module.exports = rateLimiter; 