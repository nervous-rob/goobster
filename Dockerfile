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
    python3-full \
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

# Create and activate virtual environment for Python packages
RUN python3 -m venv /opt/venv && \
    ln -s /opt/venv/bin/python3 /usr/local/bin/python3 && \
    ln -s /opt/venv/bin/pip3 /usr/local/bin/pip3 && \
    ln -s /opt/venv/bin/spotdl /usr/local/bin/spotdl && \
    ln -s /opt/venv/bin/yt-dlp /usr/local/bin/yt-dlp

# Set up environment variables for Python
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH="/opt/venv/lib/python3.11/site-packages:${PYTHONPATH}"
ENV VIRTUAL_ENV="/opt/venv"

# Install and configure Python packages and SpotDL in virtual environment
RUN pip3 install --no-cache-dir --upgrade pip && \
    pip3 install --no-cache-dir yt-dlp && \
    pip3 install --no-cache-dir spotdl && \
    spotdl --version && \
    yt-dlp --version

# Set working directory
WORKDIR /app

# Create necessary directories with proper permissions
RUN mkdir -p data/music/ data/ambience/ data/images/ cache/music/ && \
    mkdir -p /root/.cache/spotdl && \
    chmod -R 755 data/ && \
    chmod -R 755 cache/ && \
    chmod -R 777 /root/.cache

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

# Create startup script with debugging
RUN echo '#!/bin/sh\n\
echo "Starting Goobster..."\n\
echo "Python version: $(python3 --version)"\n\
echo "SpotDL version: $(spotdl --version || echo "SpotDL not found")"\n\
echo "SpotDL location: $(which spotdl || echo "SpotDL not in PATH")"\n\
echo "Current PATH: $PATH"\n\
echo "Python path: $(python3 -c "import sys; print(sys.path)")"\n\
echo "Virtual environment: $VIRTUAL_ENV"\n\
node deploy-commands.js\n\
node index.js' > /app/start.sh && \
    chmod +x /app/start.sh

# Start the application with proper environment variable handling
CMD ["/app/start.sh"]
