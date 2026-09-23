import { LimitsPanel } from '../components/TokenLimits';
import { FormEvent, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { keys } from '../lib/query';
import type { AdminAccount, Invite, OperatorAuditEntry, SkippedSchedules } from '../lib/types';
import { useSession } from '../hooks/useSession';
import { useConfirm } from '../hooks/useConfirm';
import { useToast } from '../hooks/useToast';
import { useDateLabel } from '../hooks/useDateLabel';
import { MenuButton } from '../shell/MenuButton';
import { FailureList, ResourceTotals, failureKindLabel } from '../components/WorkLedger';

const INVITES_KEY = ['admin-invites'];
const ACCOUNTS_KEY = ['admin-accounts'];
const REPORT_KEY = ['admin-identity-report'];
const INSTALLATION_KEY = ['admin-installation'];
const INSTANCE_KEY = ['admin-instance'];

function describeInterrupted(interrupted: Record<string, number> | undefined): string {
    const entries = Object.entries(interrupted || {}).filter(([, n]) => n > 0);
    if (entries.length === 0) return 'nothing was in flight';
    return entries.map(([kind, n]) => `${n} ${kind.replace('_', ' ')}${n === 1 ? '' : 's'}`).join(', ');
}

function describeSkipped(skipped: SkippedSchedules | undefined): string {
    if (!skipped) return '';
    const parts = [
        [skipped.automations, 'automation'],
        [skipped.cronTriggers, 'scheduled trigger'],
        [skipped.eventTriggers, 'event trigger fire'],
        [skipped.recurringFollowups, 'recurring reminder'],
        [skipped.oneShotFollowups, 'one-time reminder (cancelled, owner told)']
    ] as Array<[number, string]>;
    const shown = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}${n === 1 ? '' : 's'}`);
    return shown.length > 0 ? `Skipped ${shown.join(', ')}.` : 'Nothing had come due.';
}

/**
 * Pause state, and Resume. A restore (`npm run restore`) leaves the
 * installation paused: sign-in and chat work, scheduled work waits, and
 * whatever came due while the box was down is skipped - not fired late -
 * the moment the host resumes here.
 */
function InstancePanel() {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const state = useQuery({ queryKey: INSTANCE_KEY, queryFn: () => api.adminInstance(), refetchInterval: 15_000 });
    const [busy, setBusy] = useState(false);
    const data = state.data;

    async function resume() {
        const ok = await confirm(
            'Resume this installation? Scheduled work starts again. Anything that came due while it was paused moves to its '
            + 'next scheduled time; one-time reminders that were missed are cancelled and their owners told in their Inbox. Nothing runs late.'
        );
        if (!ok) return;
        setBusy(true);
        try {
            const result = await api.adminInstanceResume();
            toast(`Resumed. ${describeSkipped(result.skipped)}`);
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: INSTANCE_KEY }),
                queryClient.invalidateQueries({ queryKey: keys.me })
            ]);
        } catch (error) {
            toast((error as ApiError).message, true);
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="settings-section" aria-labelledby="host-instance-title">
            <h2 id="host-instance-title">Instance</h2>
            <p className="hint">
                Whether scheduled work is running. <code>npm run restore</code> brings an installation back paused so nothing that came due
                during the downtime fires late; resume it here once the secrets are back in place. Backups: <code>npm run backup</code>.
            </p>
            {state.isPending && <div className="hint">Loading…</div>}
            {data && (
                <div className={`list-card${data.paused ? ' host-instance-paused' : ''}`}>
                    <div className="list-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                        <span>Scheduled work</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            {data.paused
                                ? <><strong className="settings-danger">Paused</strong><span className="hint"> since {data.paused.since} UTC · {data.paused.reason}{data.paused.by ? ` · by ${data.paused.by}` : ''}</span></>
                                : <strong>Running</strong>}
                            {data.paused && (
                                <button type="button" className="btn small primary" onClick={resume} disabled={busy}>
                                    {busy ? 'Resuming…' : 'Resume'}
                                </button>
                            )}
                        </span>
                    </div>
                    {data.paused?.detail?.archive && (
                        <div className="list-row">
                            <span className="hint">Restored from <code>{data.paused.detail.archive}</code> (taken {data.paused.detail.archiveCreatedAt} UTC) · interrupted: {describeInterrupted(data.paused.detail.interrupted)}</span>
                        </div>
                    )}
                    {data.lastRestore && (
                        <div className="list-row">
                            <span>Last restore</span>
                            <span className="hint">
                                {data.lastRestore.at} UTC from <code>{data.lastRestore.archive}</code>
                                {' · '}{data.lastRestore.engine}{data.lastRestore.schemaChanged ? ' · schema migrated forward' : ''}
                                {' · '}config.json {data.lastRestore.configRestored ? 'restored' : 'not restored'}
                            </span>
                        </div>
                    )}
                    {data.lastResume && (
                        <div className="list-row">
                            <span>Last resume</span>
                            <span className="hint">
                                {data.lastResume.at} UTC{data.lastResume.by ? ` by ${data.lastResume.by}` : ''}
                                {data.lastResume.pausedSince ? ` · paused since ${data.lastResume.pausedSince} UTC` : ''} · {describeSkipped(data.lastResume.skipped)}
                            </span>
                        </div>
                    )}
                    {!data.paused && !data.lastRestore && !data.lastResume && (
                        <div className="list-row"><span className="hint">Never restored or paused.</span></div>
                    )}
                </div>
            )}
        </section>
    );
}

function absolute(url: string): string {
    return url.startsWith('http') ? url : `${window.location.origin}${url}`;
}

async function copy(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

function OneTimeLink({ label, url, expiresAt, onDone }: { label: string; url: string; expiresAt?: string | null; onDone: () => void }) {
    const toast = useToast();
    return (
        <div className="list-card settings-danger" role="status">
            <div className="list-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <span><strong>{label}</strong>{expiresAt && <span className="hint"> · expires {expiresAt} UTC</span>}</span>
                <span className="hint">Shown once. Copy it now and hand it over out of band.</span>
            </div>
            <div className="list-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <code style={{ wordBreak: 'break-all' }}>{absolute(url)}</code>
                <span style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className="btn small primary" onClick={async () => toast(await copy(absolute(url)) ? 'Copied.' : 'Copy failed - select the link instead.', false)}>Copy</button>
                    <button type="button" className="btn small subtle" onClick={onDone}>Done</button>
                </span>
            </div>
        </div>
    );
}

function InvitesPanel() {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const invites = useQuery({ queryKey: INVITES_KEY, queryFn: () => api.adminInvites() });
    const [role, setRole] = useState<'member' | 'operator'>('member');
    const [note, setNote] = useState('');
    const [ttlHours, setTtlHours] = useState('');
    const [fresh, setFresh] = useState<{ url: string; invite: Invite } | null>(null);
    const [busy, setBusy] = useState(false);

    async function create(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        try {
            const result = await api.adminCreateInvite({
                role,
                note: note.trim() || undefined,
                ttlHours: ttlHours ? Number(ttlHours) : undefined
            });
            setFresh(result);
            setNote('');
            await queryClient.invalidateQueries({ queryKey: INVITES_KEY });
        } catch (error) {
            toast((error as ApiError).message, true);
        } finally {
            setBusy(false);
        }
    }

    async function revoke(invite: Invite) {
        if (!await confirm(`Revoke invitation #${invite.id}${invite.note ? ` (${invite.note})` : ''}? The link stops working immediately.`)) return;
        try {
            await api.adminRevokeInvite(invite.id);
            await queryClient.invalidateQueries({ queryKey: INVITES_KEY });
        } catch (error) {
            toast((error as ApiError).message, true);
        }
    }

    const data = invites.data;
    return (
        <section className="settings-section" aria-labelledby="host-invites-title">
            <h2 id="host-invites-title">Invitations</h2>
            {data && !data.nativeLogin && (
                <div className="list-card settings-danger">
                    <div className="list-row"><span>Password sign-in is off (<code>identity.nativeLogin</code>). Invitations cannot be issued or redeemed until it is on.</span></div>
                </div>
            )}
            {fresh && <OneTimeLink label={`Invitation for a ${fresh.invite.role}`} url={fresh.url} expiresAt={fresh.invite.expiresAt} onDone={() => setFresh(null)} />}
            <form className="host-invite-form" onSubmit={create}>
                <select className="select" value={role} onChange={(e) => setRole(e.target.value as 'member' | 'operator')} aria-label="Role">
                    <option value="member">Member</option>
                    <option value="operator">Operator (host)</option>
                </select>
                <input className="input" placeholder="Note (who it is for)" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
                <input className="input" type="number" min={1} max={720} placeholder={`Hours (${data?.defaultTtlHours ?? 72})`} value={ttlHours}
                    onChange={(e) => setTtlHours(e.target.value)} aria-label="Lifetime in hours" style={{ width: 130 }} />
                <button type="submit" className="btn primary" disabled={busy || data?.nativeLogin === false}>New invitation</button>
            </form>
            <div className="list-card">
                {invites.isPending && <div className="list-row"><span className="hint">Loading…</span></div>}
                {data?.invites.length === 0 && <div className="list-row"><span className="hint">No invitations yet.</span></div>}
                {data?.invites.map((invite) => (
                    <div key={invite.id} className="list-row">
                        <span>
                            <span className={`badge state-${invite.state}`}>{invite.state}</span>{' '}
                            <strong>#{invite.id}</strong> {invite.role}{invite.note ? ` · ${invite.note}` : ''}
                            <span className="hint"> · {invite.state === 'redeemed' ? `redeemed ${invite.consumedAt}` : `expires ${invite.expiresAt}`}</span>
                        </span>
                        {invite.state === 'open' && (
                            <button type="button" className="btn subtle small" onClick={() => void revoke(invite)}>Revoke</button>
                        )}
                    </div>
                ))}
            </div>
        </section>
    );
}

