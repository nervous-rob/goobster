import { useEffect, useState } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { featureActive } from '../lib/rooms';
import { useMe } from '../hooks/useSession';
import { useOpenSettings } from '../hooks/useOpenSettings';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { useDateLabel } from '../hooks/useDateLabel';
import { MenuButton } from '../shell/MenuButton';
import type { AssistantInitiative, AssistantLearnedRate, Responsibility } from '../lib/types';
import { DraftForm } from './assistant/DraftForm';
import { describeGrants, describeInterruption, describeListening, describeNoticing, describeSharing, externalOperationsPerDay, reachesGitHub, writesOutside, type Project } from './assistant/grants';
import { ConnectorList } from './assistant/ConnectorList';
import { KnowledgeChanges } from './assistant/KnowledgeChanges';
import { ProcessList } from './assistant/ProcessList';
import { OutcomeSummary } from './assistant/OutcomeSummary';
import { ResponsibilityRow } from './assistant/ResponsibilityRow';

/**
 * Responsibilities (documentation/delegated_responsibilities.md): the
 * bounded jobs a person has handed to the assistant. This page drafts one
 * from plain choices, shows exactly what each grants, and carries the
 * lifecycle (activate, pause, resume, complete, revoke, archive). A draft
 * grants nothing; only Activate, pressed by the person, turns one on.
 *
 * Below them, Processes reports on the recurring work the person has set up
 * (documentation/process_stewardship.md) and lets them pause, archive,
 * restore and clean up each one; it owns those actions itself.
 *
 * This file is the page: its queries and the two action handlers. The parts
 * live under ./assistant (the draft form, one responsibility's row, its work
 * list, the wording of grants, and the process report).
 */

