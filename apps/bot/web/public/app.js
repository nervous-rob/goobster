/**
 * Goobster control panel client (800x400 touch layout).
 * Views: guild browser -> per-guild dashboard
 * (Overview / Messages / Voice / Music / Settings).
 */

import { api, ApiError } from './api.js';
import { initKeyboard } from './keyboard.js';

const $ = (id) => document.getElementById(id);

const SYSTEM_POLL_MS = 10000;

const state = {
    guilds: [],
    guild: null,          // selected guild card
    channels: { text: [], voice: [] },
    tab: 'overview',
    messageMode: 'exact', // 'exact' | 'ai'
    voiceMode: 'polite',
    voiceEngine: 'realtime', // 'realtime' | 'classic'
    status: null,
    system: null,         // host health snapshot (GET /api/system)
    music: null,
    voiceChat: null,
    settings: null,       // per-guild settings snapshot
    catalogs: new Map(),  // provider key -> model catalog (GET /api/ai/models)
    catalogLoading: null, // provider key currently being fetched
    trackSearchTimer: null
};

/* ---------- Toast & confirm dialog ---------- */

let toastTimer = null;
function toast(message, isError = false) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function confirmDialog(message) {
    return new Promise((resolve) => {
        const backdrop = $('dialog-backdrop');
        $('dialog-text').textContent = message;
        backdrop.classList.remove('hidden');
        const done = (answer) => {
            backdrop.classList.add('hidden');
            $('dialog-confirm').onclick = null;
            $('dialog-cancel').onclick = null;
            resolve(answer);
        };
        $('dialog-confirm').onclick = () => done(true);
        $('dialog-cancel').onclick = () => done(false);
    });
}

/**
 * Run an action; when the API answers 409 with requiresConfirmation, show
 * the dialog and retry with the confirmation flag set.
 */
async function withConfirmRetry(action, buildRetry) {
    try {
        return await action();
    } catch (error) {
        if (error instanceof ApiError && error.details.requiresConfirmation) {
            const ok = await confirmDialog(error.message);
            if (!ok) return null;
            return await buildRetry();
        }
        throw error;
    }
}

function reportError(error) {
    if (error instanceof ApiError) {
        toast(error.message, true);
    } else {
        toast('Cannot reach Goobster on this device.', true);
    }
}

/* ---------- Top-level navigation ---------- */

function showGuildBrowser() {
    state.guild = null;
    $('view-guilds').classList.remove('hidden');
    $('view-guild').classList.add('hidden');
    $('back-btn').classList.add('hidden');
    $('topbar-title').textContent = 'Goobster';
    refreshGuilds();
}

async function openGuild(guild) {
    state.guild = guild;
    $('topbar-title').textContent = guild.name;
    $('view-guilds').classList.add('hidden');
    $('view-guild').classList.remove('hidden');
    $('back-btn').classList.remove('hidden');
    selectTab('overview');
    try {
        state.channels = await api.get(`/api/guilds/${guild.id}/channels`);
    } catch (error) {
        state.channels = { text: [], voice: [] };
        reportError(error);
    }
    populateChannelSelects();
    refreshGuildState();
    loadTracks('');
    loadPlaylists();
    loadSettings();
}

function selectTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    for (const pane of ['overview', 'messages', 'voice', 'music', 'settings']) {
        $(`tab-${pane}`).classList.toggle('hidden', pane !== tab);
    }
    if (tab === 'settings') loadSettings();
    if (tab === 'overview') refreshSystem();
}

/* ---------- Status & guild browser ---------- */

