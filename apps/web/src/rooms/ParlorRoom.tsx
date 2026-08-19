import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { api, streamParlorChat, streamParlorNudge } from '../lib/api';
import { keys } from '../lib/query';
import { useMe } from '../hooks/useSession';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { Markdown } from '../components/Markdown';
import { GraphCanvas } from '../components/GraphCanvas';
import { Modal } from '../components/Modal';
import { MenuButton } from '../shell/MenuButton';
import { useParlorLive } from '../hooks/useParlorLive';

const PERSONA_PALETTE = ['#7c8cff', '#59d18c', '#ffb454', '#ff7ac8', '#54c2ff', '#b18aff', '#ffd166', '#8fe388'];

type Persona = {
    id: number; name: string; charter?: string; emoji?: string; color?: string; noteCount?: number;
};
type Conversation = {
    id: number; title?: string | null; role?: string;
    participants?: Persona[];
    members?: unknown[];
};
type Invite = { id: number; title?: string; inviterName?: string; inviterId?: string; conversationId?: number };
type Grounding = { id: number; title: string };
type ParlorMessage = {
    id?: number;
    role: 'user' | 'assistant';
    content: string;
    personaId?: number;
    personaName?: string;
    userId?: string;
    userName?: string;
    createdAt?: string;
    isError?: boolean;
    grounding?: Grounding[];
    draft?: boolean;
    typing?: boolean;
};
type Note = {
    id: number; title: string; content: string; source?: string;
    tags?: Array<{ id: number; name: string }>;
    updatedAt?: string; score?: number;
};
type GraphNode = { id?: string | number; type?: string; label?: string; content?: string; source?: string };

