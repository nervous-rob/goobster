# Audio System Documentation

## Overview
Goobster's audio system provides dynamic background music, ambient sounds, voice recognition, and text-to-speech capabilities. The system is designed for high performance, reliability, and seamless audio transitions.

## Components

### 1. Music Service (`musicService.js`)
- Manages background music generation and playback
- Handles music transitions and looping
- Features:
  ```javascript
  {
    music: {
      volume: 0.3,
      fadeInDuration: 2000,
      fadeOutDuration: 2000,
      crossfadeDuration: 3000,
      loopFadeStart: 5000
    }
  }
  ```

### 2. Ambient Service (`ambientService.js`)
- Handles ambient sound effects
- Manages sound mixing and transitions
- Settings:
  ```javascript
  {
    ambient: {
      volume: 0.2,
      fadeInDuration: 1000,
      fadeOutDuration: 1000,
      crossfadeDuration: 2000,
      loopFadeStart: 3000
    }
  }
  ```

### 3. Audio Mixer Service (`audioMixerService.js`)
- Combines multiple audio streams
- Handles audio transitions and effects
- Features:
  - Background music mixing
  - Voice overlay
  - Dynamic volume control
  - Crossfade transitions

### 4. TTS Service (`ttsService.js`)
- Text-to-speech conversion
- Voice synthesis management
- Integration with Azure Speech Services

## Audio Pipeline

### 1. Input Processing
```
Raw Audio -> Format Conversion -> Buffer Management -> Processing
```

### 2. Audio Mixing
```
Background Music ----→ Audio Mixer --→ Output
Ambient Sounds   ----↗     ↑
Voice/TTS       --------→--┘
```

### 3. Output Processing
```
Mixed Audio -> Volume Control -> Fade Effects -> Voice Channel
```

## Features

### 1. Background Music
- Dynamic music generation
- Seamless looping
- Mood-based selection:
  - Battle
  - Exploration
  - Mystery
  - Celebration
  - Danger
  - Peaceful
  - Sad
  - Dramatic

### 2. Ambient Sounds
- Environmental effects:
  - Forest
  - Cave
  - Tavern
  - Ocean
  - City
  - Dungeon
  - Camp
  - Storm

### 3. Audio Transitions
- Smooth crossfading
- Volume ramping
- Dynamic mixing
- State-based transitions

## Configuration

### 1. Music Settings
```javascript
{
  volume: 0.3,        // Default music volume
  fadeInDuration: 2000,    // ms
  fadeOutDuration: 2000,   // ms
  crossfadeDuration: 3000, // ms
  loopFadeStart: 5000     // ms before end
}
```

### 2. Ambient Settings
```javascript
{
  volume: 0.2,        // Default ambient volume
  fadeInDuration: 1000,    // ms
  fadeOutDuration: 1000,   // ms
  crossfadeDuration: 2000, // ms
  loopFadeStart: 3000     // ms before end
}
```

### 3. Voice Settings
```javascript
{
  voiceThreshold: -35,
  silenceThreshold: -45,
  voiceReleaseThreshold: -40,
  silenceDuration: 300
}
```

## Performance Considerations

### 1. Resource Management
- Buffer size optimization
- Memory usage monitoring
- Stream cleanup
- Connection management

### 2. Audio Quality
- Sample rate: 48kHz
- Bit depth: 16-bit
- Channels: Stereo
- Format: PCM

### 3. Latency Management
- Buffer size tuning
- Stream synchronization
- Backpressure handling
- Pipeline optimization

## Error Handling

### 1. Common Issues
- Connection failures
- Stream interruptions
- Format mismatches
- Resource exhaustion

### 2. Recovery Strategies
- Automatic reconnection
- Stream reset
- Resource cleanup
- Graceful degradation

## Best Practices

### 1. Audio Management
- Implement proper cleanup
- Monitor resource usage
- Handle transitions smoothly
- Maintain audio quality

### 2. Performance
- Optimize buffer sizes
- Monitor memory usage
- Handle backpressure
- Clean up resources

### 3. User Experience
- Smooth transitions
- Appropriate volumes
- Consistent quality
- Error recovery

## Commands

### Music Commands
- `/playmusic [mood] [volume]`
- `/stopmusic`
- `/regeneratemusic [mood]`
- `/generateallmusic`

### Ambient Commands
- `/playambience [type] [volume]`
- `/stopambience`

### Voice Commands
- `/speak [message]`
- `/transcribe [enabled]`
- `/voice [start|stop]`

## Future Improvements

### 1. Audio Features
- Advanced audio effects
- Custom music generation
- Voice filters
- Spatial audio

### 2. Performance
- Enhanced buffering
- Better resource usage
- Improved transitions
- Reduced latency

### 3. User Experience
- Visual audio feedback
- Custom voice settings
- Advanced mixing controls
- Enhanced error handling
``` 