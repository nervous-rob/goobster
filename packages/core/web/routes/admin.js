/**
 * Portal routes: installation administration (operators only).
 * Mounted by packages/core/web/appApi.js - do not require this file from apps.
 *
 * Invitations, the account roster (status, role, migration grants),
 * audited recovery links, the sign-up policy and mail status, the
 * legacy-data migration report, the per-account support view and the
 * operator audit (documentation/work_ledger.md). Every route runs behind
 * requireAuth + requireOperator; the role is read from the actor context,
 * never from the request. Every route that changes something writes one
 * operator_audit row after it succeeded.
 */

const operatorAudit = require('../../services/operatorAuditService');
const accountSupport = require('../../services/accountSupportService');

function fail(status, code, message) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

function mountAdmin(app, ctx, h) {
    const { requireAuth, requireOperator, authRoute } = h;
    const guard = [requireAuth, requireOperator];
    const audit = (req, action, target, detail) => operatorAudit.record({
        action, actor: req.webUser.userId, target, detail
    });

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
        await audit(req, 'invite.create', invite?.id, {
            role: invite?.role || req.body?.role || 'member',
            expiresAt: invite?.expiresAt || null,
            hasNote: Boolean(req.body?.note)
        });
        const base = ctx.publicUrl || '';
        return { invite, url: `${base}/app/invite?token=${encodeURIComponent(token)}` };
    }));

    app.delete('/api/app/admin/invites/:id', ...guard, authRoute(async (req) => {
        const invite = await ctx.nativeAuth.revokeInvite(req.params.id);
        await audit(req, 'invite.revoke', req.params.id, { role: invite?.role || null });
        return { invite };
    }));

    // --- Accounts --------------------------------------------------------

    // The roster, with each account's failure count for the support view.
    app.get('/api/app/admin/accounts', ...guard, authRoute(async (req) => {
        const days = req.query.days ? Number(req.query.days) : 30;
        const [accounts, failures] = await Promise.all([
            ctx.identity.listAccounts(),
            accountSupport.failureCounts({ days })
        ]);
        return {
            accounts: accounts.map(account => ({ ...account, failures: failures.get(account.principalId) || 0 })),
            failureWindowDays: days,
            requireAccount: ctx.identityConfig.requireAccount
        };
    }));

    // Grant an existing (legacy Discord) principal an account without an
    // invitation - the migration entitlement.
    app.post('/api/app/admin/accounts', ...guard, authRoute(async (req) => {
        const principalId = String(req.body?.principalId || '').trim();
        if (!ctx.identity.isPrincipalId(principalId)) {
            throw fail(400, 'BAD_PRINCIPAL', 'principalId must be a Discord snowflake or usr_<uuid>.');
        }
        const role = req.body?.role === 'operator' ? 'operator' : 'member';
        const { account, created } = await ctx.identity.grantAccount({ principalId, entitlement: 'migration', role });
        await audit(req, 'account.grant', principalId, { role, created: Boolean(created), entitlement: 'migration' });
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
            await audit(req, 'account.status', principalId, { status: account?.status ?? req.body.status });
        }
        if (req.body?.role !== undefined) {
            if (self && req.body.role !== 'operator') {
                throw fail(409, 'SELF_LOCKOUT', 'You cannot remove your own operator role.');
            }
            account = await ctx.identity.setAccountRole(principalId, req.body.role);
            await audit(req, 'account.role', principalId, { role: account?.role ?? req.body.role });
        }
        if (!account) throw fail(400, 'NOTHING_TO_CHANGE', 'Send status and/or role.');
        return { account };
    }));

    // Audited reset link (the "host can issue a reset" path when no mail
    // is configured). Shown once; hand it over out of band. The audit row
    // records that a link was issued - never the link.
    app.post('/api/app/admin/accounts/:principalId/recovery', ...guard, authRoute(async (req) => {
        const principalId = String(req.params.principalId);
        const { token, expiresAt, loginName } = await ctx.nativeAuth.issueRecovery({
            principalId,
            issuedBy: req.webUser.userId
        });
        await audit(req, 'account.recovery', principalId, { expiresAt: expiresAt || null });
        const base = ctx.publicUrl || '';
        return { url: `${base}/app/recover?token=${encodeURIComponent(token)}`, expiresAt, loginName };
    }));

    // The per-account support view: usage totals, non-token resources and
    // the failure ledger for one account over a window.
    app.get('/api/app/admin/accounts/:principalId/support', ...guard, authRoute(async (req) => {
        const principalId = String(req.params.principalId);
        if (!ctx.identity.isPrincipalId(principalId)) {
            throw fail(400, 'BAD_PRINCIPAL', 'principalId must be a Discord snowflake or usr_<uuid>.');
        }
        return accountSupport.view({
            principalId,
            days: req.query.days ? Number(req.query.days) : 30
        });
    }));

    // --- Sign-up policy and mail -------------------------------------------

    // How people get in, and whether the installation can send mail. The
    // configured value and the effective one differ when open sign-up is
    // requested but mail is missing - the panel shows the reason.
    app.get('/api/app/admin/installation', ...guard, authRoute(async () => ({
        installationId: ctx.identityConfig.installationId,
        installationName: ctx.identityConfig.installationName,
        publicUrl: ctx.publicUrl,
        nativeLogin: ctx.nativeAuth.enabled,
        requireAccount: ctx.identityConfig.requireAccount,
        registration: {
            configured: ctx.identityConfig.registration,
            effective: ctx.nativeAuth.registrationMode(ctx.publicUrl)
        },
        mail: {
            ...ctx.mail.describe(),
            linksEnabled: ctx.nativeAuth.emailEnabled(ctx.publicUrl),
            reason: ctx.nativeAuth.emailDisabledReason(ctx.publicUrl)
        },
        emailVerifyTtlMinutes: ctx.identityConfig.emailVerifyTtlMinutes,
        recoveryTtlMinutes: ctx.identityConfig.recoveryTtlMinutes
    })));

    app.post('/api/app/admin/mail/test', ...guard, authRoute(async (req) => {
        const outcome = await ctx.nativeAuth.sendTestMail({ to: req.body?.to, issuedBy: req.webUser.userId, baseUrl: ctx.publicUrl });
        await audit(req, 'signup.mail_test', null, { provider: outcome?.provider || null });
        return outcome;
    }));

    // --- Migration report --------------------------------------------------

    app.get('/api/app/admin/identity/report', ...guard, authRoute(async () => ctx.identity.migrationReport()));

    // --- Instance state (paused after a restore) ---------------------------

    // The pause flag, and the last restore / resume records
    // (documentation/backup_and_restore.md).
    app.get('/api/app/admin/instance', ...guard, authRoute(async () => ctx.instanceState.describe()));

    // Resume: every missed schedule moves to its next future time first, so
    // nothing that came due during the downtime fires late. The audit row
    // is written by instanceStateService.resume.
    app.post('/api/app/admin/instance/resume', ...guard, authRoute(async (req) => {
        const outcome = await ctx.instanceState.resume({ by: req.webUser.userId });
        return { ...outcome, state: await ctx.instanceState.describe() };
    }));

    // --- Operator audit ------------------------------------------------------

    // Newest first, keyset-paged; optional filters by target and action.
    app.get('/api/app/admin/audit', ...guard, authRoute(async (req) => operatorAudit.list({
        limit: req.query.limit ? Number(req.query.limit) : 50,
        before: req.query.before || null,
        target: req.query.target || null,
        action: req.query.action || null
    })));
}

module.exports = { mountAdmin };
