# Configuration Setup

## Overview
Goobster requires proper configuration of Discord bot credentials, database connection details, and API keys. This document outlines the necessary setup steps.

## Configuration File

Create a `config.json` file in the root directory with the following structure. To keep it somewhere else (an installed layout, a container volume), set `GOOBSTER_CONFIG_PATH` to the file; every part of Goobster reads it through one shared loader (`packages/core/config/configJson.js`) that honours that variable. A missing file reads as an empty configuration; a file that exists but is not valid JSON is an error (`CONFIG_INVALID_JSON`) rather than being ignored.

```json
{
    "clientId": "your_discord_client_id",
    "guildId": "your_discord_server_id",
    "token": "your_discord_bot_token",
    "openaiKey": "your_openai_api_key",
    "perplexityKey": "your_perplexity_api_key",
    "elevenlabs": {
        "apiKey": "your_elevenlabs_api_key",
        "voiceId": "21m00Tcm4TlvDq8ikWAM",
        "modelId": "eleven_flash_v2_5"
    },
    "azure": {
        "sql": {
            "user": "your_database_username",
            "password": "your_database_password",
            "database": "your_database_name",
            "server": "your_server.database.windows.net",
            "options": {
                "encrypt": true,
                "trustServerCertificate": false
            }
        }
    },
    "audio": {
        "music": {
            "volume": 0.3,
            "fadeInDuration": 2000,
            "fadeOutDuration": 2000,
            "crossfadeDuration": 3000,
            "loopFadeStart": 5000
        },
        "ambient": {
            "volume": 0.2,
            "fadeInDuration": 1000,
            "fadeOutDuration": 1000,
            "crossfadeDuration": 2000,
            "loopFadeStart": 3000
        },
        "voice": {
            "voiceThreshold": -35,
            "silenceThreshold": -45,
            "voiceReleaseThreshold": -40,
            "silenceDuration": 300
        }
    }
}
```

## Required Credentials

### Discord Configuration
- **clientId**: Your Discord application's client ID
- **guildId**: The ID of your Discord server
- **token**: Your Discord bot's token
  - Obtain from Discord Developer Portal
  - Keep this secret and never commit to version control

### OpenAI Configuration
- **openaiKey**: Your OpenAI API key
  - Get from OpenAI's platform
  - Required for AI-powered features
  - Keep this secret

### Perplexity API Configuration
- **perplexityKey**: Your Perplexity API key
  - Get from Perplexity AI platform
  - Required for enhanced search functionality
  - Keep this secret

### ElevenLabs Configuration
- **elevenlabs.apiKey**: Your ElevenLabs API key
  - Required for text-to-speech, mood music generation (Music API), and ambient sound effects
  - Keep this secret
- **elevenlabs.voiceId**: Voice ID or voice name (defaults to Rachel)
- **elevenlabs.modelId**: TTS model (defaults to `eleven_flash_v2_5`, the ~75ms realtime model). Portal accents use `eleven_v3` for that request only (Flash ignores audio tags).

### Azure Configuration
- **azure.sql**: Azure SQL Database settings
  - Standard database connection parameters
  - Use encryption for security

### Audio Configuration
- **audio.music**: Music playback settings
  - **volume**: Default music volume (0.0 to 1.0)
  - **fadeInDuration**: Duration for fade-in (ms)
  - **fadeOutDuration**: Duration for fade-out (ms)
  - **crossfadeDuration**: Duration for crossfade between tracks
  - **loopFadeStart**: When to start fade for looping
- **audio.ambient**: Ambient sound settings
  - Similar to music settings but for ambient sounds
- **audio.voice**: Voice detection settings
  - **voiceThreshold**: Voice activity detection threshold
  - **silenceThreshold**: Silence detection threshold
  - **voiceReleaseThreshold**: Voice release threshold
  - **silenceDuration**: Required silence duration (ms)

## Turning a feature off for one process: `GOOBSTER_FEATURE_<ID>`

Every optional feature has an id (see `documentation/feature_inventory.md`).
Setting `GOOBSTER_FEATURE_<ID>` to `0`, `false`, `no` or `off` (the id in upper
snake case: `GOOBSTER_FEATURE_MUSIC`, `GOOBSTER_FEATURE_SCREEN_VISION`,
`GOOBSTER_FEATURE_DISCORD_ACTIVITY`) deactivates that feature, and everything that
depends on it, in that process. It can only deactivate: any other value is ignored
with a warning, and it never installs a feature or supplies a missing key. It does not
touch `data/features.json` or `config.json`. The rules and the state file are in
`documentation/feature_state.md`. Nothing consults these variables until the gating
issues (#318 to #320) land.

## Environment Setup

1. **Development Environment**
   - Copy `config.json.example` to `config.json`
   - Fill in your credentials
   - Never commit `config.json` to version control

2. **Production Environment**
   - Use environment variables when possible
   - Ensure secure credential storage
   - Consider using Azure Key Vault

## Security Best Practices

1. **Credential Management**
   - Keep credentials out of version control
   - Use environment variables in production
   - Rotate credentials regularly

2. **Access Control**
   - Use minimum required permissions
   - Implement proper role-based access
   - Regular security audits

3. **Monitoring**
   - Log access attempts
   - Monitor API usage
   - Set up alerts for suspicious activity

## Rate Limiting

1. **Voice Features**
   - Maximum 2 hours of voice per hour per user
   - Automatic cleanup after 3 hours of inactivity
   - Session monitoring for resource management

2. **API Usage**
   - Monitor OpenAI API usage
   - Track Perplexity API requests
   - Monitor ElevenLabs character quota

## Deployment Configuration

### Docker Setup
```dockerfile
# Environment variables in Docker
ENV CLIENT_ID=your_client_id
ENV GUILD_ID=your_guild_id
ENV BOT_TOKEN=your_bot_token
ENV OPENAI_KEY=your_openai_key
ENV PERPLEXITY_KEY=your_perplexity_key
ENV ELEVENLABS_API_KEY=your_elevenlabs_key
```

### Local Development
1. Create `config.json` from template
2. Add local credentials
3. Use npm for development
```bash
npm install
npm run deploy-commands
npm start
``` 

## Changing settings with the manager

`apps/manager` can show where every setting comes from (environment, `config.json` or the database), write `config.json` safely (validated, atomic, owner-only, with a revision check), try a provider key before it is saved, and set the defaults new people inherit - all without the application database. The complete setting list is the generated `documentation/config_reference.md`; how the manager reads and changes them is `documentation/manager_configuration.md`.