function formatUptime(ms) {
    if (!ms || ms < 0) return '–';
    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

async function refreshStatus() {
    try {
        state.status = await api.get('/api/status');
    } catch {
        state.status = null;
    }
    const ready = Boolean(state.status?.ready);
    $('status-dot').className = `dot ${ready ? 'online' : 'offline'}`;
    $('status-text').textContent = ready ? state.status.botTag : 'Offline';
    renderOverview();
    if (state.guild) renderVoiceChat(); // capabilities gate the Voice tab
}

async function refreshSystem() {
    try {
        state.system = await api.get('/api/system');
    } catch {
        state.system = null;
    }
    renderHostHealth();
}

async function refreshGuilds() {
    if (state.guild) return;
    try {
        const { guilds } = await api.get('/api/guilds');
        state.guilds = guilds;
        renderGuildList();
    } catch {
        // status poll already reflects connectivity
    }
}

function renderGuildList() {
    const list = $('guild-list');
    list.innerHTML = '';
    $('guilds-empty').classList.toggle('hidden', state.guilds.length > 0);
    for (const guild of state.guilds) {
        const card = document.createElement('button');
        card.className = 'guild-card';
        const badges = [
            guild.musicActive ? '<span class="badge music">♪ Music</span>' : '',
            guild.voiceChatActive ? '<span class="badge voice">🎙 Voice</span>' : ''
        ].join('');
        const icon = guild.iconUrl
            ? `<img src="${guild.iconUrl}" alt="">`
            : escapeHtml(guild.name.slice(0, 1).toUpperCase());
        card.innerHTML = `
            <div class="guild-icon">${icon}</div>
            <div class="guild-meta">
                <div class="guild-name">${escapeHtml(guild.name)}</div>
                <div class="guild-sub">${badges}${guild.memberCount != null ? `${guild.memberCount} members` : ''}</div>
            </div>`;
        card.addEventListener('click', () => openGuild(guild));
        list.appendChild(card);
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
}

/* ---------- Overview tab ---------- */

function renderOverview() {
    if (!state.guild) return;
    const s = state.status;
    $('ov-bot').textContent = s?.ready ? s.botTag : 'Offline';
    $('ov-ping').textContent = s?.ping != null ? `${s.ping} ms` : '–';
    $('ov-uptime').textContent = formatUptime(s?.uptimeMs);
    $('ov-provider').textContent = s?.provider
        ? `${s.provider}${s.model ? ` · ${s.model}` : ''}`
        : '–';

    const music = state.music;
    if (music?.connected && music.guildId === state.guild.id) {
        $('ov-music').textContent = music.currentTrack ? `♪ ${music.currentTrack.title}` : 'Connected';
    } else if (music?.connected) {
        $('ov-music').textContent = `Active in ${music.guildName || 'another server'}`;
    } else {
        $('ov-music').textContent = 'Idle';
    }
    $('ov-voice').textContent = state.voiceChat?.active
        ? `Live in ${state.voiceChat.channelName} (${state.voiceChat.mode}, ${state.voiceChat.engine || 'realtime'})`
        : 'Idle';
}

/* ---------- Host health (Overview → This device) ---------- */

function formatBytes(bytes) {
    if (bytes == null || !Number.isFinite(bytes)) return '–';
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) return `${Math.round(mb)} MB`;
    const gb = mb / 1024;
    return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

function formatSeconds(seconds) {
    if (seconds == null) return '–';
    return formatUptime(seconds * 1000);
}

/** Set a stat's value and its ok/warn/danger tint in one go. */
function setStat(id, text, tone = '') {
    const value = $(id);
    value.textContent = text;
    const card = value.closest('.stat');
    card.classList.remove('ok', 'warn', 'danger');
    if (tone) card.classList.add(tone);
}

function renderHostHealth() {
    const h = state.system;
    if (!h) {
        for (const id of ['ov-temp', 'ov-throttle', 'ov-load', 'ov-memory', 'ov-disk', 'ov-db']) setStat(id, '–');
        $('ov-host-line').textContent = '';
        return;
    }

    const temp = h.cpu?.temperatureC;
    if (temp == null) {
        setStat('ov-temp', 'n/a');
    } else {
        // Pi firmware soft-limits at 80 °C and throttles hard at 85 °C.
        setStat('ov-temp', `${temp.toFixed(1)} °C`, temp >= 80 ? 'danger' : temp >= 70 ? 'warn' : 'ok');
    }

    const throttle = h.cpu?.throttle;
    if (!throttle) {
        setStat('ov-throttle', 'n/a');
    } else if (throttle.flags.length === 0) {
        setStat('ov-throttle', 'None', 'ok');
    } else {
        setStat('ov-throttle', throttle.flags.join(', '), 'danger');
    }

    const load = h.cpu?.load || [];
    const cores = h.cpu?.cores || 1;
    const load1 = load[0] ?? null;
    setStat('ov-load', load.length ? load.slice(0, 2).map(v => v.toFixed(2)).join(' / ') : '–',
        load1 == null ? '' : load1 >= cores ? 'danger' : load1 >= cores * 0.7 ? 'warn' : '');

    const mem = h.memory;
    if (mem) {
        const pct = Math.round((mem.usedBytes / mem.totalBytes) * 100);
        setStat('ov-memory', `${pct}% · ${formatBytes(mem.processRssBytes)}`,
            pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : '');
    } else {
        setStat('ov-memory', '–');
    }

    const disk = h.disk;
    if (disk) {
        const pct = Math.round((disk.usedBytes / disk.totalBytes) * 100);
        setStat('ov-disk', `${formatBytes(disk.freeBytes)} · ${pct}%`,
            pct >= 95 ? 'danger' : pct >= 85 ? 'warn' : '');
    } else {
        setStat('ov-disk', 'n/a');
    }

    const database = h.database;
    setStat('ov-db', database
        ? `${database.engine === 'postgres' ? 'Postgres' : 'SQLite'} · ${formatBytes(database.bytes)}`
        : 'Unavailable');

    $('ov-host-line').textContent = [
        h.os ? `${h.os.type} ${h.os.release} (${h.os.arch})` : null,
        h.os ? `up ${formatSeconds(h.os.uptimeSeconds)}` : null,
        h.cpu ? `${h.cpu.cores} cores` : null,
        h.process ? `Node ${h.process.nodeVersion}` : null,
        database ? `${database.messageCount} messages stored` : null
    ].filter(Boolean).join(' · ');
}

/* ---------- Channel selects ---------- */

function fillSelect(select, items, placeholder, prefix = '#') {
    select.innerHTML = '';
    if (placeholder) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = placeholder;
        select.appendChild(opt);
    }
    for (const item of items) {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.textContent = `${prefix}${item.name}`;
        select.appendChild(opt);
    }
}

function populateChannelSelects() {
    fillSelect($('msg-channel'), state.channels.text, state.channels.text.length ? null : 'No usable text channels');
    fillSelect($('voice-channel'), state.channels.voice, state.channels.voice.length ? null : 'No usable voice channels', '🔊 ');
    fillSelect($('voice-transcript'), state.channels.text, 'No transcript');
    fillSelect($('mu-channel'), state.channels.voice, state.channels.voice.length ? null : 'No usable voice channels', '🔊 ');
}

/* ---------- Messages tab ---------- */

function setMessageMode(mode) {
    state.messageMode = mode;
    $('mode-exact').classList.toggle('active', mode === 'exact');
    $('mode-ai').classList.toggle('active', mode === 'ai');
    $('msg-text').placeholder = mode === 'exact'
        ? 'Message to send as Goobster…'
        : 'Private instruction for Goobster (e.g. "hype up movie night tonight")…';
    hideDraft();
    updateMessagePrimary();
}

function hideDraft() {
    $('draft-box').classList.add('hidden');
    $('draft-discard').classList.add('hidden');
    $('draft-text').value = '';
}

function draftVisible() {
    return !$('draft-box').classList.contains('hidden');
}

function updateMessagePrimary() {
    const btn = $('msg-primary');
    if (state.messageMode === 'exact') {
        btn.textContent = 'Send';
    } else {
        btn.textContent = draftVisible() ? 'Post draft' : 'Generate draft';
    }
}

async function onMessagePrimary() {
    const guildId = state.guild?.id;
    const channelId = $('msg-channel').value;
    if (!guildId || !channelId) {
        toast('Pick a text channel first.', true);
        return;
    }
    const btn = $('msg-primary');
    btn.disabled = true;
    try {
        if (state.messageMode === 'exact') {
            const content = $('msg-text').value.trim();
            if (!content) { toast('Type a message first.', true); return; }
            await api.post(`/api/guilds/${guildId}/messages`, { channelId, content });
            $('msg-text').value = '';
            toast('Message sent.');
        } else if (!draftVisible()) {
            const instruction = $('msg-text').value.trim();
            if (!instruction) { toast('Type an instruction first.', true); return; }
            btn.textContent = 'Generating…';
            const { draft } = await api.post(`/api/guilds/${guildId}/draft`, { channelId, instruction });
            $('draft-text').value = draft;
            $('draft-box').classList.remove('hidden');
            $('draft-discard').classList.remove('hidden');
        } else {
            const content = $('draft-text').value.trim();
            if (!content) { toast('The draft is empty.', true); return; }
            await api.post(`/api/guilds/${guildId}/messages`, { channelId, content });
            hideDraft();
            $('msg-text').value = '';
            toast('Draft posted.');
        }
    } catch (error) {
        reportError(error);
    } finally {
        btn.disabled = false;
        updateMessagePrimary();
    }
}

/* ---------- Voice tab ---------- */

const ENGINE_HINTS = {
    realtime: 'Low latency, interruptible — ElevenLabs speech-to-text and voice.',
    classic: 'Waits for a clear pause — OpenAI speech-to-text, ElevenLabs voice.'
};

function setVoiceEngine(engine) {
    state.voiceEngine = engine;
    $('voice-engine-realtime').classList.toggle('active', engine === 'realtime');
    $('voice-engine-classic').classList.toggle('active', engine === 'classic');
    renderVoiceChat();
}

function renderVoiceChat() {
    const vc = state.voiceChat;
    const capabilities = state.status?.capabilities;
    const active = Boolean(vc?.active);
    $('voice-active').classList.toggle('hidden', !active);
    $('voice-setup').classList.toggle('hidden', active);
    if (active) {
        $('voice-active-text').textContent =
            `Live voice conversation in ${vc.channelName} (${vc.mode} mode, ${vc.engine || 'realtime'} engine, ${vc.turns} turns).`;
    }
    $('voice-engine-hint').textContent = ENGINE_HINTS[state.voiceEngine];

    // The realtime engine is ElevenLabs end to end; classic adds OpenAI STT.
    const engines = capabilities?.voiceEngines
        || (capabilities ? { realtime: capabilities.tts, classic: capabilities.tts && capabilities.stt } : null);
    let hint = '';
    if (capabilities && !capabilities.tts) {
        hint = 'Unavailable: ElevenLabs is not configured (ELEVENLABS_API_KEY).';
    } else if (engines && !engines[state.voiceEngine]) {
        hint = state.voiceEngine === 'classic'
            ? 'The classic engine needs an OpenAI API key for speech-to-text. Realtime still works.'
            : 'The realtime engine is unavailable on this host.';
    }
    $('voice-hint').textContent = hint;
    $('voice-start').disabled = Boolean(hint) || state.channels.voice.length === 0;
}

async function onVoiceStart() {
    const guildId = state.guild?.id;
    const voiceChannelId = $('voice-channel').value;
    if (!guildId || !voiceChannelId) {
        toast('Pick a voice channel first.', true);
        return;
    }
    const body = {
        voiceChannelId,
        mode: state.voiceMode,
        engine: state.voiceEngine,
        transcriptChannelId: $('voice-transcript').value || null
    };
    try {
        await withConfirmRetry(
            () => api.post(`/api/guilds/${guildId}/voicechat/start`, body),
            () => api.post(`/api/guilds/${guildId}/voicechat/start`, { ...body, confirm: true })
        );
        refreshGuildState();
    } catch (error) {
        reportError(error);
    }
}

async function onVoiceStop() {
    try {
        await api.post(`/api/guilds/${state.guild.id}/voicechat/stop`);
        refreshGuildState();
    } catch (error) {
        reportError(error);
    }
}

/* ---------- Music tab ---------- */

function renderMusic() {
    const music = state.music;
    if (!music?.available) {
        $('np-title').textContent = 'Music service unavailable';
        $('np-artist').textContent = '';
        $('np-where').textContent = '';
        return;
    }
    if (music.currentTrack && music.connected) {
        $('np-title').textContent = music.currentTrack.title;
        $('np-artist').textContent = music.currentTrack.artist;
    } else {
        $('np-title').textContent = 'Nothing playing';
        $('np-artist').textContent = '';
    }
    if (music.connected) {
        const here = state.guild && music.guildId === state.guild.id;
        $('np-where').textContent = here
            ? `In 🔊 ${music.channelName || 'voice channel'}${music.isPaused ? ' · paused' : ''}`
            : `Goobster is playing in ${music.guildName || 'another server'}`;
    } else {
        $('np-where').textContent = 'Not connected to a voice channel';
    }
    if (document.activeElement !== $('mu-volume')) {
        $('mu-volume').value = music.volume ?? 100;
    }
}

async function musicControl(action) {
    try {
        await api.post('/api/music/control', { action });
        refreshGuildState();
    } catch (error) {
        reportError(error);
    }
}

async function onPauseResume() {
    if (!state.music?.connected) return;
    await musicControl(state.music.isPaused ? 'resume' : 'pause');
}

async function playTrack(query) {
    const guildId = state.guild?.id;
    const channelId = $('mu-channel').value;
    if (!guildId || !channelId) {
        toast('Pick a voice channel first.', true);
        return;
    }
    const body = { guildId, channelId, query };
    try {
        const result = await withConfirmRetry(
            () => api.post('/api/music/play', body),
            () => api.post('/api/music/play', { ...body, confirmMove: true })
        );
        if (result) {
            toast(result.queued ? `Queued: ${result.track.title}` : `Playing: ${result.track.title}`);
        }
        refreshGuildState();
    } catch (error) {
        reportError(error);
    }
}

async function playCollection({ playlist = null, shuffle = false }) {
    const guildId = state.guild?.id;
    const channelId = $('mu-channel').value;
    if (!guildId || !channelId) {
        toast('Pick a voice channel first.', true);
        return;
    }
    const body = { guildId, channelId, playlist, shuffle };
    try {
        const result = await withConfirmRetry(
            () => api.post('/api/music/play-collection', body),
            () => api.post('/api/music/play-collection', { ...body, confirmMove: true })
        );
        if (result?.currentTrack) {
            toast(`Playing ${result.totalTracks} tracks — first: ${result.currentTrack.title}`);
        }
        refreshGuildState();
    } catch (error) {
        reportError(error);
    }
}

async function loadTracks(search) {
    try {
        const { tracks } = await api.get(`/api/tracks?search=${encodeURIComponent(search)}`);
        const list = $('track-list');
        list.innerHTML = '';
        if (tracks.length === 0) {
            list.innerHTML = '<div class="hint" style="padding:8px">No local tracks found.</div>';
            return;
        }
        for (const track of tracks.slice(0, 50)) {
            const row = document.createElement('div');
            row.className = 'track-row';
            row.innerHTML = `
                <div>
                    <div class="track-title">${escapeHtml(track.title)}</div>
                    <div class="track-artist">${escapeHtml(track.artist)}</div>
                </div>`;
            const btn = document.createElement('button');
            btn.className = 'btn';
            btn.textContent = 'Play';
            btn.addEventListener('click', () => playTrack(track.name));
            row.appendChild(btn);
            list.appendChild(row);
        }
    } catch (error) {
        reportError(error);
    }
}

async function loadPlaylists() {
    try {
        const { playlists } = await api.get(`/api/guilds/${state.guild.id}/playlists`);
        fillSelect($('mu-playlist'), playlists.map(name => ({ id: name, name })), playlists.length ? null : 'No playlists', '');
        $('mu-play-playlist').disabled = playlists.length === 0;
    } catch {
        fillSelect($('mu-playlist'), [], 'No playlists', '');
        $('mu-play-playlist').disabled = true;
    }
}

/* ---------- Settings tab ---------- */

async function loadSettings() {
    if (!state.guild) return;
    try {
        state.settings = await api.get(`/api/guilds/${state.guild.id}/settings`);
        renderSettings();
    } catch (error) {
        state.settings = null;
        reportError(error);
    }
}

function setToggle(id, on) {
    const el = $(id);
    el.classList.toggle('on', Boolean(on));
    el.setAttribute('aria-checked', String(Boolean(on)));
}

function renderSettings() {
    const s = state.settings;
    if (!s) return;

    setToggle('set-proactive', s.proactiveMode);
    setToggle('set-monologue', s.monologueMode);
    setToggle('set-dynamic', s.dynamicResponse);
    setToggle('set-reply-detection', s.replyDetection);
    setToggle('set-search', s.searchApproval);
    setToggle('set-thoughtful', s.ai.thoughtful);
    $('set-thoughtful').disabled = !s.ai.thoughtfulAvailable && !s.ai.thoughtful;
    $('thoughtful-sub').textContent = s.ai.defaults.thoughtfulModel
        ? `${s.ai.defaults.thoughtfulModel} · high effort`
        : 'needs a cloud AI provider';

    $('set-thread-channel').classList.toggle('active', s.threadPreference === 'ALWAYS_CHANNEL');
    $('set-thread-thread').classList.toggle('active', s.threadPreference === 'ALWAYS_THREAD');

    renderAiPickers();

    if (document.activeElement !== $('set-directive')) {
        $('set-directive').value = s.personalityDirective || '';
    }
    if (document.activeElement !== $('set-nickname')) {
        $('set-nickname').value = s.botNickname || '';
    }
    if (document.activeElement !== $('set-retention')) {
        $('set-retention').value = s.memory.retentionDays ?? 0;
    }

    const stats = s.memory.stats;
    $('memory-stats-sub').textContent =
        `${stats.count} memories · ${s.memory.facts.userFacts + s.memory.facts.guildFacts} facts · ${s.memory.pendingFollowups} follow-ups`;
    $('forget-all').disabled = stats.count === 0;

    // Exclude picker: text channels that aren't already excluded
    const excludedIds = new Set(s.memory.excludedChannels.map(c => c.id));
    const candidates = state.channels.text.filter(c => !excludedIds.has(c.id));
    fillSelect($('exclude-channel'), candidates, candidates.length ? null : 'No channels');
    $('exclude-btn').disabled = candidates.length === 0;

    const list = $('excluded-list');
    list.innerHTML = '';
    for (const channel of s.memory.excludedChannels) {
        const row = document.createElement('div');
        row.className = 'excluded-row';
        const label = document.createElement('div');
        label.textContent = `🙈 #${channel.name || channel.id} is not remembered`;
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = 'Include';
        btn.addEventListener('click', () => setExclusion(channel.id, false));
        row.append(label, btn);
        list.appendChild(row);
    }

    $('voice-settings-group').classList.toggle('hidden', !s.global.ttsAvailable);
    const globalVoiceLabel = s.global.ttsVoiceName || s.global.ttsVoiceId || 'the built-in default';
    $('tts-voice-sub').textContent = s.global.ttsVoiceName
        ? `Current: ${s.global.ttsVoiceName} · all servers without their own`
        : 'ElevenLabs voice name or ID · all servers without their own';
    if (document.activeElement !== $('set-voice-id')) {
        $('set-voice-id').value = s.global.ttsVoiceName || s.global.ttsVoiceId || '';
    }
    const guildVoice = s.voice || {};
    $('guild-voice-sub').textContent = guildVoice.voiceId
        ? `Current: ${guildVoice.voiceName || guildVoice.voiceId}`
        : `Using the default voice (${globalVoiceLabel})`;
    if (document.activeElement !== $('set-guild-voice')) {
        $('set-guild-voice').value = guildVoice.voiceName || guildVoice.voiceId || '';
    }
    $('clear-guild-voice').disabled = !guildVoice.voiceId;
    if (s.global.ttsAvailable) loadVoiceOptions();
}

/* ---------- AI pickers (provider → model → reasoning) ---------- */

function addOption(select, value, label, { disabled = false, selected = false } = {}) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.disabled = disabled;
    option.selected = selected;
    select.appendChild(option);
    return option;
}

