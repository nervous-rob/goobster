// TODO: Add proper handling for missing documentation links
// TODO: Add proper handling for documentation updates
// TODO: Add proper handling for missing command metadata
// TODO: Add proper handling for command deprecation
// TODO: Add proper handling for command version differences
// TODO: Add proper handling for embed field limits
// TODO: Add proper handling for command permission changes
// TODO: Add proper handling for disabled commands
// TODO: Add proper handling for command cooldowns
// TODO: Add proper handling for guild-specific command variations

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const REPO_URL = 'https://github.com/nervous-rob/goobster';
const DOCS_BASE_URL = `${REPO_URL}/blob/main/documentation`;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Get information about available commands')
        .addStringOption(option =>
            option.setName('category')
                .setDescription('Specific category of commands to view')
                .setRequired(false)
                .addChoices(
                    { name: 'Chat', value: 'chat' },
                    { name: 'Voice', value: 'voice' },
                    { name: 'Audio', value: 'audio' },
                    { name: 'Adventure', value: 'adventure' },
                    { name: 'Search', value: 'search' },
                    { name: 'Utility', value: 'utility' },
                    { name: 'Documentation', value: 'docs' }
                )),

    async execute(interaction) {
        const category = interaction.options.getString('category');
        
        if (category) {
            return await sendCategoryHelp(interaction, category);
        }
        
        // Main help embed
        const helpEmbed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('🤖 Goobster Bot Commands')
            .setDescription('Here are all the available command categories. Use `/help <category>` for detailed information about specific commands.\n\n[📚 View All Documentation](' + REPO_URL + '/tree/main/documentation)')
            .addFields(
                { name: '💭 Chat Commands', value: 'AI conversation and prompt management\n`/help chat`', inline: true },
                { name: '🎤 Voice Commands', value: 'Voice interaction and transcription\n`/help voice`', inline: true },
                { name: '🎵 Audio Commands', value: 'Music and ambient sound control\n`/help audio`', inline: true },
                { name: '🎮 Adventure Commands', value: 'Interactive storytelling\n`/help adventure`', inline: true },
                { name: '🔍 Search Commands', value: 'AI-powered web search\n`/help search`', inline: true },
                { name: '🛠️ Utility Commands', value: 'Bot and server management\n`/help utility`', inline: true },
                { name: '📚 Documentation', value: 'View detailed guides\n`/help docs`', inline: true }
            )
            .setFooter({ text: 'For more detailed documentation, use /help docs' });

        await interaction.reply({ embeds: [helpEmbed] });
    }
};

