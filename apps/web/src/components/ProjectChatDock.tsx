import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, streamParlorChat, streamParlorNudge } from '../lib/api';
import { keys } from '../lib/query';
import { useMe } from '../hooks/useSession';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { ParlorConversationView } from './ParlorConversationView';
import type { Attachment, Grounding, ParlorMessage, Persona } from '../parlor/types';
import { personaColor, personaGlyph } from '../parlor/persona';

/**
 * The project parlor dock (§14): a slim view of the project's shared
 * group discussion - every member plus the built-in Goobster seat - on
 * the project page. The full discussion also appears in the Parlor room;
 * this is the same conversation through the same routes.
 */
export function ProjectChatDock({
    slug,
    ownerId,
    projectName,
    open,
    onToggle
}: {
    slug: string;
    ownerId?: string | null;
    projectName: string;
    open: boolean;
    onToggle: () => void;
}) {
    const me = useMe();
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [composer, setComposer] = useState('');
    const [sending, setSending] = useState(false);
    const [streamMessages, setStreamMessages] = useState<ParlorMessage[]>([]);
    const abortRef = useRef<AbortController | null>(null);
    const logRef = useRef<HTMLDivElement>(null);

    const parlorQ = useQuery({
        queryKey: ['project-parlor', slug, ownerId || ''],
        queryFn: () => api.projectParlor(slug, ownerId),
        enabled: open,
        retry: false
    });
    const conversationId = parlorQ.data?.conversation?.id ?? null;

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
    const display = useMemo(() => [...history, ...streamMessages], [history, streamMessages]);

    useEffect(() => {
        const el = logRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [display.length, streamMessages]);

    async function settleTurn() {
        setSending(false);
        abortRef.current = null;
        setStreamMessages([]);
        await queryClient.invalidateQueries({ queryKey: ['parlor-messages', conversationId] });
        await queryClient.invalidateQueries({ queryKey: keys.parlorConversations });
        await queryClient.invalidateQueries({ queryKey: keys.observatory });
    }

    const turnHandlers = (fallbackPersonaId?: number) => ({
        onPersonaStart: (data: { personaId?: number; name?: string }) => {
            const persona = personaById(data.personaId) || { id: data.personaId || 0, name: data.name || 'Goobster' };
            setStreamMessages((prev) => [...prev, {
                role: 'persona' as const, personaId: persona.id, personaName: persona.name,
                content: '', typing: true
            }]);
        },
        onDelta: (delta: string) => {
            setStreamMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role !== 'user' && (last.draft || last.typing || last.content === '')) {
                    next[next.length - 1] = { ...last, content: (last.typing ? '' : last.content) + delta, typing: false, draft: true };
                } else {
                    next.push({ role: 'persona', personaId: fallbackPersonaId, content: delta, draft: true });
                }
                return next;
            });
        },
        onPersonaMessage: (data: { content?: string; personaId?: number; grounding?: unknown; attachments?: unknown }) => {
            setStreamMessages((prev) => {
                const next = prev.filter((m) => !m.draft && !m.typing);
                next.push({
                    role: 'persona',
                    content: data.content || '',
                    personaId: data.personaId || fallbackPersonaId,
                    personaName: personaById(data.personaId || fallbackPersonaId)?.name,
                    grounding: data.grounding as Grounding[] | undefined,
                    attachments: data.attachments as Attachment[] | undefined
                });
                return next;
            });
        },
        onError: (error: { message?: string }) => {
            setStreamMessages((prev) => [...prev.filter((m) => !m.typing), {
                role: 'persona' as const, content: error.message || 'Something went wrong.', isError: true
            }]);
        }
    });

    async function sendMessage() {
        const text = composer.trim();
        if (!text || sending || conversationId == null) return;
        setComposer('');
        setSending(true);
        setStreamMessages([{ role: 'user', content: text, userId: me.user.id }]);
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
        setStreamMessages([{ role: 'persona', personaId, personaName: persona?.name, content: '', typing: true }]);
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
        <aside className="obs-chat-dock open" aria-label={`Chat about ${projectName}`}>
            <div className="obs-chat-dock-body">
                    <div className="obs-chat-dock-head">
                        <div className="obs-chat-dock-title">
                            <strong>Project chat</strong>
                            <span className="hint">Everyone on {projectName}, including Goobster</span>
                        </div>
                        <div className="obs-chat-dock-head-actions">
                            {sending && (
                                <button type="button" className="btn danger" onClick={() => void stop()}>Stop</button>
                            )}
                            <button type="button" className="btn" onClick={onToggle}>Close</button>
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
                    <div className="obs-chat-dock-scroll" ref={logRef}>
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
