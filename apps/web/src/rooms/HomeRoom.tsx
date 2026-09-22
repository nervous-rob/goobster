import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { bindTilt, formatClock, formatRelativeTime, greeting } from '../lib/atmosphere';
import { useMe } from '../hooks/useSession';
import { MenuButton } from '../shell/MenuButton';
import { PRIMARY_ROOMS, isRoomAvailable } from '../lib/rooms';

type HomePayload = {
    you?: { factCount?: number; memoryCount?: number; nickname?: string; facts?: string[] };
    watching?: { followups?: Array<{ note: string; dueAt?: string }>; automations?: Array<{ name: string; enabled?: boolean; schedule?: string }> };
    pickup?: { conversations?: Array<{ id: number; title: string; lastMessageAt?: string }>; parlor?: Array<{ id: number; title: string; lastMessageAt?: string }> };
    workshop?: { pinned?: Array<{ title: string }>; discoveredCount?: number };
    observatory?: { enabled?: boolean; projectCount?: number; runningJobs?: number; latest?: { name: string; updatedAt?: string } };
    servers?: Array<{ name: string }>;
    inbox?: { unread: number; recent: Array<{ id: number; kind: string; title: string; read: boolean; createdAt: string }> };
};

function When({ iso }: { iso?: string }) {
    if (!iso) return null;
    return <span className="when" title={iso}>{formatRelativeTime(iso)}</span>;
}

function Card({
    title, body, action, onClick, extraClass = ''
}: {
    title: string;
    body: ReactNode;
    action?: string;
    onClick: () => void;
    extraClass?: string;
}) {
    const ref = useRef<HTMLButtonElement>(null);
    useEffect(() => bindTilt(ref.current), []);
    return (
        <button type="button" ref={ref} className={`home-card ${extraClass}`} onClick={onClick}>
            <div className="home-card-kicker">{title}</div>
            <div className="home-card-body">{body}</div>
            {action && <div className="home-card-action">{action}</div>}
        </button>
    );
}

