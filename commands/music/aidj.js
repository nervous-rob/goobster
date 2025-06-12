const { SlashCommandBuilder } = require('discord.js');
const { VoiceConnectionStatus, entersState } = require('@discordjs/voice');

// Core services
const MusicService = require('../../services/voice/musicService');
const SpotDLService = require('../../services/spotdl/spotdlService');
const TTSService = require('../../services/voice/ttsService');
const aiService = require('../../services/aiService');
const { parseTrackName } = require('../../utils/musicUtils');

// Config
const config = require('../../config.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('aidj')
        .setDescription('Let the AI DJ take over your voice channel and spin some tunes!')
        .addStringOption(option =>
            option.setName('theme')
                .setDescription('Describe the vibe (e.g. "lofi study", "80s synthwave", "upbeat pop")')
                .setRequired(true))
        .addNumberOption(option =>
            option.setName('volume')
                .setDescription('Music volume (0.1 – 1.0)')
                .setMinValue(0.1)
                .setMaxValue(1.0)
                .setRequired(false)),

    async execute(interaction) {
        let connection = null;
        let musicService = null;
        let ttsService = null;

        try {
            // Immediately defer reply to give us time and avoid Unknown interaction errors
            let deferred = false;
            async function safeDefer() {
                try {
                    await interaction.deferReply();
                    deferred = true;
                } catch (err) {
                    if (err.code === 10062 || err.rawError?.code === 10062) {
                        console.warn('Interaction expired before defer; aborting aidj command');
                        return false;
                    }
                    throw err;
                }
                return true;
            }

            const canProceed = await safeDefer();
            if (!canProceed) return;

            // ------- Voice channel checks -------
            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                await interaction.editReply('🎧 You need to be in a voice channel for me to DJ!');
                return;
            }

            const permissions = voiceChannel.permissionsFor(interaction.client.user);
            if (!permissions.has('Connect') || !permissions.has('Speak')) {
                await interaction.editReply('🚫 I need permission to join and speak in your voice channel.');
                return;
            }

            // ------- Option parsing -------
            const theme = interaction.options.getString('theme');
            const volumeOption = interaction.options.getNumber('volume');
            const targetVolume = volumeOption ?? config.audio?.music?.volume ?? 1.0;

            // ------- Service initialisation -------
            musicService = new MusicService(config);
            ttsService = new TTSService(config);
            const spotdlService = new SpotDLService();

            // Allow MusicService to emit events on the Discord client (used for presence updates etc.)
            musicService.setClient(interaction.client);
            musicService.guildId = voiceChannel.guild.id;

            // ------- Connect to voice channel -------
            connection = await musicService.joinChannel(voiceChannel);

            // Wait for ready
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

            // ------- Intro TTS -------
            const introText = await generateDjIntro(theme);
            if (!ttsService.disabled) {
                await ttsService.textToSpeech(introText, voiceChannel, connection);
            }

            // ------- Build playlist -------
            const allTracks = await spotdlService.listTracks();
            if (!allTracks || allTracks.length === 0) {
                await interaction.editReply('😢 I could not find any music in my library.');
                return;
            }

            // Attempt to pick tracks matching the theme via OpenAI; fallback to shuffle all.
            let selectedTracks = await pickTracksForTheme(allTracks, theme);
            if (selectedTracks.length === 0) {
                // Fallback – just use all tracks.
                selectedTracks = allTracks;
            }

            // Create a temporary playlist name
            const playlistName = `AI DJ ${Date.now()}`;
            await musicService.createOrUpdatePlaylistFromTracks(voiceChannel.guild.id, playlistName, selectedTracks);
            await musicService.setVolume(targetVolume);

            // --- Lock / listener vars ---
            let announceLock = false;
            musicService.removeAllListeners('trackChanged'); // prevent duplicates from prior runs

            const trackListener = async (track) => {
                if (announceLock) return; // avoid overlap with chatter
                announceLock = true;
                try {
                    const { artist, title } = parseTrackName(track.name);
                    const announceText = await generateTrackAnnouncement(title, artist, theme);

                    const bgUrl = await spotdlService.getTrackUrl(track.name).catch(() => null);
                    await ttsService.textToSpeech(announceText, voiceChannel, connection, bgUrl);
                } catch (err) {
                    console.error('AI DJ track announcement error:', err);
                } finally {
                    announceLock = false;
                }
            };

            musicService.on('trackChanged', trackListener);

            // Shuffle BEFORE starting playback so first song is random
            await musicService.playPlaylist(voiceChannel.guild.id, playlistName);
            await musicService.shufflePlaylist();

            // ------- Random chatter every 3 minutes -------
            const randomChatterInterval = setInterval(async () => {
                if (announceLock) return; // skip if another announce is running
                announceLock = true;
                try {
                    const chatter = await generateRandomChatter(theme);
                    const bgUrl = musicService.currentTrack ? await spotdlService.getTrackUrl(musicService.currentTrack.name).catch(() => null) : null;
                    await ttsService.textToSpeech(chatter, voiceChannel, connection, bgUrl);
                } catch (err) {
                    console.warn('Random chatter error:', err);
                } finally {
                    announceLock = false;
                }
            }, 180_000); // 3-minute interval

            // Outro & cleanup when playlist finishes
            const endHandler = async () => {
                try {
                    clearInterval(randomChatterInterval);
                    musicService.off('trackChanged', trackListener);
                    await ttsService.textToSpeech("That's all from me – stay groovy!", voiceChannel, connection);
                } catch {}
                connection.destroy();
            };
            musicService.once('queueEmpty', endHandler);

            // Reply success
            if (deferred) {
                await interaction.editReply(`🎶 AI DJ activated with theme **${theme}**! Enjoy the music.`);
            }

        } catch (error) {
            console.error('aidj command error:', error);
            try {
                if (deferred) await interaction.editReply('❌ An error occurred while starting the AI DJ.');
            } catch {}

            // Clean-up
            if (musicService) {
                try { await musicService.stopMusic(); } catch {}
            }
            if (connection) {
                try { connection.destroy(); } catch {}
            }
            // remove potential intervals/listeners to avoid leaks
            if (typeof randomChatterInterval !== 'undefined') clearInterval(randomChatterInterval);
            musicService?.removeAllListeners('trackChanged');
        }
    }
};

