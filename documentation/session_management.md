# Session Management Documentation

## Overview
Goobster implements a robust session management system for handling voice interactions, rate limiting, and resource management. The system ensures proper cleanup and prevents resource leaks.

## Components

### 1. Session Manager (`sessionManager.js`)
- Manages voice session lifecycle
- Handles resource cleanup
- Implements timeout monitoring
- Features:
  ```javascript
  {
    CLEANUP_DELAY: 5000,      // 5 seconds
    MONITOR_INTERVAL: 30000,  // 30 seconds
    SESSION_TIMEOUT: 300000   // 5 minutes
  }
  ```

### 2. Rate Limiter (`rateLimit.js`)
- Tracks voice usage
- Manages time windows
- Handles concurrent sessions
- Settings:
  ```javascript
  {
    voice: {
      maxDuration: 7200000,     // 2 hours
      resetTime: 3600000,       // 1 hour
      cleanupThreshold: 10800000 // 3 hours
    }
  }
  ```

## Session Lifecycle

### 1. Creation
```javascript
sessionManager.addSession(userId, {
    connection,
    audioPipeline,
    channelId,
    guildId,
    messageCallback,
    textChannel,
    audioConfig
});
```

### 2. Monitoring
```javascript
// Activity tracking
session.lastActivity = Date.now();
sessionManager.updateSessionActivity(userId);

// Timeout monitoring
if (now - session.lastActivity > timeout) {
    emit('sessionTimeout', { userId });
}
```

### 3. Cleanup
```javascript
async function cleanupSession(userId, services) {
    // Stop recognition
    await services.recognition?.stopRecognition(userId);
    
    // Clean up audio
    await session.audioPipeline?.destroy();
    
    // Clean up connection
    session.connection?.destroy();
    
    // Remove session
    sessions.delete(userId);
}
```

## Rate Limiting

### 1. Voice Usage Tracking
```javascript
async function trackVoiceUsage(userId, duration) {
    const userLimit = voiceLimits.get(userId);
    userLimit.usage += duration;
    userLimit.usage = Math.min(userLimit.usage, maxDuration);
}
```

### 2. Time Window Management
```javascript
const now = Date.now();
if (now - userLimit.lastReset >= resetTime) {
    userLimit.usage = 0;
    userLimit.lastReset = now;
}
```

## Resource Management

### 1. Audio Resources
- Audio pipeline cleanup
- Stream management
- Buffer cleanup
- Connection handling

### 2. Voice Resources
- Recognition cleanup
- TTS cleanup
- Channel cleanup
- Event listener cleanup

### 3. Memory Management
- Session cache cleanup
- Rate limit cleanup
- Resource monitoring
- Memory usage tracking

## Error Handling

### 1. Session Errors
```javascript
try {
    await cleanupSession(userId);
} catch (error) {
    console.error('Session cleanup error:', error);
    // Force cleanup
    sessions.delete(userId);
    emit('cleanupError', { userId, error });
}
```

### 2. Recovery Strategies
- Automatic retry
- Forced cleanup
- Resource reset
- Error notification

## Performance

### 1. Optimization
- Efficient cleanup
- Resource pooling
- Cache management
- Memory optimization

### 2. Monitoring
- Session duration
- Resource usage
- Cleanup timing
- Error rates

## Security

### 1. Access Control
- Session validation
- User authentication
- Resource limits
- Rate limiting

### 2. Resource Protection
- Timeout enforcement
- Concurrent limits
- Usage tracking
- Error prevention

## Best Practices

### 1. Session Management
- Proper initialization
- Regular monitoring
- Timely cleanup
- Error handling

### 2. Resource Handling
- Efficient allocation
- Proper cleanup
- Memory management
- Error recovery

### 3. Rate Limiting
- Fair usage policies
- Clear feedback
- Proper tracking
- Error handling

## Testing

### 1. Unit Tests
- Session lifecycle
- Rate limiting
- Resource cleanup
- Error handling

### 2. Integration Tests
- Full session flow
- Resource management
- Concurrent sessions
- Error scenarios

## Deployment

### 1. Configuration
- Timeout settings
- Rate limits
- Cleanup delays
- Monitor intervals

### 2. Monitoring
- Session tracking
- Resource usage
- Error logging
- Performance metrics

## Future Improvements

### 1. Features
- Enhanced monitoring
- Better rate limiting
- Resource optimization
- Error prevention

### 2. Performance
- Faster cleanup
- Better resource usage
- Improved monitoring
- Enhanced recovery

### 3. User Experience
- Better feedback
- Clear limits
- Status updates
- Error messages
``` 