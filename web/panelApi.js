/**
 * Thin HTTP routes for the local management panel. All validation,
 * permission checks, and Discord/service access live in
 * services/panelService.js - routes only translate HTTP <-> service calls.
 */

const express = require('express');
const { PanelError } = require('../services/panelService');

/**
 * Build the /api router for the panel.
 * @param {Object} params
 * @param {Object} params.panelService - created by createPanelService()
 * @param {Object} [params.logger]
 */
function createPanelApi({ panelService, logger = console }) {
    const router = express.Router();

    // Wrap async handlers so rejections reach the error middleware.
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

    router.get('/status', wrap(async (req, res) => {
        res.json(panelService.getStatus());
    }));

    router.get('/guilds', wrap(async (req, res) => {
        res.json({ guilds: panelService.listGuilds() });
    }));

    router.get('/guilds/:guildId/channels', wrap(async (req, res) => {
        res.json(panelService.listChannels(req.params.guildId));
    }));

    router.post('/guilds/:guildId/messages', wrap(async (req, res) => {
        const result = await panelService.sendMessage({
            guildId: req.params.guildId,
            channelId: req.body?.channelId,
            content: req.body?.content
        });
        res.json(result);
    }));

    router.post('/guilds/:guildId/draft', wrap(async (req, res) => {
        const result = await panelService.draftMessage({
            guildId: req.params.guildId,
            channelId: req.body?.channelId,
            instruction: req.body?.instruction
        });
        res.json(result);
    }));

    router.get('/guilds/:guildId/voicechat', wrap(async (req, res) => {
        res.json(panelService.getVoiceChat(req.params.guildId));
    }));

    router.post('/guilds/:guildId/voicechat/start', wrap(async (req, res) => {
        const result = await panelService.startVoiceChat({
            guildId: req.params.guildId,
            voiceChannelId: req.body?.voiceChannelId,
            mode: req.body?.mode ?? 'polite',
            transcriptChannelId: req.body?.transcriptChannelId ?? null,
            confirm: req.body?.confirm === true
        });
        res.json(result);
    }));

    router.post('/guilds/:guildId/voicechat/stop', wrap(async (req, res) => {
        res.json(panelService.stopVoiceChat(req.params.guildId));
    }));

    router.get('/guilds/:guildId/playlists', wrap(async (req, res) => {
        res.json({ playlists: await panelService.listPlaylists(req.params.guildId) });
    }));

    router.get('/guilds/:guildId/settings', wrap(async (req, res) => {
        res.json(await panelService.getGuildSettings(req.params.guildId));
    }));

    router.patch('/guilds/:guildId/settings', wrap(async (req, res) => {
        res.json(await panelService.updateGuildSettings(req.params.guildId, req.body));
    }));

    router.post('/guilds/:guildId/memory/exclusions', wrap(async (req, res) => {
        res.json(panelService.setChannelExclusion(
            req.params.guildId,
            req.body?.channelId,
            req.body?.exclude === true
        ));
    }));

    router.post('/guilds/:guildId/memory/forget', wrap(async (req, res) => {
        res.json(panelService.forgetGuildMemories(req.params.guildId));
    }));

    router.get('/settings/tts-voices', wrap(async (req, res) => {
        res.json(await panelService.listTtsVoices());
    }));

    router.post('/settings/tts-voice', wrap(async (req, res) => {
        res.json(await panelService.setTtsVoice(req.body?.voiceId));
    }));

    router.get('/music/state', wrap(async (req, res) => {
        res.json(panelService.getMusicState());
    }));

    router.get('/tracks', wrap(async (req, res) => {
        res.json({ tracks: await panelService.listTracks(req.query.search) });
    }));

    router.post('/music/play', wrap(async (req, res) => {
        const result = await panelService.playTrack({
            guildId: req.body?.guildId,
            channelId: req.body?.channelId,
            query: req.body?.query,
            confirmMove: req.body?.confirmMove === true
        });
        res.json(result);
    }));

    router.post('/music/play-collection', wrap(async (req, res) => {
        const result = await panelService.playCollection({
            guildId: req.body?.guildId,
            channelId: req.body?.channelId,
            playlist: req.body?.playlist ?? null,
            shuffle: req.body?.shuffle === true,
            confirmMove: req.body?.confirmMove === true
        });
        res.json(result);
    }));

    router.post('/music/control', wrap(async (req, res) => {
        res.json(await panelService.controlMusic(req.body?.action));
    }));

    router.post('/music/volume', wrap(async (req, res) => {
        res.json(await panelService.setVolume(req.body?.level));
    }));

    router.use((req, res) => {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API route.' } });
    });

    // Four-arg signature is required for Express to treat this as an error handler.
    router.use((error, req, res, next) => {
        if (error instanceof PanelError) {
            res.status(error.status).json({
                error: { code: error.code, message: error.message, ...error.details }
            });
            return;
        }
        if (error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large') {
            res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid request body.' } });
            return;
        }
        logger.error?.('Panel API error:', error);
        res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal panel error.' } });
    });

    return router;
}

module.exports = { createPanelApi };
