# Discord Developer Portal Setup Guide

## Overview
Before running Goobster, you need to create and configure a Discord application and bot. This guide walks through the necessary steps in the Discord Developer Portal.

## Step-by-Step Setup

### 1. Create New Application
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" button
3. Enter a name for your application (e.g., "Goobster")
4. Accept the Developer Terms of Service and Developer Policy
5. Click "Create"

### 2. Get Application ID (Client ID)
1. In your application's General Information page
2. Find "APPLICATION ID" (This is your `clientId` for config.json)
3. Click "Copy" to copy the ID

### 3. Create Bot User
1. Click "Bot" in the left sidebar
2. Click "Add Bot"
3. Confirm by clicking "Yes, do it!"
4. Under the bot's username, find "TOKEN"
5. Click "Reset Token" and "Yes, do it!"
6. Copy the token (This is your `token` for config.json)
   - ⚠️ **IMPORTANT**: This token is shown only once
   - Store it securely
   - Never share it or commit it to version control

### 4. Configure Bot Permissions
1. Still in the "Bot" section
2. Under "Privileged Gateway Intents", enable:
   - Presence Intent
   - Server Members Intent
   - Message Content Intent
3. Under "Bot Permissions", select:
   - Read Messages/View Channels
   - Send Messages
   - Use Slash Commands
   - Add Reactions
   - Attach Files
   - Read Message History
   - Mention Everyone
   - Use External Emojis
   - Use External Stickers
   - Add Reactions

### 5. Get Server ID (Guild ID)
1. Open Discord
2. Enable Developer Mode:
   - Go to User Settings
   - Click "App Settings"
   - Click "Advanced"
   - Turn on "Developer Mode"
3. Right-click your server name
4. Click "Copy ID" (This is your `guildId` for config.json)

### 6. Invite Bot to Server
1. In Developer Portal, click "OAuth2" in left sidebar
2. Click "URL Generator"
3. Select scopes:
   - `bot`
   - `applications.commands`
4. Select the same bot permissions as step 4
5. Copy the generated URL
6. Open URL in browser
7. Select your server
8. Click "Authorize"
9. Complete the CAPTCHA

## Final Checklist
You should now have:
- [ ] Application/Client ID
- [ ] Bot Token
- [ ] Server/Guild ID
- [ ] Bot added to your server
- [ ] Required permissions configured

## Troubleshooting

### Common Issues
1. **Bot Not Responding**
   - Verify token is correct
   - Check permissions
   - Ensure intents are enabled

2. **Commands Not Working**
   - Verify slash commands are registered
   - Check bot has applications.commands scope
   - Ensure bot has required permissions

3. **Permission Issues**
   - Verify bot role hierarchy
   - Check server permissions
   - Review channel-specific permissions

### Support Resources
- [Discord Developer Documentation](https://discord.com/developers/docs)
- [Discord.js Guide](https://discordjs.guide/)
- [Discord Developers Server](https://discord.gg/discord-developers) 