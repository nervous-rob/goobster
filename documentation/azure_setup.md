# Azure Setup Guide

## Overview
Goobster requires Azure services for storing conversations, prompts, user data, and voice capabilities. This guide walks through setting up the required Azure resources.

## Prerequisites
- An Azure account ([Create one here](https://azure.microsoft.com/free/))
- Azure CLI installed (optional, for command line setup)
- Access to Azure Portal

## Step-by-Step Setup

### 1. Create Resource Group
1. Go to [Azure Portal](https://portal.azure.com)
2. Click "Resource groups"
3. Click "Create"
4. Fill in:
   - Subscription: Your subscription
   - Resource group: (e.g., "goobster-resources")
   - Region: Choose nearest region
5. Click "Review + create"
6. Click "Create"

### 2. Create SQL Server
1. Go to "SQL servers" in Azure Portal
2. Click "Create"
3. Select your resource group
4. Fill in:
   - Server name: (e.g., "goobster-sql-server")
   - Location: Same as resource group
   - Authentication method: "Use SQL authentication"
   - Server admin login: Create admin username
   - Password: Create strong password
5. Click "Review + create"
6. Click "Create"

### 3. Configure Firewall Rules
1. Go to your new SQL server
2. Click "Networking" in left menu
3. Under "Firewall rules":
   - Add your client IP
   - Optionally allow Azure services
4. Click "Save"

### 4. Create Database
1. Go to "SQL databases"
2. Click "Create"
3. Select your resource group
4. Fill in:
   - Database name: (e.g., "goobster-db")
   - Server: Select your server
   - Want to use SQL elastic pool: No
   - Compute + storage: Configure as needed
5. Click "Review + create"
6. Click "Create"

### 5. Get Connection Information
1. Go to your database
2. Click "Connection strings"
3. Note down:
   - Server name
   - Database name
   - Admin username
   - Admin password

## Database Initialization

### 1. Connect to Database
Use Azure Data Studio or SQL Server Management Studio:
1. Install preferred tool
2. Connect using:
   - Server: your-server.database.windows.net
   - Authentication: SQL Login
   - Username: your-admin-username
   - Password: your-admin-password
   - Database: your-database-name

### 2. Initialize Schema
1. Run the initialization script:
   ```bash
   npm run db-init
   ```
   Or manually run the SQL from `initDb.js`

## Configuration Values
For your `config.json`, you'll need:
```json
{
    "azureSql": {
        "user": "your-admin-username",
        "password": "your-admin-password",
        "database": "your-database-name",
        "server": "your-server.database.windows.net",
        "options": {
            "encrypt": true,
            "trustServerCertificate": false
        }
    }
}
```

## Cost Management
1. **Monitor Usage**
   - Set up cost alerts
   - Monitor DTU/vCore usage
   - Check storage usage

2. **Optimization Tips**
   - Use appropriate service tier
   - Scale down when not needed
   - Enable auto-pause for dev/test

## Security Best Practices

### 1. Access Control
- Use Azure AD authentication when possible
- Implement least-privilege access
- Regularly rotate credentials
- Use managed identities

### 2. Data Protection
- Enable Azure Defender for SQL
- Configure auditing
- Enable transparent data encryption
- Regular security assessments

### 3. Network Security
- Use private endpoints
- Restrict firewall rules
- Enable Advanced Threat Protection

## Troubleshooting

### Common Issues
1. **Connection Failed**
   - Check firewall rules
   - Verify credentials
   - Test network connectivity

2. **Performance Issues**
   - Monitor DTU/vCore usage
   - Check query performance
   - Review index strategy

3. **Security Alerts**
   - Review audit logs
   - Check threat detection
   - Verify access patterns

### Support Resources
- [Azure SQL Documentation](https://docs.microsoft.com/azure/azure-sql/)
- [Azure Portal](https://portal.azure.com)
- [Azure Support](https://azure.microsoft.com/support/options/)

## Azure Speech Service Setup

1. Create a Speech Service:
   - Go to Azure Portal
   - Click "Create a resource"
   - Search for "Speech Service"
   - Click "Create"
   - Fill in the required details:
     - Subscription: Your subscription
     - Resource group: Use existing or create new
     - Region: Choose a region close to your users
     - Name: Unique name for your service
     - Pricing tier: Free tier (F0) for testing, Standard (S0) for production

2. Get Credentials:
   - After creation, go to the Speech Service resource
   - Click on "Keys and Endpoint"
   - Copy "Key 1" and the "Region"
   - Add these to your .env file:
     ```
     AZURE_SPEECH_KEY=your_speech_service_key
     AZURE_SPEECH_REGION=your_speech_service_region
     ```

3. Voice Configuration:
   - Default voice: en-US-JennyNeural
   - You can change the voice in services/voice/ttsService.js
   - Available voices: https://learn.microsoft.com/en-us/azure/cognitive-services/speech-service/language-support

4. Usage Limits:
   - Free tier (F0):
     - 5 audio hours free per month for Speech-to-Text
     - 5 million characters per month for Text-to-Speech
   - Standard tier (S0):
     - Pay-as-you-go pricing
     - Higher rate limits
     - SLA guarantees

5. Best Practices:
   - Monitor usage to avoid exceeding limits
   - Implement rate limiting in your application
   - Use connection pooling
   - Handle service errors gracefully

## Voice Service Troubleshooting

### Common Issues

1. **No Audio Input/Output**
   - Check microphone permissions in Discord
   - Verify bot has "Voice" permissions in the channel
   - Ensure proper voice connection state
   - Check Azure Speech Service quota and limits

2. **Poor Voice Recognition**
   - Check microphone quality and background noise
   - Verify Azure region matches user location
   - Consider using a different neural voice model
   - Check network latency and connection quality

3. **Rate Limiting**
   - Monitor usage in Azure Portal
   - Check rate limit logs in bot
   - Consider upgrading service tier
   - Implement client-side throttling

4. **Connection Issues**
   - Verify network connectivity
   - Check Discord voice server status
   - Ensure proper WebSocket configuration
   - Monitor Azure service health

### Error Messages

1. **Azure Speech Service Errors**
   ```
   CANCELED: ErrorCode=ConnectionFailure
   ```
   - Check Azure credentials
   - Verify service region
   - Check network connectivity
   - Monitor service status

2. **Discord Voice Errors**
   ```
   Error: Connection not established within 15 seconds
   ```
   - Check bot permissions
   - Verify voice channel access
   - Check Discord gateway status
   - Monitor voice connection state

3. **Audio Processing Errors**
   ```
   Error: Failed to process audio stream
   ```
   - Check audio format compatibility
   - Verify Opus decoder configuration
   - Monitor system resources
   - Check for codec issues

### Performance Optimization

1. **Voice Recognition**
   - Use appropriate silence detection settings
   - Implement proper stream cleanup
   - Monitor memory usage
   - Optimize audio processing

2. **Voice Synthesis**
   - Cache frequently used responses
   - Use appropriate audio quality settings
   - Implement response queuing
   - Monitor latency metrics

3. **Resource Management**
   - Implement proper connection pooling
   - Clean up unused resources
   - Monitor memory leaks
   - Use appropriate timeouts

### Monitoring and Logging

1. **Azure Metrics**
   - Monitor service usage
   - Track error rates
   - Monitor latency
   - Set up alerts

2. **Bot Metrics**
   - Track voice session duration
   - Monitor recognition accuracy
   - Track user engagement
   - Log error patterns

3. **Performance Metrics**
   - Monitor CPU usage
   - Track memory consumption
   - Monitor network usage
   - Track response times

### Best Practices

1. **Error Handling**
   - Implement graceful degradation
   - Provide clear error messages
   - Log detailed error information
   - Implement retry logic

2. **Resource Cleanup**
   - Properly close connections
   - Clean up audio streams
   - Release system resources
   - Handle process termination

3. **User Experience**
   - Provide clear feedback
   - Handle interruptions gracefully
   - Implement proper timeouts
   - Maintain conversation context 