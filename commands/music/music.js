const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const SpotDLService = require('../../services/spotdl/spotdlService');
const { voiceService } = require('../../services/serviceManager');
const { filterTracks, parseTrackName, createTrackListUI } = require('../../utils/musicUtils');

// Instantiate SpotDL once for this command
const spotdlService = new SpotDLService();

// Helper – ensure voice & music services are ready
async function ensureMusicReady(interaction) {
  // Voice channel checks for commands that require being in VC
  const voiceRequired = ['play','pause','resume','skip','stop','volume','playall','shuffle'];
  const cmd = interaction.options.getSubcommand();
  const group = interaction.options.getSubcommandGroup(false);
  const combined = group ? `${group}_${cmd}` : cmd;
  if (voiceRequired.includes(cmd) || ['library_playall','library_shuffle'].includes(combined)) {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      await interaction.editReply('❌ You need to be in a voice channel to use this command!');
      return false;
    }
    // Different channel check
    if (voiceService.musicService && voiceService.musicService.connection) {
      const botChannelId = voiceService.musicService.connection.joinConfig.channelId;
      if (voiceChannel.id !== botChannelId && cmd !== 'play') {
        await interaction.editReply('❌ You need to be in the same voice channel as the bot to control music.');
        return false;
      }
    }
    // Permission check
    const permissions = voiceChannel.permissionsFor(interaction.client.user);
    if (!permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
      await interaction.editReply('❌ I need permissions to join and speak in your voice channel.');
      return false;
    }
  }
  if (!voiceService._isInitialized) {
    await voiceService.initialize();
  }
  if (!voiceService.musicService) {
    await interaction.editReply('Music service is not initialized. Please try again later.');
    return false;
  }
  return true;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('music')
    .setDescription('Music playback & playlist commands')
    // --- Top-level sub-commands ---
    .addSubcommand(sub =>
      sub.setName('play')
        .setDescription('Play or queue a track')
        .addStringOption(opt =>
          opt.setName('track')
            .setDescription('Track to play – "artist - title"')
            .setRequired(true)
            .setAutocomplete(true)))
    .addSubcommand(sub =>
      sub.setName('now')
        .setDescription('Show the current queue / now playing'))
    .addSubcommand(sub =>
      sub.setName('skip').setDescription('Skip the current track'))
    .addSubcommand(sub =>
      sub.setName('pause').setDescription('Pause playback'))
    .addSubcommand(sub =>
      sub.setName('resume').setDescription('Resume playback'))
    .addSubcommand(sub =>
      sub.setName('stop').setDescription('Stop playback & clear queue'))
    .addSubcommand(sub =>
      sub.setName('volume').setDescription('Adjust volume')
        .addIntegerOption(opt =>
          opt.setName('level')
            .setDescription('Volume level 0-100')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(100)))
    // --- Playlist group ---
    .addSubcommandGroup(group =>
      group.setName('playlist')
        .setDescription('Playlist management')
        .addSubcommand(sub =>
          sub.setName('create')
            .setDescription('Create a playlist')
            .addStringOption(opt => opt.setName('name').setDescription('Playlist name').setRequired(true)))
        .addSubcommand(sub =>
          sub.setName('add')
            .setDescription('Add a track to a playlist')
            .addStringOption(opt => opt.setName('playlist_name').setDescription('Playlist').setRequired(true).setAutocomplete(true))
            .addStringOption(opt => opt.setName('track').setDescription('Track search').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub =>
          sub.setName('play')
            .setDescription('Play a playlist')
            .addStringOption(opt => opt.setName('name').setDescription('Playlist').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub =>
          sub.setName('list').setDescription('List saved playlists'))
        .addSubcommand(sub =>
          sub.setName('delete')
            .setDescription('Delete a playlist')
            .addStringOption(opt => opt.setName('name').setDescription('Playlist').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub =>
          sub.setName('fromsearch')
            .setDescription('Create playlist from search')
            .addStringOption(opt => opt.setName('name').setDescription('Playlist name').setRequired(true))
            .addStringOption(opt => opt.setName('search_query').setDescription('Search query').setRequired(true))))
    // --- Library group ---
    .addSubcommandGroup(group =>
      group.setName('library')
        .setDescription('Track library operations')
        .addSubcommand(sub => sub.setName('list').setDescription('List all tracks'))
        .addSubcommand(sub => sub.setName('playall').setDescription('Play all tracks in order'))
        .addSubcommand(sub => sub.setName('shuffle').setDescription('Shuffle play all tracks'))),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const value = focused.value.toLowerCase();
    try {
      if (focused.name === 'track') {
        const tracks = await spotdlService.listTracks();
        const suggestions = filterTracks(tracks, value).slice(0, 25).map(t => {
          const { artist, title } = parseTrackName(t.name);
          return { name: `${title} ‑ ${artist}`, value: `${artist} - ${title}` };
        });
        await interaction.respond(suggestions);
      } else if (['playlist_name', 'name'].includes(focused.name)) {
        if (!voiceService._isInitialized) await voiceService.initialize();
        const playlists = await voiceService.musicService?.listPlaylists(interaction.guildId) || [];
        const suggestions = playlists.filter(p => p.toLowerCase().includes(value)).slice(0, 25).map(p => ({ name: p, value: p }));
        await interaction.respond(suggestions);
      } else {
        await interaction.respond([]);
      }
    } catch (err) {
      console.error('Autocomplete error:', err);
      try { await interaction.respond([]); } catch {}
    }
  },

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false); // may be null
    const sub = interaction.options.getSubcommand();

    await interaction.deferReply();

    // Universal help
    if (!group && sub === 'help') {
      const helpEmbed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('🎶 Music Command Help')
        .setDescription('Quick reference for `/music`')
        .addFields(
          { name: 'Playback', value: '`/music play <track>` – play or queue\n`/music now` – now playing / queue\n`/music pause`, `resume`, `skip`, `stop`\n`/music volume <0-100>`' },
          { name: 'Library', value: '`/music library list`\n`/music library playall`\n`/music library shuffle`' },
          { name: 'Playlist', value: '`/music playlist create <name>`\n`/music playlist add <playlist> <track>`\n`/music playlist play <name>`\n`/music playlist list` / `delete` / `fromsearch`' }
        );
      return interaction.editReply({ embeds: [helpEmbed], ephemeral: true });
    }

    // ================= Playback (top-level) ===================
    if (!group) {
      if (sub === 'play') {
        // Validation & init
        if (!(await ensureMusicReady(interaction))) return;

        const query = interaction.options.getString('track');
        await interaction.editReply('🎵 Searching for track...');
        try {
          const tracks = await spotdlService.listTracks();
          const [track] = filterTracks(tracks, query);
          if (!track) return interaction.editReply('❌ Track not found. Try `/music library list`.');

          const url = await spotdlService.getTrackUrl(track.name);
          const playableTrack = { ...track, url };

          const { artist, title } = parseTrackName(track.name);

          if (voiceService.musicService.isPlaying) {
            const ok = await voiceService.musicService.addToQueue(track);
            return interaction.editReply(ok ? `✅ Queued **${title}** by ${artist}` : '❌ Failed to queue.');
          }

          await voiceService.musicService.joinChannel(interaction.member.voice.channel);
          await voiceService.musicService.playAudio(playableTrack);
          return interaction.editReply(`▶️ Now playing **${title}** by ${artist}`);
        } catch (err) {
          console.error('Play error:', err);
          return interaction.editReply(`❌ ${err.message}`);
        }
      }

      if (sub === 'now') {
        if (!voiceService.musicService) return interaction.editReply('Music service not ready.');
        const queue = voiceService.musicService.getQueue();
        return createTrackListUI(interaction, queue, 'Now Playing / Queue');
      }

      if (sub === 'skip') {
        if (!(await ensureMusicReady(interaction))) return;
        await voiceService.musicService.skip();
        return interaction.editReply('⏭️ Skipped');
      }

      if (sub === 'pause') {
        if (!(await ensureMusicReady(interaction))) return;
        await voiceService.musicService.pause();
        return interaction.editReply('⏸️ Paused');
      }

      if (sub === 'resume') {
        if (!(await ensureMusicReady(interaction))) return;
        await voiceService.musicService.resume();
        return interaction.editReply('▶️ Resumed');
      }

      if (sub === 'stop') {
        if (!(await ensureMusicReady(interaction))) return;
        await voiceService.musicService.stop();
        return interaction.editReply('⏹️ Stopped & cleared queue');
      }

      if (sub === 'volume') {
        if (!(await ensureMusicReady(interaction))) return;
        const level = interaction.options.getInteger('level');
        await voiceService.musicService.setVolume(level);
        return interaction.editReply(`🔊 Volume set to ${level}%`);
      }
    }

    // ================= Playlist group ===================
    if (group === 'playlist') {
      if (!(await ensureMusicReady(interaction))) return;
      switch (sub) {
        case 'create': {
          const name = interaction.options.getString('name');
          await voiceService.musicService.createPlaylist(interaction.guildId, name);
          return interaction.editReply(`✅ Playlist '${name}' created.`);
        }
        case 'add': {
          const playlistName = interaction.options.getString('playlist_name');
          const query = interaction.options.getString('track');
          const tracks = await spotdlService.listTracks();
          const [track] = filterTracks(tracks, query);
          if (!track) return interaction.editReply('❌ Track not found.');
          await voiceService.musicService.addToPlaylist(interaction.guildId, playlistName, track);
          const { artist, title } = parseTrackName(track.name);
          return interaction.editReply(`➕ Added **${title}** by ${artist} to '${playlistName}'.`);
        }
        case 'play': {
          const name = interaction.options.getString('name');
          await voiceService.musicService.joinChannel(interaction.member.voice.channel);
          await voiceService.musicService.playPlaylist(interaction.guildId, name);
          return interaction.editReply(`▶️ Playing playlist '${name}'.`);
        }
        case 'list': {
          const playlists = await voiceService.musicService.listPlaylists(interaction.guildId);
          if (!playlists.length) return interaction.editReply('No playlists found.');
          const embed = new EmbedBuilder().setColor('#00aaff').setTitle('Saved Playlists').setDescription(playlists.map((n,i)=>`${i+1}. ${n}`).join('\n'));
          return interaction.editReply({ embeds:[embed] });
        }
        case 'delete': {
          const name = interaction.options.getString('name');
          await voiceService.musicService.deletePlaylist(interaction.guildId, name);
          return interaction.editReply(`🗑️ Deleted playlist '${name}'.`);
        }
        case 'fromsearch': {
          const name = interaction.options.getString('name');
          const query = interaction.options.getString('search_query');
          const allTracks = await spotdlService.listTracks();
          const tracks = filterTracks(allTracks, query);
          if (!tracks.length) return interaction.editReply('❌ No tracks found for search.');
          await voiceService.musicService.createOrUpdatePlaylistFromTracks(interaction.guildId, name, tracks);
          return interaction.editReply(`✅ Playlist '${name}' created with ${tracks.length} tracks.`);
        }
      }
    }

    // ================= Library group ===================
    if (group === 'library') {
      if (sub === 'list') {
        const tracks = await spotdlService.listTracks();
        return createTrackListUI(interaction, tracks, 'Track Library');
      }
      if (!(await ensureMusicReady(interaction))) return;
      if (sub === 'playall') {
        await voiceService.musicService.joinChannel(interaction.member.voice.channel);
        const res = await voiceService.musicService.playAllTracks();
        return interaction.editReply(`▶️ Playing all ${res.totalTracks} tracks. Now playing **${res.currentTrack.title}** by ${res.currentTrack.artist}`);
      }
      if (sub === 'shuffle') {
        await voiceService.musicService.joinChannel(interaction.member.voice.channel);
        const res = await voiceService.musicService.shuffleAllTracks();
        return interaction.editReply(`🔀 Shuffle playing ${res.totalTracks} tracks. Now playing **${res.currentTrack.title}** by ${res.currentTrack.artist}`);
      }
    }
  }
}; 