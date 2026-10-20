import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, streamParlorChat, streamParlorNudge } from '../lib/api';
import { InboxContextChips } from './InboxContextChips';
import { useInboxDraft } from '../hooks/useInboxDraft';
import { useStickToBottom } from '../hooks/useStickToBottom';
import { keys } from '../lib/query';
import { useMe } from '../hooks/useSession';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { ParlorConversationView } from './ParlorConversationView';
import type { Attachment, Grounding, ParlorMessage, Persona } from '../parlor/types';
import { personaColor, personaGlyph } from '../parlor/persona';
import { applyParlorDelta, applyParlorMessage, applyParlorTool, settleParlorStream } from '../parlor/stream';
import type { ToolEvent } from '../lib/types';
import { useComposeListener } from '../hooks/useCompose';
import { useViewContext, viewContextBlock } from '../hooks/useViewContext';

/**
 * The project parlor dock (§14): a slim view of the project's shared
 * group discussions - every member plus the built-in Goobster seat - on
 * the project page. A project holds several conversations (the first is
 * its primary one); any member switches between them or starts a new one,
 * and every collaborator sees all of them. Each also appears in the Parlor
 * room; this is the same conversation through the same routes.
 */
export function ProjectChatDock({
    slug,
    ownerId,
    projectName,
    open,
    onToggle,
    variant = 'dock'
}: {
    slug: string;
    ownerId?: string | null;
    projectName: string;
    open: boolean;
    onToggle: () => void;
    /** `inline` fills the Conversation view instead of docking beside it (no Close). */
    variant?: 'dock' | 'inline';
}) {
    const me = useMe();
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [composer, setComposer] = useState('');
    // What the person has open beside the chat; a chip removed with ✕ stays
    // out until that thing changes (a new id).
    const viewContext = useViewContext();
    const [excludedContext, setExcludedContext] = useState<Set<string>>(() => new Set());
    const keptContext = viewContext.filter((item) => !excludedContext.has(item.id));
    useComposeListener(setComposer, open);
    const [sending, setSending] = useState(false);
    const [streamMessages, setStreamMessages] = useState<ParlorMessage[]>([]);
    // "Open in project" after moving a chat lands on that conversation.
    const [selectedId, setSelectedId] = useState<number | null>(() => {
        const fromUrl = Number(new URLSearchParams(globalThis.location?.search || '').get('conversation'));
        return Number.isSafeInteger(fromUrl) && fromUrl > 0 ? fromUrl : null;
    });
    const [creating, setCreating] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const logRef = useRef<HTMLDivElement>(null);

    const parlorQ = useQuery({
        queryKey: ['project-parlor', slug, ownerId || ''],
        queryFn: () => api.projectParlor(slug, ownerId),
        enabled: open,
        retry: false
    });
    const conversationsKey = ['project-conversations', slug, ownerId || ''];
    const conversationsQ = useQuery({
        queryKey: conversationsKey,
        queryFn: () => api.projectConversations(slug, ownerId),
        enabled: open && parlorQ.isSuccess,
        retry: false
    });
    const projectConversations = conversationsQ.data?.conversations || [];
    const isOwner = conversationsQ.data?.role === 'owner';
    // A selected conversation that disappeared (deleted elsewhere) falls
    // back to the primary one.
    const selectionValid = selectedId != null
        && (!conversationsQ.data || projectConversations.some((c) => c.id === selectedId));
    const conversationId = (selectionValid ? selectedId : null) ?? parlorQ.data?.conversation?.id ?? null;
    const selected = projectConversations.find((c) => c.id === conversationId) || null;
    useInboxDraft('project', conversationId, composer, setComposer);

    // Same key the Parlor room uses, so parlor-turn invalidation hints
    // (other members talking) refresh this transcript live too.
    const messagesQ = useQuery({
        queryKey: ['parlor-messages', conversationId],
        queryFn: () => api.parlorMessages(conversationId as number) as Promise<{ messages: ParlorMessage[] }>,
        enabled: conversationId != null,
        refetchInterval: sending ? false : 20_000
    });
    // Seats (the Goobster persona + any the owner added) for nudge chips.
    const convsQ = useQuery({
        queryKey: keys.parlorConversations,
        queryFn: () => api.parlorConversations() as Promise<{
            conversations: Array<{ id: number; participants?: Persona[] }>;
        }>,
        enabled: open && conversationId != null
    });
    const participants = useMemo(() => (
        (convsQ.data?.conversations || []).find((c) => c.id === conversationId)?.participants || []
    ), [convsQ.data, conversationId]);
    const personaById = (id?: number) => participants.find((p) => p.id === id);

    const history = messagesQ.data?.messages || [];
    // The last stored message id when this turn began. Once the refetched
    // history moves past it, the stored rows replace the streamed ones in
    // the same render, so the transcript never shrinks and jumps mid-settle.
    const streamBaseRef = useRef<number | null>(null);
    const historyLastId = history[history.length - 1]?.id ?? 0;
    const streamSuperseded = !sending && streamBaseRef.current !== null && historyLastId > streamBaseRef.current;
    const display = useMemo(
        () => (streamSuperseded ? history : [...history, ...streamMessages]),
        [history, streamMessages, streamSuperseded]
    );
    const stick = useStickToBottom(logRef, display);

    useEffect(() => {
        if (!streamSuperseded) return;
        streamBaseRef.current = null;
        setStreamMessages([]);
    }, [streamSuperseded]);

    function beginStream(first: ParlorMessage) {
        streamBaseRef.current = historyLastId;
        setStreamMessages([first]);
        stick.pin();
    }

    async function settleTurn() {
        setSending(false);
        abortRef.current = null;
        setStreamMessages((prev) => settleParlorStream(prev));
        await queryClient.invalidateQueries({ queryKey: ['parlor-messages', conversationId] });
        const stored = queryClient.getQueryData<{ messages: ParlorMessage[] }>(['parlor-messages', conversationId])?.messages || [];
        const storedLastId = stored[stored.length - 1]?.id ?? 0;
        if (streamBaseRef.current === null || storedLastId <= streamBaseRef.current) {
            // Nothing new was stored (stopped or failed before a reply).
            streamBaseRef.current = null;
            setStreamMessages([]);
        }
        await queryClient.invalidateQueries({ queryKey: keys.parlorConversations });
        await queryClient.invalidateQueries({ queryKey: conversationsKey });
        await queryClient.invalidateQueries({ queryKey: keys.observatory });
    }

    function switchTo(id: number) {
        if (sending || id === conversationId) return;
        streamBaseRef.current = null;
        setStreamMessages([]);
        setSelectedId(id);
        stick.pin();
    }

    async function newConversation() {
        if (sending || creating) return;
        setCreating(true);
        try {
            const { conversation } = await api.createProjectConversation(slug, ownerId);
            await queryClient.invalidateQueries({ queryKey: conversationsKey });
            await queryClient.invalidateQueries({ queryKey: keys.parlorConversations });
            setStreamMessages([]);
            setSelectedId(conversation.id);
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setCreating(false);
        }
    }

    async function deleteSelected() {
        if (!selected || selected.primary || sending) return;
        const ok = await confirm(
            `Delete "${selected.title || 'Untitled conversation'}"? It is removed for everyone on ${projectName}.`
        );
        if (!ok) return;
        try {
            await api.parlorDeleteConversation(selected.id);
            setSelectedId(null);
            await queryClient.invalidateQueries({ queryKey: conversationsKey });
            await queryClient.invalidateQueries({ queryKey: keys.parlorConversations });
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    const turnHandlers = (fallbackPersonaId?: number) => {
        let speaker: ParlorMessage = { role: 'persona', personaId: fallbackPersonaId, personaName: personaById(fallbackPersonaId)?.name, content: '' };
        return {
            onPersonaStart: (data: { personaId?: number; name?: string }) => {
                const persona = personaById(data.personaId) || { id: data.personaId || 0, name: data.name || 'Goobster' };
                speaker = { role: 'persona', personaId: persona.id, personaName: persona.name, content: '' };
                setStreamMessages((prev) => [...prev, { ...speaker, typing: true }]);
            },
            onDelta: (delta: string) => {
                setStreamMessages((prev) => applyParlorDelta(prev, delta, speaker));
            },
            onTool: (event: ToolEvent) => {
                setStreamMessages((prev) => applyParlorTool(prev, event, speaker));
            },
            onPersonaMessage: (data: { content?: string; personaId?: number; grounding?: unknown; attachments?: unknown; steps?: ParlorMessage['steps'] }) => {
                setStreamMessages((prev) => applyParlorMessage(prev, {
                    role: 'persona',
                    content: data.content || '',
                    personaId: data.personaId || fallbackPersonaId,
                    personaName: personaById(data.personaId || fallbackPersonaId)?.name,
                    grounding: data.grounding as Grounding[] | undefined,
                    attachments: data.attachments as Attachment[] | undefined,
                    steps: data.steps
                }));
            },
            onError: (error: { message?: string }) => {
                setStreamMessages((prev) => [...settleParlorStream(prev), {
                    role: 'persona' as const, content: error.message || 'Something went wrong.', isError: true
                }]);
            }
        };
    };

    async function sendMessage() {
        const typed = composer.trim();
        if (!typed || sending || conversationId == null) return;
        const block = viewContextBlock(keptContext, typed);
        const text = block ? `${block}\n\n${typed}` : typed;
        setComposer('');
        setSending(true);
        beginStream({ role: 'user', content: text, userId: me.user.id });
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            await streamParlorChat({ message: text, conversationId }, turnHandlers(), controller.signal);
        } catch (error) {
            if ((error as Error).name !== 'AbortError') toast((error as Error).message, true);
        } finally {
            await settleTurn();
        }
    }

    async function nudge(personaId: number) {
        if (sending || conversationId == null) return;
        setSending(true);
        const persona = personaById(personaId);
        beginStream({ role: 'persona', personaId, personaName: persona?.name, content: '', typing: true });
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            await streamParlorNudge(conversationId, personaId, turnHandlers(personaId), controller.signal);
        } catch (error) {
            if ((error as Error).name !== 'AbortError') toast((error as Error).message, true);
        } finally {
            await settleTurn();
        }
    }

    async function stop() {
        abortRef.current?.abort();
        try { await api.parlorStop(); } catch { /* already settled */ }
    }

    if (!open) return null;

    return (
        <aside className={`obs-chat-dock open${variant === 'inline' ? ' is-inline' : ''}`} aria-label={`Chat about ${projectName}`} data-tour="project-conversation">
            <div className="obs-chat-dock-body">
                    <div className="obs-chat-dock-head">
                        <div className="obs-chat-dock-titlebar">
                            <div className="obs-chat-dock-title">
                                <strong>Project chat</strong>
                                <span className="hint">Everyone on {projectName}, including Goobster</span>
                            </div>
                            {variant === 'dock' && (
                                <button type="button" className="btn small subtle obs-chat-dock-close" aria-label="Close project chat" title="Close" onClick={onToggle}>✕</button>
                            )}
                        </div>
                        <div className="obs-chat-dock-head-actions">
                            {projectConversations.length > 0 && (
                                <select
                                    className="input obs-chat-dock-picker"
                                    aria-label="Project conversation"
                                    value={conversationId ?? ''}
                                    disabled={sending}
                                    onChange={(e) => switchTo(Number(e.target.value))}
                                >
                                    {projectConversations.map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {(c.title || 'Untitled conversation') + (c.primary ? ' (main)' : '')}
                                        </option>
                                    ))}
                                </select>
                            )}
                            <button
                                type="button"
                                className="btn small"
                                title="Start another conversation on this project"
                                disabled={sending || creating || conversationsQ.isPending}
                                onClick={() => void newConversation()}
                            >+ New</button>
                            {isOwner && selected && !selected.primary && (
                                <button type="button" className="btn small danger" disabled={sending} onClick={() => void deleteSelected()}>
                                    Delete
                                </button>
                            )}
                            {sending && (
                                <button type="button" className="btn small danger" onClick={() => void stop()}>Stop</button>
                            )}
                        </div>
                    </div>
                    {participants.length > 1 && (
                        <div className="obs-chat-dock-seats">
                            {participants.map((persona) => (
                                <button
                                    key={persona.id}
                                    type="button"
                                    className="btn small"
                                    disabled={sending}
                                    title={`Ask ${persona.name} to speak`}
                                    onClick={() => void nudge(persona.id)}
                                >
                                    <span
                                        className="persona-dot small"
                                        style={{ background: personaColor(persona) }}
                                        aria-hidden="true"
                                    >{personaGlyph(persona)}</span>
                                    {persona.name}
                                </button>
                            ))}
                        </div>
                    )}
                    <div className="obs-chat-dock-scroll" ref={logRef} onScroll={stick.onScroll}>
                        {parlorQ.isPending || (conversationId != null && messagesQ.isPending) ? (
                            <div className="empty">Setting the table…</div>
                        ) : parlorQ.isError ? (
                            <div className="empty">{(parlorQ.error as Error)?.message || 'The project table is unavailable.'}</div>
                        ) : display.length === 0 ? (
                            <div className="empty">
                                Talk with Goobster - and everyone on this project - about {projectName}.
                            </div>
                        ) : (
                            <ParlorConversationView
                                messages={display}
                                meId={me.user.id}
                                personaById={personaById}
                                requestGrant={confirm}
                                typingLabel="thinking…"
                            />
                        )}
                    </div>
                    <InboxContextChips kind="project" conversationId={conversationId} disabled={sending} />
                    {viewContext.length > 0 && (
                        <div className="view-context" aria-label="What Goobster will see" data-testid="view-context">
                            {viewContext.map((item) => {
                                const off = excludedContext.has(item.id);
                                return (
                                    <span key={item.id} className={`view-context-chip is-${item.kind}${off ? ' is-off' : ''}`} title={item.text}>
                                        <span aria-hidden="true">{item.kind === 'file' ? '📄' : item.kind === 'selection' ? '✂' : '🧩'}</span>
                                        <span className="view-context-label">{item.label}</span>
                                        <button
                                            type="button"
                                            className="view-context-toggle"
                                            aria-label={off ? `Include ${item.label}` : `Leave out ${item.label}`}
                                            aria-pressed={!off}
                                            onClick={() => setExcludedContext((prev) => {
                                                const next = new Set(prev);
                                                if (off) next.delete(item.id); else next.add(item.id);
                                                return next;
                                            })}
                                        >{off ? '+' : '✕'}</button>
                                    </span>
                                );
                            })}
                            <span className="hint">{keptContext.length ? 'Sent with your message; visible to the project.' : 'Nothing from this page is sent.'}</span>
                        </div>
                    )}
                    <form
                        className="obs-chat-dock-composer"
                        onSubmit={(event: FormEvent) => { event.preventDefault(); void sendMessage(); }}
                    >
                        <textarea
                            className="input"
                            rows={3}
                            value={composer}
                            onChange={(e) => setComposer(e.target.value)}
                            placeholder={`Message the ${projectName} table… ("Goobster, …" to put it to work)`}
                            disabled={sending || conversationId == null}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' && !event.shiftKey) {
                                    event.preventDefault();
                                    void sendMessage();
                                }
                            }}
                        />
                        <button type="submit" className="btn primary" disabled={!composer.trim() || sending || conversationId == null}>
                            {sending ? '…' : 'Send'}
                        </button>
                    </form>
            </div>
        </aside>
    );
}