function personaColor(persona?: { id?: number; color?: string } | null): string {
    return persona?.color || PERSONA_PALETTE[(Number(persona?.id) || 0) % PERSONA_PALETTE.length];
}
function personaGlyph(persona?: { emoji?: string; name?: string } | null): string {
    return persona?.emoji || (persona?.name ? [...persona.name][0].toUpperCase() : '?');
}
function timeLabel(iso?: string): string {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function liveAvailable(caps: unknown): boolean {
    const data = caps as { live?: boolean; available?: boolean } | null;
    return Boolean(data?.live || data?.available);
}

export function ParlorRoom() {
    const me = useMe();
    const toast = useToast();
    const queryClient = useQueryClient();
    const params = useParams({ strict: false }) as { conversationId?: string };
    const paramId = params.conversationId ? Number(params.conversationId) : null;

    const [activeId, setActiveId] = useState<number | null>(Number.isFinite(paramId) ? paramId : null);
    const [workspacePersonaId, setWorkspacePersonaId] = useState<number | null>(null);
    const [composer, setComposer] = useState('');
    const [sending, setSending] = useState(false);
    const [createPersonaOpen, setCreatePersonaOpen] = useState(false);
    const [createConvOpen, setCreateConvOpen] = useState(false);
    const [streamMessages, setStreamMessages] = useState<ParlorMessage[]>([]);
    const abortRef = useRef<AbortController | null>(null);
    const logRef = useRef<HTMLDivElement>(null);
    const livePersonaRef = useRef<Persona | undefined>(undefined);

    const personasQ = useQuery({
        queryKey: keys.parlorPersonas,
        queryFn: () => api.parlorPersonas() as Promise<{ personas: Persona[] }>
    });
    const convsQ = useQuery({
        queryKey: keys.parlorConversations,
        queryFn: () => api.parlorConversations() as Promise<{ conversations: Conversation[] }>
    });
    const invitesQ = useQuery({
        queryKey: keys.parlorInvites,
        queryFn: () => api.parlorInvites() as Promise<{ invites: Invite[] }>
    });
    const liveCaps = useQuery({
        queryKey: ['parlor-live-caps'],
        queryFn: () => api.parlorLiveCapabilities(),
        retry: false
    });
    const messagesQ = useQuery({
        queryKey: ['parlor-messages', activeId],
        queryFn: () => api.parlorMessages(activeId as number) as Promise<{ messages: ParlorMessage[] }>,
        enabled: activeId !== null
    });

    const personas = personasQ.data?.personas || [];
    const conversations = convsQ.data?.conversations || [];
    const invites = invitesQ.data?.invites || [];
    const conversation = conversations.find((c) => c.id === activeId) || null;
    const history = messagesQ.data?.messages || [];
    const display = useMemo(() => [...history, ...streamMessages], [history, streamMessages]);

    useEffect(() => {
        if (activeId === null && conversations[0] && paramId == null) setActiveId(conversations[0].id);
    }, [conversations, activeId, paramId]);

    useEffect(() => {
        if (Number.isFinite(paramId) && paramId !== activeId) setActiveId(paramId);
    }, [paramId, activeId]);

    useEffect(() => {
        const el = logRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [display.length, sending]);

    useEffect(() => () => {
        abortRef.current?.abort();
    }, []);

    function personaById(id?: number): Persona | undefined {
        return personas.find((p) => p.id === id);
    }

    const live = useParlorLive({
        toast,
        onTurnEvent: (event, data) => {
            if (event === 'user_message') {
                setStreamMessages((prev) => [...prev, {
                    role: 'user',
                    content: String(data.content || ''),
                    userId: data.userId ? String(data.userId) : undefined,
                    userName: data.userName ? String(data.userName) : undefined,
                    id: data.id as number | undefined
                }]);
                return;
            }
            if (event === 'persona_start') {
                livePersonaRef.current = personaById(Number(data.id || data.personaId))
                    || { id: Number(data.id || data.personaId) || 0, name: String(data.name || 'Persona') };
                const persona = livePersonaRef.current;
                setStreamMessages((prev) => [...prev.filter((m) => !m.draft && !m.typing), {
                    role: 'assistant', personaId: persona.id, personaName: persona.name, content: '', typing: true
                }]);
                return;
            }
            if (event === 'delta') {
                const delta = String((data as { text?: string }).text || '');
                setStreamMessages((prev) => {
                    const next = [...prev];
                    const last = next[next.length - 1];
                    if (last?.role === 'assistant' && (last.draft || last.typing || last.content === '')) {
                        next[next.length - 1] = {
                            ...last,
                            content: (last.typing ? '' : last.content) + delta,
                            typing: false,
                            draft: true
                        };
                    } else {
                        const persona = livePersonaRef.current;
                        next.push({
                            role: 'assistant',
                            personaId: persona?.id,
                            personaName: persona?.name,
                            content: delta,
                            draft: true
                        });
                    }
                    return next;
                });
                return;
            }
            if (event === 'persona_message') {
                setStreamMessages((prev) => {
                    const next = prev.filter((m) => !m.draft && !m.typing);
                    next.push({
                        role: 'assistant',
                        content: String(data.content || ''),
                        personaId: (data.personaId as number | undefined) || livePersonaRef.current?.id,
                        grounding: data.grounding as Grounding[] | undefined
                    });
                    return next;
                });
                return;
            }
            if (event === 'turn_error') {
                setStreamMessages((prev) => [...prev.filter((m) => !m.typing && !m.draft), {
                    role: 'assistant', content: String(data.message || 'Something went wrong.'), isError: true
                }]);
                return;
            }
            if (event === 'turn_done') {
                void queryClient.invalidateQueries({ queryKey: ['parlor-messages', activeId] });
                void queryClient.invalidateQueries({ queryKey: keys.parlorConversations });
                void queryClient.invalidateQueries({ queryKey: keys.parlorPersonas });
            }
        }
    });

    async function send() {
        if (sending) {
            try { await api.parlorStop(); } catch { /* settled */ }
            abortRef.current?.abort();
            return;
        }
        const text = composer.trim();
        if (!text) return;
        if (!activeId) {
            setCreateConvOpen(true);
            return;
        }
        if (live.active) {
            setComposer('');
            if (!live.say(text)) toast('The live session dropped - try again.', true);
            return;
        }
        setComposer('');
        setStreamMessages([{ role: 'user', content: text }]);
        let currentPersona: Persona | undefined;
        setSending(true);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            await streamParlorChat({ message: text, conversationId: activeId }, {
                onPersonaStart: (data) => {
                    currentPersona = personaById(data.personaId) || { id: data.personaId || 0, name: data.name || 'Persona' };
                    setStreamMessages((prev) => [...prev, {
                        role: 'assistant', personaId: currentPersona?.id, personaName: currentPersona?.name,
                        content: '', typing: true
                    }]);
                },
                onDelta: (delta) => {
                    setStreamMessages((prev) => {
                        const next = [...prev];
                        const last = next[next.length - 1];
                        if (last?.role === 'assistant' && (last.draft || last.typing || last.content === '')) {
                            next[next.length - 1] = { ...last, content: (last.typing ? '' : last.content) + delta, typing: false, draft: true };
                        } else {
                            next.push({ role: 'assistant', personaId: currentPersona?.id, personaName: currentPersona?.name, content: delta, draft: true });
                        }
                        return next;
                    });
                },
                onPersonaMessage: (data) => {
                    setStreamMessages((prev) => {
                        const next = prev.filter((m) => !m.draft && !m.typing);
                        next.push({
                            role: 'assistant',
                            content: data.content || '',
                            personaId: data.personaId || currentPersona?.id,
                            grounding: data.grounding as Grounding[] | undefined
                        });
                        return next;
                    });
                },
                onError: (error) => {
                    setStreamMessages((prev) => [...prev.filter((m) => !m.typing), {
                        role: 'assistant', content: error.message || 'Something went wrong.', isError: true
                    }]);
                }
            }, controller.signal);
        } catch (error) {
            if ((error as Error).name !== 'AbortError') toast((error as Error).message, true);
        } finally {
            setSending(false);
            abortRef.current = null;
            setStreamMessages([]);
            await queryClient.invalidateQueries({ queryKey: ['parlor-messages', activeId] });
            await queryClient.invalidateQueries({ queryKey: keys.parlorConversations });
        }
    }

    async function nudge(personaId: number) {
        if (!activeId) return;
        if (live.active) {
            if (!live.nudgeLive(personaId)) toast('The live session dropped - try again.', true);
            return;
        }
        if (sending) return;
        setSending(true);
        const controller = new AbortController();
        abortRef.current = controller;
        const persona = personaById(personaId);
        setStreamMessages([{ role: 'assistant', personaId, personaName: persona?.name, content: '', typing: true }]);
        try {
            await streamParlorNudge(activeId, personaId, {
                onDelta: (delta) => {
                    setStreamMessages((prev) => {
                        const next = [...prev];
                        const last = next[next.length - 1];
                        if (last) next[next.length - 1] = { ...last, content: (last.typing ? '' : last.content) + delta, typing: false, draft: true };
                        return next;
                    });
                },
                onPersonaMessage: (data) => {
                    setStreamMessages([{
                        role: 'assistant',
                        content: data.content || '',
                        personaId: data.personaId || personaId,
                        grounding: data.grounding as Grounding[] | undefined
                    }]);
                },
                onError: (error) => {
                    setStreamMessages([{ role: 'assistant', content: error.message || 'Something went wrong.', isError: true }]);
                }
            }, controller.signal);
        } catch (error) {
            if ((error as Error).name !== 'AbortError') toast((error as Error).message, true);
        } finally {
            setSending(false);
            abortRef.current = null;
            setStreamMessages([]);
            await queryClient.invalidateQueries({ queryKey: ['parlor-messages', activeId] });
        }
    }

    async function toggleLive() {
        if (live.active) {
            live.leave();
            return;
        }
        if (!activeId) return;
        try {
            await live.join(activeId);
            toast('You are live - just start talking. The personas answer out loud.');
        } catch (error) {
            toast((error as Error).name === 'NotAllowedError'
                ? 'Microphone access was denied.'
                : ((error as Error).message || 'Could not start the live session.'), true);
        }
    }

    const workspacePersona = personas.find((p) => p.id === workspacePersonaId) || null;

    return (
        <main className="pane next-pane is-in" id="pane-parlor">
            <aside className="conversations-panel">
                <button type="button" className="btn new-chat" onClick={() => setCreateConvOpen(true)}>✚ New discussion</button>
                {invites.length > 0 && (
                    <div className="parlor-invites">
                        <div className="panel-section-head"><span>Invitations</span></div>
                        {invites.map((invite) => (
                            <div key={invite.id} className="invite-item">
                                <span className="invite-body">
                                    <span className="invite-title">{invite.title || 'A parlor discussion'}</span>
                                    <span className="hint">from {invite.inviterName || invite.inviterId}</span>
                                </span>
                                <button type="button" className="invite-action accept" title="Accept" onClick={async () => {
                                    try {
                                        const result = await api.parlorRespondInvite(invite.id, true) as { conversationId: number };
                                        await queryClient.invalidateQueries({ queryKey: keys.parlorInvites });
                                        await queryClient.invalidateQueries({ queryKey: keys.parlorConversations });
                                        setActiveId(result.conversationId);
                                        toast('You joined the discussion. Say hello!');
                                    } catch (error) { toast((error as Error).message, true); }
                                }}>✓</button>
                                <button type="button" className="invite-action decline" title="Decline" onClick={async () => {
                                    try {
                                        await api.parlorRespondInvite(invite.id, false);
                                        await queryClient.invalidateQueries({ queryKey: keys.parlorInvites });
                                    } catch (error) { toast((error as Error).message, true); }
                                }}>✕</button>
                            </div>
                        ))}
                    </div>
                )}
                <div className="conv-list">
                    {conversations.map((item) => (
                        <ConvItem
                            key={item.id}
                            conversation={item}
                            active={item.id === activeId}
                            onSelect={() => { setWorkspacePersonaId(null); setActiveId(item.id); if (live.active) live.leave(); }}
                            onRenamed={() => queryClient.invalidateQueries({ queryKey: keys.parlorConversations })}
                            onDeleted={async () => {
                                if (activeId === item.id) setActiveId(null);
                                await queryClient.invalidateQueries({ queryKey: keys.parlorConversations });
                            }}
                        />
                    ))}
                </div>
                <div className="panel-section-head">
                    <span>Personas</span>
                    <button type="button" className="panel-add" title="New persona" onClick={() => setCreatePersonaOpen(true)}>✚</button>
                </div>
                <div className="persona-list">
                    {personas.length === 0 && <div className="hint" style={{ padding: '4px 10px' }}>No personas yet — create one, or start a discussion.</div>}
                    {personas.map((persona) => (
                        <div
                            key={persona.id}
                            role="button"
                            tabIndex={0}
                            className={`persona-item${workspacePersonaId === persona.id ? ' active' : ''}`}
                            onClick={() => setWorkspacePersonaId(persona.id)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    setWorkspacePersonaId(persona.id);
                                }
                            }}
                        >
                            <span className="persona-dot" style={{ background: personaColor(persona) }}>{personaGlyph(persona)}</span>
                            <span className="persona-name">{persona.name}</span>
                            <span className="persona-count">{persona.noteCount ?? 0} 📝</span>
                        </div>
                    ))}
                </div>
            </aside>

            {workspacePersona ? (
                <WorkspaceView persona={workspacePersona} onBack={() => setWorkspacePersonaId(null)} />
            ) : (
                <div className="parlor-subview">
                    <header className="chat-header">
                        <div className="title-row">
                            <MenuButton />
                            <div className="chat-title">{conversation?.title || 'The Parlor'}</div>
                        </div>
                        <div className="chat-header-actions">
                            <div className="parlor-participants">
                                {(conversation?.participants || []).map((participant) => (
                                    <span
                                        key={participant.id}
                                        role="button"
                                        tabIndex={0}
                                        className={`participant-chip${live.speakingPersonaId === participant.id ? ' speaking' : ''}`}
                                        style={{ borderColor: personaColor(participant) }}
                                        title={`Ask ${participant.name} to speak now`}
                                        onClick={() => void nudge(participant.id)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter' || event.key === ' ') {
                                                event.preventDefault();
                                                void nudge(participant.id);
                                            }
                                        }}
                                    >
                                        <span className="persona-dot small" style={{ background: personaColor(participant) }}>{personaGlyph(participant)}</span>
                                        {participant.name}
                                    </span>
                                ))}
                            </div>
                            {conversation && liveAvailable(liveCaps.data) && (
                                <button
                                    type="button"
                                    className={`icon-action${live.active ? ' on' : ''}`}
                                    onClick={() => { void toggleLive(); }}
                                    disabled={live.joining}
                                >
                                    {live.active ? 'End live' : '🎙️ Go Live'}
                                </button>
                            )}
                        </div>
                    </header>
                    {live.status && (
                        <div className={`parlor-live-bar${live.talking ? ' talking' : ''}`}>
                            <span className="live-dot" aria-hidden="true" />
                            <span className="live-status">{live.status}</span>
                            <span className="live-caption" aria-live="polite">{live.caption}</span>
                            <span style={{ flex: 1 }} />
                            <button
                                type="button"
                                className="icon-action"
                                title={live.muted ? 'Unmute persona audio' : 'Mute persona audio'}
                                aria-label={live.muted ? 'Unmute persona audio' : 'Mute persona audio'}
                                onClick={live.toggleMute}
                            >{live.muted ? '🔇' : '🔊'}</button>
                            <button
                                type="button"
                                className="icon-action"
                                title="Stop the current speech"
                                aria-label="Stop the current speech"
                                onClick={live.stopSpeech}
                            >◼</button>
                            <button type="button" className="btn danger live-leave-btn" onClick={() => live.leave()}>End live</button>
                        </div>
                    )}
                    <div className="chat-scroll" ref={logRef}>
                        <div className="chat-log">
                            {display.map((message, index) => (
                                <MessageBubble key={message.id ?? `s-${index}`} message={message} meId={me.user.id} persona={personaById(message.personaId)} />
                            ))}
                        </div>
                        {display.length === 0 && (
                            <div className="empty-state">
                                <div className="empty-logo">🛋️</div>
                                <div className="empty-title">Welcome to Goobster&apos;s Parlor</div>
                                <div className="hint" style={{ maxWidth: 460, margin: '0 auto 22px' }}>
                                    A salon of thinking companions. Create personas, seed their workspaces, and discuss with one or several at once.
                                </div>
                            </div>
                        )}
                    </div>
                    <div className="composer-wrap">
                        <form className="composer" onSubmit={(event: FormEvent) => { event.preventDefault(); void send(); }}>
                            <textarea
                                className="composer-input"
                                rows={1}
                                value={composer}
                                onChange={(e) => setComposer(e.target.value)}
                                placeholder="Address the parlor… (Enter to send)"
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !event.shiftKey) {
                                        event.preventDefault();
                                        void send();
                                    }
                                }}
                            />
                            <button type="submit" className={`btn primary send-btn${sending ? ' stop' : ''}`} aria-label={sending ? 'Stop' : 'Send'}>
                                {sending ? '◼' : '➤'}
                            </button>
                        </form>
                        <div className="composer-hint hint">Each persona replies from its own knowledge workspace.</div>
                    </div>
                </div>
            )}

            {createPersonaOpen && (
                <CreatePersonaModal
                    onClose={() => setCreatePersonaOpen(false)}
                    onCreated={() => {
                        setCreatePersonaOpen(false);
                        queryClient.invalidateQueries({ queryKey: keys.parlorPersonas });
                    }}
                />
            )}
            {createConvOpen && (
                <CreateConversationModal
                    personas={personas}
                    onClose={() => setCreateConvOpen(false)}
                    onCreated={(id) => {
                        setCreateConvOpen(false);
                        setActiveId(id);
                        queryClient.invalidateQueries({ queryKey: keys.parlorConversations });
                    }}
                    onNeedPersona={() => { setCreateConvOpen(false); setCreatePersonaOpen(true); }}
                />
            )}
        </main>
    );
}