/**
 * Rebuild the provider, model and reasoning selects from the settings
 * snapshot plus the effective provider's catalog. The catalog is fetched
 * lazily per provider and cached; while it loads the model select says so.
 */
function renderAiPickers() {
    const s = state.settings;
    if (!s) return;
    const ai = s.ai;
    const providers = ai.providers || [];
    const effectiveKey = ai.effective?.provider || ai.defaults.provider;

    const providerSelect = $('set-provider');
    providerSelect.innerHTML = '';
    const defaultProvider = providers.find(p => p.key === ai.defaults.provider);
    addOption(providerSelect, '', `Default (${defaultProvider?.name || ai.defaults.provider || 'auto'})`);
    for (const provider of providers) {
        addOption(providerSelect, provider.key,
            provider.configured ? provider.name : `${provider.name} — not configured`,
            { disabled: !provider.configured && ai.provider !== provider.key });
    }
    providerSelect.value = ai.provider || '';

    const modelSelect = $('set-model');
    const reasoningSelect = $('set-reasoning');
    const catalog = state.catalogs.get(effectiveKey);
    if (!catalog) {
        modelSelect.innerHTML = '';
        addOption(modelSelect, ai.model || '', ai.model || `Default (${ai.effective?.model || 'provider default'})`);
        modelSelect.disabled = true;
        reasoningSelect.innerHTML = '';
        addOption(reasoningSelect, ai.reasoningEffort || '', ai.reasoningEffort || 'Default');
        reasoningSelect.disabled = true;
        $('model-sub').textContent = 'Loading the model catalog…';
        $('reasoning-sub').textContent = '';
        loadCatalog(effectiveKey);
    } else {
        renderModelPicker(catalog);
        renderReasoningPicker(catalog);
    }

    const effective = ai.effective;
    const parts = [];
    if (effective) {
        parts.push(`Using ${effective.providerName}`);
        parts.push(effective.model || 'provider default');
        if (effective.reasoningEffort) parts.push(`${effective.reasoningEffort} effort`);
        if (effective.modelSupported === false) parts.push('⚠ not in the model registry');
    }
    $('ai-effective').textContent = parts.join(' · ');
}

