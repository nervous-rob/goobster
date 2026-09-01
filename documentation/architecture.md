# Goobster Architecture

## Current layout (2026)

Goobster is an npm-workspaces monorepo. Shared code lives in `packages/core`
(services, chat pipeline, async `db/` facade, the Discord gateway seam, the
portal backend). Apps import core and never the other way around:

- `apps/bot` — Discord gateway, slash commands, voice, Activity, webhooks,
  screen/GBA, and (when `GOOBSTER_INTERNAL_TOKEN` is set) `/internal/gateway/*`.
- `apps/api` — portal backend for the split deployment. No Discord connection;
  Discord access goes through `RemoteGateway`. Requires Postgres.

Two compose profiles (see `documentation/docker_deployment.md`):

- **lite** (repo-root `docker-compose.yml`): one process, SQLite, portal
  mounted in-process on the bot.
- **full** (`deploy/docker-compose.yml`): postgres + bot + api + nginx.
  Only nginx is published.

Authoritative standards: `documentation/development_standards_and_project_goals.md`.
The reactive-port plan and phase status live in `documentation/reactive_port_spec.md`
and `documentation/reactive_port_status.md`.

## System Overview

Goobster is built with a modular architecture that separates concerns into distinct services and components:

```
goobster/
├── packages/core/           # Shared services, db, gateway, portal
├── apps/bot/                # Discord bot + lite in-process portal
│   ├── commands/            # Slash commands
│   ├── events/              # Gateway event handlers
│   └── web/                 # Health, Activity, panel, internal gateway
├── apps/api/                # Split-deployment portal backend
├── deploy/                  # full-profile compose + Dockerfiles
├── data/                    # Static assets + runtime files
└── tests/                   # Jest specs
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
- **TTS Service**: Handles text-to-speech conversion via ElevenLabs

### Database Service
- Manages persistent data storage
- Handles user profiles and preferences
- Stores conversation history

## Data Flow

1. **Command Processing**
   ```
   User Input -> Command Handler -> Appropriate Service -> Response
   ```

2. **TTS Pipeline**
   ```
   Text -> ElevenLabs API (MP3 stream) -> FFmpeg (raw PCM) -> Voice Channel
   ```

3. **Music System**
   ```
   Music Playback -> Audio Player -> Voice Channel
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
- ElevenLabs API (text-to-speech)

### Internal Communication
- Event-driven architecture for audio transitions
- Service-to-service communication via defined interfaces
- Centralized error handling and logging

## Security Considerations

- API key management via configuration
- Input validation at command level
- Secure database connections
- Rate limiting on API calls

## Performance Optimizations

- Audio stream buffering
- Cached responses where appropriate
- Efficient database queries
- Resource cleanup after command execution
- Audio format conversion optimization

## Testing Strategy

1. **Unit Tests**
   - Individual service functionality
   - Command processing
   - Audio pipeline components

2. **Integration Tests**
   - Text-to-speech flow
   - Music playback system
   - Search functionality
   - Database operations

3. **Performance Tests**
   - Audio processing latency
   - Resource usage monitoring 