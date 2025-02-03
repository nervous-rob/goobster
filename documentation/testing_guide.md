# Testing Guide

## Overview
This guide outlines the testing infrastructure and procedures for Goobster's development process, with special focus on voice and audio system testing.

## Test Structure

### 1. Unit Tests
Located in `__tests__/unit/`
- Command tests
- Service tests
- Utility tests

### 2. Integration Tests
Located in `__tests__/integration/`
- Voice recognition tests
- Audio system tests
- Database operations tests

## Test Configuration

### 1. Jest Setup
```javascript
// jest.config.js
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    collectCoverageFrom: [
        'utils/**/*.{js,ts}',
        'commands/**/*.{js,ts}',
        '!**/node_modules/**'
    ],
    coverageThreshold: {
        global: {
            branches: 80,
            functions: 80,
            lines: 80,
            statements: 80
        }
    }
}
```

### 2. Integration Test Setup
```javascript
// jest.integration.config.js
process.env.AZURE_SPEECH_KEY = config.azureSpeech.key;
process.env.AZURE_SPEECH_REGION = config.azureSpeech.region;

module.exports = {
    testMatch: ['**/__tests__/integration/**/*.test.js'],
    testTimeout: 10000,
    setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],
    testEnvironment: 'node',
    verbose: true,
    detectOpenHandles: true,
    forceExit: true
}
```

## Mock Setup

### 1. Discord.js Mocks
```javascript
jest.mock('@discordjs/voice', () => ({
    createAudioPlayer: jest.fn(),
    createAudioResource: jest.fn(),
    joinVoiceChannel: jest.fn(),
    VoiceConnectionStatus: {
        Disconnected: 'disconnected'
    }
}));
```

### 2. Azure Speech Mocks
```javascript
jest.mock('microsoft-cognitiveservices-speech-sdk', () => ({
    AudioConfig: {
        fromStreamInput: jest.fn()
    },
    SpeechConfig: {
        fromSubscription: jest.fn()
    },
    SpeechRecognizer: jest.fn(),
    ResultReason: {
        RecognizedSpeech: 'RecognizedSpeech'
    }
}));
```

### 3. Audio Processing Mocks
```javascript
jest.mock('prism-media', () => ({
    opus: {
        Decoder: jest.fn()
    },
    FFmpeg: jest.fn()
}));
```

## Running Tests

### 1. Unit Tests
```bash
# Run all unit tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

### 2. Integration Tests
```bash
# Run integration tests
npm run test:integration
```

## Test Cases

### 1. Voice Commands
- Voice recognition start/stop
- Session management
- Error handling
- Resource cleanup

### 2. Audio System
- Music playback
- Ambient sounds
- Audio mixing
- Volume control
- Transitions

### 3. Rate Limiting
- Voice usage tracking
- Time window management
- Concurrent sessions
- Resource cleanup

## Writing Tests

### 1. Test Structure
```javascript
describe('Component Name', () => {
    beforeEach(() => {
        // Setup
    });

    afterEach(() => {
        // Cleanup
    });

    describe('Feature', () => {
        it('should behave as expected', () => {
            // Test
        });
    });
});
```

### 2. Best Practices
- Test one thing per test
- Use descriptive names
- Setup/teardown properly
- Mock external dependencies
- Handle async operations
- Test error cases

### 3. Mocking Examples
```javascript
// Mock a service
const mockService = {
    method: jest.fn()
};

// Mock async function
mockService.method.mockResolvedValue(result);
mockService.method.mockRejectedValue(error);