function renderModelPicker(catalog) {
    const ai = state.settings.ai;
    const modelSelect = $('set-model');
    modelSelect.innerHTML = '';
    modelSelect.disabled = false;
    addOption(modelSelect, '', `Default (${catalog.defaultModel || 'provider default'})`);
    let currentListed = false;
    for (const model of catalog.models) {
        if (model.id === ai.model) currentListed = true;
        const suffix = model.selectable ? '' : model.availability === 'not-listed' ? ' — not on this key' : ' — unavailable';
        addOption(modelSelect, model.id, `${model.displayName}${suffix}`,
            { disabled: !model.selectable && model.id !== ai.model });
    }
    if (ai.model && !currentListed) {
        addOption(modelSelect, ai.model, `${ai.model} (custom)`);
    }
    modelSelect.value = ai.model || '';

    const discovery = catalog.discovery || {};
    const countLabel = `${catalog.models.filter(m => m.selectable).length} usable of ${catalog.models.length}`;
    let discoveryLabel = '';
    if (discovery.status === 'live' || discovery.status === 'cached') discoveryLabel = 'checked against the provider';
    else if (discovery.status === 'not-configured') discoveryLabel = 'provider not configured';
    else if (discovery.status === 'stale') discoveryLabel = 'availability may be stale';
    else if (discovery.status === 'unavailable') discoveryLabel = 'provider listing unavailable';
    $('model-sub').textContent = [countLabel, discoveryLabel].filter(Boolean).join(' · ');
}

