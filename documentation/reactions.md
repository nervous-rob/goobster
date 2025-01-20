# Goobster Bot Reaction Features

This document details the reaction-based features available in Goobster's chat threads.

## Available Reactions

### 🔄 Regenerate Response
- **Description**: Generates a new response to the same message
- **Behavior**: 
  - Finds the original user message
  - Generates a new response with slightly higher creativity
  - Adds all reaction controls to the new response
- **Use Case**: When you want a different perspective or answer to your question

### 📌 Pin Message
- **Description**: Pins important messages for easy reference
- **Behavior**:
  - Pins the message to the thread
  - Adds a 📍 reaction to confirm pinning
- **Use Case**: Saving important information or key decisions

### 🌳 Branch Conversation
- **Description**: Creates a new thread to explore a topic separately
- **Behavior**:
  - Creates a new thread with a descriptive name based on the message content
  - Maintains context from the original conversation
  - Names format: `branch-[topic]-[message-id]`
- **Use Case**: When you want to explore a subtopic without derailing the main conversation

### 💡 Mark as Solution
- **Description**: Marks a message as particularly helpful
- **Behavior**:
  - Adds a ✨ reaction
  - Adds a confirmation message
- **Use Case**: Highlighting especially useful or solution-providing responses

### 🔍 Deep Dive
- **Description**: Gets a more detailed explanation of a topic
- **Behavior**:
  - Generates a comprehensive explanation
  - Includes examples and additional context
  - Allows further expansion with nested reactions
- **Use Case**: When you want more detailed information about a topic

### 📝 Summarize Thread
- **Description**: Generates a summary of the conversation
- **Behavior**:
  - Summarizes up to 100 previous messages
  - Creates bullet-point format for clarity
  - Can be pinned for reference
- **Use Case**: Getting caught up on a long conversation or capturing key points

## Reaction Removal Behavior

### 📌 Unpin Message
- When the last 📌 reaction is removed from a message:
  - Message will be automatically unpinned
  - 📍 confirmation reaction will be removed
  - No notification is sent to avoid clutter

### Other Reactions
- Removing other reactions (🔄, 🌳, 💡, 🔍, 📝) has no effect
- Previous actions (branches created, summaries generated, etc.) remain
- Use Discord's thread management for cleaning up branches

## Usage Tips

1. **Reaction Combinations**:
   - Pin a summary (📝 then 📌) to keep track of conversation progress
   - Deep dive and then branch (🔍 then 🌳) to explore complex topics
   - Mark helpful deep dives with 💡 for future reference

2. **Best Practices**:
   - Use branches for significant topic shifts
   - Pin important information promptly
   - Summarize long conversations periodically
   - Use regenerate sparingly for truly different perspectives

3. **Thread Management**:
   - Keep main threads focused
   - Use branches for detailed explorations
   - Pin summaries for easy reference
   - Mark solutions to help others find answers 