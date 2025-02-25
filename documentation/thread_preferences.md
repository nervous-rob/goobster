# Thread Preferences

## Overview

Goobster can respond to messages in two ways:
1. By creating and using threads for conversations
2. By responding directly in the channel where the message was sent

The Thread Preference setting allows server administrators to control this behavior server-wide.

## Thread Preference Options

There are two options for thread preferences:

1. **Always Use Threads**
   - Goobster will create a thread for each conversation
   - All responses will be sent to the thread
   - This keeps conversations organized and maintains context
   - Threads are named based on the channel they were created in

2. **Always Use Channel** (default)
   - Goobster will respond directly in the channel where the message was sent
   - No threads will be created
   - This is more direct but may lead to cluttered channels

## Managing Thread Preferences

Server administrators can manage thread preferences using the `/threadpreference` command:

### Setting Thread Preference

```
/threadpreference set [preference]
```

Where `[preference]` is one of:
- "Always use threads"
- "Always use the current channel"

### Checking Current Thread Preference

```
/threadpreference status
```

This will display the current thread preference setting for the server.

## Technical Details

- Thread preferences are stored in the `guild_settings` table
- Settings are cached for 5 minutes for performance
- The default setting is "Always use channel" if no preference has been set
- Thread preferences apply to all types of interactions (mentions, commands, etc.)
- If a message is sent in an existing thread, Goobster will always respond in that thread regardless of the preference setting
- When using "Always Use Channel" mode, a placeholder thread ID is created in the format `channel-{channelId}` to maintain database integrity

## Use Cases

### When to Use Threads

- In busy servers with many conversations
- When you want to keep conversations organized
- When you need to maintain context over long conversations
- When multiple users are chatting with Goobster simultaneously

### When to Use Channel Responses

- In smaller servers with less traffic
- When you want more immediate visibility of responses
- When you prefer a more direct interaction style
- When thread management becomes cumbersome 