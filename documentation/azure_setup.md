# Azure Setup Guide

## Overview
Goobster requires an Azure SQL Database for storing conversations, prompts, and user data. This guide walks through setting up the required Azure resources.

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