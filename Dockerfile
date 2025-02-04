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

# Handle music files (if they exist)
RUN if [ -n "$(ls -A data/music/*.mp3 2>/dev/null)" ]; then \
        echo "Copying MP3 files..."; \
    else \
        echo "No MP3 files found. Continuing..."; \
    fi

# Create config.json from environment variables
RUN echo '{\n\
    "clientId": "'${DISCORD_CLIENT_ID}'",\n\
    "guildIds": '${DISCORD_GUILD_IDS}',\n\
    "token": "'${DISCORD_BOT_TOKEN}'",\n\
    "openaiKey": "'${OPENAI_API_KEY}'",\n\
    "azure": {\n\
        "speech": {\n\
            "key": "'${AZURE_SPEECH_KEY}'",\n\
            "region": "'${AZURE_REGION}'",\n\
            "language": "en-US"\n\
        },\n\
        "sql": {\n\
            "user": "'${AZURE_SQL_USER}'",\n\
            "password": "'${AZURE_SQL_PASSWORD}'",\n\
            "database": "'${AZURE_SQL_DATABASE}'",\n\
            "server": "'${AZURE_SQL_SERVER}'",\n\
            "options": {\n\
                "encrypt": true,\n\
                "trustServerCertificate": false\n\
            }\n\
        }\n\
    },\n\
    "replicate": {\n\
        "apiKey": "'${REPLICATE_API_KEY}'"\n\
    },\n\
    "perplexity": {\n\
        "apiKey": "'${PERPLEXITY_API_KEY}'"\n\
    }\n\
}' > config.json

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
