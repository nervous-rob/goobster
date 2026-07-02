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