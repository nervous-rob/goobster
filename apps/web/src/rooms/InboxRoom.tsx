import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { seedInboxDraft } from '../hooks/useInboxDraft';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useDateLabel } from '../hooks/useDateLabel';
import { useToast } from '../hooks/useToast';
import { useMe } from '../hooks/useSession';
import { Markdown } from '../components/Markdown';
import { MenuButton } from '../shell/MenuButton';
import { failureKindLabel } from '../components/WorkLedger';
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

function noticeStatusPhrase(status: string | null): string | null {
    switch (status) {
        case 'dismissed': return 'dismissed in Attention';
        case 'acted_on': return 'acted on in Attention';
        case 'snoozed': return 'snoozed in Attention';
        case 'expired': return 'expired in Attention';
        default: return null;
    }
}

/** The row is the delivery of these notices. Their actions stay on Attention. */
function AttentionDelivery({ item }: { item: InboxItem }) {
    const delivery = item.attention;
    if (!delivery || delivery.notices.length === 0) return null;
    const many = delivery.notices.length > 1;
    return (
        <div className="activity-correlation" data-testid="inbox-attention-delivery">
            {many
                ? `This is the Inbox delivery of ${delivery.notices.length} Attention notices.`
                : 'This is the Inbox delivery of the Attention notice '}
            {many ? (
                <ul className="activity-correlation-list">
                    {delivery.notices.map((notice) => {
                        const phrase = noticeStatusPhrase(notice.status);
                        return (
                            <li key={notice.id}>
                                <Link to="/activity/attention" hash={`notice-${notice.id}`}>
                                    {notice.title || `Notice ${notice.id}`}
                                </Link>
                                {phrase ? ` — ${phrase}` : ''}
                            </li>
                        );
                    })}
                </ul>
            ) : (
                <>
                    <Link to="/activity/attention" hash={`notice-${delivery.notices[0].id}`}>
                        {delivery.notices[0].title || `Notice ${delivery.notices[0].id}`}
                    </Link>
                    {noticeStatusPhrase(delivery.notices[0].status)
                        ? ` — ${noticeStatusPhrase(delivery.notices[0].status)}`
                        : ''}
                    .
                </>
            )}
        </div>
    );
}

/**
 * A failure notice links to its work_failures row: the kind, the code and
 * the short reason the ledger holds - never the text of the work itself.
 * The row is pruned after 30 days; the notice then keeps only its words.
 */
function FailureLink({ item }: { item: InboxItem }) {
    const failure = item.failure;
    if (!failure) return null;
    return (
        <div className="activity-correlation" data-testid="inbox-failure-link">
            {failure.code ? (
                <>
                    What went wrong: <span className="badge">{failureKindLabel(failure.kind)}</span>{' '}
                    <code>{failure.code}</code>
                    {failure.phase ? ` during ${failure.phase}` : ''}
                    {failure.reason ? ` — ${failure.reason}` : ''}.{' '}
                    <Link to="/usage">All your failures →</Link>
                </>
            ) : (
                <>The detail for this failure has expired (failures are kept for 30 days).</>
            )}
        </div>
    );
}

function echoLabel(item: InboxItem, discordEnabled: boolean): string | null {
    if (item.discord.status === 'sent') return 'also sent to your Discord DMs';
    if (item.discord.status === 'failed') return 'Discord DM could not be delivered';
    if (!discordEnabled) return null;
    return item.discord.error === 'no Discord identity' ? 'in-app only (no Discord connected)' : null;
}

