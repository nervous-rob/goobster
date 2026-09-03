import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, streamProjectChat } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { useChatTurn, type LocalTurnMessage } from '../hooks/useChatTurn';
import { ChatTranscript } from './ChatTranscript';
import { SaveToProjectModal, type SaveToProjectTarget } from './SaveToProjectModal';
import type { ChatMessage } from '../lib/types';

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
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const turn = useChatTurn();
    const [composer, setComposer] = useState('');
    const [sending, setSending] = useState(false);
    const [saveTarget, setSaveTarget] = useState<SaveToProjectTarget | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const logRef = useRef<HTMLDivElement>(null);

    const conversation = useQuery({
        queryKey: keys.projectConversation(slug, ownerId),
        queryFn: () => api.projectConversation(slug, ownerId),
        retry: false
    });
    const conversationId = conversation.data?.id ?? null;
    const historyQ = useQuery({
        queryKey: keys.history(conversationId),
        queryFn: () => api.chatHistory(conversationId),
        enabled: conversationId != null,
        retry: false
    });

    const history = (historyQ.data?.messages || []) as LocalTurnMessage[];
    const display = [...history, ...turn.messages, ...(turn.pending ? [turn.pending] : [])];

    useEffect(() => {
        const el = logRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [display.length, turn.pending?.content]);

    async function sendMessage() {
        const text = composer.trim();
        if (!text || sending) return;
        setComposer('');
        setSending(true);
        turn.begin({ role: 'user', content: text }, { keep: false });
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            await streamProjectChat(slug, { message: text, owner: ownerId || undefined }, {
                onTyping: turn.onTyping,
                onDelta: turn.onDelta,
                onTool: turn.onTool,
                onMessage: (message) => turn.onMessage(message as ChatMessage),
                onError: (error) => {
                    turn.onMessage({
                        role: 'assistant',
                        content: error.message || 'Something went wrong.',
                        isError: true
                    });
                }
            }, controller.signal, ownerId);
        } catch (error) {
            if ((error as Error).name !== 'AbortError') {
                toast((error as Error).message, true);
            }
        } finally {
            turn.end();
            setSending(false);
            abortRef.current = null;
            await queryClient.invalidateQueries({ queryKey: keys.history(conversationId) });
            await queryClient.invalidateQueries({ queryKey: keys.conversations });
            await queryClient.invalidateQueries({ queryKey: keys.observatory });
        }
    }

    async function stop() {
        abortRef.current?.abort();
        try { await api.stop(); } catch { /* already settled */ }
    }

    return (
        <aside className={`obs-chat-dock${open ? ' open' : ''}`}>
            <button type="button" className="obs-chat-dock-toggle" onClick={onToggle}>
                {open ? '❯ Hide chat' : `💬 Chat about ${projectName}`}
            </button>
            {open && (
                <div className="obs-chat-dock-body">
                    <div className="obs-chat-dock-head">
                        <strong>🔭 {projectName}</strong>
                        <span className="hint">Same conversation as Chat</span>
                        {sending && (
                            <button type="button" className="btn danger" onClick={() => void stop()}>◼ Stop</button>
                        )}
                    </div>
                    <div className="obs-chat-dock-scroll" ref={logRef}>
                        {conversation.isPending || historyQ.isPending ? (
                            <div className="empty">Loading conversation…</div>
                        ) : (
                            <ChatTranscript
                                messages={display}
                                onNotify={toast}
                                requestGrant={confirm}
                                onSaveToProject={(info) => setSaveTarget({
                                    ...info,
                                    conversationId,
                                    messageId: info.message.id > 0 ? info.message.id : null
                                })}
                                renderActions={(message) => (
                                    !message.typing && !message.draft && message.content ? (
                                        <button
                                            type="button"
                                            className="msg-action"
                                            onClick={async () => {
                                                try {
                                                    await navigator.clipboard.writeText(message.content);
                                                    toast('Copied.');
                                                } catch {
                                                    toast('Copy failed.', true);
                                                }
                                            }}
                                        >⧉ Copy</button>
                                    ) : null
                                )}
                                empty={<div className="empty">Ask Goobster about this project.</div>}
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
                            placeholder={`Message Goobster about ${projectName}…`}
                            disabled={sending}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' && !event.shiftKey) {
                                    event.preventDefault();
                                    void sendMessage();
                                }
                            }}
                        />
                        <button type="submit" className="btn primary" disabled={!composer.trim() && !sending}>
                            {sending ? '…' : 'Send'}
                        </button>
                    </form>
                </div>
            )}
            {saveTarget && (
                <SaveToProjectModal
                    target={saveTarget}
                    onClose={() => setSaveTarget(null)}
                />
            )}
        </aside>
    );
}