function renderReasoningPicker(catalog) {
    const ai = state.settings.ai;
    const reasoningSelect = $('set-reasoning');
    reasoningSelect.innerHTML = '';
    const selectedId = ai.model || catalog.defaultModel;
    const model = catalog.models.find(m => m.id === selectedId) || null;
    const levels = model?.reasoning?.levels || [];
    if (levels.length === 0) {
        addOption(reasoningSelect, '', model ? 'Not adjustable for this model' : 'Default');
        reasoningSelect.disabled = true;
        $('reasoning-sub').textContent = model ? `${model.displayName} has one reasoning setting` : '';
        return;
    }
    reasoningSelect.disabled = false;
    addOption(reasoningSelect, '', `Default (${model.reasoning.default || levels[0]})`);
    for (const level of levels) {
        addOption(reasoningSelect, level, level.charAt(0).toUpperCase() + level.slice(1));
    }
    if (ai.reasoningEffort && !levels.includes(ai.reasoningEffort)) {
        addOption(reasoningSelect, ai.reasoningEffort, `${ai.reasoningEffort} (unsupported)`);
    }
    reasoningSelect.value = ai.reasoningEffort || '';
    $('reasoning-sub').textContent = `${model.displayName}: ${levels.join(' · ')}`;
}

async function loadCatalog(providerKey) {
    if (!providerKey || state.catalogLoading === providerKey || state.catalogs.has(providerKey)) return;
    state.catalogLoading = providerKey;
    try {
        const catalog = await api.get(`/api/ai/models?provider=${encodeURIComponent(providerKey)}`);
        state.catalogs.set(providerKey, catalog);
    } catch (error) {
        // Leave the picker in its fallback state; the message still shows.
        $('model-sub').textContent = error instanceof ApiError ? error.message : 'Catalog unavailable.';
        return;
    } finally {
        state.catalogLoading = null;
    }
    if (state.settings) renderAiPickers();
}

