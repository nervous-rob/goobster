# Goobster Bot Commands Documentation

This document provides detailed information about all available commands in the Goobster Discord bot.

## Chat Commands

### `/addmessage`
- **Description**: Adds a message to the current conversation and gets an AI-generated response
- **Options**:
  - `text` (required): The message text to add to the conversation
- **Usage**: `/addmessage text:Hello, how are you?`

### `/speak`
- **Description**: Convert text to speech (ElevenLabs) and play it in your voice channel
- **Options**:
  - `message` (required): The text to convert to speech
  - `voice` (optional): ElevenLabs voice name or ID to use for this message
- **Usage**: `/speak message:Hello everyone!`

### `/setvoice`
- **Description**: Admin: globally set the ElevenLabs voice used for TTS
- **Options**:
  - `voice_id` (required): ElevenLabs voice name or ID
- **Usage**: `/setvoice voice_id:Rachel`

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

### `/recall`
- **Description**: Ask the server's long-term memory anything. Retrieves relevant remembered messages (semantic search over the local SQLite memory store), filters out channels you can't see, and answers grounded in those memories with source snippets
- **Options**:
  - `question` (required): What you want to know
- **Usage**: `/recall question:what did we decide about the minecraft server?`

## Privacy Commands

### `/what-do-you-know-about-me`
- **Description**: Private (ephemeral) report of everything Goobster has stored about you: facts, memory counts, pending follow-ups, nickname, preferences, chat history totals, usage rows, and activity counters
- **Usage**: `/what-do-you-know-about-me`

### `/forget-me`
- **Description**: Permanently erases everything Goobster knows about you, bot-wide, after a button confirmation. Deletes your memories, facts, follow-ups, chat history, nicknames, preferences, and profile; anonymizes usage rows and activity counters (counts kept); and scans server facts, conversation summaries, and follow-up notes for mentions of your name, deleting matches. Ends with a post-erasure audit showing zero rows still attributed to you
- **Usage**: `/forget-me`

### `/privacy`
- **Description**: Admin controls for what Goobster remembers (requires Manage Server)
- **Subcommands**:
  - `status`: Show retention window, excluded channels, and stored memory count
  - `retention`: Auto-delete long-term memories older than N days
    - `days` (required): Days to keep memories (0 = keep forever). Applies immediately and nightly
  - `exclude`: Stop remembering a channel and purge what's already stored from it (memories and activity counters)
    - `channel` (required): The channel Goobster must not remember
  - `include`: Resume remembering a previously excluded channel
    - `channel` (required): The channel to remember again
- **Usage**: `/privacy retention days:90`, `/privacy exclude channel:#venting`

## Search Commands

### `/search`
- **Description**: Performs an intelligent web search using Perplexity AI
- **Options**:
  - `query` (required): The search query text
  - `detailed` (optional): Whether to return a detailed response
- **Usage**: `/search query:What is quantum computing? detailed:true`

## Audio Commands

### `/playmusic`
- **Description**: Plays background music in a voice channel
- **Options**:
  - `mood` (required): Type of music to play (battle, exploration, mystery, etc.)
  - `loop` (optional): Whether to loop the music continuously
- **Usage**: `/playmusic mood:battle loop:true`

### `/stopmusic`
- **Description**: Stops currently playing background music
- **Usage**: `/stopmusic`

### `/regeneratemusic`
- **Description**: Regenerates a specific music track
- **Options**:
  - `mood` (required): Type of music to regenerate
- **Usage**: `/regeneratemusic mood:battle`

### `/generateallmusic`
- **Description**: Regenerates all music tracks (Admin only)
- **Options**:
  - `force` (optional): Force regeneration even if files exist
- **Usage**: `/generateallmusic force:true`

### `/playambience`
- **Description**: Play ambient sound effects
- **Options**:
  - `type` (required): Type of ambient sound (forest, cave, tavern, etc.)
  - `volume` (optional): Volume level (0.1 to 1.0)
- **Usage**: `/playambience type:forest volume:0.5`

### `/stopambience`
- **Description**: Stop playing ambient sound effects
- **Usage**: `/stopambience`

## Voice Commands

## Utility Commands

