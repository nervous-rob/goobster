import { useDateLabel } from '../hooks/useDateLabel';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { Modal } from '../components/Modal';
import { MenuButton } from '../shell/MenuButton';
import { Link } from '@tanstack/react-router';
import { useMe } from '../hooks/useSession';
import { featureActive } from '../lib/rooms';

const CRON_LABELS = new Map([
    ['0 9 * * *', 'Daily at 9:00'],
    ['0 17 * * *', 'Daily at 17:00'],
    ['0 9 * * 1', 'Mondays at 9:00'],
    ['0 9 * * 1-5', 'Weekday mornings'],
    ['0 17 * * 5', 'Fridays at 17:00'],
    ['0 9 1 * *', 'Monthly (1st)']
]);



type Automation = {
    id: number; name: string; prompt: string; enabled: boolean;
    scope?: string; scopeName?: string; schedule?: string; scheduleLabel?: string;
    nextRun?: string; lastRun?: string; delivery?: Delivery;
};
type Followup = {
    id: number; prompt: string; dueAt?: string; recurrence?: string;
    deliveryCount?: number; paused?: boolean; scope?: string; scopeName?: string; delivery?: Delivery;
};
type Delivery = 'inbox' | 'discord-dm' | 'channel';

const DELIVERY_LABEL: Record<Delivery, string> = {
    inbox: 'Inbox', 'discord-dm': 'Discord DM', channel: 'server channel'
};

const STARTERS = [
    { name: 'Morning briefing', prompt: 'Review my open loops, upcoming reminders and active projects. Give me three priorities, explain what needs my attention, and flag anything blocked. Use only information you can access; say what is missing.', schedule: '0 9 * * 1-5' },
    { name: 'Weekly review', prompt: 'Review my active projects and unresolved commitments. Summarize progress, deadlines and blockers, then suggest the next actions. Do not change anything or contact anyone.', schedule: '0 17 * * 5' }
];

