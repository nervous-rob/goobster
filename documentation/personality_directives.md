# Personality Directives

## Overview

Personality Directives allow server administrators to customize Goobster's personality and behavior on a per-server basis. This feature lets admins set custom instructions that override Goobster's default behavior when interacting with users in their server.

## Use Cases

### Customizing Goobster's Personality

Server administrators might want to customize Goobster's personality to:

- Make Goobster match their server's theme or culture
- Create a more playful or professional tone
- Add specialized knowledge or expertise relevant to the server's topic
- Implement server-specific rules or guidelines for interactions
- Create a fun, temporary personality change for events or holidays

### Examples

1. **Gaming Server**
   ```
   In this server, reference popular games like Minecraft and Fortnite. Use gaming terminology and be enthusiastic about discussing game strategies. When users ask for help with games, prioritize practical advice.
   ```

2. **Professional Community**
   ```
   Maintain a professional and formal tone in this server. Avoid casual language, focus on providing well-researched answers, and respect the expertise of the professionals in the community. Citations are highly appreciated.
   ```

3. **Meme Community**
   ```
   Act like a meme lord in this server. Use lots of internet slang, reference popular memes from 2024, and be extra playful. Don't take anything too seriously and throw in random meme references when appropriate.
   ```

## Managing Personality Directives

Server administrators can manage personality directives using the `/personalitydirective` command:

### Setting a Personality Directive

```
/personalitydirective set directive:"Your custom directive here"
```

The directive can be any text that describes how Goobster should behave in your server. This will be applied to all interactions within the server.

### Viewing the Current Directive

```
/personalitydirective view
```

This will display the current personality directive set for your server.

### Clearing the Directive

```
/personalitydirective clear
```

This removes any custom personality directive and returns Goobster to using the default behavior.

## Technical Details

- Personality directives are stored in the `guild_settings` table
- Settings are cached for 5 minutes for performance
- Directives can be up to 4000 characters long
- Directives override user-specific settings like meme mode
- The directive is applied to all AI-generated responses in the server

## Best Practices

### Writing Effective Directives

1. **Be specific** - Clearly describe the tone, style, and behavior you want
2. **Stay positive** - Focus on what Goobster should do, not what it shouldn't
3. **Consider context** - Ensure your directive fits your server's purpose
4. **Avoid restrictions** - Directives that severely limit Goobster's ability to help users may impact functionality
5. **Test and refine** - Set a directive and interact with Goobster to see if it meets your expectations

### Limitations

- Personality directives cannot override core functionality
- Cannot be used to make Goobster break content policies
- May not perfectly emulate highly specific characters or personalities
- Extremely complex directives might not be followed consistently

## Examples of Directives

### Helpful Teaching Assistant
```
Act as a patient teaching assistant who specializes in breaking down complex topics. Use analogies, step-by-step explanations, and encourage users when they make progress. If someone seems confused, offer to explain in a different way.
```

### Cyberpunk Personality
```
Adopt a cyberpunk persona. Use futuristic slang, make references to technology and dystopian futures, and generally maintain a gritty, tech-noir attitude. Occasionally mention augmentations, corporations, and the digital underground.
```

### Local Tour Guide
```
Act as an enthusiastic tour guide for our city. Be knowledgeable about local attractions, restaurants, and events. When users ask about places to visit or things to do, be specific and provide insider tips that tourists might not know.
```

## Troubleshooting

- If Goobster isn't following the directive properly, try making it more specific
- Very long or complex directives might be difficult for Goobster to follow consistently
- If you notice undesired behavior, try clearing the directive and setting a new one
- For persistent issues, contact the bot developers 