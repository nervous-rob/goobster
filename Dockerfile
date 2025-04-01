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

# Install build dependencies for native modules and Python
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
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
    # Add dependencies for canvas and other native modules
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Create and activate virtual environment for SpotDL
RUN python3 -m venv /opt/spotdl-venv && \
    . /opt/spotdl-venv/bin/activate && \
    pip install --upgrade pip && \
    pip install spotdl

# Add virtual environment to PATH
ENV PATH="/opt/spotdl-venv/bin:${PATH}"

# Set working directory
WORKDIR /app

# Create necessary directories with proper permissions
RUN mkdir -p data/music/ data/ambience/ data/images/ cache/music/ && \
    chmod -R 755 data/ && \
    chmod -R 755 cache/

# Copy package files
COPY package*.json ./

# Install dependencies with more robust error handling for native modules
RUN npm config set unsafe-perm true && \
    export CXXFLAGS="--std=c++14" && \
    # First try to install without canvas
    npm install --omit=optional || true && \
    # Then try to install canvas specifically with prebuild
    npm install canvas --build-from-source || true && \
    # Verify installation status
    npm ls canvas || echo "Canvas module may not be fully installed"

# Copy source code and data files
COPY . .

# Ensure data directories exist and have proper permissions
RUN mkdir -p data/music/ data/ambience/ data/images/ cache/music/ && \
    chmod -R 755 data/ && \
    chmod -R 755 cache/

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Expose port
EXPOSE 3000

# Start the application with proper environment variable handling
CMD ["sh", "-c", "echo 'Starting Goobster...' && node deploy-commands.js && node index.js"]
