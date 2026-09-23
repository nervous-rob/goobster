# Configuration Guide

## ElevenLabs Text-to-Speech Setup

### Prerequisites
1. An ElevenLabs account (elevenlabs.io)
2. An API key (Developers → API Keys in the ElevenLabs dashboard)

### Configuration
Add to `config.json`:

```json
{
  "elevenlabs": {
    "apiKey": "sk_...",
    "voiceId": "21m00Tcm4TlvDq8ikWAM",
    "modelId": "eleven_flash_v2_5"
  }
}
```

- `voiceId` accepts a voice ID or a voice name from your library (e.g. `Rachel`)
- `modelId` defaults to `eleven_flash_v2_5` (low latency); use `eleven_multilingual_v2` for the highest quality

### Environment Variables
```bash
# ElevenLabs (TTS, music generation, ambient sound effects)
ELEVENLABS_API_KEY=your_elevenlabs_key
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
```

### Audio Quality Settings
```javascript
{
  "audio": {
    "sampleRate": 48000,
    "channels": 2,
    "bitDepth": 16,
    "format": "s16le"
  }
}
```

## Music Generation Configuration

Mood music is generated with the **ElevenLabs Music API** (`music_v2` model, requires a paid plan) and ambient loops with the **ElevenLabs Sound Effects API**. Both use the same `elevenlabs.apiKey` as TTS — no separate configuration is needed.

### Music Generation Settings
```javascript
{
  "musicGeneration": {
    "moods": {
      "battle": "Epic orchestral battle music with intense drums and brass, fantasy game style",
      "exploration": "Ambient fantasy exploration music with soft strings and wind instruments, peaceful and adventurous",
      "mystery": "Dark mysterious music with subtle tension and ethereal sounds, fantasy RPG style",
      "celebration": "Triumphant victory fanfare with uplifting melodies, orchestral fantasy style",
      "danger": "Tense suspenseful music with low drones and percussion, dark fantasy style",
      "peaceful": "Gentle pastoral fantasy music with flutes and harps, medieval style",
      "sad": "Melancholic emotional music with solo violin and piano, fantasy ballad style",
      "dramatic": "Grand dramatic orchestral music with full symphony, epic fantasy style"
    },
    "cacheDirectory": "./data/music"
  }
}
```

### Ambient Sound Settings
```javascript
{
  "ambientSounds": {
    "types": {
      "forest": "Forest ambience with birds chirping, leaves rustling, and gentle wind",
      "cave": "Dark cave ambience with water drops, distant echoes, and subtle wind",
      "tavern": "Medieval tavern ambience with murmuring crowds, clinking glasses, and distant music",
      "ocean": "Ocean waves crashing, seagulls, and wind over water",
      "city": "Medieval city ambience with distant crowds, horse carriages, and street vendors",
      "dungeon": "Dark dungeon ambience with chains, distant moans, and eerie sounds",
      "camp": "Nighttime campfire ambience with crackling fire and nocturnal creatures",
      "storm": "Thunder, heavy rain, and howling wind ambience"
    },
    "defaultVolume": 0.2,
    "cacheDirectory": "./data/ambience"
  }
}
```

## Audio Player Configuration

### Player Settings
```javascript
{
  "player": {
    "behaviors": {
      "noSubscriber": "Pause",
      "maxMissedFrames": 50
    }
  }
}
```

### FFmpeg Settings
```javascript
{
  "ffmpeg": {
    "args": [
      "-i", "-",
      "-analyzeduration", "0",
      "-loglevel", "0",
      "-acodec", "pcm_s16le",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2"
    ]
  }
}
```

## Rate Limiting

### Voice Commands
```javascript
{
  "rateLimits": {
    "textToSpeech": {
      "requestsPerMinute": 50
    },
    "musicGeneration": {
      "requestsPerHour": 10
    }
  }
}
```

## Directory Structure
```
data/
├── music/
│   ├── battle.mp3
│   ├── peaceful.mp3
│   └── ...
└── ambience/
    ├── forest.mp3
    ├── cave.mp3
    └── ...
```

## Security Considerations

### API Key Management
- Store API keys in environment variables
- Use secure key management in production
- Implement proper error handling for invalid keys

### Resource Protection
- Implement rate limiting
- Monitor resource usage
- Clean up temporary files
- Validate user permissions

## Error Handling

### Common Issues
1. **API Errors**
   - Invalid API keys
   - Rate limit exceeded
   - Service unavailable

2. **Audio Processing**
   - FFmpeg errors
   - Stream interruptions
   - Resource allocation failures

3. **File System**
   - Cache directory access
   - Disk space issues
   - File permissions

### Recovery Strategies
1. **Automatic Recovery**
   - Retry with exponential backoff
   - Fallback to cached content
   - Resource cleanup

2. **Manual Intervention**
   - Clear cache directories
   - Reset API keys
   - Restart services

## Account token limits

Single-user use is unlimited unless the host sets a cap. The reservation ledger still records token usage for cost reports.

```json
{
  "limits": {
    "dailyTokens": null,
    "windowHours": 24,
    "retentionDays": 90
  }
}
```

| Key | Environment default | Meaning |
|---|---|---|
| `limits.dailyTokens` | `GOOBSTER_LIMITS_DAILY_TOKENS` | Positive token cap per account per window; null/unset means unlimited. |
| `limits.windowHours` | `GOOBSTER_LIMITS_WINDOW_HOURS` | Integer 1–24; defaults to a 24-hour window resetting at midnight UTC. |
| `limits.retentionDays` | `GOOBSTER_LIMITS_RETENTION_DAYS` | Integer 1–3,650; settled/released token reservations default to 90 days. |

Resolution on a fresh installation is environment → `config.json` → default. **Host → Limits** saves an override in the database, effective for new reservations without restart. That saved override takes precedence over startup defaults. `identity.requireAccount: true` requires a cap before a second account can be created, including invitation and open-registration paths. It also prevents clearing the cap while multiple accounts exist.

The cap covers routed model chat/text calls, including reasoning output. Images, speech, search and embeddings have separate resource records and no token cap here. Foreground requests fail with the named limit; background requests wait up to `admission.modelQueueMs` (default 30 seconds), then report the failure. No in-flight model stream is preempted. See [work_ledger.md](work_ledger.md#budgets) for reservations, estimates, reset times and reconciliation.
