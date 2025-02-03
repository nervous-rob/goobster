# Configuration Guide

## Azure Speech Service Setup

### Prerequisites
1. Azure Account with active subscription
2. Access to Azure Portal (portal.azure.com)
3. Permissions to create Speech Services

### Service Creation
1. **Azure Portal Steps**
   - Navigate to Azure Portal
   - Click "Create a resource"
   - Search for "Speech Service"
   - Click "Create"

2. **Basic Configuration**
   ```json
   {
     "subscription": "Your-Subscription",
     "resourceGroup": "speech-resources",
     "name": "goobster-speech",
     "region": "westus2",
     "pricingTier": "Standard S0"
   }
   ```

3. **Security Settings**
   - Network isolation
   - Private endpoints
   - Access control (IAM)

### Environment Variables
```bash
# Azure Speech Service
AZURE_SPEECH_KEY=your_speech_service_key
AZURE_SPEECH_REGION=westus2

# Replicate API
REPLICATE_API_KEY=your_replicate_api_key
```

## Audio Processing Parameters

### Voice Recognition Settings
```javascript
{
  "recognition": {
    "language": "en-US",
    "mode": "interactive",
    "format": "detailed",
    "profanityFilter": true
  }
}
```

### Voice Synthesis Settings
```javascript
{
  "synthesis": {
    "voice": "en-US-JennyNeural",
    "format": "audio-24khz-96kbitrate-mono-mp3"
  }
}
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

### Replicate API Settings
```javascript
{
  "replicate": {
    "apiKey": "your_replicate_api_key",
    "models": {
      "musicgen": {
        "version": "MODEL_VERSION",
        "defaults": {
          "model_version": "melody",
          "duration": 30,
          "temperature": 1,
          "top_k": 250,
          "top_p": 0,
          "classifier_free_guidance": 3
        },
        "ambient": {
          "model_version": "melody",
          "duration": 30,
          "temperature": 1,
          "top_k": 250,
          "top_p": 0,
          "classifier_free_guidance": 3
        }
      }
    }
  }
}
```

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
    "speechToText": {
      "requestsPerMinute": 100
    },
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