function AccountsPanel() {
    const me = useSession();
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const accounts = useQuery({ queryKey: ACCOUNTS_KEY, queryFn: () => api.adminAccounts() });
    const [principalId, setPrincipalId] = useState('');
    const [reset, setReset] = useState<{ url: string; expiresAt: string; who: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [support, setSupport] = useState<string | null>(null);

    async function refresh() {
        await queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    }

    async function grant(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        try {
            const result = await api.adminGrantAccount(principalId.trim());
            toast(result.created ? 'Account granted.' : 'That principal already had an account.');
            setPrincipalId('');
            await refresh();
        } catch (error) {
            toast((error as ApiError).message, true);
        } finally {
            setBusy(false);
        }
    }

    async function toggleStatus(account: AdminAccount) {
        const next = account.status === 'active' ? 'disabled' : 'active';
        if (next === 'disabled' && !await confirm(`Disable ${account.loginName || account.displayName || account.principalId}? Their sessions end now; data is kept.`)) return;
        try {
            await api.adminUpdateAccount(account.principalId, { status: next });
            await refresh();
        } catch (error) {
            toast((error as ApiError).message, true);
        }
    }

    async function toggleRole(account: AdminAccount) {
        const next = account.role === 'operator' ? 'member' : 'operator';
        if (!await confirm(`Make ${account.loginName || account.displayName || account.principalId} ${next === 'operator' ? 'an operator (host)' : 'a member'}?`)) return;
        try {
            await api.adminUpdateAccount(account.principalId, { role: next });
            await refresh();
        } catch (error) {
            toast((error as ApiError).message, true);
        }
    }

    async function issueReset(account: AdminAccount) {
        if (!await confirm(`Issue a password reset link for ${account.loginName || account.displayName || account.principalId}? This is recorded against your account.`)) return;
        try {
            const result = await api.adminIssueRecovery(account.principalId);
            setReset({ url: result.url, expiresAt: result.expiresAt, who: account.loginName || account.displayName || account.principalId });
        } catch (error) {
            toast((error as ApiError).message, true);
        }
    }

    const rows = accounts.data?.accounts || [];
    const failureWindow = accounts.data?.failureWindowDays ?? 30;
    return (
        <section className="settings-section" aria-labelledby="host-accounts-title">
            <h2 id="host-accounts-title">Accounts</h2>
            <p className="hint">
                Everyone with an application account. {accounts.data?.requireAccount
                    ? 'The release gate is on: only these people can use the portal.'
                    : 'The release gate (identity.requireAccount) is off: Discord users without an account still get in for now.'}
            </p>
            {reset && <OneTimeLink label={`Reset link for ${reset.who}`} url={reset.url} expiresAt={reset.expiresAt} onDone={() => setReset(null)} />}
            <form className="host-invite-form" onSubmit={grant}>
                <input className="input" placeholder="Grant an existing Discord user: paste their user id" value={principalId}
                    onChange={(e) => setPrincipalId(e.target.value)} aria-label="Principal id to grant" style={{ flex: 1 }} />
                <button type="submit" className="btn" disabled={busy || !principalId.trim()}>Grant account</button>
            </form>
            <div className="list-card">
                {accounts.isPending && <div className="list-row"><span className="hint">Loading…</span></div>}
                {rows.map((account) => {
                    const self = account.principalId === me?.user.id;
                    const open = support === account.principalId;
                    return (
                        <div key={account.principalId} className="list-row" style={{ flexWrap: 'wrap', gap: 8 }} data-testid="host-account-row">
                            <span>
                                <strong>{account.loginName || account.displayName || account.principalId}</strong>
                                {self && <span className="hint"> (you)</span>}
                                <span className="hint"> · {account.role} · {account.status} · joined by {account.entitlement}</span>
                                {(account.failures ?? 0) > 0 && (
                                    <span className="badge state-unverified" title={`work failures in the last ${failureWindow} days`} data-testid="host-account-failures">
                                        {' '}{account.failures} failure{account.failures === 1 ? '' : 's'}
                                    </span>
                                )}
                                <div className="hint">
                                    <code>{account.principalId}</code>
                                    {account.discordLinked ? ' · Discord' : ''}{account.hasPassword ? ' · password' : ' · no password'}
                                    {account.email && (
                                        <> · {account.email.address} <span className={`badge ${account.email.verified ? 'state-verified' : 'state-unverified'}`}>{account.email.verified ? 'verified' : 'unverified'}</span></>
                                    )}
                                </div>
                            </span>
                            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                <button type="button" className="btn subtle small" disabled={self} onClick={() => void toggleStatus(account)}>
                                    {account.status === 'active' ? 'Disable' : 'Enable'}
                                </button>
                                <button type="button" className="btn subtle small" disabled={self} onClick={() => void toggleRole(account)}>
                                    {account.role === 'operator' ? 'Make member' : 'Make operator'}
                                </button>
                                <button type="button" className="btn subtle small" onClick={() => void issueReset(account)}>Reset link</button>
                                <button type="button" className={`btn subtle small${open ? ' active' : ''}`} aria-expanded={open}
                                    onClick={() => setSupport(open ? null : account.principalId)}>
                                    {open ? 'Hide support' : 'Support'}
                                </button>
                            </span>
                            {open && <AccountSupport principalId={account.principalId} />}
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

/**
 * The per-account support view (documentation/work_ledger.md): usage
 * totals, non-token resources and the failure ledger for one account.
 * Codes and short reasons only - the ledger never holds the person's text.
 */
function AccountSupport({ principalId }: { principalId: string }) {
    const [days, setDays] = useState<7 | 30 | 90>(30);
    const view = useQuery({
        queryKey: ['admin-account-support', principalId, days],
        queryFn: () => api.adminAccountSupport(principalId, days)
    });
    const data = view.data;
    return (
        <div className="host-support" data-testid="host-account-support" style={{ flexBasis: '100%' }}>
            <div className="segment" role="tablist" aria-label="Support window" style={{ marginBottom: 10 }}>
                {([7, 30, 90] as const).map((option) => (
                    <button key={option} type="button" role="tab" aria-selected={days === option}
                        className={`segment-btn${days === option ? ' active' : ''}`} onClick={() => setDays(option)}>
                        {option}d
                    </button>
                ))}
            </div>
            {view.isPending && <div className="hint">Loading…</div>}
            {view.isError && <div className="hint">{(view.error as Error).message}</div>}
            {data && (
                <>
                    <div className="stat-grid">
                        <div className="stat-card">
                            <div className="stat-label">AI calls</div>
                            <div className="stat-value">{data.usage.calls.toLocaleString()}</div>
                            <div className="stat-sub">last {data.days} days</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Tokens</div>
                            <div className="stat-value">{data.usage.totalTokens.toLocaleString()}</div>
                            <div className="stat-sub">{data.usage.inputTokens.toLocaleString()} in · {data.usage.outputTokens.toLocaleString()} out</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Failures</div>
                            <div className="stat-value">{data.failures.total.toLocaleString()}</div>
                            <div className="stat-sub">{data.failures.byKind.map((row) => `${row.count} ${failureKindLabel(row.kind)}`).join(', ') || 'none'}</div>
                        </div>
                    </div>
                    <ResourceTotals totals={data.resources} days={data.days} />
                    <div style={{ marginTop: 10 }}>
                        <FailureList view={data} emptyText={`No failed work for this account in the last ${data.days} days.`} />
                    </div>
                </>
            )}
        </div>
    );
}

const AUDIT_KEY = ['admin-audit'];

const AUDIT_ACTION_LABEL: Record<string, string> = {
    'invite.create': 'created an invitation',
    'invite.revoke': 'revoked an invitation',
    'account.grant': 'granted an account',
    'account.status': 'changed an account status',
    'account.role': 'changed an account role',
    'account.recovery': 'issued a reset link',
    'signup.mail_test': 'sent a test email',
    'instance.resume': 'resumed the instance',
    'instance.restore': 'restored the instance',
    'instance.pause': 'paused the instance',
    'limits.change': 'changed a limit'
};

function describeDetail(detail: Record<string, unknown> | null): string {
    if (!detail) return '';
    return Object.entries(detail)
        .filter(([key, value]) => key !== 'via' && value !== null && value !== undefined && typeof value !== 'object')
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(' · ');
}

/** Who did it: a named account, the CLI that ran it, or a person since erased. */
function actorLabel(entry: OperatorAuditEntry, nameFor: (id: string) => string): string {
    if (entry.actor) return nameFor(entry.actor);
    const via = entry.detail?.via;
    return typeof via === 'string' && via ? via : 'someone erased';
}

function targetLabel(entry: OperatorAuditEntry, nameFor: (id: string) => string): string | null {
    if (!entry.target) return entry.action.startsWith('invite.') ? null : (entry.action.startsWith('account.') ? 'someone erased' : null);
    return entry.action.startsWith('invite.') ? `invitation #${entry.target}` : nameFor(entry.target);
}

/** Who changed what, when (documentation/work_ledger.md). Kept one year. */
function AuditPanel() {
    const whenLabel = useDateLabel();
    const accounts = useQuery({ queryKey: ACCOUNTS_KEY, queryFn: () => api.adminAccounts() });
    const audit = useInfiniteQuery({
        queryKey: AUDIT_KEY,
        queryFn: ({ pageParam }) => api.adminAudit({ before: pageParam, limit: 25 }),
        initialPageParam: null as string | null,
        getNextPageParam: (page) => page.nextCursor
    });
    const names = new Map((accounts.data?.accounts || []).map((account) => [account.principalId, account.loginName || account.displayName || account.principalId]));
    const nameFor = (id: string) => names.get(id) || id;
    const entries = audit.data?.pages.flatMap((page) => page.entries) || [];
    return (
        <section className="settings-section" aria-labelledby="host-audit-title" data-testid="host-audit">
            <h2 id="host-audit-title">Operator audit</h2>
            <p className="hint">Every change made from this room - accounts, invitations, sign-up, limits and the instance itself - kept for one year. Never a token or a password.</p>
            {audit.isPending && <div className="hint">Loading…</div>}
            {audit.isError && <div className="hint">{(audit.error as Error).message}</div>}
            {audit.data && entries.length === 0 && <div className="hint">Nothing recorded yet.</div>}
            {entries.length > 0 && (
                <div className="list-card">
                    {entries.map((entry) => (
                        <div key={entry.id} className="list-row" data-testid="host-audit-entry">
                            <div className="row-body">
                                <strong>{actorLabel(entry, nameFor)}</strong> {AUDIT_ACTION_LABEL[entry.action] || entry.action}
                                {targetLabel(entry, nameFor) ? <> for <code>{targetLabel(entry, nameFor)}</code></> : null}
                                <div className="row-meta">
                                    {whenLabel(entry.createdAt)}
                                    {describeDetail(entry.detail) ? ` · ${describeDetail(entry.detail)}` : ''}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
            {audit.hasNextPage && (
                <button type="button" className="btn" disabled={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()} style={{ marginTop: 10 }}>
                    {audit.isFetchingNextPage ? 'Loading…' : 'Load older entries'}
                </button>
            )}
        </section>
    );
}

function SignupPanel() {
    const toast = useToast();
    const view = useQuery({ queryKey: INSTALLATION_KEY, queryFn: () => api.adminInstallation() });
    const [testTo, setTestTo] = useState('');
    const [busy, setBusy] = useState(false);
    const data = view.data;

    async function sendTest(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        try {
            const result = await api.adminTestMail(testTo.trim());
            toast(`Test message handed to ${result.provider}. Check the inbox (and the spam folder).`);
        } catch (error) {
            toast((error as ApiError).message, true);
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="settings-section" aria-labelledby="host-signup-title">
            <h2 id="host-signup-title">Sign-up &amp; mail</h2>
            <p className="hint">
                How people get in, and whether this installation can send email. Both are set in <code>config.json</code> or the environment
                (<code>identity.registration</code>, <code>mail.*</code>, <code>webapp.publicUrl</code>); this panel shows what is in effect.
            </p>
            {view.isPending && <div className="hint">Loading…</div>}
            {data && (
                <div className="list-card">
                    <div className="list-row">
                        <span>Registration</span>
                        <span>
                            <strong>{data.registration.effective === 'open' ? 'Open sign-up' : 'Invitation only'}</strong>
                            {data.registration.configured !== data.registration.effective && (
                                <span className="hint"> · configured <code>{data.registration.configured}</code>, but {data.mail.reason?.replace(/\.$/, '').toLowerCase() || 'mail is off'}</span>
                            )}
                        </span>
                    </div>
                    <div className="list-row">
                        <span>Outbound mail</span>
                        <span>
                            {data.mail.enabled
                                ? <><strong>On</strong> · {data.mail.provider} · from <code>{data.mail.from}</code></>
                                : <><strong>Off</strong>{data.mail.reason && <span className="hint"> · {data.mail.reason}</span>}</>}
                        </span>
                    </div>
                    <div className="list-row">
                        <span>Emailed links</span>
                        <span>
                            {data.mail.linksEnabled
                                ? <>Verification and password reset by email are available · <code>{data.publicUrl}</code></>
                                : <><strong>Unavailable</strong>{data.mail.reason && <span className="hint"> · {data.mail.reason}</span>}</>}
                        </span>
                    </div>
                    <div className="list-row">
                        <span className="hint">Verification links last {Math.round(data.emailVerifyTtlMinutes / 60)} h · reset links {data.recoveryTtlMinutes} min</span>
                    </div>
                </div>
            )}
            {data?.mail.linksEnabled && (
                <form className="host-invite-form" onSubmit={sendTest}>
                    <input className="input" type="email" placeholder="Send a test message to…" value={testTo}
                        onChange={(e) => setTestTo(e.target.value)} aria-label="Test recipient" style={{ flex: 1 }} required />
                    <button type="submit" className="btn" disabled={busy || !testTo.trim()}>Send test</button>
                </form>
            )}
        </section>
    );
}

function ReportPanel() {
    const report = useQuery({ queryKey: REPORT_KEY, queryFn: () => api.adminIdentityReport() });
    const data = report.data;
    return (
        <section className="settings-section" aria-labelledby="host-report-title">
            <h2 id="host-report-title">Migration report</h2>
            <p className="hint">Legacy Discord data and how much of it already has a principal and an account. The same numbers as <code>npm run identity:report</code>.</p>
            {report.isPending && <div className="hint">Loading…</div>}
            {data && (
                <div className="list-card">
                    <div className="list-row"><span>Installation</span><span><code>{data.installationId}</code> · requireAccount {data.requireAccount ? 'on' : 'off'}</span></div>
                    <div className="list-row"><span>Distinct owners across identity-bearing tables</span><span>{data.owners.total}</span></div>
                    <div className="list-row"><span>With a principal / with an account</span><span>{data.owners.withPrincipal} / {data.owners.withAccount}</span></div>
                    <div className="list-row"><span>Unresolved ids (not a snowflake or usr_)</span><span>{data.owners.unresolved}</span></div>
                    <div className="list-row"><span>Accounts</span><span>{data.accounts.total} ({data.accounts.active} active, {data.accounts.disabled} disabled, {data.accounts.operators} operators)</span></div>
                    <div className="list-row"><span className="hint">Generated {data.generatedAt} UTC</span></div>
                </div>
            )}
        </section>
    );
}

/** /host - the operator's installation panel. Hidden from the nav for members; the API refuses them anyway. */
export function HostRoom() {
    const me = useSession();
    const operator = me?.identity?.operator === true;
    return (
        <main className="pane next-pane is-in" id="pane-host">
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1>Host</h1>
                </div>
            </header>
            <div className="pane-body host-body">
                {!operator && <div className="empty">Only the host of this installation can open this room.</div>}
                {operator && (
                    <>
                        <InstancePanel />
            <LimitsPanel />
                        <SignupPanel />
                        <InvitesPanel />
                        <AccountsPanel />
                        <AuditPanel />
                        <ReportPanel />
                    </>
                )}
            </div>
        </main>
    );
}
