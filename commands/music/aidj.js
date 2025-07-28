const { SlashCommandBuilder } = require('discord.js');
const { VoiceConnectionStatus, entersState } = require('@discordjs/voice');

// Core services
const SpotDLService = require('../../services/spotdl/spotdlService');
const { voiceService } = require('../../services/serviceManager');
const aiService = require('../../services/aiService');
const { parseTrackName } = require('../../utils/musicUtils');
const { getGuildContext, getPreferredUserName } = require('../../utils/guildContext');

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
        .addIntegerOption(option =>
            option.setName('volume')
                .setDescription('Music volume percent (1–100)')
                .setMinValue(1)
                .setMaxValue(100)
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
            const volumeOption = interaction.options.getInteger('volume');

            // ------- Gather contextual data -------
            const guildContext = await getGuildContext(interaction.guild);
            const listenerMembers = voiceChannel.members.filter(m => !m.user.bot);
            const listenerNames = await Promise.all(listenerMembers.map(m => getPreferredUserName(m.id, interaction.guildId, m)));

            // ------- Service initialisation -------
            // Use shared musicService so that /music pause|stop|skip work during AI DJ
            if (!voiceService._isInitialized) await voiceService.initialize();
            musicService = voiceService.musicService;
            // Grab shared TTS instance
            ttsService = voiceService.tts;

            if (!ttsService || ttsService.disabled) {
                console.warn('TTS disabled or not configured');
            }
            const spotdlService = new SpotDLService();

            // Allow MusicService to emit events on the Discord client (used for presence updates etc.)
            musicService.setClient(interaction.client);
            musicService.guildId = voiceChannel.guild.id;

            // ------- Connect to voice channel -------
            connection = await musicService.joinChannel(voiceChannel);

            // Wait for ready
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

            // ------- Intro TTS (with ducking) -------
            const introText = await generateDjIntro(theme, guildContext, listenerNames);

            // Helper to duck music, speak, then restore music
            async function speakWithDuck(text, bgUrl = null) {
                if (ttsService.disabled) return;

                // Preserve the current volume and play-state
                const originalVolume = musicService.getVolume ? musicService.getVolume() : 100;
                const duckVolume = Math.max(Math.round(originalVolume * 0.3), 5); // 30% of original (min 5)

                const { AudioPlayerStatus } = require('@discordjs/voice');
                const wasPlaying = musicService.player.state.status === AudioPlayerStatus.Playing;

                try {
                    // Fade volume down quickly (no smooth ramp for now)
                    await musicService.setVolume(duckVolume).catch(() => {});

                    // Pause only if it was playing (allows external /music pause to stay paused)
                    if (wasPlaying) {
                        await musicService.pause().catch(() => {});
                    }

                    // Speak (this will temporarily subscribe its own player)
                    await ttsService.textToSpeech(text, voiceChannel, connection, bgUrl);
                } finally {
                    // Re-attach the music player and resume only if we paused it
                    try { connection.subscribe(musicService.player); } catch {}
                    if (wasPlaying) {
                        await musicService.resume().catch(() => {});
                    }

                    // Restore original volume
                    await musicService.setVolume(originalVolume).catch(() => {});
                }
            }

            await speakWithDuck(introText);

            // ------- Build playlist -------
            const allTracks = await spotdlService.listTracks();
            if (!allTracks || allTracks.length === 0) {
                await interaction.editReply('😢 I could not find any music in my library.');
                return;
            }

            // Attempt to pick tracks matching the theme via OpenAI; fallback to shuffle all.
            let selectedTracks = await curateTracksForTheme(allTracks, theme, listenerNames, guildContext);
            if (selectedTracks.length === 0) {
                // Fallback – just use all tracks.
                selectedTracks = allTracks;
            }

            // Create a temporary playlist name
            const playlistName = `AI DJ ${Date.now()}`;
            await musicService.createOrUpdatePlaylistFromTracks(voiceChannel.guild.id, playlistName, selectedTracks);
            if (volumeOption !== null) {
                await musicService.setVolume(volumeOption);
            }

            // --- Lock / listener vars ---
            let announceLock = false;
            let trackCounter = 0; // To announce every N tracks
            musicService.removeAllListeners('trackChanged'); // prevent duplicates from prior runs

            const ANNOUNCE_EVERY_N_TRACKS = 2; // change to adjust frequency

            const trackListener = async (track) => {
                trackCounter++;
                if (trackCounter % ANNOUNCE_EVERY_N_TRACKS !== 0) return; // Skip most tracks

                if (announceLock) return; // avoid overlap with chatter
                announceLock = true;
                try {
                    const { artist, title } = parseTrackName(track.name);
                    const announceText = await generateTrackAnnouncement(title, artist, theme, guildContext, listenerNames);

                    const bgUrl = await spotdlService.getTrackUrl(track.name).catch(() => null);
                    await speakWithDuck(announceText, bgUrl);
                } catch (err) {
                    console.error('AI DJ track announcement error:', err);
                } finally {
                    announceLock = false;
                }
            };

            musicService.on('trackChanged', trackListener);

            // Shuffle BEFORE starting playback so first song is random
            await musicService.playPlaylist(voiceChannel.guild.id, playlistName);

            // ------- Random chatter every 3 minutes -------
            const CHATTER_INTERVAL_MS = 6 * 60 * 1000; // 6 minutes

            const randomChatterInterval = setInterval(async () => {
                if (announceLock) return; // skip if another announce is running
                announceLock = true;
                try {
                    const chatter = await generateRandomChatter(theme, guildContext, listenerNames);
                    const bgUrl = musicService.currentTrack ? await spotdlService.getTrackUrl(musicService.currentTrack.name).catch(() => null) : null;
                    await speakWithDuck(chatter, bgUrl);
                } catch (err) {
                    console.warn('Random chatter error:', err);
                } finally {
                    announceLock = false;
                }
            }, CHATTER_INTERVAL_MS); // Reduced frequency

            // Outro & cleanup when playlist finishes
            const endHandler = async () => {
                try {
                    clearInterval(randomChatterInterval);
                    musicService.off('trackChanged', trackListener);
                    await speakWithDuck("That's all from me – stay groovy!");
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
async function generateDjIntro(theme, guildContext, listenerNames) {
    try {
        const nameList = listenerNames.slice(0, 3).join(', ');
        const promptText = `You are an energetic streaming DJ (like Spotify DJ) named Goobster for the Discord server "${guildContext.name}". There are ${listenerNames.length} listeners${nameList ? `: ${nameList}` : ''}. Welcome them and introduce the upcoming set themed "${theme}". Keep it under 25 words and upbeat.`;
        const result = await aiService.generateText(promptText, { temperature: 0.8, max_tokens: 60 });
        return result.trim();
    } catch (err) {
        console.warn('Failed to generate DJ intro, using fallback.');
        return `Hey everyone, Goobster here! Let's dive into some ${theme} vibes!`;
    }
}

/**
 * Ask OpenAI to build a short, coherent playlist matching the theme and provide an ORDERED list.
 * Returns an array of track objects in order.
 */
async function curateTracksForTheme(tracks, theme, listenerNames, guildContext) {
    try {
        // Sample at most 200 tracks to keep prompt size reasonable
        const shuffled = [...tracks].sort(() => 0.5 - Math.random());
        const sample = shuffled.slice(0, 200);
        const namesBlock = sample.map(t => t.name).join('\n');

        const systemPrompt = 'You are an expert music curator like Spotify DJ. You create short, flowing playlists where each song transitions well to the next.';
        const userPrompt = `Discord server: ${guildContext.name}. Listeners: ${listenerNames.join(', ') || 'N/A'}. Theme: "${theme}".\nBelow is a library list (one per line). Choose **10-20** filenames that best match the theme AND order them for a smooth listening experience. Output ONLY a JSON array (ordered) of filenames.\n\n${namesBlock}`;

        const raw = await aiService.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ], { temperature: 0.7, max_tokens: 400 });

        const jsonMatch = raw.match(/\[.*\]/s);
        if (!jsonMatch) throw new Error('No JSON array found in AI response');
        const selectedNames = JSON.parse(jsonMatch[0]);

        // Map back to track objects preserving order
        const nameToTrack = new Map(tracks.map(t => [t.name, t]));
        const playlistTracks = selectedNames.map(n => nameToTrack.get(n)).filter(Boolean);
        return playlistTracks;
    } catch (err) {
        console.warn('Track curation failed:', err.message);
        return [];
    }
}

/**
 * Generate a brief radio-style track announcement.
 */
async function generateTrackAnnouncement(title, artist, theme, guildContext, listenerNames) {
    try {
        const randomListener = listenerNames.length ? listenerNames[Math.floor(Math.random() * listenerNames.length)] : null;
        const listenerPart = randomListener ? `Give a shout-out to ${randomListener}. ` : '';
        const promptText = `You are Goobster, the DJ for Discord server "${guildContext.name}". ${listenerPart}Introduce the track "${title}" by ${artist} in under 20 words, linking it to the theme "${theme}". Keep it lively.`;
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
async function generateRandomChatter(theme, guildContext, listenerNames) {
    try {
        const nameList = listenerNames.slice(0, 3).join(', ');
        const prompt = `You are Goobster, the DJ for "${guildContext.name}" with listeners ${nameList || 'tuned in'}. Say a fresh, fun remark (<=18 words) relating to the theme "${theme}". Avoid repetition.`;
        const res = await aiService.generateText(prompt, { temperature: 0.85, max_tokens: 40 });
        return res.trim();
    } catch {
        return 'Stay tuned for more great music!';
    }
}