/**
 * Portal routes: the signed-in person's own account.
 * Mounted by packages/core/web/appApi.js - do not require this file from apps.
 *
 * Sign-in methods (what Settings -> Account shows), credential enrollment
 * and changes, the recovery email address, and disconnecting Discord.
 * Sensitive changes need a recent proof of identity; see requireRecentAuth
 * in appHelpers.
 */

function mountAccount(app, ctx, h) {
    const { requireAuth, requireRecentAuth, authRoute } = h;

    app.get('/api/app/account', requireAuth, authRoute(async (req) => ({
        ...(await ctx.nativeAuth.summary(req.webUser.userId, { baseUrl: ctx.publicUrl })),
        recentAuth: ctx.sessions.isRecentlyAuthenticated(req.webUser, ctx.identityConfig.recentAuthMinutes),
        recentAuthMinutes: ctx.identityConfig.recentAuthMinutes,
        discordLoginAvailable: Boolean(ctx.clientSecret && ctx.publicUrl && ctx.discordConfig.enabled)
    })));

    // Set or change the login name and password. Proof: the current
    // password when one exists (checked by the service); otherwise - the
    // enrollment case for a Discord-only account - a recent authentication.
    app.put('/api/app/account/credentials', requireAuth, async (req, res, next) => {
        if (await ctx.nativeAuth.hasPassword(req.webUser.userId)) return next();
        return requireRecentAuth(req, res, next);
    }, authRoute(async (req) => {
        const result = await ctx.nativeAuth.setCredentials({
            principalId: req.webUser.userId,
            loginName: req.body?.loginName,
            password: String(req.body?.newPassword ?? ''),
            currentPassword: req.body?.currentPassword ?? null
        });
        // Changing a credential is itself a fresh proof of identity.
        await ctx.sessions.markAuthenticated(req.webSessionToken);
        return { ok: true, loginName: result.loginName };
    }));

    // --- Email address -----------------------------------------------------

    // Set or replace the address. It starts unverified; a link is mailed.
    app.put('/api/app/account/email', requireAuth, requireRecentAuth, authRoute(async (req) =>
        ctx.nativeAuth.setEmail({ principalId: req.webUser.userId, email: req.body?.email, baseUrl: ctx.publicUrl })
    ));

    app.post('/api/app/account/email/resend', requireAuth, authRoute(async (req) =>
        ctx.nativeAuth.resendVerification({ principalId: req.webUser.userId, baseUrl: ctx.publicUrl })
    ));

    app.delete('/api/app/account/email', requireAuth, requireRecentAuth, authRoute(async (req) =>
        ctx.nativeAuth.removeEmail(req.webUser.userId)
    ));

    app.delete('/api/app/account/identities/:provider', requireAuth, requireRecentAuth, authRoute(async (req) => {
        const provider = String(req.params.provider || '').toLowerCase();
        if (provider !== 'discord') {
            const error = new Error('Only Discord can be disconnected here.');
            error.status = 400;
            error.code = 'BAD_PROVIDER';
            throw error;
        }
        await ctx.nativeAuth.disconnect({ principalId: req.webUser.userId, provider });
        return { ok: true };
    }));
}

module.exports = { mountAccount };