// Verify calls
expect(mockService.method).toHaveBeenCalledWith(args);
```

## Coverage Requirements

### 1. Minimum Coverage
- Branches: 80%
- Functions: 80%
- Lines: 80%
- Statements: 80%

### 2. Critical Paths
- Voice recognition flow
- Audio processing pipeline
- Error handling
- Resource management

## Continuous Integration

### 1. Pre-commit Checks
- Linting
- Unit tests
- Type checking
- Format verification

### 2. CI Pipeline
- Full test suite
- Integration tests
- Coverage report
- Performance tests

## Debugging Tests

### 1. Tools
- Jest debugger
- VS Code integration
- Console logging
- Performance profiling

### 2. Common Issues
- Async timing
- Resource cleanup
- Mock configuration
- Environment setup

## Performance Testing

### 1. Metrics
- Response times
- Resource usage
- Memory leaks
- CPU utilization

### 2. Benchmarks
- Voice recognition latency
- Audio processing speed
- Connection handling
- Resource cleanup time

## Security Testing

### 1. Areas
- API key handling
- Rate limiting
- Input validation
- Resource access

### 2. Tools
- Static analysis
- Dependency scanning
- Security linting
- Vulnerability checks

## Voice and Audio Testing

### 1. Voice Service Testing
```javascript
describe('VoiceService', () => {
    let voiceService;
    let mockConnection;
    
    beforeEach(() => {
        mockConnection = {
            subscribe: jest.fn(),
            state: { status: 'ready' }
        };
        voiceService = new VoiceService(config);
    });

    afterEach(() => {
        voiceService.cleanup();
    });

    it('should handle voice recognition', async () => {
        const result = await voiceService.startRecognition(mockConnection);
        expect(result.status).toBe('active');
    });

    it('should manage voice sessions', () => {
        voiceService.createSession(userId, channelId);
        expect(voiceService.hasActiveSession(userId)).toBe(true);
    });
});
```

### 2. Mock Audio Streams
```javascript
class MockAudioStream extends Readable {
    constructor(options = {}) {
        super(options);
        this.sampleRate = options.sampleRate || 48000;
        this.channels = options.channels || 2;
        this.bitDepth = options.bitDepth || 16;
    }

    _read(size) {
        // Generate mock audio data
        const buffer = Buffer.alloc(size);
        this.push(buffer);
    }
}

