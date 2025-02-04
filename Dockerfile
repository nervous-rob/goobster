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
RUN echo '#!/bin/sh' > create-config.sh && \
    echo 'cat > config.json << EOL' >> create-config.sh && \
    echo '{' >> create-config.sh && \
    echo '  "clientId": '"\"$DISCORD_CLIENT_ID\"," >> create-config.sh && \
    echo '  "guildIds": '"$DISCORD_GUILD_IDS," >> create-config.sh && \
    echo '  "token": '"\"$DISCORD_BOT_TOKEN\"," >> create-config.sh && \
    echo '  "openaiKey": '"\"$OPENAI_API_KEY\"," >> create-config.sh && \
    echo '  "azure": {' >> create-config.sh && \
    echo '    "speech": {' >> create-config.sh && \
    echo '      "key": '"\"$AZURE_SPEECH_KEY\"," >> create-config.sh && \
    echo '      "region": "eastus",' >> create-config.sh && \
    echo '      "language": "en-US"' >> create-config.sh && \
    echo '    },' >> create-config.sh && \
    echo '    "sql": {' >> create-config.sh && \
    echo '      "user": '"\"$AZURE_SQL_USER\"," >> create-config.sh && \
    echo '      "password": '"\"$AZURE_SQL_PASSWORD\"," >> create-config.sh && \
    echo '      "database": '"\"$AZURE_SQL_DATABASE\"," >> create-config.sh && \
    echo '      "server": '"\"$AZURE_SQL_SERVER\"," >> create-config.sh && \
    echo '      "options": {' >> create-config.sh && \
    echo '        "encrypt": true,' >> create-config.sh && \
    echo '        "trustServerCertificate": false' >> create-config.sh && \
    echo '      }' >> create-config.sh && \
    echo '    }' >> create-config.sh && \
    echo '  },' >> create-config.sh && \
    echo '  "replicate": {' >> create-config.sh && \
    echo '    "apiKey": '"\"$REPLICATE_API_KEY\"" >> create-config.sh && \
    echo '  },' >> create-config.sh && \
    echo '  "perplexity": {' >> create-config.sh && \
    echo '    "apiKey": '"\"$PERPLEXITY_API_KEY\"" >> create-config.sh && \
    echo '  }' >> create-config.sh && \
    echo '}' >> create-config.sh && \
    echo 'EOL' >> create-config.sh && \
    chmod +x create-config.sh && \
    ./create-config.sh && \
    rm create-config.sh

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
