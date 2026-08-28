import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { bindTilt, formatClock, formatRelativeTime, greeting } from '../lib/atmosphere';
import { useMe } from '../hooks/useSession';
import { MenuButton } from '../shell/MenuButton';

type HomePayload = {
    you?: { factCount?: number; memoryCount?: number; nickname?: string; facts?: string[] };
    watching?: { followups?: Array<{ note: string; dueAt?: string }>; automations?: Array<{ name: string; enabled?: boolean; schedule?: string }> };
    pickup?: { conversations?: Array<{ id: number; title: string; lastMessageAt?: string }>; parlor?: Array<{ id: number; title: string; lastMessageAt?: string }> };
    workshop?: { pinned?: Array<{ title: string }>; discoveredCount?: number };
    observatory?: { enabled?: boolean; projectCount?: number; runningJobs?: number; latest?: { name: string; updatedAt?: string } };
    servers?: Array<{ name: string }>;
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
                                <p className="home-sub">Same brain as Discord. Chat is one of the rooms.</p>
                            </div>
                        </header>
                        <div className="home-talk">
                            <button type="button" className="btn primary big" onClick={() => navigate({ to: '/study' })}>
                                Talk to Goobster
                            </button>
                            <button type="button" className="btn" onClick={() => {
                                const last = pickup.conversations?.[0];
                                if (last) navigate({ to: '/study/$conversationId', params: { conversationId: String(last.id) } });
                                else navigate({ to: '/study' });
                            }}>Pick up the last chat</button>
                        </div>
                        <div className="home-grid">
                            <Card title="What I know about you" action="Open Spitball →"
                                extraClass="home-card-you" onClick={() => navigate({ to: '/spitball' })}
                                body={(
                                    <>
                                        <div className="home-counts">
                                            <span><strong>{you.factCount || 0}</strong> facts</span>
                                            <span><strong>{you.memoryCount || 0}</strong> memories</span>
                                            {you.nickname && <span>calls you <strong>{you.nickname}</strong></span>}
                                        </div>
                                        <ul className="home-facts">
                                            {(you.facts || []).slice(0, 5).map((f) => <li key={f}>{f}</li>)}
                                            {!(you.facts || []).length && <li className="hint">Nothing distilled yet — talk in the Study.</li>}
                                        </ul>
                                    </>
                                )}
                            />
                            <Card title="What I'm watching" action="Open Tasks →"
                                extraClass={`home-card-watch${followups.length || automations.some((a) => a.enabled) ? ' is-live' : ''}`}
                                onClick={() => navigate({ to: '/tasks' })}
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
                                        : <div className="hint">No follow-ups or automations right now.</div>
                                )}
                            />
                            <div className="home-card">
                                <div className="home-card-kicker">Pick up where we left off</div>
                                <div className="home-card-body">
                                    {(pickup.conversations?.length || pickup.parlor?.length) ? (
                                        <ul className="home-list home-pickup">
                                            {(pickup.conversations || []).slice(0, 4).map((c) => (
                                                <li key={`c-${c.id}`} onClick={() => navigate({ to: '/study/$conversationId', params: { conversationId: String(c.id) } })}>
                                                    <span>💬 {c.title}</span> <When iso={c.lastMessageAt} />
                                                </li>
                                            ))}
                                            {(pickup.parlor || []).slice(0, 3).map((c) => (
                                                <li key={`p-${c.id}`} onClick={() => navigate({ to: '/parlor/$conversationId', params: { conversationId: String(c.id) } })}>
                                                    <span>🛋️ {c.title}</span> <When iso={c.lastMessageAt} />
                                                </li>
                                            ))}
                                        </ul>
                                    ) : <div className="hint">No conversations yet. The Study is empty and waiting.</div>}
                                </div>
                            </div>
                            <Card title="Tools I built you" action="Open the Workshop →" onClick={() => navigate({ to: '/workshop' })}
                                body={workshop.pinned?.length
                                    ? <ul className="home-list">{workshop.pinned.slice(0, 3).map((a) => <li key={a.title}>{a.title}</li>)}</ul>
                                    : <div className="hint">{workshop.discoveredCount
                                        ? `${workshop.discoveredCount} mini-app${workshop.discoveredCount === 1 ? '' : 's'} waiting in chat — pin them in the Workshop.`
                                        : 'Ask in the Study: “build me a …” and it lands here.'}</div>}
                            />
                            {(observatory.enabled || me.features?.observatory) && (
                                <Card title="The Observatory" extraClass={`home-card-obs${observatory.runningJobs ? ' is-live' : ''}`}
                                    action="Open the dome →" onClick={() => navigate({ to: '/observatory' })}
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
                                        : <div className="hint">The dome is dark. Ask in the Study to start a simulation.</div>}
                                />
                            )}
                        </div>
                        <div className="home-doors-label">More rooms</div>
                        <div className="home-doors">
                            {([
                                ['🛋️ Parlor', '/parlor'],
                                ['🎹 Conservatory', '/conservatory'],
                                ['📊 Exchange', '/exchange'],
                                ['🗓️ Tasks', '/tasks'],
                                ['🃏 Decks', '/decks'],
                                ['📈 Usage', '/usage']
                            ] as const).map(([label, to]) => (
                                <Door key={to} label={label} onClick={() => navigate({ to })} />
                            ))}
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
