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
                    { name: 'Search', value: 'search' },
                    { name: 'Economy', value: 'economy' },
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
                { name: '🎤 Voice Commands', value: 'Text-to-speech in voice channels\n`/help voice`', inline: true },
                { name: '🎵 Audio Commands', value: 'Music and ambient sound control\n`/help audio`', inline: true },
                { name: '🔍 Search Commands', value: 'AI-powered web search\n`/help search`', inline: true },
                { name: '💰 Economy Commands', value: 'Points, gambling, and the stock game\n`/help economy`', inline: true },
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
                    value: '• Start or continue a chat with Goobster\n• Usage: `/chat message:"Hello"`', 
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
                    name: '/recall', 
                    value: '• Ask the server\'s long-term memory anything\n• Usage: `/recall question:"what did we decide about the minecraft server?"`', 
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
            description: 'Text-to-speech commands (powered by ElevenLabs). All voice commands require being in a voice channel.',
            fields: [
                { 
                    name: '/speak', 
                    value: 'Convert text to speech\n• Usage: `/speak message:"Hello"`\n• Plays the message in your voice channel', 
                    inline: true 
                },
                { 
                    name: '/setvoice', 
                    value: 'Admin: set the global ElevenLabs voice\n• Usage: `/setvoice voice_id:Rachel`\n• Accepts a voice name or voice ID', 
                    inline: true 
                }
            ]
        },
        audio: {
            color: '#32CD32',
            title: '🎵 Audio Commands',
            description: 'Music and ambient sound control. Most audio commands require being in a voice channel.',
            fields: [
                {
                    name: '/play',
                    value: '• Play audio straight from a URL\n• Supports YouTube videos/playlists and Spotify tracks/playlists/albums\n• Joins your voice channel, downloads (or reuses cached MP3s), and starts playing immediately\n• Usage: `/play url:<youtube_or_spotify_url>`',
                    inline: false
                },
                {
                    name: '/playtrack',
                    value: '• Play and manage downloaded tracks\n• Subcommands: play, list, queue, skip, pause, resume, stop, volume, playlist_create, playlist_add, playlist_play, playlist_list, playlist_delete, play_all, shuffle_all\n• Usage: `/playtrack play track:"Artist - Title"` or `/playtrack playlist_play name:"My Favs"`',
                    inline: false // Make it full width due to length
                },
                {
                    name: '/spotdl',
                    value: '• Download music from Spotify\n• Subcommands: download, list, delete\n• Usage: `/spotdl download url:<spotify_url>`\n• **Tip:** Use the "Share" option in Spotify to get the URL.',
                    inline: true
                },
                {
                    name: '/playmusic',
                    value: '• Play generated background music\n• Moods: battle, exploration, etc.\n• Usage: `/playmusic mood:battle`',
                    inline: true
                },
                {
                    name: '/stopmusic',
                    value: '• Stop generated background music\n• Usage: `/stopmusic`',
                    inline: true
                },
                {
                    name: '/playambience',
                    value: '• Play ambient background sounds\n• Types: forest, cave, etc.\n• Usage: `/playambience type:forest`',
                    inline: true
                },
                {
                    name: '/stopambience',
                    value: '• Stop ambient sound effects\n• Usage: `/stopambience`',
                    inline: true
                },
                {
                    name: '/regeneratemusic',
                    value: '• Regenerate music for a mood\n• Usage: `/regeneratemusic mood:battle`',
                    inline: true
                },
                {
                    name: '/generateallmusic',
                    value: '• Admin: Regenerate all music\n• Usage: `/generateallmusic force:true`',
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
        economy: {
            color: '#F1C40F',
            title: '💰 Economy Commands',
            description: 'The server point currency (name it anything, e.g. "Jimmy points"), gambling games, and the stock trading game (1 point = $1)',
            fields: [
                {
                    name: '/points',
                    value: '• Balance, daily claim, transfers, leaderboard, history\n• Usage: `/points balance`, `/points daily`, `/points give user:@friend amount:100`\n• Admin: `/points admin name`, `grant`, `config`',
                    inline: true
                },
                {
                    name: '/gamble',
                    value: '• Bet points on games (even money)\n• Coin flip: `/gamble coinflip bet:50 call:heads`\n• D20 showdown: `/gamble d20 bet:50`\n• Poker: `/gamble poker bet:50`',
                    inline: true
                },
                {
                    name: '/stocks',
                    value: '• Trade real stocks with points at live prices\n• Usage: `/stocks quote symbol:AAPL`, `/stocks buy symbol:AAPL units:2`, `/stocks sell`, `/stocks portfolio`, `/stocks chart`, `/stocks search`, `/stocks trades`',
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
                    name: '/what-do-you-know-about-me', 
                    value: '• Private report of everything Goobster stored about you\n• Usage: `/what-do-you-know-about-me`', 
                    inline: true 
                },
                { 
                    name: '/forget-me', 
                    value: '• Erase everything Goobster knows about you\n• ⚠️ Bot-wide, cannot be undone\n• Usage: `/forget-me`', 
                    inline: true 
                },
                { 
                    name: '/privacy', 
                    value: '• Admin: memory retention + channel exclusions\n• Usage: `/privacy retention days:90`', 
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