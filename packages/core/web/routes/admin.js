/**
 * Portal routes: installation administration (operators only).
 * Mounted by packages/core/web/appApi.js - do not require this file from apps.
 *
 * Invitations, the account roster (status, role, migration grants),
 * audited recovery links, and the legacy-data migration report. Every
 * route runs behind requireAuth + requireOperator; the role is read from
 * the actor context, never from the request.
 */

function fail(status, code, message) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

function mountAdmin(app, ctx, h) {
    const { requireAuth, requireOperator, authRoute } = h;
    const guard = [requireAuth, requireOperator];

    // --- Invitations -----------------------------------------------------

    app.get('/api/app/admin/invites', ...guard, authRoute(async () => ({
        invites: await ctx.nativeAuth.listInvites(),
        nativeLogin: ctx.nativeAuth.enabled,
        defaultTtlHours: ctx.identityConfig.inviteTtlHours
    })));

    // The raw token is returned exactly once, embedded in a ready-to-share
    // URL; only its hash is stored.
    app.post('/api/app/admin/invites', ...guard, authRoute(async (req) => {
        const { token, invite } = await ctx.nativeAuth.createInvite({
            issuedBy: req.webUser.userId,
            role: req.body?.role || 'member',
            ttlHours: req.body?.ttlHours,
            note: req.body?.note
        });
        const base = ctx.publicUrl || '';
        return { invite, url: `${base}/app/invite?token=${encodeURIComponent(token)}` };
    }));

    app.delete('/api/app/admin/invites/:id', ...guard, authRoute(async (req) => ({
        invite: await ctx.nativeAuth.revokeInvite(req.params.id)
    })));

    // --- Accounts --------------------------------------------------------

    app.get('/api/app/admin/accounts', ...guard, authRoute(async () => ({
        accounts: await ctx.identity.listAccounts(),
        requireAccount: ctx.identityConfig.requireAccount
    })));

    // Grant an existing (legacy Discord) principal an account without an
    // invitation - the migration entitlement.
    app.post('/api/app/admin/accounts', ...guard, authRoute(async (req) => {
        const principalId = String(req.body?.principalId || '').trim();
        if (!ctx.identity.isPrincipalId(principalId)) {
            throw fail(400, 'BAD_PRINCIPAL', 'principalId must be a Discord snowflake or usr_<uuid>.');
        }
        const role = req.body?.role === 'operator' ? 'operator' : 'member';
        const { account, created } = await ctx.identity.grantAccount({ principalId, entitlement: 'migration', role });
        return { account, created };
    }));

    app.patch('/api/app/admin/accounts/:principalId', ...guard, authRoute(async (req) => {
        const principalId = String(req.params.principalId);
        const self = principalId === req.webUser.userId;
        let account = null;
        if (req.body?.status !== undefined) {
            if (self && req.body.status !== 'active') {
                throw fail(409, 'SELF_LOCKOUT', 'You cannot disable your own account.');
            }
            account = await ctx.identity.setAccountStatus(principalId, req.body.status);
        }
        if (req.body?.role !== undefined) {
            if (self && req.body.role !== 'operator') {
                throw fail(409, 'SELF_LOCKOUT', 'You cannot remove your own operator role.');
            }
            account = await ctx.identity.setAccountRole(principalId, req.body.role);
        }
        if (!account) throw fail(400, 'NOTHING_TO_CHANGE', 'Send status and/or role.');
        return { account };
    }));

    // Audited reset link (the "host can issue a reset" path when no mail
    // is configured). Shown once; hand it over out of band.
    app.post('/api/app/admin/accounts/:principalId/recovery', ...guard, authRoute(async (req) => {
        const { token, expiresAt, loginName } = await ctx.nativeAuth.issueRecovery({
            principalId: String(req.params.principalId),
            issuedBy: req.webUser.userId
        });
        const base = ctx.publicUrl || '';
        return { url: `${base}/app/recover?token=${encodeURIComponent(token)}`, expiresAt, loginName };
    }));

    // --- Migration report --------------------------------------------------

    app.get('/api/app/admin/identity/report', ...guard, authRoute(async () => ctx.identity.migrationReport()));
}

module.exports = { mountAdmin };
