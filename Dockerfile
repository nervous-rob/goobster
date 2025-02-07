# Dockerfile
#
# This file contains the instructions to build a Docker image for your application.
# It specifies the base image, installs dependencies, and sets up the environment.
#
# Usage:
#   docker build -t myapp .
#   docker run -p 8080:8080 myapp
#
# Author: Rob Browning
# Version: 1.0

FROM node:18

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    build-essential \
    libtool-bin \
    autoconf \
    automake \
    ffmpeg \
    curl \
    jq \
    gettext-base \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Create necessary directories
RUN mkdir -p data/music/ data/ambience/ data/images/

# Copy package files
COPY package*.json ./
COPY frontend/package*.json ./frontend/

# Install dependencies with build flags for native modules
RUN npm install --build-from-source
RUN cd frontend && npm install

# Copy source code and data files
COPY . .
COPY data/music/*.mp3 data/music/

# Create config.json from environment variables
RUN echo '{\n\
    "clientId": "'$DISCORD_CLIENT_ID'",\n\
    "guildIds": '$DISCORD_GUILD_IDS',\n\
    "token": "'$DISCORD_BOT_TOKEN'",\n\
    "openaiKey": "'$OPENAI_API_KEY'",\n\
    "azure": {\n\
        "speech": {\n\
            "key": "'$AZURE_SPEECH_KEY'",\n\
            "region": "'$AZURE_REGION'",\n\
            "language": "en-US"\n\
        },\n\
        "sql": {\n\
            "user": "'$AZURE_SQL_USER'",\n\
            "password": "'$AZURE_SQL_PASSWORD'",\n\
            "database": "'$AZURE_SQL_DATABASE'",\n\
            "server": "'$AZURE_SQL_SERVER'",\n\
            "options": {\n\
                "encrypt": true,\n\
                "trustServerCertificate": false\n\
            }\n\
        }\n\
    },\n\
    "replicate": {\n\
        "apiKey": "'$REPLICATE_API_KEY'"\n\
    },\n\
    "perplexity": {\n\
        "apiKey": "'$PERPLEXITY_API_KEY'"\n\
    },\n\
    "DEFAULT_PROMPT": "You are Goobster, a quirky and clever Discord bot with a passion for helping users and a dash of playful sass. You love making witty observations and dropping the occasional pun, but you always stay focused on being genuinely helpful.\n\nKey Traits:\n- Friendly and approachable, but not afraid to show personality\n- Loves making clever wordplay and references when appropriate\n- Takes pride in being accurate and helpful\n- Excited about learning new things alongside users\n\nYou have access to real-time web search capabilities through the /search command. When users ask for current information or facts you are not certain about, you should:\n\n1. Acknowledge their request with enthusiasm\n2. Use the /search command by replying with a message in this EXACT format (including quotes):\n   \"/search query:\"your search query here\" reason:\"why you need this information\"\"\n\nExample responses:\n\nWhen needing current info:\n\"Let me check the latest data on that! /search query:\"current cryptocurrency market trends March 2024\" reason:\"User asked about crypto prices, and even a bot as clever as me needs up-to-date numbers to give accurate advice!\"\"\n\nWhen verifying facts:\n\"I want to make sure I give you the most accurate info! /search query:\"latest Mars rover discoveries 2024\" reason:\"Need to verify recent Mars exploration data\"\"\n\nRemember:\n- Be enthusiastic but professional\n- Make search queries specific and focused\n- Use appropriate emojis and formatting to make responses engaging\n- Stay helpful and informative while maintaining your quirky personality"\n\
}' > config.json

# Build backend and frontend
RUN npm run build:backend
RUN cd frontend && npm run build

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Expose port
EXPOSE 3000

# Start the application with proper environment variable handling
CMD ["sh", "-c", "echo 'Starting Goobster...' && node deploy-commands.js && node index.js"]
