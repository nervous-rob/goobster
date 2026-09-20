/**
 * Portal routes: authentication.
 * Mounted by packages/core/web/appApi.js - do not require this file from apps.
 *
 * Discord OAuth (login and "Connect Discord" linking), dev sessions,
 * logout, the /me bootstrap, and - behind the `identity.nativeLogin`
 * release gate - invitation redemption, username + password login,
 * re-authentication, operator-issued recovery, and (with outbound mail
 * configured) open sign-up, email verification, and self-service recovery.
 */

const crypto = require('node:crypto');
const axios = require('axios');
const { DISCORD_API, SESSION_COOKIE, STATE_COOKIE } = require('../appHelpers');

const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

const PRIVATE_PEER = /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/;

/**
 * Client address for the per-address login throttle. X-Forwarded-For is
 * honoured only when the direct peer is a private/loopback address (the
 * nginx or Cloudflare-tunnel profile); a public peer's header is ignored so
 * it cannot spoof its way into a fresh bucket.
 */
function clientAddress(req) {
    const peer = req.socket?.remoteAddress || req.ip || null;
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded && peer && PRIVATE_PEER.test(peer)) {
        const first = String(forwarded).split(',')[0].trim();
        if (first) return first;
    }
    return peer;
}

function mountAuth(app, ctx, h) {
    const { requireAuth, authRoute, sendError, parseCookies, cookieAttributes } = h;

    const setSession = (res, token) => {
        res.append('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieAttributes(ctx, SESSION_MAX_AGE)}`);
    };
    const discordConfigured = () => Boolean(ctx.clientSecret && ctx.publicUrl);

    // Client bootstrap info (nothing secret)
    app.get('/api/app/config', (req, res) => {
        res.json({
            clientId: ctx.clientId,
            devMode: ctx.devMode,
            loginAvailable: discordConfigured(),
            nativeLogin: ctx.nativeAuth.enabled,
            // Email-backed features: open sign-up and "forgot password".
            // Both need native login, a mail provider, and publicUrl.
            registration: ctx.nativeAuth.registrationMode(ctx.publicUrl),
            emailRecovery: ctx.nativeAuth.emailEnabled(ctx.publicUrl),
            installationName: ctx.identityConfig.installationName,
            passwordMinLength: ctx.identityConfig.passwordMinLength,
            maxInputLength: ctx.chat.maxInputLength
        });
    });

    // --- Discord OAuth ------------------------------------------------------

    function redirectToDiscord(res, state) {
        res.append('Set-Cookie', `${STATE_COOKIE}=${state}; ${cookieAttributes(ctx, 600)}`);
        const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
        authorizeUrl.searchParams.set('client_id', ctx.clientId);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('redirect_uri', `${ctx.publicUrl}/api/app/auth/callback`);
        authorizeUrl.searchParams.set('scope', 'identify');
        authorizeUrl.searchParams.set('state', state);
        res.redirect(authorizeUrl.toString());
    }

    // Step 1: redirect to Discord's consent page with a state nonce
    app.get('/api/app/auth/login', (req, res) => {
        if (!discordConfigured()) {
            sendError(res, 503, 'LOGIN_UNAVAILABLE',
                'Discord login is not configured (webapp.publicUrl and the client secret are required).');
            return;
        }
        redirectToDiscord(res, crypto.randomBytes(16).toString('hex'));
    });

    // "Connect Discord" from a signed-in native account: the state nonce is
    // bound to this principal and session so the callback links instead of
    // logging in, and refuses a state minted for someone else.
    app.get('/api/app/auth/link/discord', requireAuth, h.requireRecentAuth, async (req, res) => {
        if (!discordConfigured()) {
            sendError(res, 503, 'LOGIN_UNAVAILABLE', 'Discord login is not configured on this installation.');
            return;
        }
        try {
            const { state } = await ctx.nativeAuth.beginLink({
                principalId: req.webUser.userId,
                sessionId: req.webUser.id
            });
            redirectToDiscord(res, state);
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Web app link start failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

    // Step 2: exchange the code, resolve the user, mint a session cookie -
    // or, for a link intent, attach the Discord identity to the caller.
    app.get('/api/app/auth/callback', async (req, res) => {
        const settingsUrl = '/app/settings/account';
        try {
            if (!discordConfigured()) {
                sendError(res, 503, 'LOGIN_UNAVAILABLE', 'Discord login is not configured.');
                return;
            }
            const { code, state } = req.query;
            const cookies = parseCookies(req);
            const expectedState = cookies[STATE_COOKIE];
            if (!code || !state || !expectedState || state !== expectedState) {
                sendError(res, 400, 'BAD_STATE', 'Login flow expired or was tampered with - try again.');
                return;
            }
            res.append('Set-Cookie', `${STATE_COOKIE}=; ${cookieAttributes(ctx, 0)}`);

            // Is this a link intent? Resolve the caller's session first so
            // the intent can be checked against it (and consumed regardless).
            const currentToken = cookies[SESSION_COOKIE];
            const current = currentToken ? await ctx.sessions.get(currentToken) : null;
            let link = null;
            try {
                link = await ctx.nativeAuth.takeLink({
                    state: String(state),
                    principalId: current?.userId || null,
                    sessionId: current?.id ?? null
                });
            } catch (error) {
                if (error?.status && error?.code) {
                    res.redirect(`${settingsUrl}?link=${encodeURIComponent(error.code.toLowerCase())}`);
                    return;
                }
                throw error;
            }

            const tokenResponse = await axios.post(
                `${DISCORD_API}/oauth2/token`,
                new URLSearchParams({
                    client_id: ctx.clientId,
                    client_secret: ctx.clientSecret,
                    grant_type: 'authorization_code',
                    code: String(code),
                    redirect_uri: `${ctx.publicUrl}/api/app/auth/callback`
                }),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
            );
            const accessToken = tokenResponse.data.access_token;

            const userResponse = await axios.get(`${DISCORD_API}/users/@me`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: 10000
            });
            const user = userResponse.data;
            const displayName = user.global_name || user.username;

            if (link) {
                try {
                    await ctx.identity.linkExternal({ principalId: link.principalId, provider: 'discord', subject: user.id });
                    res.redirect(`${settingsUrl}?link=ok`);
                } catch (error) {
                    if (error?.code === 'IDENTITY_CONFLICT') {
                        res.redirect(`${settingsUrl}?link=conflict`);
                        return;
                    }
                    throw error;
                }
                return;
            }

            // The Discord subject resolves to whichever principal owns it -
            // a native account that linked Discord, or (the common case)
            // the legacy principal whose id is the snowflake itself.
            const principalId = await ctx.identity.resolveExternal({ provider: 'discord', subject: user.id })
                || (await ctx.identity.ensureLegacyPrincipal({ discordId: user.id, displayName })).id;
            const { token } = await ctx.sessions.create({
                userId: principalId,
                userName: displayName,
                avatar: user.avatar || null
            });
            setSession(res, token);
            res.redirect('/app/');
        } catch (error) {
            ctx.logger.error?.('Web app OAuth callback failed:', error.response?.data || error.message);
            sendError(res, 502, 'OAUTH_FAILED', 'Discord login failed - try again.');
        }
    });

    // Local development identity (never available unless explicitly enabled)
    app.post('/api/app/auth/dev-session', async (req, res) => {
        if (!ctx.devMode) {
            sendError(res, 403, 'DEV_DISABLED', 'Dev sessions are disabled.');
            return;
        }
        const userId = String(req.body?.userId || '').trim();
        const name = String(req.body?.name || 'dev user').trim().slice(0, 32);
        if (!ctx.identity.isPrincipalId(userId)) {
            sendError(res, 400, 'BAD_USER_ID',
                'userId must be a principal id: a Discord snowflake (digits) or usr_<uuid>.');
            return;
        }
        // Dev mode mints any principal: a native id that does not exist yet
        // is created on the spot so the Discord-free path can be exercised
        // without the invitation flow.
        if (ctx.identity.isNativeId(userId) && !(await ctx.identity.getPrincipal(userId))) {
            await ctx.identity.createNativePrincipal({ id: userId, displayName: name });
        }
        const { token } = await ctx.sessions.create({ userId, userName: name });
        setSession(res, token);
        res.json({ user: { id: userId, name }, devMode: true });
    });

    app.post('/api/app/auth/logout', requireAuth, async (req, res) => {
        await ctx.sessions.destroy(req.webSessionToken);
        res.append('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttributes(ctx, 0)}`);
        res.json({ ok: true });
    });

    // --- Native sign-in (release-gated) ---------------------------------------

    // What an invitation page shows before the person commits. Never consumes.
    app.get('/api/app/auth/invite/:token', authRoute(async (req) =>
        ctx.nativeAuth.inspectInvite(req.params.token)
    ));

    // Redeem an invitation: one atomic winner per token, then a fresh session.
    app.post('/api/app/auth/register', async (req, res) => {
        try {
            const created = await ctx.nativeAuth.register({
                token: req.body?.token,
                loginName: req.body?.loginName,
                password: req.body?.password,
                displayName: req.body?.displayName,
                address: clientAddress(req)
            });
            const { token } = await ctx.sessions.create({ userId: created.principalId, userName: created.displayName });
            setSession(res, token);
            res.json({ user: { id: created.principalId, name: created.displayName, loginName: created.loginName } });
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Web app register failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

    // Username + password. Neutral error on failure; a new session on
    // success (login always rotates - the old cookie, if any, is replaced).
    app.post('/api/app/auth/native-login', async (req, res) => {
        try {
            const who = await ctx.nativeAuth.login({
                loginName: req.body?.loginName,
                password: req.body?.password,
                address: clientAddress(req)
            });
            const { token } = await ctx.sessions.create({ userId: who.principalId, userName: who.displayName });
            setSession(res, token);
            res.json({ user: { id: who.principalId, name: who.displayName, loginName: who.loginName } });
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Web app native login failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

    // Prove identity again on the current session (unlocks sensitive changes).
    app.post('/api/app/auth/reauth', requireAuth, authRoute(async (req) => {
        ctx.nativeAuth.assertEnabled();
        const ok = req.body?.password
            ? await ctx.nativeAuth.checkPassword(req.webUser.userId, String(req.body.password))
            : false;
        if (!ok) {
            const error = new Error('Password is incorrect.');
            error.status = 401;
            error.code = 'BAD_CREDENTIALS';
            throw error;
        }
        await ctx.sessions.markAuthenticated(req.webSessionToken);
        return { ok: true, recentAuthMinutes: ctx.identityConfig.recentAuthMinutes };
    }));

    // Finish an operator-issued reset: every other session of the account
    // is revoked and a fresh one is minted here.
    app.post('/api/app/auth/recover', async (req, res) => {
        try {
            const who = await ctx.nativeAuth.completeRecovery({
                token: req.body?.token,
                password: req.body?.password,
                loginName: req.body?.loginName,
                address: clientAddress(req)
            });
            const { token } = await ctx.sessions.create({ userId: who.principalId, userName: who.displayName });
            setSession(res, token);
            res.json({ user: { id: who.principalId, name: who.displayName, loginName: who.loginName } });
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Web app recovery failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

    // --- Email-backed flows (release-gated, and hidden without mail) -----------

    // Open sign-up, step one. Neutral 200 whether the address is new or
    // already someone's; the next step arrives by email.
    app.post('/api/app/auth/signup', authRoute(async (req) => ctx.nativeAuth.signup({
        loginName: req.body?.loginName,
        password: req.body?.password,
        email: req.body?.email,
        displayName: req.body?.displayName,
        address: clientAddress(req),
        baseUrl: ctx.publicUrl
    })));

    // Follow a verification link. A sign-up's link creates the account and
    // signs the person in; an existing account's link just marks the
    // address verified (the person may or may not be signed in here).
    app.post('/api/app/auth/verify-email', async (req, res) => {
        try {
            const outcome = await ctx.nativeAuth.verifyEmail({ token: req.body?.token, address: clientAddress(req) });
            if (outcome.kind === 'registration') {
                const { token } = await ctx.sessions.create({ userId: outcome.principalId, userName: outcome.displayName });
                setSession(res, token);
                res.json({
                    kind: 'registration',
                    user: { id: outcome.principalId, name: outcome.displayName, loginName: outcome.loginName }
                });
                return;
            }
            res.json({ kind: 'verified', address: outcome.address });
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Web app email verification failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

    // "Forgot password": the reset link goes to the verified address, and
    // the response is the same whether or not one exists.
    app.post('/api/app/auth/forgot', authRoute(async (req) => ctx.nativeAuth.requestRecovery({
        email: req.body?.email,
        address: clientAddress(req),
        baseUrl: ctx.publicUrl
    })));

    // --- Session info ----------------------------------------------------

    app.get('/api/app/me', requireAuth, async (req, res) => {
        try {
            const scopes = await ctx.dashboard.listScopes({
                gateway: ctx.gateway,
                userId: req.webUser.userId,
                discordUserId: ctx.identity.discordSubjectFor(req.actor)
            });
            // The assistant identity is always present (spec §6): the bot's
            // Discord user when there is one, the installation identity
            // otherwise. `bot` stays for compatibility and is null when
            // Discord is not connected; `discord` says which case this is.
            const discordEnabled = ctx.discordConfig.enabled && ctx.gateway?.kind !== 'disabled';
            let bot = null;
            let connected = false;
            let assistant = null;
            try {
                const botUser = await ctx.gateway?.botUser();
                if (botUser) assistant = { id: botUser.id, name: botUser.username };
            } catch { /* bot down - degraded, the client shows offline state */ }
            if (!assistant) {
                const local = ctx.assistantIdentity.assistantUser();
                assistant = { id: local.id, name: local.username };
            }
            if (discordEnabled) {
                bot = assistant;
                try {
                    connected = (await ctx.gateway?.available()) === true;
                } catch { /* unreachable */ }
            }
            res.json({
                user: {
                    id: req.webUser.userId,
                    name: req.webUser.userName,
                    avatar: req.webUser.avatar && req.actor?.externalActor?.provider === 'discord'
                        ? `https://cdn.discordapp.com/avatars/${req.actor.externalActor.subject}/${req.webUser.avatar}.png?size=64`
                        : null
                },
                // Application identity (shared-instance Increments A/B): the
                // entitlement, when one has been granted, and whether this
                // principal can act on Discord at all.
                identity: {
                    installationId: req.actor?.installationId ?? null,
                    installationName: ctx.identityConfig.installationName,
                    account: req.actor?.account
                        ? { role: req.actor.account.role, status: req.actor.account.status, entitlement: req.actor.account.entitlement }
                        : null,
                    discordLinked: req.actor?.externalActor?.provider === 'discord',
                    operator: req.actor?.account?.role === 'operator',
                    nativeLogin: ctx.nativeAuth.enabled,
                    registration: ctx.nativeAuth.registrationMode(ctx.publicUrl),
                    mail: ctx.nativeAuth.emailEnabled(ctx.publicUrl)
                },
                bot,
                assistant,
                // The Discord adapter: part of this installation at all, and
                // reachable right now. Surfaces that are Discord-specific
                // (Exchange, server scopes, Connect Discord) key off these.
                discord: {
                    enabled: discordEnabled,
                    connected,
                    reason: discordEnabled ? null : ctx.discordConfig.disabledReason
                },
                inbox: { unread: await ctx.inbox.unreadCount(req.webUser.userId).catch(() => 0) },
                scopes,
                maxInputLength: ctx.chat.maxInputLength,
                // Feature switches the client uses to show/hide panes
                features: {
                    observatory: ctx.observatory.enabled === true,
                    spitball: ctx.spitball.enabled === true
                }
            });
        } catch (error) {
            ctx.logger.error?.('Web app /me failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });
}

module.exports = { mountAuth, clientAddress };
