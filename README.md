# Goobster

## Description

A feature-rich Discord chatbot designed using the Discord.js framework, featuring AI-powered chat, intelligent web search, dynamic audio capabilities, voice interaction, and extensive documentation.

## Table of Contents

- [Features](#features)
  - [AI & Chat](#ai--chat)
  - [Audio System](#audio-system)
  - [Voice Interaction](#voice-interaction)
  - [Adventure System](#adventure-system)
  - [Development Features](#development-features)
- [Documentation](#documentation)
- [Prerequisites](#prerequisites)
- [Dependencies](#dependencies)
- [Configuration](#configuration)
- [Installation](#installation)
  - [Docker Installation](#docker-installation)
  - [Manual Installation](#manual-installation)
- [Usage](#usage)
  - [Available Commands](#available-commands)
  - [Voice Features](#voice-features)
  - [Music and Ambience](#music-and-ambience)
- [Development](#development)
  - [Testing](#testing)
  - [Code Style](#code-style)
- [Contributing](#contributing)
- [License](#license)

## Features

### AI & Chat
- AI-powered chat using OpenAI GPT models
- Intelligent web search using Perplexity AI
- Multi-turn dialogue support with conversation memory
- Customizable chat prompts and personalities

### Audio System
- Dynamic background music system with fade transitions
- Mood-based music generation (battle, celebration, danger, dramatic, etc.)
- Ambient sound effects (forest, ocean, tavern, camp)
- Text-to-speech capabilities using Azure Speech Services
- Voice recognition and transcription
- Advanced audio mixing and processing
- Volume control and audio transitions

### Voice Interaction
- Real-time voice recognition and response
- Voice activity detection and silence detection
- Session management for voice interactions
- Rate limiting for voice usage
- Automatic reconnection handling

### Adventure System
- Interactive storytelling with real consequences
- Dynamic challenge generation
- State-based progression system
- Meaningful decision impacts

### Development Features
- Comprehensive test suite (unit, integration, voice)
- Docker deployment support
- Azure SQL database integration
- Rate limiting and resource management
- Extensive error handling and logging
- Health monitoring and diagnostics

## Documentation

Detailed documentation is available in the `/documentation` directory:
- `architecture.md` - System architecture and components
- `audio_system.md` - Audio processing and playback
- `voice_commands.md` - Voice interaction features
- `adventure_mode_guide.md` - Adventure system guide
- `configuration_guide.md` - Setup and configuration
- `testing_guide.md` - Testing procedures
- And many more...

## Prerequisites

Software required to run the Goobster chatbot:
- Node.js (v16 or higher)
- FFmpeg (for audio processing)
- Docker (optional)
- Azure Speech Services account
- Azure SQL Database (optional)

## Dependencies

```bash
npm install discord.js @discordjs/voice @discordjs/opus ffmpeg-static libsodium-wss microsoft-cognitiveservices-speech-sdk prism-media sodium-native
```

## Configuration

The Goobster chatbot requires a `config.json` file in the project directory with the following configuration settings:

```json
{
    "clientId": "<discord bot client id>",
    "guildId": "<discord server id>",
    "token": "<discord bot token>",
    "openaiKey": "<openai API key>",
    "perplexityKey": "<perplexity API key>",
    "replicateKey": "<replicate API key>",
    "azureSpeech": {
        "key": "<azure speech service key>",
        "region": "<azure speech service region>"
    },
    "azureSql": {
        "user": "your_username",
        "password": "your_password",
        "database": "your_database",
        "server": "your_server.database.windows.net",
        "options": {
            "encrypt": true,
            "trustServerCertificate": false
        }
    },
    "audio": {
        "defaultVolume": 1.0,
        "fadeInDuration": 2000,
        "fadeOutDuration": 2000,
        "backgroundMusicPath": "./data/music/",
        "ambiencePath": "./data/ambience/"
    }
}
```

Replace the placeholders with the appropriate values for your Discord bot and API keys.

## Installation

### Docker Installation

1. Make sure you have Docker installed on your machine.
2. Clone the repository:
    ```bash
    git clone https://github.com/nervous-rob/goobster.git
    ```
3. Navigate to project directory:
    ```bash
    cd goobster
    ```
4. Copy your `config.json` file to the project directory with the required configuration settings.
5. Build and run:
    ```bash
    docker build -t goobster .
    docker run -d goobster
    ```

Now you should have the Goobster chatbot up and running using Docker!

### Manual Installation

1. Clone the repository:
    ```bash
    git clone https://github.com/nervous-rob/goobster.git
    ```
2. Navigate to the project directory:
    ```bash
    cd goobster
    ```
3. Install dependencies:
    ```bash
    npm install
    ```
4. Copy your `config.json` file to the project directory with the required configuration settings.
5. Start the bot:
    ```bash
    node index.js
    ```

Now you should have the Goobster chatbot up and running!

## Usage

### Available Commands

Use `/help` in Discord to see all available commands, organized by categories:
- 💭 Chat Commands - AI conversation and prompts
- 🎮 Adventure Commands - Interactive storytelling
- 🎵 Music Commands - Background music control
- 🎤 Voice Commands - Voice interaction and TTS
- 🔍 Search Commands - Web search functionality
- 🛠️ Utility Commands - Bot configuration and help

### Voice Features

1. Join a voice channel
2. Use voice commands to:
    - Start voice recognition: `/voice start`
    - Convert text to speech: `/speak <text>`
    - Stop voice interaction: `/voice stop`

### Music and Ambience

1. Join a voice channel
2. Play background music: `/playmusic <mood>`
3. Play ambient sounds: `/playambience <type>`
4. Control playback with:
    - `/stop` - Stop all audio
    - `/regeneratemusic` - Generate new music
    - Volume control options

## Development

### Testing
```bash
# Run all tests
npm test

# Run integration tests
npm run test:integration

# Run with coverage
npm run test:coverage
```

### Code Style
```bash
# Run linter
npm run lint

# Format code
npm run format
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

MIT License - See LICENSE file for details