let voiceOptionsLoaded = false;

/** Fill the TTS voice picker with the account's real voice library. */
async function loadVoiceOptions() {
    if (voiceOptionsLoaded) return;
    voiceOptionsLoaded = true;
    try {
        const voices = await api.get('/api/settings/tts-voices');
        const datalist = $('voice-options');
        datalist.innerHTML = '';
        for (const voice of voices) {
            const option = document.createElement('option');
            option.value = voice.name;
            datalist.appendChild(option);
        }
    } catch {
        voiceOptionsLoaded = false; // picker degrades to free text; retry later
    }
}

async function patchSettings(patch, successMessage = 'Setting saved.') {
    if (!state.guild) return;
    try {
        const applied = await api.patch(`/api/guilds/${state.guild.id}/settings`, patch);
        let message = successMessage;
        if (typeof applied.memoriesPurged === 'number' && applied.memoriesPurged > 0) {
            message += ` ${applied.memoriesPurged} old memories purged.`;
        }
        toast(message);
    } catch (error) {
        reportError(error);
    }
    loadSettings();
}

async function setExclusion(channelId, exclude) {
    if (!state.guild) return;
    if (exclude) {
        const name = state.channels.text.find(c => c.id === channelId)?.name || 'that channel';
        const ok = await confirmDialog(
            `Stop remembering #${name}? Stored memories and activity counts from it will be deleted now.`);
        if (!ok) return;
    }
    try {
        const result = await api.post(`/api/guilds/${state.guild.id}/memory/exclusions`, { channelId, exclude });
        toast(exclude
            ? `Channel excluded${result.removedMemories ? ` — ${result.removedMemories} memories deleted` : ''}.`
            : 'Channel included again.');
    } catch (error) {
        reportError(error);
    }
    loadSettings();
}

