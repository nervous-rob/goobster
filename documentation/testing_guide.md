# Testing Guide

## Overview

Goobster's automated tests are Jest unit specs plus optional live provider
checks and Playwright portal journeys. The unit suite needs no
`config.json`, API keys, or network. Cloud providers are mocked.

## Test Structure

### 1. Unit Tests

Located in `tests/*.test.js`. These are the only files `npm test` runs.
Each file belongs to exactly one CI group in `tests/ciGroups.js`:

| Group | Scope |
| --- | --- |
| Core infrastructure (`core`) | Database, migrations, gateways, locks, configuration, feature gating |
| Installer and lifecycle (`install`) | Manager, installer, payloads, service adapters, managed Postgres, releases, updates |
| Chat and AI | Providers, prompts, tools, conversations, message queues |
| Portal and collaboration | Web APIs, sessions, applets, Parlor, sharing |
| Knowledge and memory | Spitball, graphs, memory, research expeditions |
| Projects and autonomy | Observatory, missions, triggers, automation, attention |
| Voice and media | Speech, realtime audio, playback, music |
| Games and economy | Casino, exchange, Tavern, GBA |
| Privacy and execution safety | Erasure, permissions, approvals, sandbox |

`tests/test*.js` files that do not match `*.test.js` are standalone manual
scripts — do not run them under Jest.

### 2. Live provider checks

Located in `tests/live/*.live.test.js`, run with `npm run test:live`
(`jest.live.config.js`). Each file skips when its env var is unset and
fails when the key is present but the provider call fails. Mocked provider
suites in `tests/*.test.js` always run; live checks never replace them.

| Variable | Live file |
| --- | --- |
| `OPENAI_API_KEY` | `tests/live/openai.live.test.js` |
| `ANTHROPIC_API_KEY` | `tests/live/anthropic.live.test.js` |
| `GEMINI_API_KEY` | `tests/live/gemini.live.test.js` |
| `PERPLEXITY_API_KEY` | `tests/live/perplexity.live.test.js` |
| `ELEVENLABS_API_KEY` | `tests/live/elevenlabs.live.test.js` |

### 3. Playwright journeys

Located in `e2e/*.spec.js`. Run with `npm run test:e2e` after `npm run build:web`.

## Test Configuration

Unit Jest config lives in the root `package.json` (`testMatch`:
`tests/*.test.js`). Coverage thresholds (80%) apply only when running
`npm run test:coverage`, and only to `packages/core/utils/**` and
`apps/bot/commands/**`.

Live checks use `jest.live.config.js`. They do not require `config.json`.

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

