import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { AdminAssistantView, AssistantCapField, AssistantCodeCount } from '../../lib/types';
import { useConfirm } from '../../hooks/useConfirm';
import { useToast } from '../../hooks/useToast';
import { AssistantModelPolicy } from './ConfigPages';

const ASSISTANT_KEY = ['admin-assistant'];
const AUDIT_KEY = ['admin-audit'];
const ACCOUNTS_KEY = ['admin-accounts'];

type View = Extract<AdminAssistantView, { available: true }>;

const CAP_FIELDS: Array<{ id: AssistantCapField; label: string; hint: string }> = [
    { id: 'installationRuns', label: 'Runs at once, whole installation', hint: 'How many delegated runs may work at the same time.' },
    { id: 'runsPerAccount', label: 'Runs at once, per account', hint: 'How many of those one account may hold.' },
    { id: 'defaultModelTokens', label: 'Model tokens per responsibility per day', hint: 'Used when a responsibility sets no budget, and the most it can set.' },
    { id: 'defaultSearches', label: 'Web searches per responsibility per day', hint: 'Used when a responsibility sets no budget, and the most it can set.' },
    { id: 'defaultComputeSeconds', label: 'Sandbox seconds per responsibility per day', hint: 'Used when a responsibility sets no budget, and the most it can set.' }
];

const WORK_STATES = ['QUEUED', 'RUNNING', 'WAITING', 'REVIEW', 'CANDIDATE', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'];

function age(seconds: number | null): string {
    if (seconds === null) return 'none';
    if (seconds < 90) return `${seconds} s`;
    if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
    if (seconds < 129600) return `${Math.round(seconds / 3600)} h`;
    return `${Math.round(seconds / 86400)} d`;
}

function CodeList({ title, rows, empty }: { title: string; rows: AssistantCodeCount[]; empty: string }) {
    return (
        <div className="list-card" style={{ marginTop: 12 }}>
            <div className="list-row"><strong>{title}</strong></div>
            {rows.length === 0 && <div className="list-row"><span className="hint">{empty}</span></div>}
            {rows.map((row) => (
                <div className="list-row" key={row.code}><code>{row.code}</code><span>{row.count.toLocaleString()}</span></div>
            ))}
        </div>
    );
}

function CapsForm({ view, onSaved }: { view: View; onSaved: (next: AdminAssistantView) => void }) {
    const toast = useToast();
    const [values, setValues] = useState<Record<string, string>>({});
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (dirty) return;
        setValues(Object.fromEntries(CAP_FIELDS.map(({ id }) => [id, view.hostSet.includes(id) ? String(view.caps[id]) : ''])));
    }, [view, dirty]);

    async function save(event: FormEvent) {
        event.preventDefault();
        const body: Partial<Record<AssistantCapField, number | null>> = {};
        for (const { id } of CAP_FIELDS) {
            const raw = (values[id] ?? '').trim();
            const stored = view.hostSet.includes(id) ? view.caps[id] : null;
            const wanted = raw === '' ? null : Number(raw);
            if (wanted !== stored) body[id] = wanted;
        }
        if (Object.keys(body).length === 0) { setDirty(false); return; }
        setBusy(true);
        try {
            onSaved(await api.adminAssistantCaps(body));
            setDirty(false);
            toast('Caps saved. They apply to the next run that starts.');
        } catch (error) {
            toast((error as ApiError).message, true);
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={save} data-testid="assistant-caps-form" style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', alignItems: 'end' }}>
            {CAP_FIELDS.map(({ id, label, hint }) => (
                <label key={id} title={hint}>
                    {label}<br />
                    <input
                        type="number" step="1" min={view.bounds[id].min} max={view.bounds[id].max}
                        name={id} data-testid={`assistant-cap-${id}`}
                        value={values[id] ?? ''} placeholder={`Default: ${view.defaults[id].toLocaleString()}`}
                        onChange={(event) => { setDirty(true); setValues((current) => ({ ...current, [id]: event.target.value })); }}
                    />
                </label>
            ))}
            <button className="btn primary" type="submit" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save caps'}</button>
        </form>
    );
}

/**
 * /host/assistant - delegated work across the installation
 * (documentation/delegated_operations.md): stop everything, set the caps,
 * record the pilot decision, and see counts, spend and failure codes. The
 * server sends no title, prompt or result, and names accounts by id; the
 * names shown here come from the host's own account roster.
 */
