# Configuration Setup

## Overview
Goobster requires proper configuration of Discord bot credentials, database connection details, and API keys. This document outlines the necessary setup steps.

## Configuration File

Create a `config.json` file in the root directory with the following structure:

```json
{
    "clientId": "your_discord_client_id",
    "guildId": "your_discord_server_id",
    "token": "your_discord_bot_token",
    "openaiKey": "your_openai_api_key",
    "azureSql": {
        "user": "your_database_username",
        "password": "your_database_password",
        "database": "your_database_name",
        "server": "your_server.database.windows.net",
        "options": {
            "encrypt": true,
            "trustServerCertificate": false
        }
    }
}
```

## Required Credentials

### Discord Configuration
- **clientId**: Your Discord application's client ID
- **guildId**: The ID of your Discord server
- **token**: Your Discord bot's token
  - Obtain from Discord Developer Portal
  - Keep this secret and never commit to version control

### OpenAI Configuration
- **openaiKey**: Your OpenAI API key
  - Get from OpenAI's platform
  - Required for AI-powered features
  - Keep this secret

### Azure SQL Database
- **user**: Database username
- **password**: Database password
- **database**: Name of your database
- **server**: Azure SQL server address
- **options**:
  - `encrypt`: Should be true for Azure SQL
  - `trustServerCertificate`: Security setting for SSL

## Environment Setup

1. **Development Environment**
   - Copy `config.json.example` to `config.json`
   - Fill in your credentials
   - Never commit `config.json` to version control

2. **Production Environment**
   - Use environment variables when possible
   - Ensure secure credential storage
   - Consider using Azure Key Vault

## Security Best Practices

1. **Credential Management**
   - Keep credentials out of version control
   - Use environment variables in production
   - Rotate credentials regularly

2. **Access Control**
   - Use minimum required permissions
   - Implement proper role-based access
   - Regular security audits

3. **Monitoring**
   - Log access attempts
   - Monitor API usage
   - Set up alerts for suspicious activity

## Deployment Configuration

### Docker Setup
```dockerfile
# Environment variables in Docker
ENV CLIENT_ID=your_client_id
ENV GUILD_ID=your_guild_id
ENV BOT_TOKEN=your_bot_token
ENV OPENAI_KEY=your_openai_key
```

### Local Development
1. Create `config.json` from template
2. Add local credentials
3. Use npm for development
```bash
npm install
npm run deploy-commands
npm start
``` 