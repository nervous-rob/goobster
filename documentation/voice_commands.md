# Voice Commands Documentation

## Overview
This document covers all voice-related commands and features in Goobster, including text-to-speech (powered by ElevenLabs) and audio management capabilities.

## Command Reference

### Text-to-Speech Commands

#### `/speak [message]`
Converts text to speech using ElevenLabs.

**Usage:**
```
/speak Hello, this is a test message
```

**Parameters:**
- `message`: The text to convert to speech (required)
- `voice`: Override the ElevenLabs voice for this message (optional; accepts a voice name like `Rachel` or a voice ID)

**Permissions Required:**
- Basic user permissions
- Voice channel access
- Bot must have Connect and Speak permissions

#### `/setvoice [voice_id]`
Admin command that globally sets the ElevenLabs voice used for all TTS.

**Usage:**
```
/setvoice Rachel
/setvoice 21m00Tcm4TlvDq8ikWAM
```

**Parameters:**
- `voice_id`: An ElevenLabs voice name or voice ID (required)

### Music Commands

#### `/playmusic [mood] [loop]`
Plays background music with specified mood.

**Parameters:**
- `mood`: The mood of the music (required)
  - battle
  - exploration
  - mystery
  - celebration
  - danger
  - peaceful
  - sad
  - dramatic
- `loop`: Whether to loop the music (optional, defaults to false)

#### `/stopmusic`
Stops currently playing background music with a smooth fade-out.

#### `/regeneratemusic [mood]`
Regenerates music for a specific mood.

**Parameters:**
- `mood`: The mood of the music to regenerate (required)

#### `/generateallmusic [force]`
Admin command to generate and cache all music variations.

**Parameters:**
- `force`: Force regeneration even if files exist (optional)

### Ambient Sound Commands

#### `/playambience [type] [volume]`
Plays ambient sound effects.

**Parameters:**
- `type`: The type of ambient sound (required)
  - forest
  - cave
  - tavern
  - ocean
  - city
  - dungeon
  - camp
  - storm
- `volume`: Volume level from 0.1 to 1.0 (optional, defaults to 0.3)

#### `/stopambience`
Stops currently playing ambient sounds.

### Voice Conversations

#### `/voicechat start [mode] [engine] [transcript]`
Starts a live voice conversation in your current voice channel.

**Parameters:**
- `mode`: `polite` (default; replies when addressed or clearly needed) or `open` (replies to every turn)
- `engine`: `realtime` (default) or `classic`
  - **realtime** - low latency and interruptible: speech is transcribed while you talk (ElevenLabs Scribe v2 Realtime), the reply is spoken as it is generated (multi-context TTS WebSocket), and you can barge in by just talking. Requires only `ELEVENLABS_API_KEY`.
  - **classic** - the original batch pipeline (OpenAI speech-to-text, full reply, then TTS). Requires an OpenAI key as well.
- `transcript`: post a live transcript in the invoking text channel (default: true)

`/voicechat stop` ends the session; `/voicechat status` shows the active channel, mode, and engine.

## TTS Configuration

TTS requires an ElevenLabs API key, set either in `config.json`:

```json
"elevenlabs": {
    "apiKey": "sk_...",
    "voiceId": "21m00Tcm4TlvDq8ikWAM",
    "modelId": "eleven_flash_v2_5"
}
```

or via the `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` environment variables. Without a key, TTS commands report that the engine is not configured; the rest of the bot works normally.

## Best Practices

### Voice Channel Usage
- One active audio player per channel
- Regular session cleanup
- Proper permission management

### Command Usage
- Verify permissions before commands
- Handle long text appropriately
- Monitor ElevenLabs rate limits and character quota
- Clean up resources after use

## Troubleshooting

### Common Issues
1. **TTS Issues**
   - Validate the ElevenLabs API key (`Invalid ElevenLabs API key format` at startup means the key is malformed)
   - Check your ElevenLabs plan's character quota and concurrency limits
   - Verify audio output permissions in the voice channel
   - Confirm FFmpeg is installed and on the PATH

2. **Voice Not Found**
   - `/setvoice` and `/speak voice:` accept voice names only for voices in your ElevenLabs voice library; otherwise use the voice ID

3. **Session Errors**
   - Review connection status
   - Verify resource availability

## Security Considerations
- Role-based access control (`/setvoice` is admin-only)
- Channel permissions verification
- API keys live in `config.json` / `.env`, both gitignored
- Rate limiting enforcement
