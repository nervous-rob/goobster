# Configuration Setup

## Overview
Goobster requires proper configuration of Discord bot credentials, database connection details, and API keys. This document outlines the necessary setup steps.

## Configuration File

Create a `config.json` file in the root directory with the following structure:

```json
{
    "clientId": "your_discord_client_id",
    "guildId": "your_discord_server_id",
    "token": "your_discord_bot_token",
    "openaiKey": "your_openai_api_key",
    "perplexityKey": "your_perplexity_api_key",
    "replicate": {
        "apiKey": "your_replicate_api_key",
        "models": {
            "musicgen": {
                "version": "latest_version",
                "defaults": {
                    "model_version": "melody",
                    "duration": 30,
                    "temperature": 1,
                    "top_k": 250,
                    "top_p": 0
                },
                "ambient": {
                    "model_version": "large",
                    "duration": 30,
                    "temperature": 0.7,
                    "top_k": 50,
                    "top_p": 0.9
                }
            }
        }
    },
    "azure": {
        "speech": {
            "key": "your_azure_speech_key",
            "region": "your_azure_region",
            "language": "en-US"
        },
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

### Replicate Configuration
- **replicate.apiKey**: Your Replicate API key
  - Required for music generation
  - Keep this secret
- **replicate.models**: Model configurations
  - **musicgen**: Settings for music generation model
    - **version**: Model version to use
    - **defaults**: Default parameters for music generation
    - **ambient**: Parameters for ambient sound generation

### Azure Configuration
- **azure.speech**: Azure Speech Service settings
  - **key**: Your Azure Speech Service key
  - **region**: Azure region (e.g., "eastus")
  - **language**: Speech recognition language
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
   - Monitor Azure Speech Service usage

## Deployment Configuration

### Docker Setup
```dockerfile
# Environment variables in Docker
ENV CLIENT_ID=your_client_id
ENV GUILD_ID=your_guild_id
ENV BOT_TOKEN=your_bot_token
ENV OPENAI_KEY=your_openai_key
ENV PERPLEXITY_KEY=your_perplexity_key
ENV REPLICATE_API_KEY=your_replicate_key
ENV AZURE_SPEECH_KEY=your_speech_key
ENV AZURE_SPEECH_REGION=your_speech_region
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