function MessageBubble({ message, meId, persona }: { message: ParlorMessage; meId: string; persona?: Persona }) {
    if (message.role === 'user') {
        const other = message.userId && message.userId !== meId;
        return (
            <div className={`msg user${other ? ' from-member' : ''}`}>
                {other && <div className="member-byline">{message.userName || `User ${message.userId}`}</div>}
                <div className="msg-bubble">{message.content}</div>
                {message.createdAt && <div className="msg-meta">{timeLabel(message.createdAt)}</div>}
            </div>
        );
    }
    const color = personaColor(persona || { id: message.personaId, color: undefined });
    return (
        <div className={`msg assistant persona-msg${message.isError ? ' error' : ''}`}>
            <div className="persona-byline" style={{ color }}>
                <span className="persona-dot small" style={{ background: color }}>{personaGlyph(persona || { name: message.personaName })}</span>
                {message.personaName || persona?.name || 'a former persona'}
                {message.typing ? <span className="hint"> consulting their notes…</span> : null}
            </div>
            <div className="msg-bubble" style={{ borderLeft: `3px solid ${color}` }}>
                {message.typing
                    ? <span className="typing"><i /><i /><i /></span>
                    : <Markdown source={message.content} />}
            </div>
            {message.grounding && message.grounding.length > 0 && (
                <div className="grounding">
                    📎 grounded on:
                    {message.grounding.map((note) => <span key={note.id} className="gchip">{note.title}</span>)}
                </div>
            )}
        </div>
    );
}