export function AssistantPage() {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState<string | null>(null);
    const query = useQuery({ queryKey: ASSISTANT_KEY, queryFn: () => api.adminAssistant(), refetchInterval: 15_000 });
    const roster = useQuery({ queryKey: ACCOUNTS_KEY, queryFn: () => api.adminAccounts() });
    const view = query.data;

    const names = new Map((roster.data?.accounts || []).map((account) => [account.principalId, account.displayName || account.loginName || null]));
    async function applied(next: AdminAssistantView) {
        queryClient.setQueryData(ASSISTANT_KEY, next);
        await queryClient.invalidateQueries({ queryKey: AUDIT_KEY });
    }
    async function act(name: string, question: string, run: () => Promise<AdminAssistantView>, done: (next: View) => string) {
        if (!await confirm(question)) return;
        setBusy(name);
        try {
            const next = await run();
            await applied(next);
            if (next.available) toast(done(next));
        } catch (error) {
            toast((error as ApiError).message, true);
            await queryClient.invalidateQueries({ queryKey: ASSISTANT_KEY });
        } finally {
            setBusy(null);
        }
    }

    if (query.isPending) return <><div className="hint">Loading…</div><AssistantModelPolicy /></>;
    if (query.isError) return <><div className="settings-danger">{query.error.message}</div><AssistantModelPolicy /></>;
    if (!view || !view.available) {
        return <><div className="empty" data-testid="assistant-unavailable">The delegated assistant is not turned on for this installation. Turn it on under Features.</div><AssistantModelPolicy /></>;
    }

    const open = view.pilot.decision.scope === 'everyone';
    return (
        <>
            <section className="settings-section" aria-labelledby="host-assistant-title">
                <h2 id="host-assistant-title">Delegated work</h2>
                <nav aria-label="Delegated work settings" className="modal-actions" style={{ justifyContent: 'flex-start' }}>
                    <a className="btn small" href="#host-assistant-caps-title">Daily budgets</a>
                    <a className="btn small" href="#assistant-model-policy">Model and output limit</a>
                    <a className="btn small" href="#host-assistant-pilot-title">Pilot access</a>
                </nav>
                <p className="hint">
                    Work people have handed to Goobster under a responsibility. Stopping it here stops it for everyone: nothing new starts,
                    work already running halts at its next step and waits, and nothing is cancelled. Resuming puts the halted work back in the queue.
                </p>
                <div className={`list-card${view.paused ? ' host-instance-paused' : ''}`} data-testid="assistant-status">
                    <div className="list-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                        <span>All delegated work</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            {view.paused
                                ? <><strong className="settings-danger">Stopped</strong><span className="hint"> since {view.paused.since} UTC</span></>
                                : <strong>Running</strong>}
                            {view.paused
                                ? <button type="button" className="btn small primary" disabled={busy !== null}
                                    onClick={() => act('resume', 'Resume delegated work? Work that was halted goes back in the queue and continues from where it stopped.',
                                        api.adminAssistantResume, (next) => `Resumed. ${next.requeued || 0} halted ${next.requeued === 1 ? 'piece of work is' : 'pieces of work are'} back in the queue.`)}>
                                    {busy === 'resume' ? 'Resuming…' : 'Resume'}
                                </button>
                                : <button type="button" className="btn small danger" disabled={busy !== null}
                                    onClick={() => act('pause', 'Stop all delegated work for everyone on this installation? Nothing new starts and running work halts at its next step. Nothing is cancelled or lost.',
                                        api.adminAssistantPause, () => 'Stopped. Running work halts at its next step.')}>
                                    {busy === 'pause' ? 'Stopping…' : 'Stop all'}
                                </button>}
                        </span>
                    </div>
                </div>
                <div className="stat-grid" style={{ marginTop: 12 }}>
                    <div className="stat-card">
                        <div className="stat-label">Running now</div>
                        <div className="stat-value" data-testid="assistant-running">{view.work.running} of {view.caps.installationRuns}</div>
                        <div className="stat-sub">up to {view.caps.runsPerAccount} per account</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Queued</div>
                        <div className="stat-value">{(view.work.byStatus.QUEUED || 0).toLocaleString()}</div>
                        <div className="stat-sub">oldest: {age(view.work.oldestQueuedSeconds)}</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Waiting</div>
                        <div className="stat-value">{(view.work.byStatus.WAITING || 0).toLocaleString()}</div>
                        <div className="stat-sub">oldest: {age(view.work.oldestWaitingSeconds)}</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Active responsibilities</div>
                        <div className="stat-value">{(view.responsibilities.byStatus.ACTIVE || 0).toLocaleString()}</div>
                        <div className="stat-sub">{(view.responsibilities.byStatus.PAUSED || 0).toLocaleString()} paused by their owners</div>
                    </div>
                </div>
            </section>

            <section className="settings-section" aria-labelledby="host-assistant-caps-title">
                <h2 id="host-assistant-caps-title">Caps</h2>
                <p className="hint">
                    Leave a box empty to use the default. The daily numbers are what a responsibility gets when its owner sets no budget, and the most
                    an owner can set. A change applies to the next run that starts; a run already working keeps the budget it started with.
                </p>
                <CapsForm view={view} onSaved={applied} />
            </section>

            <AssistantModelPolicy />

            <section className="settings-section" aria-labelledby="host-assistant-pilot-title">
                <h2 id="host-assistant-pilot-title">Pilot</h2>
                <p className="hint">
                    Capabilities added after the first pilot ({view.pilot.capabilities.map((entry) => `${entry.name} (${entry.increment})`).join(', ')}) stay with
                    the host account until you record the decision to open them. Everything that shipped before is available to everyone already.
                </p>
                <div className="list-card" data-testid="assistant-pilot">
                    <div className="list-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                        <span>Pilot capabilities</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <strong>{open ? 'Open to everyone' : 'Host only'}</strong>
                            <span className="hint">{view.pilot.decision.decidedAt ? `decided ${view.pilot.decision.decidedAt} UTC` : 'no decision recorded'}</span>
                            {open
                                ? <button type="button" className="btn small" disabled={busy !== null}
                                    onClick={() => act('pilot', 'Limit the pilot capabilities to the host account again? Other people\'s responsibilities that use them stop being able to.',
                                        () => api.adminAssistantPilot('owner'), () => 'Recorded. Pilot capabilities are host only.')}>
                                    Limit to the host
                                </button>
                                : <button type="button" className="btn small" disabled={busy !== null}
                                    onClick={() => act('pilot', 'Record the pilot decision and open these capabilities to every account on this installation?',
                                        () => api.adminAssistantPilot('everyone'), () => 'Recorded. Pilot capabilities are open to everyone.')}>
                                    Open to everyone
                                </button>}
                        </span>
                    </div>
                </div>
            </section>

            <section className="settings-section" aria-labelledby="host-assistant-runs-title">
                <h2 id="host-assistant-runs-title">Last {view.windowDays} days</h2>
                <p className="hint">Counts and codes only. What a run was about, what it found and what it changed stay with the person it worked for.</p>
                <div className="list-card">
                    <div className="list-row"><strong>Runs per day (UTC)</strong></div>
                    {view.runs.perDay.length === 0 && <div className="list-row"><span className="hint">No runs yet.</span></div>}
                    {view.runs.perDay.map((day) => (
                        <div className="list-row" key={day.day}>
                            <span>{day.day}</span>
                            <span>{day.runs.toLocaleString()} runs · {day.tokens.toLocaleString()} tokens · {day.searches.toLocaleString()} searches · {day.computeSeconds.toLocaleString()} s sandbox</span>
                        </div>
                    ))}
                </div>
                <CodeList title="Runs that failed or need review" rows={view.runs.failures} empty="None." />
                <CodeList title="Refused steps" rows={view.runs.refusals} empty="None." />
                <CodeList title="Waiting now, by reason" rows={view.work.waitingByCode} empty="Nothing is waiting." />
                <div className="list-card" style={{ marginTop: 12 }}>
                    <div className="list-row"><strong>All work by state</strong></div>
                    {WORK_STATES.filter((state) => view.work.byStatus[state]).map((state) => (
                        <div className="list-row" key={state}><code>{state}</code><span>{view.work.byStatus[state].toLocaleString()}</span></div>
                    ))}
                    {WORK_STATES.every((state) => !view.work.byStatus[state]) && <div className="list-row"><span className="hint">No delegated work yet.</span></div>}
                </div>
            </section>

            <section className="settings-section" aria-labelledby="host-assistant-accounts-title">
                <h2 id="host-assistant-accounts-title">Accounts</h2>
                <div className="list-card" data-testid="assistant-accounts">
                    {view.accounts.length === 0 && <div className="list-row"><span className="hint">Nobody has delegated anything yet.</span></div>}
                    {view.accounts.map((account) => (
                        <div className="list-row" key={account.id} style={{ flexWrap: 'wrap', gap: 8 }}>
                            <span>{names.get(account.id) || account.id}{names.get(account.id) ? <span className="hint"> · {account.id}</span> : null}</span>
                            <span>
                                {account.activeResponsibilities} active · {account.running} running · {account.queued} queued · {account.waiting} waiting
                                {' · '}{account.runsToday} runs and {account.tokensToday.toLocaleString()} tokens today
                            </span>
                        </div>
                    ))}
                    {view.accountsOmitted > 0 && <div className="list-row"><span className="hint">{view.accountsOmitted} more accounts not shown.</span></div>}
                </div>
            </section>
        </>
    );
}