export function TasksRoom() {
    const me = useMe();
    const whenLabel = useDateLabel();
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const tasks = useQuery({ queryKey: keys.tasks, queryFn: () => api.tasks() as Promise<{ automations: Automation[]; followups: Followup[] }> });
    const [creating, setCreating] = useState(false);
    const [editing, setEditing] = useState<Automation | null>(null);
    const [starter, setStarter] = useState<typeof STARTERS[number] | null>(null);
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState('all');
    const matches = (text: string) => text.toLowerCase().includes(search.toLowerCase());
    const automations = (tasks.data?.automations || []).filter((task) => matches(`${task.name} ${task.prompt}`) && filter !== 'reminders' && (filter !== 'paused' || !task.enabled) && (filter !== 'active' || task.enabled));
    const followups = (tasks.data?.followups || []).filter((task) => matches(task.prompt) && ['all', 'reminders'].includes(filter));

    const invalidate = () => Promise.all([keys.tasks, keys.home].map((queryKey) => queryClient.invalidateQueries({ queryKey })));

    return (
        <main className="pane next-pane is-in" id="pane-tasks">
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1>Scheduled</h1>
                </div>
                <button type="button" className="btn primary" onClick={() => { setStarter(null); setCreating(true); }}>✚ New task</button>
            </header>
            <div className="pane-body">
                <section className="responsibility-setup">
                    <h2>Put recurring work on a schedule.</h2>
                    <p className="hint">Manage prompts {me.assistant.name} runs on a timer and reminders delivered to your Inbox.</p>
                    <div className="responsibility-setup-actions">
                        {featureActive(me, 'assistant') && <Link className="btn" to="/assistant">Responsibilities →</Link>}
                        <Link className="btn" to="/activity/attention">Commitments & watches →</Link>
                        <Link className="btn" to="/activity/inbox">View results →</Link>
                    </div>
                </section>
                <div className="responsibility-toolbar">
                    <label><span className="sr-only">Search scheduled work</span><input className="input" type="search" placeholder="Search scheduled work…" value={search} onChange={e => setSearch(e.target.value)} /></label>
                    <select className="select" aria-label="Filter scheduled work" value={filter} onChange={e => setFilter(e.target.value)}>
                        <option value="all">All scheduled work</option><option value="active">Active recurring</option><option value="paused">Paused recurring</option><option value="reminders">Reminders</option>
                    </select>
                </div>
                {tasks.isPending && <div className="empty">Loading…</div>}
                {tasks.isError && <div className="empty" role="alert">{(tasks.error as Error).message} <button className="btn small" onClick={() => void tasks.refetch()}>Retry scheduled work</button></div>}
                {tasks.data && !tasks.data.automations.length && !tasks.data.followups.length && (
                    <div className="empty-state" style={{ marginTop: '6vh' }}>
                        <div className="empty-logo">🗓️</div>
                        <div className="empty-title">Start with one task</div>
                        <div className="hint" style={{ maxWidth: 440, margin: '0 auto' }}>
                            Scheduled tasks are prompts {me.assistant.name} runs for you on a timer. Results land in your{' '}
                            <Link to="/activity/inbox">Inbox</Link>{me.discord.enabled ? ' - and in your Discord DMs when you have them.' : '.'}
                        </div>
                        <div className="responsibility-starters">{STARTERS.map(s => <button key={s.name} className="btn" onClick={() => { setStarter(s); setCreating(true); }}>＋ {s.name}</button>)}</div>
                    </div>
                )}
                {tasks.data && (tasks.data.automations.length > 0 || tasks.data.followups.length > 0) && !automations.length && !followups.length && <p className="empty" role="status">No scheduled work matches this view.</p>}
                {!!automations.length && (
                    <>
                        <div className="section-title">Recurring tasks <span className="hint">· schedules use UTC</span></div>
                        <div className="list-card">
                            {automations.map((task) => (
                                <div key={task.id} className={`list-row task-row${task.enabled ? '' : ' disabled'}`}>
                                    <div className="row-body">
                                        <span className="badge">{task.scope === 'dm' ? (task.delivery ? `→ ${DELIVERY_LABEL[task.delivery]}` : 'DM') : task.scopeName}</span>
                                        <strong>{task.name}</strong>
                                        <span className="badge">{task.enabled ? 'Active' : 'Paused'}</span>
                                        <div className="task-prompt">{task.prompt}</div>
                                        <div className="row-meta">
                                            ⏱ {CRON_LABELS.get(task.schedule || '') || task.scheduleLabel || task.schedule}
                                            {task.nextRun ? ` · next ${whenLabel(task.nextRun)}` : ''}
                                            {task.lastRun ? ` · last ${whenLabel(task.lastRun)}` : ''}
                                        </div>
                                    </div>
                                    <button className="btn small" onClick={() => setEditing(task)} aria-label={`Edit ${task.name}`}>Edit</button>
                                    <button type="button" className={`toggle${task.enabled ? ' on' : ''}`} role="switch"
                                        aria-checked={task.enabled}
                                        onClick={async () => {
                                            try {
                                                const result = await api.toggleAutomation(task.id, !task.enabled) as { enabled: boolean };
                                                toast(result.enabled ? 'Task enabled.' : 'Task paused.');
                                                invalidate();
                                            } catch (error) { toast((error as Error).message, true); }
                                        }}
                                    />
                                    <button type="button" className="row-delete" aria-label={`Delete ${task.name}`}
                                        onClick={async () => {
                                            if (!await confirm(`Delete "${task.name}"? It will never run again.`)) return;
                                            try {
                                                await api.deleteAutomation(task.id);
                                                toast('Task deleted.');
                                                invalidate();
                                            } catch (error) { toast((error as Error).message, true); }
                                        }}>✕</button>
                                </div>
                            ))}
                        </div>
                    </>
                )}
                {!!followups.length && (
                    <>
                        <div className="section-title">Reminders</div>
                        <div className="list-card">
                            {followups.map((task) => (
                                <div key={task.id} className="list-row task-row">
                                    <div className="row-body">
                                        <span className="badge">{task.scope === 'dm' ? (task.delivery ? `→ ${DELIVERY_LABEL[task.delivery]}` : 'DM') : task.scopeName}</span>
                                        <span>{task.prompt}</span>
                                        <div className="row-meta">
                                            {task.recurrence
                                                ? `🔁 repeats ${task.recurrence}${task.paused ? ' · paused by the host' : ` · next ${whenLabel(task.dueAt)}`}${task.deliveryCount ? ` · delivered ${task.deliveryCount}×` : ''}`
                                                : `🔔 due ${whenLabel(task.dueAt)}`}
                                        </div>
                                    </div>
                                    <button type="button" className="row-delete" aria-label={`Cancel reminder: ${task.prompt}`} onClick={async () => {
                                        if (!await confirm(task.recurrence ? 'Cancel this recurring reminder? The whole series stops.' : 'Cancel this reminder?')) return;
                                        try {
                                            await api.cancelFollowup(task.id);
                                            toast('Reminder cancelled.');
                                            invalidate();
                                        } catch (error) { toast((error as Error).message, true); }
                                    }}>✕</button>
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </div>
            {(creating || editing) && <CreateTaskModal task={editing || undefined} starter={starter || undefined} onClose={() => { setCreating(false); setEditing(null); }} onCreated={() => { setCreating(false); setEditing(null); invalidate(); }} />}
        </main>
    );
}

function CreateTaskModal({ onClose, onCreated, task, starter }: { onClose: () => void; onCreated: () => void; task?: Automation; starter?: typeof STARTERS[number] }) {
    const toast = useToast();
    const [kind, setKind] = useState<'recurring' | 'once'>('recurring');
    const initialSchedule = task?.schedule || starter?.schedule || '0 9 * * *';
    const [name, setName] = useState(task?.name || starter?.name || '');
    const [prompt, setPrompt] = useState(task?.prompt || starter?.prompt || '');
    const [schedule, setSchedule] = useState(CRON_LABELS.has(initialSchedule) ? initialSchedule : 'custom');
    const [cron, setCron] = useState(initialSchedule);
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    soon.setMinutes(soon.getMinutes() - soon.getTimezoneOffset());
    const [due, setDue] = useState(soon.toISOString().slice(0, 16));
    const create = useMutation({
        mutationFn: () => {
            const body: Record<string, unknown> = { name: name.trim(), prompt: prompt.trim() };
            if (kind === 'recurring') body.cron = schedule === 'custom' ? cron.trim() : schedule;
            else body.dueAt = new Date(due).toISOString();
            return task ? api.updateAutomation(task.id, body) : api.createTask(body);
        },
        onSuccess: () => { toast(task ? 'Task updated.' : 'Task scheduled.'); onCreated(); },
        onError: (error) => toast((error as Error).message, true)
    });

    return (
        <Modal onClose={onClose}>
            <h2>{task ? 'Edit task' : 'New task'}</h2>
            <label>Name<input className="input" maxLength={60} placeholder="e.g. Morning briefing" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>{kind === 'recurring' ? 'What should Goobster do?' : 'What should Goobster remind you of?'}<textarea className="input" maxLength={kind === 'recurring' ? 2000 : 500} placeholder="Describe the outcome and any boundaries" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} /></label>
            {!task && <div className="segment" role="group" aria-label="Task type">
                <button type="button" className={`segment-btn${kind === 'recurring' ? ' active' : ''}`} onClick={() => setKind('recurring')}>Recurring</button>
                <button type="button" className={`segment-btn${kind === 'once' ? ' active' : ''}`} onClick={() => setKind('once')}>Once</button>
            </div>}
            <p className="hint">{kind === 'recurring' ? 'Goobster performs AI work on each run, using the operator’s assistant policy and your account budget. Schedules use UTC.' : 'A one-time reminder delivers the text you enter; it does not perform AI work. Time uses this browser’s timezone.'}</p>
            {kind === 'recurring' ? (
                <>
                    <select className="select" aria-label="Schedule (UTC)" value={schedule} onChange={(e) => setSchedule(e.target.value)}>
                        {[...CRON_LABELS.entries()].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        <option value="custom">Custom cron…</option>
                    </select>
                    {schedule === 'custom' && (
                        <input className="input" aria-label="Custom cron (UTC)" placeholder="5-part cron (UTC)" value={cron} onChange={(e) => setCron(e.target.value)} />
                    )}
                </>
            ) : (
                <input className="input" aria-label="Reminder time" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
            )}
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button type="button" className="btn primary" disabled={create.isPending || !name.trim() || !prompt.trim() || (kind === 'once' && (!due || !Number.isFinite(new Date(due).getTime())))} onClick={() => create.mutate()}>{create.isPending ? 'Saving…' : 'Save'}</button>
            </div>
        </Modal>
    );
}
