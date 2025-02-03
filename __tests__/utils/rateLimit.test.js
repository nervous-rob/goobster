// Mock fs module
jest.mock('fs', () => {
    let mockData = {};
    const mockWriteFile = jest.fn().mockImplementation((path, data) => {
        mockData[path] = data;
        return Promise.resolve();
    });
    const mockReadFile = jest.fn().mockImplementation((path) => {
        if (!mockData[path]) {
            const error = new Error('File not found');
            error.code = 'ENOENT';
            return Promise.reject(error);
        }
        return Promise.resolve(mockData[path]);
    });
    const mockMkdir = jest.fn().mockImplementation(() => Promise.resolve());

    return {
        promises: {
            writeFile: mockWriteFile,
            readFile: mockReadFile,
            mkdir: mockMkdir
        }
    };
});

// Import after mocking
const fs = require('fs').promises;
const rateLimiter = require('../../utils/rateLimit');

describe('RateLimiter', () => {
    const userId = 'test-user-123';
    const maxDuration = 300000; // 5 minutes in milliseconds
    const baseTime = 1000000;

    beforeEach(async () => {
        // Reset rate limiter state
        rateLimiter.voiceLimits = new Map();
        rateLimiter.locks = new Map();
        jest.clearAllMocks();
        
        // Initialize with default state
        await rateLimiter.init();
        
        // Mock Date.now() for consistent testing
        jest.spyOn(Date, 'now').mockImplementation(() => baseTime);
    });

    afterEach(async () => {
        // Cleanup
        rateLimiter.voiceLimits.clear();
        rateLimiter.locks.clear();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    describe('Voice Limits', () => {
        it('should allow first-time users', async () => {
            rateLimiter.voiceLimits.clear(); // Ensure clean state
            const canUse = await rateLimiter.canUseVoice(userId);
            expect(canUse).toBe(true);
            expect(rateLimiter.voiceLimits.get(userId)).toEqual({
                usage: 0,
                lastReset: baseTime
            });
        });

        it('should track usage correctly', async () => {
            const usageTime = 60000; // 1 minute
            await rateLimiter.trackVoiceUsage(userId, usageTime);
            const remaining = await rateLimiter.getRemainingVoiceTime(userId);
            expect(remaining).toBe(maxDuration - usageTime);
        });

        it('should prevent exceeding limits', async () => {
            // Set initial state
            rateLimiter.voiceLimits.set(userId, {
                usage: maxDuration,
                lastReset: baseTime
            });
            
            const canUse = await rateLimiter.canUseVoice(userId);
            expect(canUse).toBe(false);
        });

        it('should reset after window expires', async () => {
            rateLimiter.voiceLimits.set(userId, {
                usage: maxDuration,
                lastReset: baseTime - rateLimiter.limits.voice.resetTime - 1000
            });

            const canUse = await rateLimiter.canUseVoice(userId);
            expect(canUse).toBe(true);
            expect(rateLimiter.voiceLimits.get(userId).usage).toBe(0);
        });
    });

    describe('Persistence', () => {
        it('should save limits to file', async () => {
            const usageTime = 60000;
            const mockState = {
                [userId]: {
                    usage: usageTime,
                    lastReset: baseTime
                }
            };
            rateLimiter.voiceLimits = new Map(Object.entries(mockState));
            
            await rateLimiter.saveLimits();
            
            expect(fs.writeFile).toHaveBeenCalledWith(
                expect.any(String),
                JSON.stringify(mockState, null, 2)
            );
        });

        it('should load limits from file', async () => {
            const mockData = {
                [userId]: {
                    usage: 60000,
                    lastReset: baseTime
                }
            };
            
            fs.readFile.mockResolvedValueOnce(JSON.stringify(mockData));
            await rateLimiter.loadLimits();
            
            expect(rateLimiter.voiceLimits.has(userId)).toBe(true);
            expect(rateLimiter.voiceLimits.get(userId).usage).toBe(60000);
        });

        it('should handle missing data file', async () => {
            rateLimiter.voiceLimits.clear();
            fs.readFile.mockRejectedValueOnce({ code: 'ENOENT' });
            await expect(rateLimiter.loadLimits()).resolves.not.toThrow();
            expect(rateLimiter.voiceLimits.size).toBe(0);
        });
    });

    describe('Cleanup', () => {
        it('should remove stale entries', () => {
            rateLimiter.voiceLimits.set(userId, {
                usage: 0,
                lastReset: baseTime - rateLimiter.limits.voice.cleanupThreshold - 1000
            });

            rateLimiter.cleanup();
            expect(rateLimiter.voiceLimits.has(userId)).toBe(false);
        });

        it('should keep active entries', () => {
            rateLimiter.voiceLimits.set(userId, {
                usage: 60000,
                lastReset: baseTime - 1000 // Recent activity
            });

            rateLimiter.cleanup();
            expect(rateLimiter.voiceLimits.has(userId)).toBe(true);
        });
    });

    describe('Concurrency', () => {
        it('should handle concurrent access', async () => {
            const usagePerCall = 10000;
            const numberOfCalls = 5;
            
            // Initialize user state
            rateLimiter.voiceLimits.set(userId, {
                usage: 0,
                lastReset: baseTime
            });
            
            const promises = Array(numberOfCalls).fill().map(() => 
                rateLimiter.trackVoiceUsage(userId, usagePerCall)
            );
            
            await Promise.all(promises);
            
            const userLimit = rateLimiter.voiceLimits.get(userId);
            expect(userLimit).toBeDefined();
            expect(userLimit.usage).toBe(usagePerCall * numberOfCalls);
        });

        it('should prevent race conditions with locks', async () => {
            let currentTime = baseTime;
            jest.spyOn(Date, 'now').mockImplementation(() => {
                currentTime += 100;
                return currentTime;
            });

            const results = [];
            const promises = Array(3).fill().map(async () => {
                await rateLimiter.acquireLock(userId);
                try {
                    results.push(Date.now());
                    await new Promise(resolve => setTimeout(resolve, 10));
                } finally {
                    rateLimiter.releaseLock(userId);
                }
            });

            await Promise.all(promises);
            
            // Check that executions were sequential
            for (let i = 1; i < results.length; i++) {
                expect(results[i]).toBeGreaterThan(results[i - 1]);
            }
        });
    });
}); 