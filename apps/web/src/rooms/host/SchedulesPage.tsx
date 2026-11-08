import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { OperatorSchedule } from '../../lib/types';
import { useConfirm } from '../../hooks/useConfirm';
import { useToast } from '../../hooks/useToast';
import { useDateLabel } from '../../hooks/useDateLabel';

const SCHEDULES_KEY = ['admin-schedules'];
const AUDIT_KEY = ['admin-audit'];

const LABEL_TEXT: Record<OperatorSchedule['label'], string> = {
    prompt: 'Automation',
    digest: 'Channel digest',
    wrapped: 'Server Wrapped',
    wheel: 'Daily Wheel',
    reminder: 'Reminder'
};

type Action = 'pause' | 'resume' | 'trigger' | 'delete';

function titleOf(row: OperatorSchedule): string {
    return row.name || (row.note ? `"${row.note}"` : `Reminder #${row.id}`);
}

/**
 * /host/schedules - every automation and reminder that posts into a server,
 * whoever owns it. The host can pause, resume, run now or delete any of them
 * (documentation/operator_schedules.md). Private DM and Inbox tasks never
 * appear here, and the prompt text of an automation is never sent.
 */
export function SchedulesPage() {
    const toast = useToast();
    const confirm = useConfirm();
    const whenLabel = useDateLabel();
    const queryClient = useQueryClient();
    const [guildId, setGuildId] = useState('');
    const [kind, setKind] = useState('');
    const [status, setStatus] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    const view = useQuery({
        queryKey: [...SCHEDULES_KEY, guildId, kind, status],
        queryFn: () => api.adminSchedules({ guildId, kind, status }),
        refetchInterval: 30_000
    });
    const data = view.data;

    async function run(row: OperatorSchedule, action: Action) {
        const title = titleOf(row);
        const prompts: Partial<Record<Action, string>> = {
            trigger: `Run "${title}" now? It posts into ${row.guildName || `server ${row.guildId}`} within about a minute; its regular schedule is unchanged.`,
            delete: row.kind === 'automation'
                ? `Delete "${title}"? It will never run again, and its owner is told in their Inbox.`
                : `Cancel ${title}? ${row.recurring ? 'The whole series stops, and ' : ''}its owner is told in their Inbox.`,
            pause: `Pause "${title}"? It will not run until you resume it, and its owner is told in their Inbox.`
        };
        const question = prompts[action];
        if (question && !await confirm(question)) return;
        setBusy(`${row.key}:${action}`);
        try {
            if (action === 'delete') {
                await api.adminDeleteSchedule(row.kind, row.id);
                toast(row.kind === 'automation' ? 'Deleted.' : 'Cancelled.');
            } else {
                const result = await api.adminScheduleAction(row.kind, row.id, action);
                toast(
                    action === 'trigger'
                        ? (result.botOnline ? 'Queued - it runs within a minute.' : 'Queued - it runs when the bot is back online.')
                        : action === 'pause' ? 'Paused.' : 'Resumed.'
                );
            }
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY }),
                queryClient.invalidateQueries({ queryKey: AUDIT_KEY })
            ]);
        } catch (error) {
            toast((error as ApiError).message, true);
            await queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY });
        } finally {
            setBusy(null);
        }
    }

    return (
        <section className="settings-section" aria-labelledby="host-schedules-title" data-testid="host-schedules">
            <h2 id="host-schedules-title">Server schedules</h2>
            <p className="hint">
                Every recurring automation and reminder that posts into a server, whoever set it up. Pause, resume, run now or delete any
                of them; the owner is told in their Inbox and every change is in the audit list. Personal tasks (DMs and Inbox) are not
                shown and cannot be changed from here.
            </p>
            {data && !data.botOnline && (
                <div className="hint" role="status" data-testid="schedules-offline">
                    The bot is not reachable, so server names are shown as ids and runs that post to Discord wait until it is back.
                </div>
            )}
            <div className="host-invite-form" style={{ marginBottom: 12 }}>
                <select className="select" value={guildId} onChange={(e) => setGuildId(e.target.value)} aria-label="Server" data-testid="schedules-guild">
                    <option value="">All servers</option>
                    {(data?.guilds || []).map((guild) => (
                        <option key={guild.id} value={guild.id}>{guild.name || `Server ${guild.id}`} ({guild.count})</option>
                    ))}
                </select>
                <select className="select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind" data-testid="schedules-kind">
                    <option value="">Automations and reminders</option>
                    <option value="automation">Automations</option>
                    <option value="followup">Reminders</option>
                </select>
                <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" data-testid="schedules-status">
                    <option value="">Active and paused</option>
                    <option value="active">Active</option>
                    <option value="paused">Paused</option>
                </select>
            </div>
            {view.isPending && <div className="hint">Loading…</div>}
            {view.isError && <div className="hint">{(view.error as Error).message}</div>}
            {data && data.schedules.length === 0 && (
                <div className="empty" data-testid="schedules-empty">Nothing is scheduled to post into a server{guildId || kind || status ? ' with these filters' : ''}.</div>
            )}
            {data && data.schedules.length > 0 && (
                <div className="list-card">
                    {data.schedules.map((row) => (
                        <div key={row.key} className={`list-row${row.paused ? ' disabled' : ''}`} style={{ flexWrap: 'wrap', gap: 8 }} data-testid="schedule-row" data-key={row.key}>
                            <span style={{ minWidth: 0, flex: '1 1 280px' }}>
                                <span className="badge">{LABEL_TEXT[row.label]}</span>{' '}
                                <strong>{titleOf(row)}</strong>{' '}
                                {row.paused
                                    ? <span className="badge state-unverified">paused</span>
                                    : <span className="badge state-open">active</span>}
                                <div className="hint">
                                    {row.guildName || `Server ${row.guildId}`} · <code>{row.channelId}</code> · by {row.ownerName || (row.ownerId ? <code>{row.ownerId}</code> : 'Goobster')}
                                </div>
                                <div className="hint">
                                    {row.kind === 'automation'
                                        ? <>⏱ <code>{row.schedule}</code> UTC</>
                                        : row.recurring ? `🔁 repeats ${row.recurrence}` : '🔔 one time'}
                                    {row.nextRunAt ? ` · next ${whenLabel(row.nextRunAt)}` : ''}
                                    {row.lastRunAt ? ` · last ${whenLabel(row.lastRunAt)}` : ''}
                                    {row.deliveryCount ? ` · delivered ${row.deliveryCount}×` : ''}
                                </div>
                            </span>
                            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                {row.actions.includes('pause') && !row.paused && (
                                    <button type="button" className="btn subtle small" disabled={busy !== null} onClick={() => void run(row, 'pause')} data-testid="schedule-pause">Pause</button>
                                )}
                                {row.actions.includes('resume') && row.paused && (
                                    <button type="button" className="btn subtle small" disabled={busy !== null} onClick={() => void run(row, 'resume')} data-testid="schedule-resume">Resume</button>
                                )}
                                {row.actions.includes('trigger') && (
                                    <button type="button" className="btn subtle small" disabled={busy !== null || row.paused} title={row.paused ? 'Resume it first' : undefined} onClick={() => void run(row, 'trigger')} data-testid="schedule-trigger">Run now</button>
                                )}
                                {row.actions.includes('delete') && (
                                    <button type="button" className="btn subtle small danger" disabled={busy !== null} onClick={() => void run(row, 'delete')} data-testid="schedule-delete">
                                        {row.kind === 'automation' ? 'Delete' : 'Cancel'}
                                    </button>
                                )}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}