function ConvItem({
    conversation, active, onSelect, onRenamed, onDeleted
}: {
    conversation: Conversation;
    active: boolean;
    onSelect: () => void;
    onRenamed: () => void;
    onDeleted: () => void;
}) {
    const toast = useToast();
    const confirm = useConfirm();
    const [renaming, setRenaming] = useState(false);
    const [title, setTitle] = useState(conversation.title || '');
    const mine = conversation.role !== 'member';
    return (
        <div className={`conv-item${active ? ' active' : ''}`} role="button" tabIndex={0} onClick={onSelect}>
            {renaming ? (
                <input
                    className="conv-rename-input"
                    value={title}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setTitle(e.target.value)}
                    onBlur={async () => {
                        setRenaming(false);
                        const next = title.trim();
                        if (next && next !== conversation.title) {
                            try {
                                await api.parlorRenameConversation(conversation.id, next);
                                onRenamed();
                            } catch (error) { toast((error as Error).message, true); }
                        }
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
            ) : (
                <>
                    <span className="conv-title-text">{conversation.title || 'New discussion'}</span>
                    <span className="conv-actions">
                        {mine && (
                            <>
                                <button type="button" className="conv-action" title="Rename" onClick={(e) => { e.stopPropagation(); setRenaming(true); }}>✎</button>
                                <button
                                    type="button"
                                    className="conv-action"
                                    title="Delete"
                                    onClick={async (e) => {
                                        e.stopPropagation();
                                        if (!await confirm(`Delete "${conversation.title || 'this discussion'}"? The personas keep everything they learned.`)) return;
                                        try {
                                            await api.parlorDeleteConversation(conversation.id);
                                            toast('Discussion deleted.');
                                            onDeleted();
                                        } catch (error) { toast((error as Error).message, true); }
                                    }}
                                >🗑</button>
                            </>
                        )}
                    </span>
                </>
            )}
        </div>
    );
}

function CreatePersonaModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
    const toast = useToast();
    const [name, setName] = useState('');
    const [charter, setCharter] = useState('');
    const create = useMutation({
        mutationFn: () => api.parlorCreatePersona({ name: name.trim(), charter: charter.trim() }),
        onSuccess: () => { toast('Persona created.'); onCreated(); },
        onError: (error) => toast((error as Error).message, true)
    });
    return (
        <Modal onClose={onClose}>
            <h2>New persona</h2>
            <input className="input" placeholder="The Researcher" maxLength={48} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <textarea className="input" rows={5} maxLength={2000} placeholder="Who this persona is and how it thinks" value={charter} onChange={(e) => setCharter(e.target.value)} />
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button type="button" className="btn primary" disabled={create.isPending || !name.trim() || !charter.trim()} onClick={() => create.mutate()}>Create</button>
            </div>
        </Modal>
    );
}