async function onForgetAll() {
    const count = state.settings?.memory?.stats?.count ?? 0;
    const ok = await confirmDialog(
        `Delete ALL ${count} long-term memories for ${state.guild.name}? This cannot be undone.`);
    if (!ok) return;
    try {
        const { removed } = await api.post(`/api/guilds/${state.guild.id}/memory/forget`);
        toast(`Deleted ${removed} memories.`);
    } catch (error) {
        reportError(error);
    }
    loadSettings();
}

function wireSettings() {
    const toggles = [
        ['set-proactive', () => ({ proactiveMode: !state.settings.proactiveMode })],
        ['set-monologue', () => ({ monologueMode: !state.settings.monologueMode })],
        ['set-dynamic', () => ({ dynamicResponse: !state.settings.dynamicResponse })],
        ['set-reply-detection', () => ({ replyDetection: !state.settings.replyDetection })],
        ['set-search', () => ({ searchApproval: !state.settings.searchApproval })],
        ['set-thoughtful', () => ({ thoughtfulMode: !state.settings.ai.thoughtful })]
    ];
    for (const [id, buildPatch] of toggles) {
        $(id).addEventListener('click', () => {
            if (state.settings) patchSettings(buildPatch());
        });
    }

    $('set-thread-channel').addEventListener('click', () => patchSettings({ threadPreference: 'ALWAYS_CHANNEL' }));
    $('set-thread-thread').addEventListener('click', () => patchSettings({ threadPreference: 'ALWAYS_THREAD' }));

    $('set-provider').addEventListener('change', (e) => patchSettings({ aiProvider: e.target.value }));
    $('set-reasoning').addEventListener('change', (e) => patchSettings({ aiReasoningEffort: e.target.value }));
    $('set-model').addEventListener('change', (e) => patchSettings({ aiModel: e.target.value.trim() }));

    $('save-directive').addEventListener('click', () =>
        patchSettings({ personalityDirective: $('set-directive').value.trim() }, 'Personality directive saved.'));
    $('clear-directive').addEventListener('click', () => {
        $('set-directive').value = '';
        patchSettings({ personalityDirective: null }, 'Personality directive cleared.');
    });

    $('save-nickname').addEventListener('click', () =>
        patchSettings({ botNickname: $('set-nickname').value.trim() || null }, 'Nickname saved.'));

    $('save-retention').addEventListener('click', () => {
        const days = Number($('set-retention').value);
        patchSettings({ memoryRetentionDays: Number.isInteger(days) ? days : 0 },
            days > 0 ? `Memories now expire after ${days} days.` : 'Memories are kept forever.');
    });

    $('exclude-btn').addEventListener('click', () => {
        const channelId = $('exclude-channel').value;
        if (channelId) setExclusion(channelId, true);
    });
    $('forget-all').addEventListener('click', onForgetAll);

    $('save-guild-voice').addEventListener('click', () => {
        const voice = $('set-guild-voice').value.trim();
        if (!voice) { toast('Enter a voice name or ID first.', true); return; }
        patchSettings({ ttsVoice: voice }, `Voice set for ${state.guild.name}.`);
    });
    $('clear-guild-voice').addEventListener('click', () => {
        $('set-guild-voice').value = '';
        patchSettings({ ttsVoice: null }, 'Back to the default voice for this server.');
    });

    $('save-voice-id').addEventListener('click', async () => {
        const voiceId = $('set-voice-id').value.trim();
        if (!voiceId) { toast('Enter a voice name or ID first.', true); return; }
        try {
            const result = await api.post('/api/settings/tts-voice', { voiceId });
            toast(`TTS voice set to ${result.voiceName || result.voiceId} for all servers.`);
        } catch (error) {
            reportError(error);
        }
        loadSettings();
    });
}

