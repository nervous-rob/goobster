# Docker Deployment Guide

## Overview
This guide outlines the Docker deployment process for Goobster, including setup, configuration, and best practices.

## Prerequisites
- Docker installed
- Docker Compose (optional)
- Access to required API keys
- Node.js environment for local testing

## Dockerfile Structure

### 1. Base Image
```dockerfile
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
    curl
```

### 2. Directory Setup
```dockerfile
# Set working directory
WORKDIR /app

# Create necessary directories
RUN mkdir -p data/music
```

### 3. Dependencies
```dockerfile
# Copy package files
COPY package*.json ./

# Install dependencies with build flags
RUN npm install --build-from-source
```

### 4. Application Files
```dockerfile
# Copy source code and data files
COPY . .
COPY data/music/*.mp3 data/music/
```

### 5. Build Steps
```dockerfile
# No build steps required for a backend-only Node.js application
# The application runs directly without a build step
```

## Environment Configuration

### 1. Environment Variables
```dockerfile
ENV CLIENT_ID=your_client_id
ENV GUILD_ID=your_guild_id
ENV BOT_TOKEN=your_bot_token
ENV OPENAI_KEY=your_openai_key
ENV PERPLEXITY_KEY=your_perplexity_key
ENV REPLICATE_API_KEY=your_replicate_key
ENV AZURE_SPEECH_KEY=your_speech_key
ENV AZURE_SPEECH_REGION=your_speech_region
```

### 2. Configuration Files
- `config.json` template
- `.env` file setup
- Volume mounts for data

## Build Process

### 1. Building the Image
```bash
# Basic build
docker build -t goobster .

# Build with specific args
docker build \
  --build-arg NODE_ENV=production \
  --build-arg BUILD_VERSION=1.0.0 \
  -t goobster:1.0.0 .
```

### 2. Using a Lightweight Base Image
```dockerfile
# Single-stage build with lightweight Node image
FROM node:18-slim

# Install only the essential dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    # Add minimal dependencies for native modules
    python3 \
    make \
    g++ \
    build-essential

WORKDIR /app
COPY . .
RUN npm install --production

# Add healthcheck and start command
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "index.js"]
```

## Running the Container

### 1. Basic Run
```bash
docker run -d \
  --name goobster \
  -p 3000:3000 \
  --env-file .env \
  goobster
```

### 2. With Volume Mounts
```bash
docker run -d \
  --name goobster \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  --env-file .env \
  goobster
```

## Health Checks

### 1. Configuration
```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1
```

### 2. Monitoring
- Container health status
- Resource usage
- Log monitoring
- Error tracking

## Resource Management

### 1. Container Resources
```bash
docker run -d \
  --name goobster \
  --memory=2g \
  --cpus=2 \
  goobster
```

### 2. Volume Management
- Data persistence
- Log rotation
- Cache management
- Backup strategies

## Security

### 1. Container Security
- Non-root user
- Minimal permissions
- Secure networking
- Resource limits

### 2. Secret Management
- Environment variables
- Docker secrets
- Volume mounts
- Key rotation

## Monitoring

### 1. Logging
```dockerfile
# Configure logging
RUN mkdir -p /var/log/goobster
VOLUME /var/log/goobster
```

### 2. Metrics
- Container stats
- Application metrics
- Resource usage
- Error rates

## Best Practices

### 1. Image Building
- Layer optimization
- Cache utilization
- Multi-stage builds
- Version tagging

### 2. Runtime
- Resource limits
- Health checks
- Logging configuration
- Error handling

### 3. Security
- Minimal base image
- Security scanning
- Regular updates
- Access control

## Troubleshooting

### 1. Common Issues
- Build failures
- Runtime errors
- Resource issues
- Network problems

### 2. Debug Tools
```bash
# Access container shell
docker exec -it goobster /bin/bash

# View logs
docker logs goobster

# Check resource usage
docker stats goobster
```

## Deployment Checklist

### 1. Pre-deployment
- Environment variables
- Configuration files
- Resource requirements
- Network setup

### 2. Deployment
- Image build
- Container start
- Health check
- Log verification

### 3. Post-deployment
- Monitor performance
- Check logs
- Verify functionality
- Resource usage

## Updates and Maintenance

### 1. Update Process
```bash
# Pull latest code
git pull

# Build new image
docker build -t goobster:new .

# Stop old container
docker stop goobster

# Start new container
docker run -d --name goobster-new goobster:new

# Verify and switch
docker rm goobster
docker rename goobster-new goobster
```

### 2. Maintenance Tasks
- Log rotation
- Data backup
- Image cleanup
- Security updates 