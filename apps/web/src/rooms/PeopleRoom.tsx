import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { ROOM_BY_ID, resolvePeopleView } from '../lib/rooms';
import { useDateLabel } from '../hooks/useDateLabel';
import { useToast } from '../hooks/useToast';
import { useMe } from '../hooks/useSession';
import { MenuButton } from '../shell/MenuButton';
import type { DmMessage, DmThread, Friend, FriendCandidate, FriendRequest } from '../lib/types';

/**
 * People: Goobster's own friends and direct messages
 * (documentation/friends_and_messages.md). Two views with their own state:
 * Friends (find someone, send / answer requests, see who is in the portal)
 * and Messages (one private thread per pair of friends). Nothing here is
 * read from Discord - bots cannot see friend lists - so the friendship is
 * Goobster's record and works with the Discord adapter off.
 */
export function PeopleRoom() {
    const me = useMe();
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const current = resolvePeopleView(pathname);
    const views = ROOM_BY_ID.people.views || [];
    const pending = me.people?.pending || 0;
    const unread = me.people?.unread || 0;

    return (
        <div className="activity-shell people-shell" id="pane-people">
            <nav className="activity-tabs" aria-label="People views">
                {views.map((view) => {
                    const count = view.id === 'friends' ? pending : view.id === 'messages' ? unread : 0;
                    return (
                        <Link key={view.id} to={view.path as never}
                            className={`activity-tab${current === view.id ? ' active' : ''}`}
                            aria-current={current === view.id ? 'page' : undefined}
                            data-tour={`people-tab-${view.id}`}>
                            <span aria-hidden="true">{view.icon}</span> {view.name}
                            {count > 0 && (
                                <span className="nav-count" aria-label={`${count} ${view.id === 'friends' ? 'waiting' : 'unread'}`}>{count > 99 ? '99+' : count}</span>
                            )}
                        </Link>
                    );
                })}
            </nav>
            <Outlet />
        </div>
    );
}

function Avatar({ avatar, name }: { avatar?: string | null; name: string }) {
    return avatar
        ? <img className="person-avatar" src={avatar} alt="" />
        : <span className="person-avatar" aria-hidden="true">{initial(name)}</span>;
}

function initial(name: string): string {
    const trimmed = String(name || '').trim();
    return trimmed ? trimmed[0].toUpperCase() : '🙂';
}

// --- Friends -----------------------------------------------------------------

