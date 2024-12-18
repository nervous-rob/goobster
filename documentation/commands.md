# Goobster Bot Commands Documentation

This document provides detailed information about all available commands in the Goobster Discord bot.

## Chat Commands

### `/addmessage`
- **Description**: Adds a message to the current conversation and gets an AI-generated response
- **Options**:
  - `text` (required): The message text to add to the conversation
- **Usage**: `/addmessage text:Hello, how are you?`

### `/createconversation`
- **Description**: Creates a new conversation with a specified prompt
- **Options**:
  - `promptlabel` (optional): Label of an existing prompt to use
  - `promptid` (optional): ID of an existing prompt to use
- **Note**: Either promptlabel or promptid must be provided
- **Usage**: `/createconversation promptlabel:casual_chat`

### `/createprompt`
- **Description**: Creates a new prompt for future conversations
- **Options**:
  - `text` (required): The prompt text
  - `label` (optional): A label to identify the prompt
- **Usage**: `/createprompt text:You are a helpful assistant label:helper`

### `/joke`
- **Description**: Generates a one-sentence joke using AI
- **Options**:
  - `category` (optional): The category/type of joke
- **Usage**: `/joke category:dad`

### `/poem`
- **Description**: Generates a poem using AI
- **Options**:
  - `topic` (optional): The topic for the poem
- **Usage**: `/poem topic:nature`

### `/viewconversations`
- **Description**: Shows summaries of all your conversations
- **Usage**: `/viewconversations`

### `/viewprompts`
- **Description**: Lists all your saved prompts
- **Usage**: `/viewprompts`

## Utility Commands

### `/createuser`
- **Description**: Creates a new user profile in the database
- **Usage**: `/createuser`

### `/ping`
- **Description**: Tests bot responsiveness and database connectivity
- **Usage**: `/ping`

### `/resetchatdata`
- **Description**: Deletes all your prompts, conversations, and messages
- **Warning**: This action cannot be undone
- **Usage**: `/resetchatdata`

### `/server`
- **Description**: Displays information about the current Discord server
- **Usage**: `/server`

### `/user`
- **Description**: Shows information about your Discord account
- **Usage**: `/user`

## Command Flow Examples

### Starting a New Conversation
1. Create a prompt: `/createprompt text:"You are a helpful assistant" label:helper`
2. Create a conversation: `/createconversation promptlabel:helper`
3. Start chatting: `/addmessage text:"Hello, how can you help me today?"`

### Using Fun Features
- Get a quick laugh: `/joke category:programming`
- Get some poetry: `/poem topic:computers`

### Managing Your Data
- View your conversations: `/viewconversations`
- View your prompts: `/viewprompts`
- Reset all data: `/resetchatdata`