export function HomeRoom() {
    const me = useMe();
    const navigate = useNavigate();
    const homeQuery = useQuery({ queryKey: keys.home, queryFn: () => api.home() as Promise<HomePayload> });
    const [clock, setClock] = useState(formatClock());
    useEffect(() => {
        const id = setInterval(() => setClock(formatClock()), 15_000);
        return () => clearInterval(id);
    }, []);

    const home = homeQuery.data;
    const you = home?.you || {};
    const watching = home?.watching || {};
    const pickup = home?.pickup || {};
    const workshop = home?.workshop || {};
    const observatory = home?.observatory || {};
    const followups = watching.followups || [];
    const automations = watching.automations || [];
    const inbox = home?.inbox || { unread: 0, recent: [] };

    return (
        <main className="pane next-pane is-in" id="pane-home">
            <div className="home-toolbar">
                <MenuButton />
                <div className="chat-title">Home</div>
                <span id="home-clock" className="home-clock">{clock}</span>
            </div>
            <div className="home-content" id="home-content">
                {homeQuery.isError && <div className="empty">{(homeQuery.error as Error).message}</div>}
                {!home && homeQuery.isPending && <div className="empty">Looking around…</div>}
                {home && (
                    <div className="home-shell">
                        <header className="home-hero">
                            <div className="home-berry-wrap">
                                <img className="home-berry" src="/app/icons/goobster.svg" alt="" width={72} height={72} />
                            </div>
                            <div>
                                <h1 className="home-hello">{greeting(me.user.name || '')}</h1>
                                <p className="home-sub" data-tour="home-private">
                                    {me.discord?.enabled === false
                                        ? `${me.assistant.name} lives here. Work through a question in Chat, keep what matters in Knowledge, carry it through in Projects.`
                                        : 'Same brain as Discord. Work through a question in Chat, keep what matters in Knowledge, carry it through in Projects.'}
                                    {' '}Your work starts Private.
                                </p>
                            </div>
                        </header>
                        <div className="home-talk" data-tour="home-create">
                            <button type="button" className="btn primary big" data-tour="home-new-chat" onClick={() => navigate({ to: '/chat' })}>
                                💬 New chat
                            </button>
                            <button type="button" className="btn" data-tour="home-new-note" onClick={() => navigate({ to: '/knowledge' })}>
                                🧠 New note
                            </button>
                            {(observatory.enabled || me.features?.projects) && (
                                <button type="button" className="btn" data-tour="home-new-project" onClick={() => navigate({ to: '/projects' })}>
                                    🔭 New project
                                </button>
                            )}
                            <button type="button" className="btn subtle" onClick={() => {
                                const last = pickup.conversations?.[0];
                                if (last) navigate({ to: '/chat/$conversationId', params: { conversationId: String(last.id) } });
                                else navigate({ to: '/chat' });
                            }}>Pick up the last chat</button>
                        </div>
                        <div className="home-grid">
                            <Card title="Personal memory" action="Inspect in Settings → Memory & privacy →"
                                extraClass="home-card-you" onClick={() => navigate({ to: '/settings/$section', params: { section: 'memory' } })}
                                body={(
                                    <>
                                        <div className="home-counts">
                                            <span><strong>{you.factCount || 0}</strong> facts</span>
                                            <span><strong>{you.memoryCount || 0}</strong> memories</span>
                                            {you.nickname && <span>calls you <strong>{you.nickname}</strong></span>}
                                        </div>
                                        <ul className="home-facts">
                                            {(you.facts || []).slice(0, 5).map((f) => <li key={f}>{f}</li>)}
                                            {!(you.facts || []).length && <li className="hint">Nothing distilled yet — talk in Chat. Saved notes live in Knowledge, separately.</li>}
                                        </ul>
                                    </>
                                )}
                            />
                            <Card title={inbox.unread > 0 ? `Activity · ${inbox.unread} unread` : 'Activity'} action="Open Activity →"
                                extraClass={`home-card-inbox${inbox.unread > 0 ? ' is-live' : ''}`}
                                onClick={() => navigate({ to: '/activity/inbox' })}
                                body={(
                                    <div data-tour="home-activity">
                                    {inbox.recent.length
                                        ? (
                                            <ul className="home-list">
                                                {inbox.recent.map((item) => (
                                                    <li key={item.id}>{item.read ? '○' : '●'} {item.title} <When iso={item.createdAt} /></li>
                                                ))}
                                            </ul>
                                        )
                                        : <div className="hint">Reminders, task results, notices, and invitations land in your Inbox{me.discord?.enabled ? ' (and in your Discord DMs)' : ''}.</div>}
                                    </div>
                                )}
                            />
                            <Card title="Scheduled" action="Open Activity → Scheduled →"
                                extraClass={`home-card-watch${followups.length || automations.some((a) => a.enabled) ? ' is-live' : ''}`}
                                onClick={() => navigate({ to: '/activity/scheduled' })}
                                body={(
                                    (followups.length || automations.length)
                                        ? (
                                            <ul className="home-list">
                                                {followups.slice(0, 3).map((f) => (
                                                    <li key={f.note}>⏰ {f.note} <When iso={f.dueAt} /></li>
                                                ))}
                                                {automations.slice(0, 3).map((a) => (
                                                    <li key={a.name}>{a.enabled ? '▶' : '⏸'} {a.name} <span className="when">{a.schedule}</span></li>
                                                ))}
                                            </ul>
                                        )
                                        : <div className="hint">No reminders or recurring tasks right now.</div>
                                )}
                            />
                            <div className="home-card">
                                <div className="home-card-kicker">Pick up where we left off</div>
                                <div className="home-card-body">
                                    {(pickup.conversations?.length || pickup.parlor?.length) ? (
                                        <ul className="home-list home-pickup">
                                            {(pickup.conversations || []).slice(0, 4).map((c) => (
                                                <li key={`c-${c.id}`} onClick={() => navigate({ to: '/chat/$conversationId', params: { conversationId: String(c.id) } })}>
                                                    <span>💬 {c.title}</span> <When iso={c.lastMessageAt} />
                                                </li>
                                            ))}
                                            {(pickup.parlor || []).slice(0, 3).map((c) => (
                                                <li key={`p-${c.id}`} onClick={() => navigate({ to: '/discussions/$conversationId', params: { conversationId: String(c.id) } })}>
                                                    <span>🛋️ {c.title}</span> <When iso={c.lastMessageAt} />
                                                </li>
                                            ))}
                                        </ul>
                                    ) : <div className="hint">No conversations yet. Start one in Chat.</div>}
                                </div>
                            </div>
                            <Card title="Unfiled apps" action="Open Projects →" onClick={() => navigate({ to: '/projects' })}
                                body={workshop.pinned?.length
                                    ? <ul className="home-list">{workshop.pinned.slice(0, 3).map((a) => <li key={a.title}>{a.title}</li>)}</ul>
                                    : <div className="hint">{workshop.discoveredCount
                                        ? `${workshop.discoveredCount} generated app${workshop.discoveredCount === 1 ? '' : 's'} waiting to be filed under a project.`
                                        : 'Ask in Chat: “build me a …” and the app waits here until you file it under a project.'}</div>}
                            />
                            {(observatory.enabled || me.features?.projects) && (
                                <Card title="Projects" extraClass={`home-card-obs${observatory.runningJobs ? ' is-live' : ''}`}
                                    action="Open Projects →" onClick={() => navigate({ to: '/projects' })}
                                    body={observatory.projectCount
                                        ? (
                                            <>
                                                <div className="home-counts">
                                                    <span><strong>{observatory.projectCount}</strong> project{(observatory.projectCount === 1) ? '' : 's'}</span>
                                                    {!!observatory.runningJobs && <span className="home-live"><strong>{observatory.runningJobs}</strong> running</span>}
                                                </div>
                                                {observatory.latest && <p className="hint">Last touched {observatory.latest.name} <When iso={observatory.latest.updatedAt} /></p>}
                                            </>
                                        )
                                        : <div className="hint">No projects yet. Create one to bring a conversation, selected notes, a plan, and runs together.</div>}
                                />
                            )}
                        </div>
                        <div className="home-doors-label">Everywhere else</div>
                        <div className="home-doors">
                            {PRIMARY_ROOMS
                                .filter((room) => room.path !== '/' && isRoomAvailable(room, me))
                                .map((room) => (
                                    <Door key={room.id} label={`${room.icon} ${room.name}`} onClick={() => navigate({ to: room.path as never })} />
                                ))}
                            <Door label="📈 Usage & limits" onClick={() => navigate({ to: '/usage' })} />
                        </div>
                        {!!home.servers?.length && (
                            <div className="home-servers hint">
                                Servers we share:{' '}
                                <ul className="home-inline">{home.servers.map((s) => <li key={s.name}>{s.name}</li>)}</ul>
                            </div>
                        )}
                        <div className="home-privacy">
                            <p>You can inspect every row and watch it disappear.</p>
                            <button type="button" className="btn danger" onClick={() => window.dispatchEvent(new CustomEvent('goobster-forget'))}>
                                Forget me
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </main>
    );
}

function Door({ label, onClick }: { label: string; onClick: () => void }) {
    const ref = useRef<HTMLButtonElement>(null);
    useEffect(() => bindTilt(ref.current), []);
    return <button type="button" ref={ref} className="home-door" onClick={onClick}>{label}</button>;
}
