# Azure Setup Guide

## Overview
Goobster requires Azure services for storing conversations, prompts, user data, and voice capabilities. This guide walks through setting up the required Azure resources.

## Prerequisites
- An Azure account ([Create one here](https://azure.microsoft.com/free/))
- Azure CLI installed (optional, for command line setup)
- Access to Azure Portal

## Initial Setup

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

## Voice Service Setup

### 1. Create Speech Service
1. Go to Azure Portal
2. Click "Create a resource"
3. Search for "Speech Service"
4. Click "Create"
5. Fill in:
   - Subscription: Your subscription
   - Resource group: Use existing or create new
   - Region: Choose nearest region
   - Name: (e.g., "goobster-speech")
   - Pricing tier: Standard S0 (recommended for production)

### 2. Configure Speech Service
1. Get credentials:
   - Go to "Keys and Endpoint"
   - Copy "Key 1" and "Region"
   - Add to config.json:
     ```json
     {
       "azure": {
         "speech": {
           "key": "your_speech_key",
           "region": "your_region",
           "language": "en-US"
         }
       }
     }
     ```

2. Voice Configuration:
   - Default voice: en-US-JennyNeural
   - Available voices: [Azure Neural TTS Voices](https://learn.microsoft.com/azure/cognitive-services/speech-service/language-support)
   - Custom voice settings:
     ```json
     {
       "audio": {
         "voice": {
           "voiceThreshold": -35,
           "silenceThreshold": -45,
           "voiceReleaseThreshold": -40,
           "silenceDuration": 300
         }
       }
     }
     ```

### 3. Performance Settings
1. Recognition Configuration:
   ```javascript
   {
     recognition: {
       continuous: true,
       punctuation: true,
       profanityFilter: true,
       maxAlternatives: 1
     }
   }
   ```

2. Voice Detection:
   ```javascript
   {
     voiceDetection: {
       useHysteresis: true,
       voiceThreshold: -35,
       silenceThreshold: -45,
       voiceReleaseThreshold: -40,
       silenceDuration: 300,
       minVoiceDuration: 250
     }
   }
   ```

### 4. Usage Limits
- Free tier (F0):
  - 5 audio hours free per month for Speech-to-Text
  - 5 million characters per month for Text-to-Speech
- Standard tier (S0):
  - Pay-as-you-go pricing
  - Higher rate limits
  - SLA guarantees

### 5. Resource Management
1. **Monitoring**:
   - Enable Azure Monitor
   - Set up alerts for:
     - High latency (>500ms)
     - Error rate spikes
     - Recognition failures
     - Resource usage

2. **Scaling**:
   - Start with S0 tier
   - Monitor usage patterns
   - Scale up based on:
     - Concurrent users
     - Recognition accuracy
     - Response times

3. **Cost Management**:
   - Monitor usage metrics
   - Set up budgets
   - Configure alerts
   - Optimize resource usage

## Database Setup

### 1. Create SQL Server
1. Go to "SQL servers"
2. Click "Create"
3. Fill in:
   - Server name: (e.g., "goobster-sql-server")
   - Location: Same as resource group
   - Authentication method: "Use SQL authentication"
   - Server admin login: Create admin username
   - Password: Create strong password

### 2. Configure Firewall Rules
1. Go to your new SQL server
2. Click "Networking" in left menu
3. Under "Firewall rules":
   - Add your client IP
   - Configure Azure services access
   - Set up private endpoints

### 3. Create Database
1. Go to "SQL databases"
2. Click "Create"
3. Configure:
   - Database name: (e.g., "goobster-db")
   - Server: Select your server
   - Want to use SQL elastic pool: No
   - Compute + storage: Configure as needed
   - Backup retention

### 4. Database Initialization
1. Get Connection Information:
   - Server name
   - Database name
   - Admin username
   - Admin password

2. Initialize Schema:
   ```bash
   npm run db-init
   ```

### 5. Security Configuration
1. **Authentication**:
   - Enable Azure AD
   - Configure connection security
   - Set up managed identity
   - Use minimum required permissions

2. **Data Protection**:
   - Enable Azure Defender for SQL
   - Configure auditing
   - Enable transparent data encryption
   - Regular security assessments

## Error Handling

### 1. Speech Service Errors
```javascript
try {
    await recognizer.startContinuousRecognitionAsync();
} catch (error) {
    if (error.name === 'RecognitionError') {
        // Handle recognition-specific errors
    } else if (error.name === 'ConnectionError') {
        // Handle connection issues
    }
}
```

### 2. Common Issues
1. **Connection Failures**:
   - Check network connectivity
   - Verify credentials
   - Check service status
   - Monitor connection state

2. **Recognition Issues**:
   - Check audio format
   - Verify language settings
   - Monitor recognition quality
   - Adjust voice detection settings

3. **Resource Limits**:
   - Monitor quota usage
   - Handle rate limiting
   - Implement backoff strategies
   - Scale resources as needed

4. **Audio Processing Issues**:
   - Check audio format compatibility
   - Verify Opus decoder configuration
   - Monitor system resources
   - Check for codec issues

## Monitoring Setup

### 1. Azure Monitor
1. Enable diagnostic settings
2. Configure log analytics
3. Set up custom dashboards
4. Create alert rules

### 2. Key Metrics
- Recognition accuracy
- Response latency
- Error rates
- Resource utilization
- DTU/vCore usage
- Storage usage

### 3. Logging
1. **Application Insights**:
   - Track custom events
   - Monitor dependencies
   - Trace requests
   - Analyze performance

2. **Custom Logging**:
   ```javascript
   console.log('Recognition event:', {
       type: event.type,
       duration: event.duration,
       timestamp: new Date().toISOString()
   });
   ```

## Best Practices

### 1. Resource Management
- Implement proper cleanup
- Handle connection lifecycle
- Monitor resource usage
- Implement rate limiting
- Use connection pooling

### 2. Error Handling
- Implement retry logic
- Handle specific errors
- Log error details
- Provide user feedback
- Implement graceful degradation

### 3. Performance
- Optimize audio settings
- Monitor latency
- Handle backpressure
- Scale resources appropriately
- Enable auto-pause for dev/test

### 4. Security
- Secure credentials
- Implement authentication
- Monitor access
- Regular audits
- Use private endpoints

## Deployment Checklist

1. **Pre-deployment**:
   - Verify credentials
   - Test connections
   - Check configurations
   - Validate settings
   - Review security settings

2. **Deployment**:
   - Update credentials
   - Deploy resources
   - Verify connectivity
   - Test functionality
   - Enable monitoring

3. **Post-deployment**:
   - Monitor performance
   - Check logs
   - Verify security
   - Test recovery procedures
   - Set up alerts

## Support Resources
- [Azure SQL Documentation](https://docs.microsoft.com/azure/azure-sql/)
- [Azure Speech Service Documentation](https://docs.microsoft.com/azure/cognitive-services/speech-service/)
- [Azure Portal](https://portal.azure.com)
- [Azure Support](https://azure.microsoft.com/support/options/) 