/* ---------- Polling ---------- */

async function refreshGuildState() {
    if (!state.guild) return;
    try {
        state.music = await api.get('/api/music/state');
    } catch {
        state.music = null;
    }
    try {
        state.voiceChat = await api.get(`/api/guilds/${state.guild.id}/voicechat`);
    } catch {
        state.voiceChat = null;
    }
    renderOverview();
    renderVoiceChat();
    renderMusic();
}

/* ---------- Wiring ---------- */

function init() {
    $('back-btn').addEventListener('click', showGuildBrowser);
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => selectTab(btn.dataset.tab));
    });

    $('mode-exact').addEventListener('click', () => setMessageMode('exact'));
    $('mode-ai').addEventListener('click', () => setMessageMode('ai'));
    $('msg-primary').addEventListener('click', onMessagePrimary);
    $('draft-discard').addEventListener('click', () => { hideDraft(); updateMessagePrimary(); });

    $('voice-mode-polite').addEventListener('click', () => {
        state.voiceMode = 'polite';
        $('voice-mode-polite').classList.add('active');
        $('voice-mode-open').classList.remove('active');
    });
    $('voice-mode-open').addEventListener('click', () => {
        state.voiceMode = 'open';
        $('voice-mode-open').classList.add('active');
        $('voice-mode-polite').classList.remove('active');
    });
    $('voice-engine-realtime').addEventListener('click', () => setVoiceEngine('realtime'));
    $('voice-engine-classic').addEventListener('click', () => setVoiceEngine('classic'));
    $('voice-start').addEventListener('click', onVoiceStart);
    $('voice-stop').addEventListener('click', onVoiceStop);

    $('mu-pause').addEventListener('click', onPauseResume);
    $('mu-skip').addEventListener('click', () => musicControl('skip'));
    $('mu-stop').addEventListener('click', () => musicControl('stop'));
    $('mu-volume').addEventListener('change', async (event) => {
        try {
            await api.post('/api/music/volume', { level: Number(event.target.value) });
        } catch (error) {
            reportError(error);
        }
    });
    $('mu-shuffle').addEventListener('click', () => playCollection({ shuffle: true }));
    $('mu-play-playlist').addEventListener('click', () => {
        const playlist = $('mu-playlist').value;
        if (playlist) playCollection({ playlist });
    });
    $('mu-search').addEventListener('input', (event) => {
        clearTimeout(state.trackSearchTimer);
        state.trackSearchTimer = setTimeout(() => loadTracks(event.target.value.trim()), 350);
    });

    wireSettings();
    initKeyboard();

    refreshStatus();
    refreshGuilds();
    refreshSystem();
    setInterval(refreshStatus, 5000);
    setInterval(() => {
        if (state.guild) refreshGuildState();
        else refreshGuilds();
    }, 5000);
    setInterval(() => {
        if (state.guild && state.tab === 'overview') refreshSystem();
    }, SYSTEM_POLL_MS);
}

init();
