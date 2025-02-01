# Voice Commands Documentation

## Overview
This document covers all voice-related commands and features in Goobster, including text-to-speech, voice recognition, and audio management capabilities.

## Command Reference

### Text-to-Speech Commands

#### `/speak [message]`
Converts text to speech using Azure's Speech Services.

**Usage:**
```
/speak Hello, this is a test message
```

**Parameters:**
- `message`: The text to convert to speech (required)

**Permissions Required:**
- Basic user permissions
- Voice channel access
- Bot must have Connect and Speak permissions

### Voice Recognition Commands

#### `/transcribe [enabled]`
Enables or disables voice transcription in the current channel.

**Usage:**
```
/transcribe on
/transcribe off
```

**Parameters:**
- `enabled`: Boolean value to enable/disable transcription (required)

**Thread Management:**
- Creates a dedicated thread for transcriptions in the general channel or command channel
- Maintains session context for continuous conversations
- Auto-closes after inactivity
- Requires CreatePrivateThreads and SendMessagesInThreads permissions

**Error Recovery:**
- Automatic reconnection attempts on disconnection
- Session cleanup on errors
- Resource management for memory and connections
- Detailed error logging and user feedback

### Voice Control Commands

#### `/voice [subcommand]`
Manages voice recognition and processing settings.

**Subcommands:**
- `start`: Begin voice recognition session
- `stop`: End voice recognition session

**Usage:**
```
/voice start
/voice stop
```

**Requirements:**
- User must be in a voice channel
- Bot must have Connect and Speak permissions
- Only one active voice session per user

### Music Commands

#### `/playmusic [mood] [loop]`
Plays background music with specified mood.

**Parameters:**
- `mood`: The mood of the music (required)
  - battle
  - exploration
  - mystery
  - celebration
  - danger
  - peaceful
  - sad
  - dramatic
- `loop`: Whether to loop the music (optional, defaults to false)

#### `/stopmusic`
Stops currently playing background music with a smooth fade-out.

#### `/regeneratemusic [mood]`
Regenerates music for a specific mood.

**Parameters:**
- `mood`: The mood of the music to regenerate (required)

#### `/generateallmusic [force]`
Admin command to generate and cache all music variations.

**Parameters:**
- `force`: Force regeneration even if files exist (optional)

### Ambient Sound Commands

#### `/playambience [type] [volume]`
Plays ambient sound effects.

**Parameters:**
- `type`: The type of ambient sound (required)
  - forest
  - cave
  - tavern
  - ocean
  - city
  - dungeon
  - camp
  - storm
- `volume`: Volume level from 0.1 to 1.0 (optional, defaults to 0.3)

#### `/stopambience`
Stops currently playing ambient sounds.

## Voice Session Management

### Session Lifecycle
1. **Initialization**
   - User joins voice channel
   - Bot validates permissions
   - Creates voice connection
   - Initializes audio pipeline

2. **Active Session**
   - Processes voice input
   - Manages audio streams
   - Handles transcription
   - Monitors voice activity
   - Manages session timeouts

3. **Termination**
   - User leaves channel
   - Session timeout
   - Manual stop command
   - Error conditions
   - Resource cleanup

### Rate Limiting
- Speech-to-text: 100 requests per minute
- Text-to-speech: 50 requests per minute
- Music generation: 10 requests per hour

### Error Handling
- Connection drops with automatic reconnection attempts
- API failures with graceful degradation
- Permission issues with user feedback
- Resource constraints with cleanup
- Session timeouts with automatic cleanup

## Best Practices

### Voice Channel Usage
- One active voice session per channel
- Clear audio input with proper volume levels
- Regular session cleanup
- Proper permission management

### Command Usage
- Verify permissions before commands
- Handle long text appropriately
- Manage resource usage
- Monitor rate limits
- Clean up resources after use

### Performance Optimization
- Buffer management for audio streams
- Stream cleanup after usage
- Memory monitoring and garbage collection
- Connection pooling and reuse
- Session timeout monitoring

## Troubleshooting

### Common Issues
1. **Voice Recognition Problems**
   - Check microphone settings
   - Verify voice channel permissions
   - Test connection quality
   - Check voice activity thresholds

2. **TTS Issues**
   - Validate Azure API access
   - Check rate limits
   - Verify audio output permissions
   - Monitor connection status

3. **Session Errors**
   - Review connection status
   - Check thread management permissions
   - Verify resource availability
   - Monitor session timeouts

## Security Considerations

### Authentication
- Role-based access control
- Channel permissions verification
- Command restrictions
- Admin-only commands protection

### Data Privacy
- Voice data handling with proper cleanup
- Transcription storage in private threads
- Session information cleanup
- Temporary file management

### Resource Protection
- Rate limiting enforcement
- Resource quotas monitoring
- Access controls verification
- Permission checks at multiple levels 