async function sendCategoryHelp(interaction, category) {
    const categoryEmbeds = {
        chat: {
            color: '#FF69B4',
            title: '💭 Chat Commands',
            description: 'Commands for interacting with the AI chat system and managing conversations',
            fields: [
                { 
                    name: '/chat', 
                    value: '• Start or continue a chat with Goobster\n• Select AI model for responses\n• Usage: `/chat message:"Hello" model:o1`', 
                    inline: true 
                },
                { 
                    name: '/addmessage', 
                    value: '• Add to current conversation\n• Usage: `/addmessage text:"What do you think?"`', 
                    inline: true 
                },
                { 
                    name: '/createconversation', 
                    value: '• Start new conversation with prompt\n• Use promptlabel or promptid\n• Usage: `/createconversation promptlabel:casual`', 
                    inline: true 
                },
                { 
                    name: '/createprompt', 
                    value: '• Create a new conversation prompt\n• Usage: `/createprompt text:"You are..." label:helper`', 
                    inline: true 
                },
                { 
                    name: '/viewconversations', 
                    value: '• View your conversation history\n• Usage: `/viewconversations`', 
                    inline: true 
                },
                { 
                    name: '/viewprompts', 
                    value: '• List your saved prompts\n• Usage: `/viewprompts`', 
                    inline: true 
                },
                { 
                    name: '/joke', 
                    value: '• Get an AI-generated joke\n• Usage: `/joke category:dad`', 
                    inline: true 
                },
                { 
                    name: '/poem', 
                    value: '• Get an AI-generated poem\n• Usage: `/poem topic:nature`', 
                    inline: true 
                }
            ]
        },
        voice: {
            color: '#9932CC',
            title: '🎤 Voice Commands',
            description: 'Voice interaction and speech commands. All voice commands require being in a voice channel.',
            fields: [
                { 
                    name: '/voice start', 
                    value: 'Start voice interaction with the AI\n• Requires voice channel\n• Listens to your voice and responds with AI-generated speech', 
                    inline: true 
                },
                { 
                    name: '/voice stop', 
                    value: 'Stop voice interaction\n• Stops listening and cleans up voice resources\n• Use when done with voice chat', 
                    inline: true 
                },
                { 
                    name: '/speak', 
                    value: 'Convert text to speech\n• Usage: `/speak message:"Hello"`\n• Plays the message in your voice channel', 
                    inline: true 
                },
                { 
                    name: '/transcribe', 
                    value: 'Start/stop voice transcription\n• Usage: `/transcribe enabled:true`\n• Creates a thread for transcriptions', 
                    inline: true 
                }
            ]
        },
        audio: {
            color: '#32CD32',
            title: '🎵 Audio Commands',
            description: 'Music and ambient sound control. All audio commands require being in a voice channel.',
            fields: [
                { 
                    name: '/playmusic', 
                    value: '• Available moods: battle, exploration, mystery, celebration, danger, peaceful, sad, dramatic\n• Usage: `/playmusic mood:battle loop:true`', 
                    inline: true 
                },
                { 
                    name: '/stopmusic', 
                    value: '• Stop background music playback\n• Usage: `/stopmusic`', 
                    inline: true 
                },
                { 
                    name: '/playambience', 
                    value: '• Types: forest, cave, tavern, ocean, city, dungeon, camp, storm\n• Usage: `/playambience type:forest volume:0.5`', 
                    inline: true 
                },
                { 
                    name: '/stopambience', 
                    value: '• Stop ambient sound effects\n• Usage: `/stopambience`', 
                    inline: true 
                },
                { 
                    name: '/regeneratemusic', 
                    value: '• Regenerate music for a specific mood\n• Usage: `/regeneratemusic mood:battle`', 
                    inline: true 
                },
                { 
                    name: '/generateallmusic', 
                    value: '• Admin only: Regenerate all music tracks\n• Usage: `/generateallmusic force:true`', 
                    inline: true 
                }
            ]
        },
        adventure: {
            color: '#4169E1',
            title: '🎮 Adventure Commands',
            description: 'Interactive storytelling system with rich narratives, dynamic decisions, and meaningful progression.',
            fields: [
                { 
                    name: '/createparty', 
                    value: '• Create a new adventure party\n• Required: character name\n• Optional: character backstory\n• Usage: `/createparty name:"Thorin" backstory:"A dwarf warrior"`', 
                    inline: true 
                },
                { 
                    name: '/joinparty', 
                    value: '• Join an existing adventure party\n• Requires party ID\n• Usage: `/joinparty id:"123" name:"Gimli"`', 
                    inline: true 
                },
                { 
                    name: '/makedecision', 
                    value: '• Make choices in your story\n• Affects story progression\n• Tracks consequences and state\n• Usage: `/makedecision choice:1`', 
                    inline: true 
                },
                { 
                    name: '/partystatus', 
                    value: '• View party status and progress\n• Shows current situation\n• Usage: `/partystatus`', 
                    inline: true 
                },
                { 
                    name: '/generatescene', 
                    value: '• Generate a new scene\n• Creates dynamic story content\n• Usage: `/generatescene`', 
                    inline: true 
                }
            ]
        },
        search: {
            color: '#FFD700',
            title: '🔍 Search Commands',
            description: 'AI-powered web search functionality using Perplexity AI',
            fields: [
                { 
                    name: '/search', 
                    value: '• Search the web with AI assistance\n• Optional: detailed mode for comprehensive results\n• Usage: `/search query:"quantum computing" detailed:true`\n• Results are summarized and relevant', 
                    inline: true 
                },
                { 
                    name: '/requiresearchapproval', 
                    value: '• Admin only: Configure whether searches require approval\n• Usage: `/requiresearchapproval set setting:option`\n• Check status: `/requiresearchapproval status`', 
                    inline: true 
                }
            ]
        },
        utility: {
            color: '#A0522D',
            title: '🛠️ Utility Commands',
            description: 'Bot and server management commands',
            fields: [
                { 
                    name: '/help', 
                    value: '• Show command categories and help\n• Optional: view specific category\n• Usage: `/help [category]`', 
                    inline: true 
                },
                { 
                    name: '/automation', 
                    value: '• Manage automated message triggers\n• Subcommands: create, list, toggle, delete\n• Usage: `/automation create name:"DailyReminder" prompt:"..." schedule:"every day at 9am"`\n• Supports natural language scheduling', 
                    inline: true 
                },
                { 
                    name: '/createuser', 
                    value: '• Create your user profile\n• Required for conversation features\n• Usage: `/createuser`', 
                    inline: true 
                },
                { 
                    name: '/ping', 
                    value: '• Test bot and database connection\n• Checks response time\n• Usage: `/ping`', 
                    inline: true 
                },
                { 
                    name: '/resetchatdata', 
                    value: '• Delete all your chat data\n• ⚠️ Cannot be undone\n• Usage: `/resetchatdata`', 
                    inline: true 
                },
                { 
                    name: '/cleanup', 
                    value: '• Clean up bot resources\n• Frees up system resources\n• Usage: `/cleanup`', 
                    inline: true 
                },
                { 
                    name: '/server', 
                    value: '• View server information\n• Shows member count and details\n• Usage: `/server`', 
                    inline: true 
                },
                { 
                    name: '/user', 
                    value: '• View your Discord info\n• Shows account details\n• Usage: `/user`', 
                    inline: true 
                },
                { 
                    name: '/mememode', 
                    value: '• Toggle meme mode for responses\n• Usage: `/mememode toggle true/false`\n• Check status: `/mememode status`', 
                    inline: true 
                },
                { 
                    name: '/threadpreference', 
                    value: '• Configure thread usage for responses\n• Usage: `/threadpreference set <preference>`\n• Check status: `/threadpreference status`', 
                    inline: true 
                },
                { 
                    name: '/requiresearchapproval', 
                    value: '• Admin only: Configure whether searches require approval\n• Usage: `/requiresearchapproval set setting:option`\n• Check status: `/requiresearchapproval status`', 
                    inline: true 
                },
                { 
                    name: '/aimodel', 
                    value: '• Admin only: Configure which AI model to use\n• Available models: o1 (default), gpt-4, claude-3, gemini-pro\n• Usage: `/aimodel set model:o1`\n• Check status: `/aimodel view`\n• Models have automatic fallback options', 
                    inline: true 
                }
            ]
        },
        docs: {
            color: '#8B4513',
            title: '📚 Documentation & Resources',
            description: 'Important documentation and guides for Goobster Bot',
            fields: [
                { 
                    name: '📖 Commands Guide', 
                    value: `[View Documentation](${DOCS_BASE_URL}/commands.md)\nDetailed command reference and examples`, 
                    inline: true 
                },
                { 
                    name: '🎮 Adventure Guide', 
                    value: `[View Documentation](${DOCS_BASE_URL}/adventure_mode_guide.md)\nHow to play adventure mode`, 
                    inline: true 
                },
                { 
                    name: '🎵 Music System', 
                    value: `[View Documentation](${DOCS_BASE_URL}/music_system.md)\nMusic and audio features`, 
                    inline: true 
                },
                { 
                    name: '🔧 Configuration', 
                    value: `[View Documentation](${DOCS_BASE_URL}/configuration_guide.md)\nBot setup and config`, 
                    inline: true 
                },
                { 
                    name: '🎤 Voice Features', 
                    value: `[View Documentation](${DOCS_BASE_URL}/voice_commands.md)\nVoice commands and TTS`, 
                    inline: true 
                },
                {
                    name: '⏱️ Automations',
                    value: `[View Documentation](${DOCS_BASE_URL}/commands.md#automation)\nScheduled message automations`,
                    inline: true
                },
                { 
                    name: '🔍 Search Guide', 
                    value: `[View Documentation](${DOCS_BASE_URL}/search_service.md)\nWeb search functionality`, 
                    inline: true 
                },
                { 
                    name: '🎧 Audio System', 
                    value: `[View Documentation](${DOCS_BASE_URL}/audio_system.md)\nAudio processing details`, 
                    inline: true 
                },
                { 
                    name: '📊 Architecture', 
                    value: `[View Documentation](${DOCS_BASE_URL}/architecture.md)\nSystem design overview`, 
                    inline: true 
                },
                { 
                    name: '☁️ Azure Setup', 
                    value: `[View Documentation](${DOCS_BASE_URL}/azure_setup.md)\nCloud service setup`, 
                    inline: true 
                }
            ]
        },
        'Fun & Customization': {
            description: 'Commands for fun features and customizing bot behavior',
            commands: [
                {
                    name: 'mememode',
                    description: 'Toggle meme mode for more meme-flavored responses',
                    usage: [
                        '/mememode toggle <true/false> - Turn meme mode on or off',
                        '/mememode status - Check if meme mode is currently enabled'
                    ],
                    examples: [
                        '/mememode toggle true',
                        '/mememode toggle false',
                        '/mememode status'
                    ]
                }
            ]
        }
    };

    const embed = new EmbedBuilder()
        .setColor(categoryEmbeds[category].color)
        .setTitle(categoryEmbeds[category].title)
        .setDescription(categoryEmbeds[category].description)
        .addFields(categoryEmbeds[category].fields)
        .setFooter({ text: category === 'docs' ? 'Click the links above to view full documentation' : 'Use /help to see all categories' });

    await interaction.reply({ embeds: [embed] });
} 