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
RUN echo '{"clientId":"${DISCORD_CLIENT_ID}","guildIds":${DISCORD_GUILD_IDS},"token":"${DISCORD_BOT_TOKEN}","openaiKey":"${OPENAI_API_KEY}","azure":{"speech":{"key":"${AZURE_SPEECH_KEY}","region":"eastus","language":"en-US"},"sql":{"user":"${AZURE_SQL_USER}","password":"${AZURE_SQL_PASSWORD}","database":"${AZURE_SQL_DATABASE}","server":"${AZURE_SQL_SERVER}","options":{"encrypt":true,"trustServerCertificate":false}}},"replicate":{"apiKey":"${REPLICATE_API_KEY}"},"perplexity":{"apiKey":"${PERPLEXITY_API_KEY}"}}' | envsubst > config.json

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
