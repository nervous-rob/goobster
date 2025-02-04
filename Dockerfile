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
RUN jq -n \
    --arg clientId "$DISCORD_CLIENT_ID" \
    --arg guildIds "$DISCORD_GUILD_IDS" \
    --arg token "$DISCORD_BOT_TOKEN" \
    --arg openaiKey "$OPENAI_API_KEY" \
    --arg speechKey "$AZURE_SPEECH_KEY" \
    --arg region "$AZURE_REGION" \
    --arg sqlUser "$AZURE_SQL_USER" \
    --arg sqlPass "$AZURE_SQL_PASSWORD" \
    --arg sqlDb "$AZURE_SQL_DATABASE" \
    --arg sqlServer "$AZURE_SQL_SERVER" \
    --arg replicateKey "$REPLICATE_API_KEY" \
    --arg perplexityKey "$PERPLEXITY_API_KEY" \
    '{clientId:$clientId,guildIds:($guildIds|fromjson),token:$token,openaiKey:$openaiKey,azure:{speech:{key:$speechKey,region:$region,language:"en-US"},sql:{user:$sqlUser,password:$sqlPass,database:$sqlDb,server:$sqlServer,options:{encrypt:true,trustServerCertificate:false}}},replicate:{apiKey:$replicateKey},perplexity:{apiKey:$perplexityKey}}' > config.json

# Build backend and frontend
RUN npm run build:backend
RUN cd frontend && npm run build

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Expose port
EXPOSE 3000

# Start the application with proper environment variable handling
CMD ["sh", "-c", "echo 'Starting Goobster...' && node deploy-commands.js && node index.js"]
