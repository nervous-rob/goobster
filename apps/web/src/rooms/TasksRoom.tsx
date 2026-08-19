import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { Modal } from '../components/Modal';

const CRON_LABELS = new Map([
    ['0 9 * * *', 'Daily at 9:00'],
    ['0 17 * * *', 'Daily at 17:00'],
    ['0 9 * * 1', 'Mondays at 9:00'],
    ['0 9 * * 1-5', 'Weekday mornings'],
    ['0 9 1 * *', 'Monthly (1st)']
]);

function whenLabel(iso?: string) {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

type Automation = {
    id: number; name: string; prompt: string; enabled: boolean;
    scope?: string; scopeName?: string; schedule?: string; scheduleLabel?: string;
    nextRun?: string; lastRun?: string;
};
type Followup = {
    id: number; prompt: string; dueAt?: string; recurrence?: string;
    deliveryCount?: number; scope?: string; scopeName?: string;
};

export function TasksRoom() {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const tasks = useQuery({ queryKey: keys.tasks, queryFn: () => api.tasks() as Promise<{ automations: Automation[]; followups: Followup[] }> });
    const [creating, setCreating] = useState(false);

    const invalidate = () => queryClient.invalidateQueries({ queryKey: keys.tasks });

    return (
        <main className="pane next-pane is-in">
            <header className="pane-header">
                <h1>Tasks</h1>
                <button type="button" className="btn primary" onClick={() => setCreating(true)}>✚ New task</button>
            </header>
            <div className="pane-body">
                {tasks.isPending && <div className="empty">Loading…</div>}
                {tasks.isError && <div className="empty">{(tasks.error as Error).message}</div>}
                {tasks.data && !tasks.data.automations.length && !tasks.data.followups.length && (
                    <div className="empty-state" style={{ marginTop: '6vh' }}>
                        <div className="empty-logo">🗓️</div>
                        <div className="empty-title">Nothing scheduled yet</div>
                        <div className="hint" style={{ maxWidth: 440, margin: '0 auto' }}>
                            Scheduled tasks are prompts Goobster runs for you on a timer. Results land in your Discord DMs.
                        </div>
                    </div>
                )}
                {!!tasks.data?.automations.length && (
                    <>
                        <div className="section-title">Repeating tasks</div>
                        <div className="list-card">
                            {tasks.data.automations.map((task) => (
                                <div key={task.id} className={`list-row task-row${task.enabled ? '' : ' disabled'}`}>
                                    <div className="row-body">
                                        <span className="badge">{task.scope === 'dm' ? 'DM' : task.scopeName}</span>
                                        <strong>{task.name}</strong>
                                        <div className="task-prompt">{task.prompt}</div>
                                        <div className="row-meta">
                                            ⏱ {CRON_LABELS.get(task.schedule || '') || task.scheduleLabel || task.schedule}
                                            {task.nextRun ? ` · next ${whenLabel(task.nextRun)}` : ''}
                                            {task.lastRun ? ` · last ${whenLabel(task.lastRun)}` : ''}
                                        </div>
                                    </div>
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
                {!!tasks.data?.followups.length && (
                    <>
                        <div className="section-title">Reminders</div>
                        <div className="list-card">
                            {tasks.data.followups.map((task) => (
                                <div key={task.id} className="list-row task-row">
                                    <div className="row-body">
                                        <span className="badge">{task.scope === 'dm' ? 'DM' : task.scopeName}</span>
                                        <span>{task.prompt}</span>
                                        <div className="row-meta">
                                            {task.recurrence
                                                ? `🔁 repeats ${task.recurrence} · next ${whenLabel(task.dueAt)}${task.deliveryCount ? ` · delivered ${task.deliveryCount}×` : ''}`
                                                : `🔔 due ${whenLabel(task.dueAt)}`}
                                        </div>
                                    </div>
                                    <button type="button" className="row-delete" onClick={async () => {
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
            {creating && <CreateTaskModal onClose={() => setCreating(false)} onCreated={() => { setCreating(false); invalidate(); }} />}
        </main>
    );
}

function CreateTaskModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
    const toast = useToast();
    const [kind, setKind] = useState<'recurring' | 'once'>('recurring');
    const [name, setName] = useState('');
    const [prompt, setPrompt] = useState('');
    const [schedule, setSchedule] = useState('0 9 * * *');
    const [cron, setCron] = useState('');
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    soon.setMinutes(soon.getMinutes() - soon.getTimezoneOffset());
    const [due, setDue] = useState(soon.toISOString().slice(0, 16));
    const create = useMutation({
        mutationFn: () => {
            const body: Record<string, unknown> = { name: name.trim(), prompt: prompt.trim() };
            if (kind === 'recurring') body.cron = schedule === 'custom' ? cron.trim() : schedule;
            else body.dueAt = new Date(due).toISOString();
            return api.createTask(body);
        },
        onSuccess: () => { toast('Task scheduled.'); onCreated(); },
        onError: (error) => toast((error as Error).message, true)
    });

    return (
        <Modal onClose={onClose}>
            <h2>New task</h2>
            <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <textarea className="input" placeholder="Prompt Goobster will run" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} />
            <div className="segment" role="tablist">
                <button type="button" className={`segment-btn${kind === 'recurring' ? ' active' : ''}`} onClick={() => setKind('recurring')}>Recurring</button>
                <button type="button" className={`segment-btn${kind === 'once' ? ' active' : ''}`} onClick={() => setKind('once')}>Once</button>
            </div>
            {kind === 'recurring' ? (
                <>
                    <select className="select" value={schedule} onChange={(e) => setSchedule(e.target.value)}>
                        {[...CRON_LABELS.entries()].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        <option value="custom">Custom cron…</option>
                    </select>
                    {schedule === 'custom' && (
                        <input className="input" placeholder="5-part cron (UTC)" value={cron} onChange={(e) => setCron(e.target.value)} />
                    )}
                </>
            ) : (
                <input className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
            )}
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button type="button" className="btn primary" disabled={create.isPending} onClick={() => create.mutate()}>Save</button>
            </div>
        </Modal>
    );
}