function CreateConversationModal({
    personas, onClose, onCreated, onNeedPersona
}: {
    personas: Persona[];
    onClose: () => void;
    onCreated: (id: number) => void;
    onNeedPersona: () => void;
}) {
    const toast = useToast();
    const [selected, setSelected] = useState<number[]>([]);
    if (personas.length === 0) {
        return (
            <Modal onClose={onClose}>
                <h2>New discussion</h2>
                <p className="hint">Create a persona first, then seat them in a discussion.</p>
                <div className="modal-actions">
                    <button type="button" className="btn" onClick={onClose}>Cancel</button>
                    <button type="button" className="btn primary" onClick={onNeedPersona}>New persona</button>
                </div>
            </Modal>
        );
    }
    return (
        <Modal onClose={onClose}>
            <h2>New discussion</h2>
            <p className="hint">Invite up to 4 personas. Each replies in turn, grounded in its own workspace.</p>
            <div className="persona-picker">
                {personas.map((persona) => {
                    const picked = selected.includes(persona.id);
                    return (
                        <div
                            key={persona.id}
                            role="button"
                            tabIndex={0}
                            className={`persona-pick${picked ? ' picked' : ''}`}
                            onClick={() => {
                                setSelected((prev) => {
                                    if (prev.includes(persona.id)) return prev.filter((id) => id !== persona.id);
                                    if (prev.length >= 4) { toast('At most 4 personas per discussion.', true); return prev; }
                                    return [...prev, persona.id];
                                });
                            }}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    setSelected((prev) => {
                                        if (prev.includes(persona.id)) return prev.filter((id) => id !== persona.id);
                                        if (prev.length >= 4) { toast('At most 4 personas per discussion.', true); return prev; }
                                        return [...prev, persona.id];
                                    });
                                }
                            }}
                        >
                            <span className="persona-dot" style={{ background: personaColor(persona) }}>{personaGlyph(persona)}</span>
                            <span className="persona-pick-body">
                                <span className="persona-name">{persona.name}</span>
                                <span className="hint">{(persona.charter || '').slice(0, 90)}</span>
                            </span>
                            <span className="persona-check">{picked ? '✓' : ''}</span>
                        </div>
                    );
                })}
            </div>
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button
                    type="button"
                    className="btn primary"
                    disabled={selected.length === 0}
                    onClick={async () => {
                        try {
                            const created = await api.parlorCreateConversation(selected) as Conversation;
                            onCreated(created.id);
                        } catch (error) { toast((error as Error).message, true); }
                    }}
                >Start</button>
            </div>
        </Modal>
    );
}