// ---------- Helper functions ----------

/**
 * Generate a short DJ introduction using OpenAI.
 */
async function generateDjIntro(theme) {
    try {
        const promptText = `You are an energetic radio DJ named Goobster. Welcome listeners to a new set themed "${theme}". Write a short, upbeat intro under 25 words.`;
        const result = await aiService.generateText(promptText, { temperature: 0.8, max_tokens: 60 });
        return result.trim();
    } catch (err) {
        console.warn('Failed to generate DJ intro, using fallback.');
        return `Hey everyone, Goobster here! Let's dive into some ${theme} vibes!`;
    }
}

/**
 * Ask OpenAI to choose tracks matching the requested theme.
 * Returns an array of track objects (subset of the provided library).
 */
async function pickTracksForTheme(tracks, theme) {
    try {
        const names = tracks.map(t => t.name).slice(0, 200).join('\n'); // limit list size
        const systemPrompt = 'You are a helpful assistant that picks songs matching a listener\'s desired vibe.';
        const userPrompt = `Listener wants the theme: "${theme}".\nHere is the library list (one per line):\n${names}\n\nReturn up to 30 exact filenames from the library that fit best, as a JSON array of strings. Respond with ONLY the JSON.`;

        const raw = await aiService.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ], { temperature: 0.7, max_tokens: 300 });

        const jsonMatch = raw.match(/\[.*\]/s);
        if (jsonMatch) {
            const arr = JSON.parse(jsonMatch[0]);
            return tracks.filter(t => arr.includes(t.name));
        }
        return [];
    } catch (err) {
        console.warn('Track picking failed:', err.message);
        return [];
    }
}

/**
 * Generate a brief radio-style track announcement.
 */
async function generateTrackAnnouncement(title, artist, theme) {
    try {
        const promptText = `You are Goobster, an upbeat radio DJ. Announce the track "${title}" by ${artist}. Keep it fun, under 20 words, reference the overall theme "${theme}".`;
        const result = await aiService.generateText(promptText, { temperature: 0.9, max_tokens: 50 });
        return result.trim();
    } catch (err) {
        console.warn('Failed to generate track announcement.');
        return `Now playing: ${title} by ${artist}!`;
    }
}

/**
 * Generate spontaneous DJ chatter unrelated to track changes.
 */
async function generateRandomChatter(theme) {
    try {
        const prompt = `You are Goobster, an energetic radio DJ. Say a short (max 18 words) fun comment or trivia related to the overall theme "${theme}". Avoid repeating yourself.`;
        const res = await aiService.generateText(prompt, { temperature: 0.85, max_tokens: 40 });
        return res.trim();
    } catch {
        return 'Stay tuned for more great music!';
    }
}