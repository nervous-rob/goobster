import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useDateLabel } from '../hooks/useDateLabel';
import { useToast } from '../hooks/useToast';
import { useMe } from '../hooks/useSession';
import { Markdown } from '../components/Markdown';
import { MenuButton } from '../shell/MenuButton';
import type { InboxItem, InboxKind } from '../lib/types';

/**
 * The Inbox: where the results of unattended work land - reminders,
 * scheduled task output, watches that fired, invitations, notices. Every
 * item exists here first; a Discord DM, when this installation has Discord
 * and the person can receive one, is an echo that is tracked on the item.
 * The pane is the same with Discord connected, offline, or absent.
 */

type View = 'open' | 'unread' | 'archived';

const KIND_MARK: Record<InboxKind, string> = {
    reminder: '⏰', task: '🗓️', watch: '🧭', notice: '🔔',
    invite: '✉️', project: '🔭', expedition: '🧠', system: '⚙️'
};

const KIND_LABEL: Record<InboxKind, string> = {
    reminder: 'reminder', task: 'task', watch: 'watch', notice: 'notice',
    invite: 'invitation', project: 'project', expedition: 'expedition', system: 'system'
};

function echoLabel(item: InboxItem, discordEnabled: boolean): string | null {
    if (item.discord.status === 'sent') return 'also sent to your Discord DMs';
    if (item.discord.status === 'failed') return 'Discord DM could not be delivered';
    if (!discordEnabled) return null;
    return item.discord.error === 'no Discord identity' ? 'in-app only (no Discord connected)' : null;
}

export function InboxRoom() {
    const me = useMe();
    const whenLabel = useDateLabel();
    const toast = useToast();
    const queryClient = useQueryClient();
    const [view, setView] = useState<View>('open');
    const [expanded, setExpanded] = useState<number | null>(null);

    const list = useQuery({
        queryKey: keys.inbox(view),
        queryFn: () => api.inbox({ unread: view === 'unread', archived: view === 'archived' })
    });

    const invalidate = () => Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inbox'] }),
        queryClient.invalidateQueries({ queryKey: keys.me })
    ]);

    async function open(item: InboxItem) {
        const next = expanded === item.id ? null : item.id;
        setExpanded(next);
        if (next !== null && !item.read) {
            try {
                await api.inboxRead(item.id, true);
                await invalidate();
            } catch (error) { toast((error as Error).message, true); }
        }
    }

    async function toggleRead(item: InboxItem) {
        try {
            await api.inboxRead(item.id, !item.read);
            await invalidate();
        } catch (error) { toast((error as Error).message, true); }
    }

    async function archive(item: InboxItem) {
        try {
            await api.inboxArchive(item.id);
            if (expanded === item.id) setExpanded(null);
            toast('Archived.');
            await invalidate();
        } catch (error) { toast((error as Error).message, true); }
    }

    async function readAll() {
        try {
            const { updated } = await api.inboxReadAll();
            toast(updated ? `Marked ${updated} read.` : 'Nothing unread.');
            await invalidate();
        } catch (error) { toast((error as Error).message, true); }
    }

    const unread = list.data?.unread ?? me.inbox?.unread ?? 0;
    const items = list.data?.items || [];

    return (
        <main className="pane next-pane is-in">
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1>Inbox</h1>
                    {unread > 0 && <span className="badge inbox-count" aria-label={`${unread} unread`}>{unread}</span>}
                </div>
                <button type="button" className="btn" disabled={unread === 0} onClick={readAll}>Mark all read</button>
            </header>
            <div className="pane-body">
                <div className="segment" role="tablist" aria-label="Inbox view" style={{ marginBottom: 14 }}>
                    {(['open', 'unread', 'archived'] as View[]).map((option) => (
                        <button key={option} type="button" role="tab" aria-selected={view === option}
                            className={`segment-btn${view === option ? ' active' : ''}`}
                            onClick={() => { setView(option); setExpanded(null); }}>
                            {option === 'open' ? 'Inbox' : option === 'unread' ? 'Unread' : 'Archive'}
                        </button>
                    ))}
                </div>

                {list.isPending && <div className="empty">Loading…</div>}
                {list.isError && <div className="empty">{(list.error as Error).message}</div>}

                {list.data && items.length === 0 && (
                    <div className="empty-state" style={{ marginTop: '6vh' }}>
                        <div className="empty-logo">📥</div>
                        <div className="empty-title">
                            {view === 'archived' ? 'Nothing archived' : view === 'unread' ? 'All caught up' : 'Nothing here yet'}
                        </div>
                        <div className="hint" style={{ maxWidth: 480, margin: '0 auto' }}>
                            {view === 'open'
                                ? <>When {me.assistant.name} finishes something for you while you are away - a reminder comes due,
                                    a scheduled <Link to="/tasks">task</Link> runs, a watch fires, someone invites you - the result lands here
                                    {me.discord.enabled ? ', and in your Discord DMs when you have them.' : '.'}</>
                                : 'Items you archive stay readable here.'}
                        </div>
                    </div>
                )}

                {items.length > 0 && (
                    <div className="list-card">
                        {items.map((item) => {
                            const isOpen = expanded === item.id;
                            const echo = echoLabel(item, me.discord.enabled);
                            return (
                                <div key={item.id} className={`list-row task-row inbox-row${item.read ? '' : ' unread'}${isOpen ? ' open' : ''}`}>
                                    <button type="button" className="row-body inbox-row-main" aria-expanded={isOpen}
                                        onClick={() => open(item)}>
                                        <span className="badge">{KIND_MARK[item.kind]} {KIND_LABEL[item.kind]}</span>
                                        <strong>{item.title}</strong>
                                        {!item.read && <span className="inbox-dot" aria-label="unread" />}
                                        <div className="row-meta">
                                            {whenLabel(item.createdAt)}
                                            {echo ? ` · ${echo}` : ''}
                                            {item.attachments.length > 0 ? ` · ${item.attachments.length} attachment${item.attachments.length === 1 ? '' : 's'}` : ''}
                                        </div>
                                        {isOpen && (
                                            <div className="inbox-body">
                                                {item.body
                                                    ? <Markdown source={item.body} attachments={item.attachments.map((a) => ({ url: a.url, name: a.name || undefined }))} />
                                                    : <div className="hint">No details - the title is the whole message.</div>}
                                            </div>
                                        )}
                                    </button>
                                    <div className="inbox-actions">
                                        {item.link && (
                                            <Link to={item.link as never} className="btn subtle" title="Open where this came from">Open →</Link>
                                        )}
                                        <button type="button" className="btn subtle" onClick={() => toggleRead(item)}>
                                            {item.read ? 'Unread' : 'Read'}
                                        </button>
                                        {!item.archived && (
                                            <button type="button" className="row-delete" aria-label={`Archive ${item.title}`}
                                                title="Archive" onClick={() => archive(item)}>✕</button>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </main>
    );
}