function WorkspaceView({ persona, onBack }: { persona: Persona; onBack: () => void }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [tab, setTab] = useState<'notes' | 'graph'>('notes');
    const [search, setSearch] = useState('');
    const [noteModal, setNoteModal] = useState<Note | 'new' | null>(null);
    const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
    const notesKey = ['parlor-notes', persona.id, search];
    const notesQ = useQuery({
        queryKey: notesKey,
        queryFn: async () => {
            if (search.trim()) {
                const result = await api.parlorSearch(persona.id, search.trim()) as { results: Note[] };
                return { notes: result.results };
            }
            return api.parlorNotes(persona.id) as Promise<{ notes: Note[] }>;
        }
    });
    const graphQ = useQuery({
        queryKey: ['parlor-graph', persona.id],
        queryFn: () => api.parlorGraph(persona.id) as Promise<{ nodes: GraphNode[]; edges: unknown[] }>,
        enabled: tab === 'graph'
    });
    const notes = notesQ.data?.notes || [];

    return (
        <div className="parlor-subview">
            <header className="chat-header">
                <div className="workspace-head">
                    <button type="button" className="icon-action" title="Back to discussions" onClick={onBack}>←</button>
                    <div className="chat-title">
                        <span className="persona-dot" style={{ background: personaColor(persona) }}>{personaGlyph(persona)}</span>
                        {' '}{persona.name}&apos;s workspace
                    </div>
                </div>
                <div className="segment">
                    <button type="button" className={`segment-btn${tab === 'notes' ? ' active' : ''}`} onClick={() => setTab('notes')}>Notes</button>
                    <button type="button" className={`segment-btn${tab === 'graph' ? ' active' : ''}`} onClick={() => setTab('graph')}>Graph</button>
                </div>
            </header>
            {tab === 'notes' && (
                <div className="workspace-content">
                    <div className="workspace-toolbar">
                        <input className="input" type="search" placeholder="Search this workspace…" value={search} onChange={(e) => setSearch(e.target.value)} />
                        <button type="button" className="btn primary" onClick={() => setNoteModal('new')}>✚ New note</button>
                    </div>
                    <div className="workspace-notes">
                        {notesQ.isPending && <div className="empty">Loading…</div>}
                        {notesQ.isError && <div className="empty">{(notesQ.error as Error).message}</div>}
                        {notes.length === 0 && !notesQ.isPending && (
                            <div className="empty">No notes yet. Seed what {persona.name} should know.</div>
                        )}
                        {notes.map((note) => (
                            <div key={note.id} className="note-card">
                                <div className="note-head">
                                    <span className="note-title">{note.title}</span>
                                    <span className="note-actions">
                                        <button type="button" className="conv-action" title="Edit" onClick={() => setNoteModal(note)}>✎</button>
                                        <button
                                            type="button"
                                            className="conv-action"
                                            title="Delete"
                                            onClick={async () => {
                                                if (!await confirm(`Delete "${note.title}"? ${persona.name} forgets it for good.`)) return;
                                                try {
                                                    await api.parlorDeleteNote(note.id);
                                                    toast('Note deleted.');
                                                    queryClient.invalidateQueries({ queryKey: notesKey });
                                                } catch (error) { toast((error as Error).message, true); }
                                            }}
                                        >🗑</button>
                                    </span>
                                </div>
                                <div className="note-body">{note.content}</div>
                                <div className="note-foot">
                                    {note.source === 'conversation' ? <span className="badge learned-badge">🌱 learned</span> : null}
                                    {(note.tags || []).map((tag) => <span key={tag.id} className="gchip">{tag.name}</span>)}
                                    <span className="note-when">{timeLabel(note.updatedAt)}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {tab === 'graph' && (
                <div className="workspace-content workspace-graph">
                    {graphQ.isPending && <div className="empty">Loading…</div>}
                    {graphQ.isError && <div className="empty">{(graphQ.error as Error).message}</div>}
                    {graphQ.data && (
                        <div className="graph-wrap">
                            <GraphCanvas data={graphQ.data} onSelect={(node) => setSelectedNode(node as GraphNode | null)} />
                            {(graphQ.data.nodes?.length || 0) === 0 && <div className="empty">This workspace graph is empty.</div>}
                            {selectedNode && (
                                <div className="graph-detail">
                                    <div className="gd-type">{selectedNode.type}{selectedNode.source === 'conversation' ? ' · 🌱 learned' : ''}</div>
                                    <div className="gd-label">{selectedNode.label}</div>
                                    {selectedNode.content ? <div className="gd-content">{selectedNode.content}</div> : null}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
            {noteModal && (
                <NoteModal
                    persona={persona}
                    note={noteModal === 'new' ? null : noteModal}
                    onClose={() => setNoteModal(null)}
                    onSaved={() => {
                        setNoteModal(null);
                        queryClient.invalidateQueries({ queryKey: notesKey });
                    }}
                />
            )}
        </div>
    );
}

function NoteModal({
    persona, note, onClose, onSaved
}: {
    persona: Persona;
    note: Note | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    const toast = useToast();
    const [title, setTitle] = useState(note?.title || '');
    const [content, setContent] = useState(note?.content || '');
    const [tags, setTags] = useState((note?.tags || []).map((t) => t.name).join(', '));
    const save = useMutation({
        mutationFn: () => {
            const fields = {
                title: title.trim(),
                content: content.trim(),
                tags: tags.split(',').map((t) => t.trim()).filter(Boolean)
            };
            return note ? api.parlorUpdateNote(note.id, fields) : api.parlorCreateNote(persona.id, fields);
        },
        onSuccess: () => { toast(note ? 'Note updated.' : `${persona.name} now knows it.`); onSaved(); },
        onError: (error) => toast((error as Error).message, true)
    });
    return (
        <Modal onClose={onClose} wide>
            <h2>{note ? 'Edit note' : `New note for ${persona.name}`}</h2>
            <input className="input" maxLength={120} placeholder="A short, unique title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <textarea className="input" rows={6} maxLength={4000} placeholder="The knowledge itself" value={content} onChange={(e) => setContent(e.target.value)} />
            <input className="input" placeholder="Tags, comma-separated" value={tags} onChange={(e) => setTags(e.target.value)} />
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button type="button" className="btn primary" disabled={save.isPending || !title.trim() || !content.trim()} onClick={() => save.mutate()}>
                    {note ? 'Save' : 'Add note'}
                </button>
            </div>
        </Modal>
    );
}