### 2. ElevenLabs Mocks
```javascript
jest.mock('node-fetch', () => jest.fn().mockResolvedValue({
    ok: true,
    body: require('stream').Readable.from([])
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
# Run all unit tests (SQLite)
npm test

# Same suite against local Postgres + pgvector
npm run test:postgres

# One CI group
npm run test:group -- core

# Fail if a spec is missing from tests/ciGroups.js
npm run test:groups:check

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

### 2. Live provider checks
```bash
npm run test:live
# alias:
npm run test:integration
```

Missing keys skip; invalid keys fail. Values are never printed.

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
- Put a new `tests/*.test.js` file in exactly one group in `tests/ciGroups.js`

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

(`npm run test:coverage` only; CI does not collect coverage.)

### 2. Critical Paths
- Voice recognition flow
- Audio processing pipeline
- Error handling
- Resource management

## Continuous Integration

`.github/workflows/ci.yml`:

1. `static checks` — lint, smoke, typecheck, web build, group inventory
2. `test (sqlite, <shard>)` — the named Jest groups on SQLite, in two
   parallel shards
3. `test (postgres, <shard>)` — the same groups against pgvector, in four
   parallel shards
4. `sandbox isolation` — bubblewrap canary
5. `both engines` — fails unless static checks, every SQLite shard, every
   Postgres shard and isolation succeeded. This is the check to require.
6. `test (playwright, <n>/5)` — portal journeys in five parallel shards,
   and `test (playwright)`, which reports them as one check
7. `test (docker postgres)` — the Docker-managed Postgres specs against a
   real daemon
8. `test (live integrations)` — main pushes and `workflow_dispatch` only

A shard is one matrix entry of an engine job and runs the groups in its
`groups` list. Every group runs exactly once per engine; the inventory
(`npm run test:groups:check`, also `tests/ciGroups.test.js`) fails if a
group is in no shard of an engine or in two, and if the manifest drifts
from Jest's discovered files. Which groups share a shard is a timing
decision and lives in the workflow; the two engines are split differently
because Postgres is slower.

Group steps are ordinary named steps in each engine job (not a composite
action) so the Actions step list shows names, statuses, and timings; a
group that belongs to another shard shows as skipped. They use
`continue-on-error` so a later group still runs after an earlier failure.
The shard fails at the end unless every one of its groups wrote a passing
result (`scripts/require-test-groups.js`).

The journeys are split by `scripts/e2e-shard.js`, which balances the spec
files by the seconds recorded in `e2e/shard-durations.json`. A new
`e2e/*.spec.js` is picked up without being registered anywhere. Each shard
starts its own server and throwaway database, so a spec must not depend on
what a spec in another file left behind. To see the split or run one shard:

```bash
node scripts/e2e-shard.js --plan 5      # every shard, its files and weight
node scripts/e2e-shard.js 2 5           # run shard 2 of 5
```

A shard runs about four minutes of journeys and its job limit is 15
minutes. Keep it that way as journeys are added: `tests/ciGroups.test.js`
fails when the longest planned shard passes half of the limit, and the fix
is to add the next number to the `shard` list of `test-e2e` in `ci.yml`
(nothing else changes; the plan is recomputed for the new count). To
refresh the recorded seconds, run
`npx playwright test --reporter=json > report.json` and then
`node scripts/e2e-shard.js --record report.json`. A failed or cancelled
shard uploads its Playwright traces as the artifact
`playwright-shard-<n>`.

Each shard installs Chromium with `scripts/ci-playwright-chromium.sh`.
The nine font packages Chromium needs on a runner are kept in a cache
(keyed on the runner image and the Playwright version) and installed from
it without downloading; Playwright's own dry run then confirms that
nothing is missing. With no cache, or if anything about the cache is off,
the script runs `npx playwright install --with-deps chromium` as before,
so a miss costs time and never a failure. The step's log says which path
ran (`system packages from the cache` or `full install`) and prints a
hash of the installed fonts. Locally nothing changes: `npm run
test:e2e:install` is still the plain Playwright command.

Every journey of a shard talks to one `e2e/server.js` process. A fixture
route there has to be safe to call twice, because CI retries a failed
journey once and the retry seeds again, and it must not be able to end
the process: `e2e/harness.spec.js` holds both. A long run of journeys
failing in about 100 ms each means that server has exited; look for the
first failure before the run, not at the run.

A journey whose actions each take longer than the one before, while the
server answers in milliseconds, is the page doing more work on every
frame, and it is not a cold start: the first portal journey of a shard
costs about 0.3 s more than the next one. Open the shard's trace and
compare an element's size across the snapshots. The followed-sources
journey passed the 45-second limit this way, on a map canvas that grew
about 100 px a frame (fixed in `apps/web/src/styles.css`, held by the
last test in `e2e/followedSources.spec.js`).

A new push to a pull request cancels the run for the previous push. Runs
on `main` are never cancelled.

The job summary lists group, engine, passed/failed/skipped counts, duration,
and skip reasons (live credentials: names and status only).

See `documentation/adr/0007-ci-test-groups.md`.


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

### 3. ElevenLabs API Mocking
```javascript
jest.mock('node-fetch', () =>
    jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: require('stream').Readable.from([Buffer.alloc(0)])
    })
);
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
   - ElevenLabs API (via node-fetch)
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