export function AssistantRoom() {
    const me = useMe();
    const toast = useToast();
    const openSettings = useOpenSettings();
    const confirm = useConfirm();
    const whenLabel = useDateLabel();
    const queryClient = useQueryClient();
    const enabled = featureActive(me, 'assistant');
    const [busy, setBusy] = useState<number | null>(null);
    const [showArchived, setShowArchived] = useState(false);
    const [search, setSearch] = useState('');
    const [status, setStatus] = useState('all');
    const list = useQuery({ queryKey: keys.responsibilities, queryFn: () => api.responsibilities(), enabled });
    const projectsQ = useQuery({
        queryKey: keys.observatory, queryFn: () => api.observatoryProjects() as Promise<{ projects: Project[] }>,
        enabled: enabled && featureActive(me, 'projects')
    });
    // Work in progress changes without the person doing anything. The portal
    // event stream says when (documentation/delegated_delivery.md); the gentle
    // poll covers an account or a moment the stream does not reach.
    const workQ = useQuery({ queryKey: keys.assistantInitiatives, queryFn: () => api.assistantInitiatives(), enabled, refetchInterval: 15_000 });
    // Health is judged on every read, and incidents move on the steward's pass.
    const processesQ = useQuery({ queryKey: keys.assistantProcesses, queryFn: () => api.assistantProcesses(), enabled, refetchInterval: 60_000 });
    const hash = useLocation({ select: (location) => location.hash }).replace(/^#/, '');
    const processesReady = Boolean(processesQ.data);
    useEffect(() => {
        if (hash === 'processes' && processesReady) document.getElementById('processes')?.scrollIntoView({ block: 'start' });
    }, [hash, processesReady]);
    const workByResponsibility = new Map<number, AssistantInitiative[]>();
    for (const item of workQ.data?.initiatives || []) {
        // Work a newer look at the same source replaced is history. A request
        // the person withdrew by changing direction stays, so they can see
        // what was stopped and start it again.
        if (item.status === 'SUPERSEDED' && !item.origin) continue;
        const list = workByResponsibility.get(item.responsibilityId) || [];
        if (list.length < 5) list.push(item);
        workByResponsibility.set(item.responsibilityId, list);
    }
    const projects = projectsQ.data?.projects || [];
    const projectById = new Map(projects.map((project) => [String(project.id), project]));

    const refresh = () => Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.responsibilities }),
        queryClient.invalidateQueries({ queryKey: keys.assistantInitiatives }),
        queryClient.invalidateQueries({ queryKey: keys.home }),
        queryClient.invalidateQueries({ queryKey: ['inbox'] })
    ]);

    async function act(item: Responsibility, action: string, question?: string) {
        setBusy(item.id);
        try {
            if (action === 'discard') {
                if (question && !await confirm(question)) return;
                await api.proposalAction(item.id, 'discard', item.revision);
                return;
            }
            if (action !== 'activate' && action !== 'resume') {
                if (question && !await confirm(question)) return;
                await api.responsibilityAction(item.id, action, item.revision);
                return;
            }
            // Turning authority on is confirmed: the server says what this
            // revision allows, the question shows that, and the single-use
            // confirmation it issued is spent by the action.
            const confirmation = await api.confirmResponsibility(item.id, action, item.revision, 'portal');
            const shown = confirmation.shown;
            if (action === 'activate') {
                const grants = describeGrants(shown.operations, projectById);
                const listening = describeListening(shown, me.assistant.name);
                const noticing = describeNoticing(shown);
                const sharing = describeSharing(shown);
                if (!await confirm(`Activate "${shown.title}"? ${me.assistant.name} may then, as you: ${grants.join('; ')}.${listening ? ` ${listening}; only your own messages are read for this.` : ''}${noticing ? ` ${noticing}.` : ''}${sharing ? ` ${sharing}.` : ''}${shown.rules?.autoStart ? ' It will start proposed work by itself, within its daily budgets.' : ' Each piece of work will wait for you to press Start.'}${reachesGitHub(shown.operations) ? ` Pushes and pull requests go to GitHub as you and cannot be undone from here; at most ${externalOperationsPerDay(shown.budgets)} a day.` : ''}${writesOutside(shown.operations) ? ` Writes to outside services are made as you and cannot be undone from here; at most ${externalOperationsPerDay(shown.budgets)} outside operations a day.` : ''}${shown.expiresAt ? ` It ends ${whenLabel(shown.expiresAt)}.` : ''} ${describeInterruption(shown.rules?.interruption)}. You can pause or revoke it at any time.`)) return;
            } else if (question && !await confirm(question)) {
                return;
            }
            await api.responsibilityAction(item.id, action, shown.revision, confirmation.receipt);
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            await refresh();
            setBusy(null);
        }
    }

    async function actOnWork(item: AssistantInitiative, action: string) {
        if (action === 'queue' && !await confirm(
            `Start "${item.title}"? ${me.assistant.name} will work within this responsibility and report back. `
            + 'It can only do what the responsibility lists above, and tells you about anything it changed. '
            + 'It uses your token allowance, up to the responsibility\'s daily budget.'
        )) return;
        setBusy(item.responsibilityId);
        try {
            await api.initiativeAction(item.id, action, item.revision);
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            await refresh();
            setBusy(null);
        }
    }

    async function resetRate(rate: AssistantLearnedRate) {
        if (!await confirm('Forget what your feedback taught about this source? It proposes at its usual rate again. The feedback you gave stays on record.')) return;
        setBusy(rate.responsibilityId);
        try {
            await api.resetLearnedRate(rate.responsibilityId, rate.adapter);
            toast('Reset. This source proposes at its usual rate again.');
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            await refresh();
            setBusy(null);
        }
    }

    const learnedByResponsibility = new Map<number, AssistantLearnedRate[]>();
    for (const rate of list.data?.learned || []) {
        learnedByResponsibility.set(rate.responsibilityId, [...(learnedByResponsibility.get(rate.responsibilityId) || []), rate]);
    }
    const all = list.data?.responsibilities || [];
    const historyStatuses = ['COMPLETED', 'REVOKED', 'EXPIRED', 'ARCHIVED'];
    const shown = all.filter((item) =>
        (showArchived || status === 'history' || item.status !== 'ARCHIVED')
        && (status === 'all' || (status === 'history' ? historyStatuses.includes(item.status) : item.status === status))
        && `${item.title} ${item.outcome || ''}`.toLowerCase().includes(search.trim().toLowerCase())
    );
    const startDraft = () => document.getElementById('responsibility-title')?.focus();
    return (
        <main className="pane next-pane is-in" id="pane-assistant">
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1>Responsibilities</h1>
                </div>
                <div className="assistant-head-actions">
                    <Link to="/" className="btn subtle">← Home</Link>
                    {enabled && <button type="button" className="btn primary" onClick={startDraft}>New responsibility</button>}
                </div>
            </header>
            <div className="pane-body">
                {!enabled && (
                    <div className="empty-state" data-testid="assistant-unavailable">
                        <div className="empty-title">Delegated work is not turned on here</div>
                        <div className="hint">The host of this installation can turn on the Delegated assistant feature.</div>
                    </div>
                )}
                {enabled && (
                    <>
                        <section className="responsibility-hero">
                            <div>
                                <div className="responsibility-kicker">Your proactive assistant</div>
                                <h2>A little less to keep in your head.</h2>
                                <p>Tell {me.assistant.name} what to look after, choose what it may do, and review its work here. Drafts stay inactive until you activate them.</p>
                            </div>
                            <Link className="btn" to="/activity/inbox">View results →</Link>
                        </section>
                        <div className="responsibility-stats" aria-label="Responsibility summary">
                            <div><strong>{list.data ? all.filter(item => item.status === 'ACTIVE').length : '—'}</strong><span>Active responsibilities</span></div>
                            <div><strong>{list.data ? all.filter(item => item.status === 'DRAFT').length : '—'}</strong><span>Drafts to review</span></div>
                            <div><strong>{list.data ? all.filter(item => item.status === 'NEEDS_REVIEW').length : '—'}</strong><span>Need your review</span></div>
                        </div>
                        <section className="responsibility-setup" aria-labelledby="responsibility-setup-title">
                            <h2 id="responsibility-setup-title">Set up how your assistant works</h2>
                            <p className="hint">Attention must be on for delegated work. Set your initiative level and quiet hours, then draft a responsibility with clear boundaries.</p>
                            <div className="responsibility-setup-actions">
                                <button type="button" className="btn" onClick={() => openSettings('initiative')}>Initiative & boundaries</button>
                                <Link className="btn" to="/activity/scheduled">Scheduled tasks →</Link>
                                <Link className="btn" to="/activity/attention">Commitments & watches →</Link>
                                {me.identity?.operator && <Link className="btn" to="/host/$page" params={{ page: 'assistant' }}>Assistant models & limits →</Link>}
                            </div>
                        </section>
                        <nav className="responsibility-section-nav" aria-label="Responsibilities sections">
                            <a href="#responsibility-list">Responsibilities</a>
                            <a href="#new-responsibility">Draft a responsibility</a>
                            <a href="#processes">Processes</a>
                        </nav>
                        <section id="responsibility-list" aria-labelledby="responsibility-list-title">
                            <h2 id="responsibility-list-title">Your responsibilities</h2>
                            <div className="responsibility-toolbar">
                                <label><span className="sr-only">Search responsibilities</span><input className="input" type="search" placeholder="Search responsibilities…" value={search} onChange={event => setSearch(event.target.value)} /></label>
                                <select className="select" aria-label="Filter responsibilities" value={status} onChange={event => setStatus(event.target.value)}>
                                    <option value="all">All responsibilities</option>
                                    <option value="ACTIVE">Active</option>
                                    <option value="DRAFT">Drafts</option>
                                    <option value="PAUSED">Paused</option>
                                    <option value="NEEDS_REVIEW">Needs review</option>
                                    <option value="history">Finished & archived</option>
                                </select>
                            </div>
                            {list.isPending && <div className="empty">Loading…</div>}
                            {list.isError && <div className="empty" role="alert">{(list.error as Error).message} <button type="button" className="btn small" onClick={() => void list.refetch()}>Retry</button></div>}
                            {list.data && all.length === 0 && <div className="hint" data-testid="responsibilities-empty">Nothing delegated yet. Start by drafting one responsibility below.</div>}
                            {list.data && all.length > 0 && shown.length === 0 && <p className="empty" role="status">No responsibilities match this view.</p>}
                            {shown.length > 0 && (
                                <div className="list-card">
                                    {shown.map((item) => (
                                        <ResponsibilityRow key={item.id} item={item} projects={projectById}
                                            work={workByResponsibility.get(item.id) || []} learned={learnedByResponsibility.get(item.id) || []}
                                            busy={busy === item.id}
                                            onAct={(target, action, question) => void act(target, action, question)}
                                            onActOnWork={(work, action) => void actOnWork(work, action)}
                                            onResetRate={(rate) => void resetRate(rate)} />
                                    ))}
                                </div>
                            )}
                            {status === 'all' && all.some((item) => item.status === 'ARCHIVED') && (
                                <button type="button" className="btn subtle" style={{ marginTop: 10 }} onClick={() => setShowArchived((value) => !value)}>
                                    {showArchived ? 'Hide archived' : 'Show archived'}
                                </button>
                            )}
                        </section>
                        <div id="new-responsibility" style={{ marginTop: 22 }}>
                            <DraftForm projects={projects} onCreated={refresh} />
                        </div>
                        <ConnectorList enabled={enabled} />
                        {featureActive(me, 'knowledge') && <KnowledgeChanges />}
                        <ProcessList data={processesQ.data} pending={processesQ.isPending} error={processesQ.isError ? processesQ.error as Error : null} />
                        <OutcomeSummary />
                    </>
                )}
            </div>
        </main>
    );
}