export function InboxRoom() {
    const me = useMe();
    const navigate = useNavigate();
    const hash = useLocation({ select: location => location.hash });
    const hashId = Number(/^#?inbox-(\d+)$/.exec(hash)?.[1]) || null;
    const [asking, setAsking] = useState(false);
    const whenLabel = useDateLabel();
    const toast = useToast();
    const queryClient = useQueryClient();
    const [view, setView] = useState<View>('open');
    const [selected, setSelected] = useState<InboxItem | null>(null);

    const selectedQ = useQuery({
        queryKey: ['inbox', 'item', hashId], queryFn: () => api.inboxItem(hashId!), enabled: hashId != null, retry: false
    });
    useEffect(() => {
        if (selectedQ.data && hashId === selectedQ.data.id) setSelected(selectedQ.data);
        if (!hashId) setSelected(null);
    }, [hashId, selectedQ.data]);

    const list = useInfiniteQuery({
        queryKey: keys.inbox(view),
        queryFn: ({ pageParam }) => api.inbox({ unread: view === 'unread', archived: view === 'archived', cursor: pageParam }),
        initialPageParam: null as string | null,
        getNextPageParam: (page) => page.nextCursor
    });

    const invalidate = () => Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inbox'] }),
        queryClient.invalidateQueries({ queryKey: keys.me })
    ]);

    async function open(item: InboxItem) {
        const next = selected?.id === item.id ? null : item;
        // Keep the open message independently of the filtered list: marking
        // it read removes it from Unread, but must not close its contents.
        setSelected(next);
        void navigate({ to: '/activity/inbox', hash: next ? `inbox-${next.id}` : '', replace: true });
        if (next !== null && !item.read) {
            try {
                const updated = await api.inboxRead(item.id, true);
                setSelected((current) => current?.id === updated.id ? updated : current);
                await invalidate();
            } catch (error) { toast((error as Error).message, true); }
        }
    }

    async function ask(item: InboxItem, inProject = false) {
        if (asking) return;
        setAsking(true);
        try {
            await navigate({ to: '/activity/inbox', hash: `inbox-${item.id}`, replace: true });
            const result = await api.inboxAsk(item.id, inProject);
            seedInboxDraft(result.kind, result.conversationId, result.suggestedQuestion);
            await invalidate();
            await queryClient.invalidateQueries({ queryKey: ['inbox-context'] });
            await queryClient.invalidateQueries({ queryKey: keys.conversations });
            await navigate({ to: result.path as never });
        } catch (error) { toast((error as Error).message, true); }
        finally { setAsking(false); }
    }

    async function toggleRead(item: InboxItem) {
        try {
            const updated = await api.inboxRead(item.id, !item.read);
            setSelected((current) => current?.id === updated.id ? updated : current);
            await invalidate();
        } catch (error) { toast((error as Error).message, true); }
    }

    async function archive(item: InboxItem) {
        try {
            await api.inboxArchive(item.id);
            setSelected((current) => current?.id === item.id ? null : current);
            toast('Archived.');
            await invalidate();
        } catch (error) { toast((error as Error).message, true); }
    }

    async function readAll() {
        try {
            const { updated } = await api.inboxReadAll();
            setSelected((current) => current ? { ...current, read: true } : current);
            toast(updated ? `Marked ${updated} read.` : 'Nothing unread.');
            await invalidate();
        } catch (error) { toast((error as Error).message, true); }
    }

    const unread = list.data?.pages[0]?.unread ?? me.inbox?.unread ?? 0;
    const byId = new Map(list.data?.pages.flatMap((page) => page.items).map((item) => [item.id, item]) || []);
    if (selected && !byId.has(selected.id)) byId.set(selected.id, selected);
    const items = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);

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
                            onClick={() => { setView(option); setSelected(null); void navigate({ to: '/activity/inbox', hash: '', replace: true }); }}>
                            {option === 'open' ? 'Inbox' : option === 'unread' ? 'Unread' : 'Archive'}
                        </button>
                    ))}
                </div>

                {selectedQ.isError && <div role="alert" className="hint">{(selectedQ.error as Error).message}</div>}
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
                                    a scheduled <Link to="/activity/scheduled">task</Link> runs, a watch fires, someone invites you - the result lands here
                                    {me.discord.enabled ? ', and in your Discord DMs when you have them.' : '.'}</>
                                : 'Items you archive stay readable here.'}
                        </div>
                    </div>
                )}

                {items.length > 0 && (
                    <div className="list-card">
                        {items.map((item) => {
                            const isOpen = selected?.id === item.id;
                            const echo = echoLabel(item, me.discord.enabled);
                            return (
                                <div key={item.id} id={`inbox-${item.id}`} className={`list-row task-row inbox-row${item.read ? '' : ' unread'}${isOpen ? ' open' : ''}`}>
                                    <div className="row-body">
                                        <button type="button" className="inbox-row-main" aria-expanded={isOpen}
                                            onClick={() => open(item)}>
                                            <span className="badge">{KIND_MARK[item.kind]} {KIND_LABEL[item.kind]}</span>
                                            <strong>{item.title}</strong>
                                            {!item.read && <span className="inbox-dot" aria-label="unread" />}
                                            <div className="row-meta">
                                                {whenLabel(item.createdAt)}
                                                {echo ? ` · ${echo}` : ''}
                                                {item.attachments.length > 0 ? ` · ${item.attachments.length} attachment${item.attachments.length === 1 ? '' : 's'}` : ''}
                                            </div>
                                        </button>
                                        {item.ask?.conversations.map(conversation => <div className="hint" key={conversation.path}>
                                            Asked in <Link to={conversation.path as never}>{conversation.title}</Link>
                                        </div>)}
                                        <AttentionDelivery item={item} />
                                        <FailureLink item={item} />
                                        {isOpen && (
                                            <div className="inbox-body">
                                                <div className="inbox-ask-details">
                                                    {item.ask?.available ? <>
                                                        <button type="button" className="btn primary" disabled={asking} onClick={() => void ask(item)}>Ask Goobster</button>
                                                        {item.ask.project && <button type="button" className="btn" disabled={asking} onClick={() => void ask(item, true)}>Ask in the project</button>}
                                                    </> : <div className="hint">{item.ask?.reason}</div>}
                                                    {item.ask?.project && <div className="hint">Ask Goobster opens private Chat. Ask in the project opens its shared Conversation.</div>}
                                                </div>
                                                {item.body || item.attachments.length > 0
                                                    ? <Markdown source={item.body || ''} attachments={item.attachments.map((a) => ({ url: a.url, name: a.name || undefined }))} />
                                                    : <div className="hint">No details - the title is the whole message.</div>}
                                            </div>
                                        )}
                                    </div>
                                    <div className="inbox-actions">
                                        {item.link && (
                                            <Link to={item.link as never} className="btn subtle" title="Open where this came from">Open →</Link>
                                        )}
                                        {item.ask?.available && <button type="button" className="btn subtle inbox-ask-compact" aria-label={`Ask Goobster about ${item.title}`} disabled={asking}
                                            onClick={() => void ask(item)}>Ask Goobster</button>}
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
                {list.hasNextPage && (
                    <button type="button" className="btn" disabled={list.isFetchingNextPage}
                        onClick={() => void list.fetchNextPage()} style={{ marginTop: 14 }}>
                        {list.isFetchingNextPage ? 'Loading…' : 'Load older items'}
                    </button>
                )}
            </div>
        </main>
    );
}
