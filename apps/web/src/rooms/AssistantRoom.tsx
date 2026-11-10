import { useEffect, useState } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { featureActive } from '../lib/rooms';
import { useMe } from '../hooks/useSession';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { useDateLabel } from '../hooks/useDateLabel';
import { MenuButton } from '../shell/MenuButton';
import type { AssistantInitiative, Responsibility } from '../lib/types';
import { DraftForm } from './assistant/DraftForm';
import { describeGrants, describeInterruption, describeListening, externalOperationsPerDay, reachesGitHub, type Project } from './assistant/grants';
import { ProcessList } from './assistant/ProcessList';
import { ResponsibilityRow } from './assistant/ResponsibilityRow';

/**
 * Responsibilities (documentation/delegated_responsibilities.md): the
 * bounded jobs a person has handed to the assistant. This page drafts one
 * from plain choices, shows exactly what each grants, and carries the
 * lifecycle (activate, pause, resume, complete, revoke, archive). A draft
 * grants nothing; only Activate, pressed by the person, turns one on.
 *
 * Below them, Processes reports on the recurring work the person has set up
 * (documentation/process_stewardship.md). That part is read-only.
 *
 * This file is the page: its queries and the two action handlers. The parts
 * live under ./assistant (the draft form, one responsibility's row, its work
 * list, the wording of grants, and the process report).
 */

export function AssistantRoom() {
    const me = useMe();
    const toast = useToast();
    const confirm = useConfirm();
    const whenLabel = useDateLabel();
    const queryClient = useQueryClient();
    const enabled = featureActive(me, 'assistant');
    const [busy, setBusy] = useState<number | null>(null);
    const [showArchived, setShowArchived] = useState(false);
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
        const grants = describeGrants(item.operations, projectById);
        const listening = describeListening(item, me.assistant.name);
        const ask = action === 'activate'
            ? `Activate "${item.title}"? ${me.assistant.name} may then, as you: ${grants.join('; ')}.${listening ? ` ${listening}; only your own messages are read for this.` : ''}${item.rules?.autoStart ? ' It will start proposed work by itself, within its daily budgets.' : ' Each piece of work will wait for you to press Start.'}${reachesGitHub(item.operations) ? ` Pushes and pull requests go to GitHub as you and cannot be undone from here; at most ${externalOperationsPerDay(item.budgets)} a day.` : ''}${item.expiresAt ? ` It ends ${whenLabel(item.expiresAt)}.` : ''} ${describeInterruption(item.rules?.interruption)}. You can pause or revoke it at any time.`
            : question;
        if (ask && !await confirm(ask)) return;
        setBusy(item.id);
        try {
            await api.responsibilityAction(item.id, action, item.revision);
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

    const all = list.data?.responsibilities || [];
    const shown = all.filter((item) => showArchived || item.status !== 'ARCHIVED');
    return (
        <main className="pane next-pane is-in" id="pane-assistant">
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1>Responsibilities</h1>
                </div>
                <Link to="/" className="btn subtle">← Home</Link>
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
                        <p className="hint" style={{ maxWidth: 720 }}>
                            A responsibility is a bounded job you hand to {me.assistant.name}: what to look after, exactly what it may do, and until when.
                            Each action is checked against it. Nothing here runs until you activate it, and Attention must be on.
                        </p>
                        {list.isPending && <div className="empty">Loading…</div>}
                        {list.isError && <div className="empty" role="alert">{(list.error as Error).message}</div>}
                        {list.data && shown.length === 0 && <div className="hint" data-testid="responsibilities-empty">Nothing delegated yet.</div>}
                        {shown.length > 0 && (
                            <div className="list-card">
                                {shown.map((item) => (
                                    <ResponsibilityRow key={item.id} item={item} projects={projectById}
                                        work={workByResponsibility.get(item.id) || []} busy={busy === item.id}
                                        onAct={(target, action, question) => void act(target, action, question)}
                                        onActOnWork={(work, action) => void actOnWork(work, action)} />
                                ))}
                            </div>
                        )}
                        {all.some((item) => item.status === 'ARCHIVED') && (
                            <button type="button" className="btn subtle" style={{ marginTop: 10 }} onClick={() => setShowArchived((value) => !value)}>
                                {showArchived ? 'Hide archived' : 'Show archived'}
                            </button>
                        )}
                        <div style={{ marginTop: 22 }}>
                            <DraftForm projects={projects} onCreated={refresh} />
                        </div>
                        <ProcessList data={processesQ.data} pending={processesQ.isPending} error={processesQ.isError ? processesQ.error as Error : null} />
                    </>
                )}
            </div>
        </main>
    );
}