// Usage in tests
const mockStream = new MockAudioStream({
    sampleRate: 48000,
    channels: 2,
    bitDepth: 16
});
```

### 3. Azure Speech SDK Mocking
```javascript
jest.mock('microsoft-cognitiveservices-speech-sdk', () => ({
    AudioConfig: {
        fromStreamInput: jest.fn().mockReturnValue({
            close: jest.fn()
        })
    },
    SpeechConfig: {
        fromSubscription: jest.fn().mockReturnValue({
            speechRecognitionLanguage: 'en-US',
            close: jest.fn()
        })
    },
    SpeechRecognizer: jest.fn().mockImplementation(() => ({
        recognizeOnceAsync: jest.fn().mockResolvedValue({
            result: {
                text: 'Mock recognized text',
                reason: 'RecognizedSpeech'
            }
        }),
        startContinuousRecognitionAsync: jest.fn().mockResolvedValue(),
        stopContinuousRecognitionAsync: jest.fn().mockResolvedValue(),
        close: jest.fn()
    }))
}));
```

### 4. Music Service Testing
```javascript
describe('MusicService', () => {
    let musicService;
    
    beforeEach(() => {
        musicService = new MusicService(config);
    });

    it('should generate music for mood', async () => {
        const result = await musicService.generateBackgroundMusic({
            atmosphere: 'peaceful'
        });
        expect(result).toMatch(/^https:/);
    });

    it('should handle music playback', async () => {
        const connection = mockConnection();
        await musicService.playBackgroundMusic('peaceful', connection);
        expect(connection.subscribe).toHaveBeenCalled();
    });

    it('should manage music cache', async () => {
        await musicService.generateAndCacheMoodMusic('battle');
        const exists = await musicService.doesMoodMusicExist('battle');
        expect(exists).toBe(true);
    });
});
```

### 5. Ambient Service Testing
```javascript
describe('AmbientService', () => {
    let ambientService;
    
    beforeEach(() => {
        ambientService = new AmbientService(config);
    });

    it('should generate ambient sounds', async () => {
        const result = await ambientService.generateAmbience('forest');
        expect(result).toMatch(/^https:/);
    });

    it('should handle ambient playback', async () => {
        const connection = mockConnection();
        await ambientService.playAmbience('cave', connection, 0.2);
        expect(connection.subscribe).toHaveBeenCalled();
    });
});
```

### 6. Rate Limiting Tests
```javascript
describe('Rate Limiting', () => {
    it('should enforce voice command limits', async () => {
        const service = new VoiceService(config);
        
        // Test rapid commands
        for (let i = 0; i < 10; i++) {
            await service.processCommand('speak');
        }
        
        await expect(
            service.processCommand('speak')
        ).rejects.toThrow('Rate limit exceeded');
    });

    it('should track time windows', () => {
        const limiter = new RateLimiter({
            maxRequests: 100,
            timeWindow: 60000
        });
        
        expect(limiter.canMakeRequest()).toBe(true);
    });
});
```

### 7. Session Management Tests
```javascript
describe('Session Management', () => {
    it('should handle concurrent sessions', () => {
        const sessionManager = new SessionManager();
        
        sessionManager.createSession('user1', 'channel1');
        sessionManager.createSession('user2', 'channel2');
        
        expect(sessionManager.getActiveSessions()).toHaveLength(2);
    });

    it('should cleanup inactive sessions', async () => {
        const sessionManager = new SessionManager();
        sessionManager.createSession('user1', 'channel1');
        
        await new Promise(r => setTimeout(r, 1000));
        sessionManager.cleanupInactiveSessions();
        
        expect(sessionManager.getActiveSessions()).toHaveLength(0);
    });
});
```

### 8. Performance Testing
```javascript
describe('Performance', () => {
    it('should handle memory usage', async () => {
        const initialMemory = process.memoryUsage().heapUsed;
        
        // Run intensive operations
        for (let i = 0; i < 100; i++) {
            await musicService.generateBackgroundMusic({ atmosphere: 'peaceful' });
        }
        
        const finalMemory = process.memoryUsage().heapUsed;
        expect(finalMemory - initialMemory).toBeLessThan(50 * 1024 * 1024); // 50MB limit
    });

    it('should measure response times', async () => {
        const start = Date.now();
        await voiceService.startRecognition(mockConnection);
        const duration = Date.now() - start;
        
        expect(duration).toBeLessThan(1000); // 1 second limit
    });
});
```

### 9. Integration Testing
```javascript
describe('End-to-End Voice Flow', () => {
    it('should handle complete voice interaction', async () => {
        // Setup
        const voiceService = new VoiceService(config);
        const musicService = new MusicService(config);
        const connection = mockConnection();
        
        // Start voice session
        await voiceService.startRecognition(connection);
        
        // Simulate voice command
        await voiceService.processCommand('playmusic peaceful');
        
        // Verify music playback
        expect(musicService.currentMood).toBe('peaceful');
        
        // Cleanup
        await voiceService.stopRecognition();
        expect(voiceService.hasActiveSession()).toBe(false);
    });
});
```

## Best Practices

### Voice Testing
1. **Mock Dependencies**
   - Azure Speech SDK
   - Discord voice connections
   - Audio streams
   - File system operations

2. **Test Coverage**
   - Command handling
   - Session management
   - Error scenarios
   - Resource cleanup

3. **Performance Monitoring**
   - Memory usage
   - CPU utilization
   - Response times
   - Resource leaks

### Audio Testing
1. **Mock Generation**
   - Audio streams
   - Music generation
   - Ambient sounds
   - Transitions

2. **Validation**
   - Audio quality
   - Playback behavior
   - Cache management
   - Resource usage

3. **Error Handling**
   - Connection drops
   - API failures
   - Resource limits
   - Invalid states 