### `/automation`
- **Description**: Manage automated message triggers
- **Subcommands**:
  - `create`: Create a new automated message trigger
    - `name` (required): Name for this automation
    - `prompt` (required): The prompt text to use for generating messages
    - `schedule` (required): When to trigger (use natural language like "every day at 9am")
  - `list`: List your automated message triggers
  - `toggle`: Enable or disable an automation
    - `name` (required): Name of the automation to toggle
    - `enabled` (required): Whether to enable or disable the automation
  - `delete`: Delete an automation
    - `name` (required): Name of the automation to delete
- **Usage Examples**:
  - Create a daily reminder: `/automation create name:DailyUpdate prompt:Generate a friendly daily update message for the team schedule:every day at 9am`
  - Create a weekly meeting reminder: `/automation create name:WeeklySync prompt:Remind everyone about our weekly sync meeting schedule:every Monday at 3:30pm`
  - Create an hourly check: `/automation create name:HourlyCheck prompt:Generate a brief system status update schedule:every hour`
  - List automations: `/automation list`
  - Toggle automation: `/automation toggle name:DailyUpdate enabled:false`
  - Delete automation: `/automation delete name:DailyUpdate`
- **Schedule Examples**:
  - "every day at 9am"
  - "every Monday at 3:30pm"
  - "every hour"
  - "every 30 minutes"
  - "at 2:45pm on weekdays"
  - "every Tuesday and Thursday at 10am"
  - "every morning at 8am"
  - "every weekday at noon"
- **Note**: Automations only trigger when the creating user is online

### `/createuser`
- **Description**: Creates a new user profile in the database
- **Usage**: `/createuser`

### `/monologue`
- **Description**: Control Goobster's internal monologue - a private, per-server background thought process. When enabled, Goobster periodically reflects on recent conversations, keeps a scratch pad of working notes, and builds a knowledge graph linking concepts, facts, opinions, and experiences. Thoughts are never posted; they quietly inform normal chat replies
- **Permissions**: Manage Server
- **Subcommands**:
  - `enable`: Turn the internal monologue on for this server
  - `disable`: Turn it off (existing thoughts and graph are kept)
  - `status`: Show thought/note counts and knowledge graph size (ephemeral)
  - `thoughts`: Peek at recent private thoughts and the scratch pad (ephemeral)
  - `graph`: Show the most salient knowledge graph nodes and their links (ephemeral)
  - `reset`: Erase all private thoughts, scratch pad notes, and the knowledge graph
- **Usage**: `/monologue enable`, `/monologue thoughts`

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

### `/wrapped`
- **Description**: Server Wrapped - a shareable, Spotify-Wrapped-style recap of the server: top chatters, hot channels, busiest day, new memories/facts, and AI usage. Built entirely from local SQLite counters (counts only, no message content). When OpenAI is configured, also generates a stats-card image; otherwise posts the embed alone
- **Subcommands**:
  - `show`: Post the recap publicly in the current channel
    - `period` (optional): `Last month` (default), `This month`, or `This year`
  - `schedule`: Post last month's Wrapped in this channel on the 1st of every month (requires Manage Server)
  - `unschedule`: Stop the monthly Wrapped post (requires Manage Server)
- **Usage**: `/wrapped show period:Last month`, `/wrapped schedule`
- **Note**: Activity counters start when this feature is deployed, so the first full Wrapped covers the first complete month after launch

### `/whatsnew`
- **Description**: Shows a summary of recent changes from git logs
- **Options**:
  - `days` (optional): Number of days to look back (default: 7)
  - `limit` (optional): Maximum number of changes to show (default: 10)
- **Usage**: `/whatsnew days:14 limit:20`

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

### Using Audio Features
1. Join a voice channel
2. Play background music: `/playmusic mood:battle`
3. Add ambient sounds: `/playambience type:forest`
4. Stop when done: `/stopmusic` and `/stopambience`

### Using Search
- Basic search: `/search query:How does photosynthesis work?`
- Detailed search: `/search query:Explain quantum entanglement detailed:true`

### Text-to-Speech
1. Join a voice channel
2. Use speak command: `/speak message:Hello everyone!`

## Notes

- Voice commands require being in a voice channel
- Some commands require specific permissions
- Audio commands can be used together for immersive experiences
- Rate limits apply to voice features to prevent abuse