export function FriendsView() {
    const me = useMe();
    const toast = useToast();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const whenLabel = useDateLabel();
    const [query, setQuery] = useState('');
    const [debounced, setDebounced] = useState('');

    useEffect(() => {
        const handle = window.setTimeout(() => setDebounced(query.trim()), 250);
        return () => window.clearTimeout(handle);
    }, [query]);

    const overviewQ = useQuery({
        queryKey: keys.friends,
        queryFn: () => api.friends(),
        // Presence rides this read; keep it fresh while the pane is open.
        refetchInterval: 60_000
    });
    const searchQ = useQuery({
        queryKey: keys.friendSearch(debounced),
        queryFn: () => api.friendSearch(debounced),
        enabled: debounced.length >= 2 || debounced.includes('@'),
        staleTime: 10_000
    });

    const refresh = () => Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.friends }),
        queryClient.invalidateQueries({ queryKey: ['friend-search'] }),
        queryClient.invalidateQueries({ queryKey: keys.me })
    ]);

    const request = useMutation({
        mutationFn: (person: FriendCandidate) => api.friendRequest(person.id),
        onSuccess: async (result, person) => {
            toast(result.status === 'accepted'
                ? `You and ${person.name} are friends now - they had already asked you.`
                : result.dmSent
                    ? `Friend request sent to ${person.name} (also by Discord DM).`
                    : `Friend request sent to ${person.name} - it is waiting in their Inbox.`);
            await refresh();
        },
        onError: (error) => toast((error as Error).message, true)
    });
    const respond = useMutation({
        mutationFn: async ({ item, accept }: { item: FriendRequest; accept: boolean }): Promise<{ request: FriendRequest }> =>
            accept ? api.friendAccept(item.id) : api.friendDecline(item.id),
        onSuccess: async (_result, { item, accept }) => {
            toast(accept ? `You and ${item.requesterName} are friends now.` : 'Declined - they are not told.');
            await refresh();
        },
        onError: (error) => toast((error as Error).message, true)
    });
    const cancel = useMutation({
        mutationFn: (item: FriendRequest) => api.friendCancel(item.id),
        onSuccess: async () => { toast('Request withdrawn.'); await refresh(); },
        onError: (error) => toast((error as Error).message, true)
    });
    const remove = useMutation({
        mutationFn: (friend: Friend) => api.friendRemove(friend.id),
        onSuccess: async (_result, friend) => { toast(`${friend.name} is no longer on your friends list.`); await refresh(); },
        onError: (error) => toast((error as Error).message, true)
    });

    async function message(friend: Friend) {
        try {
            const thread = await api.dmOpen(friend.id);
            await queryClient.invalidateQueries({ queryKey: keys.dmThreads });
            void navigate({ to: '/people/messages/$threadId', params: { threadId: String(thread.id) } });
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    const overview = overviewQ.data;
    const friends = overview?.friends || [];
    const online = friends.filter((friend) => friend.online);
    const searching = debounced.length >= 2 || debounced.includes('@');
    const results = searchQ.data?.people || [];
    const busy = request.isPending || respond.isPending || cancel.isPending || remove.isPending;

    return (
        <main className="pane next-pane is-in">
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1>Friends</h1>
                    {friends.length > 0 && (
                        <span className="hint-inline" style={{ marginLeft: 8 }}>
                            {friends.length} · {online.length} in the portal now
                        </span>
                    )}
                </div>
            </header>
            <div className="pane-body people-body">
                <section className="people-section" aria-labelledby="people-find">
                    <h2 id="people-find" className="people-heading">Find someone</h2>
                    <input
                        className="input people-search"
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="A name, an email address, or a user id"
                        aria-label="Find someone to add as a friend"
                        autoComplete="off"
                    />
                    <p className="hint">
                        Names match people who use this portal and members of Discord servers you share with {me.assistant?.name || 'Goobster'}.
                        An email address only finds someone who has verified it here, and is never shown to anyone.
                    </p>
                    {searching && (
                        <div className="people-list people-results" data-testid="friend-search-results">
                            {searchQ.isPending && <div className="hint" style={{ padding: '4px 10px' }}>Looking…</div>}
                            {searchQ.isError && <div className="hint" style={{ padding: '4px 10px' }}>{(searchQ.error as Error).message}</div>}
                            {searchQ.data && results.length === 0 && (
                                <div className="hint" style={{ padding: '4px 10px' }}>
                                    {searchQ.data.kind === 'email'
                                        ? 'Nobody here has verified that address.'
                                        : searchQ.data.kind === 'id'
                                            ? 'Nobody with that id.'
                                            : 'Nobody by that name yet.'}
                                </div>
                            )}
                            {results.map((person) => (
                                <div key={person.id} className="person-item people-result">
                                    <Avatar avatar={person.avatar} name={person.name} />
                                    <div className="person-body">
                                        <span className="person-name">{person.name}</span>
                                        {person.via && <span className="hint-inline">{person.source === 'server' ? `Server · ${person.via}` : person.via}</span>}
                                    </div>
                                    <RelationshipAction
                                        person={person}
                                        busy={busy}
                                        onRequest={() => request.mutate(person)}
                                        onAccept={() => {
                                            const item = overview?.incoming.find((entry) => entry.id === person.relationship.requestId);
                                            if (item) respond.mutate({ item, accept: true });
                                        }}
                                        onMessage={() => void message({ id: person.id, name: person.name, avatar: person.avatar || null, since: null })}
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                </section>

                {overview && overview.incoming.length > 0 && (
                    <section className="people-section" aria-labelledby="people-incoming" data-testid="friend-incoming">
                        <h2 id="people-incoming" className="people-heading">Waiting for your answer</h2>
                        <div className="people-list">
                            {overview.incoming.map((item) => (
                                <div key={item.id} className="person-item">
                                    <Avatar avatar={item.requesterAvatar} name={item.requesterName} />
                                    <div className="person-body">
                                        <span className="person-name">{item.requesterName}</span>
                                        <span className="hint-inline">asked {whenLabel(item.createdAt)}</span>
                                    </div>
                                    <button type="button" className="btn primary small" disabled={busy}
                                        onClick={() => respond.mutate({ item, accept: true })}>Accept</button>
                                    <button type="button" className="btn small" disabled={busy}
                                        onClick={() => respond.mutate({ item, accept: false })}>Decline</button>
                                </div>
                            ))}
                        </div>
                    </section>
                )}

                {overview && overview.outgoing.length > 0 && (
                    <section className="people-section" aria-labelledby="people-outgoing" data-testid="friend-outgoing">
                        <h2 id="people-outgoing" className="people-heading">Sent</h2>
                        <div className="people-list">
                            {overview.outgoing.map((item) => (
                                <div key={item.id} className="person-item">
                                    <Avatar avatar={item.addresseeAvatar} name={item.addresseeName} />
                                    <div className="person-body">
                                        <span className="person-name">{item.addresseeName}</span>
                                        <span className="hint-inline">waiting since {whenLabel(item.createdAt)}</span>
                                    </div>
                                    <button type="button" className="btn subtle small" disabled={busy}
                                        onClick={() => cancel.mutate(item)}>Withdraw</button>
                                </div>
                            ))}
                        </div>
                    </section>
                )}

                <section className="people-section" aria-labelledby="people-friends" data-testid="friend-list">
                    <h2 id="people-friends" className="people-heading">Your friends</h2>
                    {overviewQ.isPending && <div className="hint">Loading…</div>}
                    {overviewQ.isError && <div className="hint">{(overviewQ.error as Error).message}</div>}
                    {overview && friends.length === 0 && (
                        <div className="empty-state people-empty">
                            <div className="empty-logo" aria-hidden="true">🤝</div>
                            <div className="empty-title">No friends yet</div>
                            <p className="hint">
                                Find someone above and send a request. It lands in their Inbox (and their Discord DMs when they have one);
                                once they accept, you see when each other is in the portal and can message each other here.
                            </p>
                        </div>
                    )}
                    {friends.length > 0 && (
                        <div className="people-list">
                            {[...online, ...friends.filter((friend) => !friend.online)].map((friend) => (
                                <div key={friend.id} className="person-item">
                                    <Avatar avatar={friend.avatar} name={friend.name} />
                                    <div className="person-body">
                                        <span className="person-name">{friend.name}</span>
                                        <span className="hint-inline">{friend.online ? 'In the portal now' : `Friends since ${whenLabel(friend.since)}`}</span>
                                    </div>
                                    <span className={`presence-dot${friend.online ? ' online' : ''}`}
                                        title={friend.online ? `${friend.name} is in the portal` : `${friend.name} is not in the portal`} />
                                    <button type="button" className="btn small" onClick={() => void message(friend)}>Message</button>
                                    <button type="button" className="btn subtle small" disabled={busy} aria-label={`Remove ${friend.name} from your friends`}
                                        onClick={() => { if (window.confirm(`Remove ${friend.name} from your friends? They are not told.`)) remove.mutate(friend); }}>Unfriend</button>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </main>
    );
}

function RelationshipAction({ person, busy, onRequest, onAccept, onMessage }: {
    person: FriendCandidate; busy: boolean; onRequest: () => void; onAccept: () => void; onMessage: () => void;
}) {
    switch (person.relationship.status) {
    case 'friends':
        return <button type="button" className="btn small" onClick={onMessage}>Message</button>;
    case 'outgoing':
        return <span className="person-badge">Requested</span>;
    case 'incoming':
        return <button type="button" className="btn primary small" disabled={busy} onClick={onAccept}>Accept</button>;
    default:
        return <button type="button" className="btn primary small" disabled={busy} onClick={onRequest}>Add friend</button>;
    }
}

// --- Messages ----------------------------------------------------------------

export function MessagesView() {
    const me = useMe();
    const params = useParams({ strict: false }) as { threadId?: string };
    const threadId = params.threadId ? Number(params.threadId) : null;
    const threadsQ = useQuery({
        queryKey: keys.dmThreads,
        queryFn: () => api.dmThreads(),
        refetchInterval: 60_000
    });
    const threads = threadsQ.data?.threads || [];

    return (
        <main className="pane next-pane is-in">
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1>Messages</h1>
                </div>
                <Link to="/people/friends" className="btn subtle small">Friends</Link>
            </header>
            <div className={`people-messages${threadId ? ' has-thread' : ''}`}>
                <aside className="people-threads" aria-label="Conversations">
                    {threadsQ.isPending && <div className="hint" style={{ padding: 10 }}>Loading…</div>}
                    {threadsQ.isError && <div className="hint" style={{ padding: 10 }}>{(threadsQ.error as Error).message}</div>}
                    {threadsQ.data && threads.length === 0 && (
                        <div className="hint" style={{ padding: 10 }}>
                            No conversations yet. Open <Link to="/people/friends">Friends</Link> and press Message next to a friend.
                        </div>
                    )}
                    {threads.map((thread) => (
                        <Link key={thread.id} to="/people/messages/$threadId" params={{ threadId: String(thread.id) }}
                            className={`person-item people-thread${thread.id === threadId ? ' active' : ''}`}
                            aria-current={thread.id === threadId ? 'page' : undefined}>
                            <Avatar avatar={thread.with.avatar} name={thread.with.name} />
                            <div className="person-body">
                                <span className="person-name">
                                    {thread.with.name}
                                    <span className={`presence-dot${thread.with.online ? ' online' : ''}`} style={{ display: 'inline-block', marginLeft: 6 }} />
                                </span>
                                <span className="hint-inline people-preview">
                                    {thread.lastMessage
                                        ? `${thread.lastMessage.senderId === me.user.id ? 'You: ' : ''}${thread.lastMessage.content}`
                                        : 'No messages yet'}
                                </span>
                            </div>
                            {thread.unread > 0 && <span className="nav-count" aria-label={`${thread.unread} unread`}>{thread.unread}</span>}
                        </Link>
                    ))}
                </aside>
                <section className="people-thread-pane">
                    {threadId
                        ? <Thread key={threadId} threadId={threadId} summary={threads.find((thread) => thread.id === threadId) || null} />
                        : (
                            <div className="empty-state people-empty">
                                <div className="empty-logo" aria-hidden="true">✉️</div>
                                <div className="empty-title">Pick a conversation</div>
                                <p className="hint">Messages stay between the two of you: nothing here goes to Discord or to {me.assistant?.name || 'Goobster'}.</p>
                            </div>
                        )}
                </section>
            </div>
        </main>
    );
}

function Thread({ threadId, summary }: { threadId: number; summary: DmThread | null }) {
    const me = useMe();
    const toast = useToast();
    const queryClient = useQueryClient();
    const whenLabel = useDateLabel();
    const [draft, setDraft] = useState('');
    const logRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);

    const pageQ = useQuery({
        queryKey: keys.dmThread(threadId),
        queryFn: () => api.dmThread(threadId)
    });
    const thread = pageQ.data?.thread || summary;
    const messages: DmMessage[] = pageQ.data?.messages || [];
    const lastId = messages.length > 0 ? messages[messages.length - 1].id : 0;

    // Reading the thread reads the messages: the badge and the other
    // person's "seen" state follow the newest message on screen.
    useEffect(() => {
        if (!pageQ.data || (thread?.unread || 0) === 0) return;
        void api.dmMarkRead(threadId).then(() => Promise.all([
            queryClient.invalidateQueries({ queryKey: keys.dmThreads }),
            queryClient.invalidateQueries({ queryKey: keys.me })
        ])).catch(() => { /* cosmetic */ });
    }, [threadId, lastId, pageQ.data, thread?.unread, queryClient]);

    useEffect(() => {
        const log = logRef.current;
        if (log) log.scrollTop = log.scrollHeight;
    }, [lastId]);

    const send = useMutation({
        mutationFn: (content: string) => api.dmSend(threadId, content),
        onSuccess: async () => {
            setDraft('');
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: keys.dmThread(threadId) }),
                queryClient.invalidateQueries({ queryKey: keys.dmThreads })
            ]);
            inputRef.current?.focus();
        },
        onError: (error) => toast((error as Error).message, true)
    });

    function submit() {
        const content = draft.trim();
        if (!content || send.isPending) return;
        send.mutate(content);
    }

    if (pageQ.isError) {
        return <div className="empty"><p>{(pageQ.error as Error).message}</p><Link to="/people/messages" className="btn">Back to conversations</Link></div>;
    }

    return (
        <div className="people-thread-inner" data-testid="dm-thread">
            <div className="people-thread-head">
                <Link to="/people/messages" className="btn subtle small people-back" aria-label="Back to conversations">←</Link>
                {thread && <>
                    <Avatar avatar={thread.with.avatar} name={thread.with.name} />
                    <span className="person-name">{thread.with.name}</span>
                    <span className={`presence-dot${thread.with.online ? ' online' : ''}`}
                        title={thread.with.online ? `${thread.with.name} is in the portal` : `${thread.with.name} is not in the portal`} />
                    <span className="hint-inline">{thread.with.online ? 'in the portal' : 'away - they will see this when they are back'}</span>
                </>}
            </div>
            <div className="people-thread-log" ref={logRef}>
                <div className="chat-log">
                    {pageQ.isPending && <div className="hint">Loading…</div>}
                    {pageQ.data?.hasMore && <div className="hint" style={{ textAlign: 'center' }}>Older messages are kept; this shows the most recent.</div>}
                    {pageQ.data && messages.length === 0 && (
                        <div className="hint" style={{ textAlign: 'center' }}>Say hello - only {thread?.with.name || 'they'} will see it.</div>
                    )}
                    {messages.map((message) => {
                        const mine = message.senderId === me.user.id;
                        return (
                            <div key={message.id} className={`msg ${mine ? 'user' : 'assistant'} dm-msg`}>
                                <div className="msg-bubble dm-bubble">{message.content}</div>
                                <div className="msg-meta">{mine ? 'You' : thread?.with.name || ''} · {whenLabel(message.createdAt)}</div>
                            </div>
                        );
                    })}
                </div>
            </div>
            <div className="composer-wrap people-composer">
                {thread && !thread.friends
                    ? <div className="hint" style={{ textAlign: 'center' }}>You are no longer friends, so this conversation is read-only.</div>
                    : (
                        <div className="composer">
                            <textarea
                                ref={inputRef}
                                className="composer-input"
                                value={draft}
                                rows={1}
                                maxLength={4000}
                                placeholder={`Message ${thread?.with.name || ''}`}
                                aria-label="Message"
                                onChange={(event) => setDraft(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
                                }}
                            />
                            <div className="composer-actions">
                                <button type="button" className="btn primary send-btn" aria-label="Send" disabled={!draft.trim() || send.isPending} onClick={submit}>➤</button>
                            </div>
                        </div>
                    )}
            </div>
        </div>
    );
}
