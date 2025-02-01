# Goobster Architecture

## System Overview

Goobster is built with a modular architecture that separates concerns into distinct services and components:

```
goobster/
├── commands/                # Discord bot commands
│   ├── chat/               # Chat-related commands
│   ├── utility/            # Utility commands
│   ├── music/              # Audio playback commands
│   ├── image/              # Image generation commands
│   └── search/             # Search commands
├── services/               # Core services
│   ├── chatService/        # OpenAI integration
│   ├── perplexityService/  # Perplexity AI integration
│   ├── voice/              # Audio processing services
│   │   ├── musicService.js     # Background music management
│   │   ├── ttsService.js       # Text-to-speech service
│   │   ├── audioMixerService.js # Audio mixing and effects
│   │   ├── audioPipeline.js    # Audio processing pipeline
│   │   ├── connectionService.js # Voice connection management
│   │   ├── recognitionService.js # Speech recognition
│   │   └── sessionManager.js    # Voice session management
│   └── dbService/          # Database operations
├── utils/                  # Utility functions
│   ├── chatHandler.js      # Chat message processing
│   ├── configValidator.js  # Configuration validation
│   └── rateLimit.js       # Rate limiting
├── data/                   # Static assets
│   ├── music/             # Background music files
│   └── ambience/          # Ambient sound effects
└── tests/                 # Test suites
    ├── unit/              # Unit tests
    └── integration/       # Integration tests
```

## Core Components

### Command Handler
- Processes Discord slash commands
- Routes requests to appropriate services
- Handles command validation and permissions

### Chat Service
- Integrates with OpenAI GPT models
- Manages conversation context and history
- Handles prompt management

### Perplexity Service
- Provides intelligent web search capabilities
- Processes natural language queries
- Returns detailed or concise responses

### Audio System
- **Music Service**: Manages background music playback and transitions
- **TTS Service**: Handles text-to-speech conversion
- **Audio Mixer**: Combines multiple audio streams with fade effects
- **Audio Pipeline**: Processes and transforms audio streams
- **Recognition Service**: Handles speech-to-text conversion
- **Session Manager**: Manages voice channel sessions and state

### Database Service
- Manages persistent data storage
- Handles user profiles and preferences
- Stores conversation history

## Data Flow

1. **Command Processing**
   ```
   User Input -> Command Handler -> Appropriate Service -> Response
   ```

2. **Audio Pipeline**
   ```
   Voice Input -> Audio Pipeline -> Recognition Service -> Chat Service -> TTS Service -> Voice Output
   ```

3. **Music System**
   ```
   Music Generation -> Audio Mixer -> Voice Channel
   ```

4. **Search Flow**
   ```
   Query -> Perplexity Service -> Formatted Response
   ```

## Integration Points

### External Services
- Discord API (via discord.js)
- OpenAI API
- Perplexity AI API
- Azure Speech Services
- Azure SQL Database

### Internal Communication
- Event-driven architecture for audio transitions
- Service-to-service communication via defined interfaces
- Centralized error handling and logging

## Security Considerations

- API key management via configuration
- Input validation at command level
- Secure database connections
- Rate limiting on API calls
- Voice session authentication

## Performance Optimizations

- Audio stream buffering
- Cached responses where appropriate
- Efficient database queries
- Resource cleanup after command execution
- Voice activity detection
- Audio format conversion optimization

## Testing Strategy

1. **Unit Tests**
   - Individual service functionality
   - Command processing
   - Audio pipeline components

2. **Integration Tests**
   - Voice recognition flow
   - Music playback system
   - Search functionality
   - Database operations

3. **Performance Tests**
   - Audio processing latency
   - Voice recognition accuracy
   - Resource usage monitoring 