/**
 * Portal routes: VoiceTasks.
 * Mounted by packages/core/web/appApi.js — do not require this file from apps.
 */


function mountVoiceTasks(app, ctx, h) {
    const { requireAuth, chatRoute } = h;


    // --- Voice (mic input + read-aloud) --------------------------------------

    // What the client may offer (missing keys hide the buttons - never error)
    app.get('/api/app/voice/capabilities', requireAuth, chatRoute(async () =>
        ctx.voice.capabilities()
    ));

    // The ElevenLabs voice library, for the voice-picker UI
    app.get('/api/app/voice/voices', requireAuth, chatRoute(async () =>
        ctx.voice.listVoices()
    ));

    // The user's saved voice preference (voice + playback speed)
    app.get('/api/app/voice/settings', requireAuth, chatRoute(async (req) =>
        ctx.voice.getVoiceSettings({ userId: req.webUser.userId })
    ));

    app.patch('/api/app/voice/settings', requireAuth, chatRoute(async (req) =>
        ctx.voice.setVoiceSettings({
            userId: req.webUser.userId,
            voiceId: req.body?.voiceId,
            speed: req.body?.speed
        })
    ));

    // One recorded clip in, transcribed text out (the composer mic button)
    app.post('/api/app/voice/transcribe', requireAuth, chatRoute(async (req) =>
        ctx.voice.transcribe({
            userId: req.webUser.userId,
            audioBase64: req.body?.audio,
            mimeType: req.body?.mimeType
        })
    ));

    // Read a reply aloud: MP3 streamed straight from the TTS provider
    app.post('/api/app/voice/tts', requireAuth, async (req, res) => {
        try {
            const { stream, contentType } = await ctx.voice.synthesize({
                userId: req.webUser.userId,
                text: req.body?.text
            });
            res.status(200).set({ 'Content-Type': contentType, 'Cache-Control': 'no-store' });
            stream.on('error', () => { try { res.end(); } catch { /* gone */ } });
            stream.pipe(res);
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Web TTS failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

    // --- Scheduled tasks (automations + followups) ----------------------------

    app.get('/api/app/tasks', requireAuth, chatRoute(async (req) =>
        ctx.tasks.listTasks({ gateway: ctx.gateway, userId: req.webUser.userId })
    ));

    app.post('/api/app/tasks', requireAuth, chatRoute(async (req) =>
        ctx.tasks.createTask({
            gateway: ctx.gateway,
            userId: req.webUser.userId,
            name: req.body?.name,
            prompt: req.body?.prompt,
            cron: req.body?.cron ?? null,
            dueAt: req.body?.dueAt ?? null
        })
    ));

    app.patch('/api/app/tasks/automations/:automationId', requireAuth, chatRoute(async (req) =>
        ctx.tasks.setAutomationEnabled({
            userId: req.webUser.userId,
            automationId: req.params.automationId,
            enabled: req.body?.enabled === true
        })
    ));

    app.delete('/api/app/tasks/automations/:automationId', requireAuth, chatRoute(async (req) =>
        ctx.tasks.deleteAutomation({
            userId: req.webUser.userId,
            automationId: req.params.automationId
        })
    ));

    app.delete('/api/app/tasks/followups/:followupId', requireAuth, chatRoute(async (req) =>
        ctx.tasks.cancelFollowup({
            userId: req.webUser.userId,
            followupId: req.params.followupId
        })
    ));
}

module.exports = { mountVoiceTasks };
