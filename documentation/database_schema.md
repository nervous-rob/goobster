# Database Schema Documentation

## Overview
The database schema is designed to support conversation management, user data, and prompt storage. It uses Azure SQL Database with proper relationships and constraints.

## Tables

### users
Stores user information and their active conversation state.
```sql
CREATE TABLE users (
    id INT PRIMARY KEY IDENTITY(1,1),
    username NVARCHAR(50) NOT NULL,
    joinedAt DATETIME NOT NULL DEFAULT GETDATE(),
    activeConversationId INT
)
```
- `id`: Unique identifier for each user
- `username`: Discord username
- `joinedAt`: Timestamp of when the user was created
- `activeConversationId`: Reference to the current active conversation

### prompts
Stores conversation prompts that guide AI responses.
```sql
CREATE TABLE prompts (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    prompt NVARCHAR(MAX) NOT NULL,
    label NVARCHAR(50),
    FOREIGN KEY (userId) REFERENCES users(id)
)
```
- `id`: Unique identifier for each prompt
- `userId`: Reference to the user who created the prompt
- `prompt`: The actual prompt text
- `label`: Optional label for easy prompt identification

### conversations
Manages ongoing conversations between users and the bot.
```sql
CREATE TABLE conversations (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    promptId INT,
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (promptId) REFERENCES prompts(id)
)
```
- `id`: Unique identifier for each conversation
- `userId`: Reference to the conversation owner
- `promptId`: Reference to the prompt used for this conversation

### messages
Stores all messages within conversations.
```sql
CREATE TABLE messages (
    id INT PRIMARY KEY IDENTITY(1,1),
    conversationId INT NOT NULL,
    message NVARCHAR(MAX) NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT GETDATE(),
    FOREIGN KEY (conversationId) REFERENCES conversations(id)
)
```
- `id`: Unique identifier for each message
- `conversationId`: Reference to the parent conversation
- `message`: The actual message content
- `createdAt`: Timestamp of when the message was created

## Relationships

1. **User to Conversations** (1:Many)
   - One user can have multiple conversations
   - Each conversation belongs to one user

2. **User to Prompts** (1:Many)
   - One user can have multiple prompts
   - Each prompt belongs to one user

3. **Conversation to Messages** (1:Many)
   - One conversation can have multiple messages
   - Each message belongs to one conversation

4. **User to Active Conversation** (1:1)
   - One user can have one active conversation
   - Active conversation is tracked in the users table

## Data Management

### Initialization
- Tables are created in a specific order to maintain referential integrity
- Foreign key constraints ensure data consistency
- Default values are set for timestamps

### Cleanup
- The `resetchatdata` command properly cascades deletions
- Active conversation references are nullified before deletion
- Messages are deleted before conversations 