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
RUN printf '{\n\
  "clientId": %s,\n\
  "guildIds": %s,\n\
  "token": %s,\n\
  "openaiKey": %s,\n\
  "azure": {\n\
    "speech": {\n\
      "key": %s,\n\
      "region": "%s",\n\
      "language": "en-US"\n\
    },\n\
    "sql": {\n\
      "user": %s,\n\
      "password": %s,\n\
      "database": %s,\n\
      "server": %s,\n\
      "options": {\n\
        "encrypt": true,\n\
        "trustServerCertificate": false\n\
      }\n\
    }\n\
  },\n\
  "replicate": {\n\
    "apiKey": %s\n\
  },\n\
  "perplexity": {\n\
    "apiKey": %s\n\
  }\n\
}' "$DISCORD_CLIENT_ID" "$DISCORD_GUILD_IDS" "$DISCORD_BOT_TOKEN" "$OPENAI_API_KEY" \
   "$AZURE_SPEECH_KEY" "$AZURE_REGION" "$AZURE_SQL_USER" "$AZURE_SQL_PASSWORD" \
   "$AZURE_SQL_DATABASE" "$AZURE_SQL_SERVER" "$REPLICATE_API_KEY" "$PERPLEXITY_API_KEY" \
   | jq '.' > config.json

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
