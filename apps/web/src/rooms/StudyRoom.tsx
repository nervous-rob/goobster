import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { api, fetchSpeech, streamChat, ApiError } from '../lib/api';
import { keys } from '../lib/query';
import { useMe } from '../hooks/useSession';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { ThinkingSteps } from '../components/ThinkingSteps';
import type { ChatMessage, Conversation } from '../lib/types';
import { MenuButton } from '../shell/MenuButton';
import { HeaderOverflow } from '../shell/HeaderOverflow';
import { useConversationDrawer } from '../hooks/useConversationDrawer';
import { useChatTurn, type LocalTurnMessage } from '../hooks/useChatTurn';
import { useVoiceChat, type VoiceChatStatus } from '../hooks/useVoiceChat';

const SUGGESTIONS = [
    'What do you remember about me?',
    'Generate an image of a blueberry running a casino',
    'Build me a playable mini-app: a tiny breakout game',
    'Explain the math behind compound interest, with formulas',
    'What can you do? Give me the highlights.',
    'Help me plan a movie night for the server'
];

const VOICE_LABELS: Record<VoiceChatStatus, string> = {
    idle: '',
    listening: 'Listening — speak, then pause to send.',
    transcribing: 'Heard you — transcribing…',
    thinking: 'Goobster is thinking…',
    speaking: 'Goobster is speaking…'
};

const DEFAULT_HINT = 'Goobster shares memory with your Discord DMs. He can make mistakes.';
const INCOGNITO_HINT = 'Incognito: nothing here is saved to history or memory. Close or switch chats and it’s gone.';
const MAX_ATTACH = 4;
const MAX_TEXT_FILE_BYTES = 200 * 1024;
const REASONING_OPTIONS = [
    { value: '', label: 'Default' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' }
];

type SearchHit = { conversationId: number; messageId: number; title?: string; snippet: string; role?: string };
type PendingImage = { dataUrl: string; name: string };
type PendingFile = { name: string; content: string };
type ChatSettings = {
    thoughtful?: boolean;
    thoughtfulAvailable?: boolean;
    provider?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    customInstructions?: string | null;
    effective?: { providerName?: string; model?: string; reasoningEffort?: string };
    providers?: Array<{ key: string; name: string; configured?: boolean; isDefault?: boolean; chatModel?: string; thoughtfulModel?: string; reasoningEffort?: boolean }>;
};
type Integration = {
    provider: string; name: string; description?: string; connected?: boolean;
    account?: string; tokenHint?: string; docsUrl?: string;
};
type ShareState = { shared?: boolean; url?: string; createdAt?: string };
type TurnStatus = { inFlight: boolean; elapsedMs?: number; conversationId?: number | null };

function elapsedLabel(ms?: number): string {
    const totalSeconds = Math.max(0, Math.round((ms || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function timeLabel(iso?: string): string {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error(`Couldn't read "${file.name}".`));
        reader.readAsDataURL(file);
    });
}

function fileToText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        if (file.size > MAX_TEXT_FILE_BYTES) {
            reject(new Error(`"${file.name}" is too large (max ${Math.round(MAX_TEXT_FILE_BYTES / 1024)}KB).`));
            return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error(`Couldn't read "${file.name}".`));
        reader.readAsText(file);
    });
}

export function StudyRoom() {
    const me = useMe();
    const toast = useToast();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const params = useParams({ strict: false }) as { conversationId?: string };
    const routeId = params.conversationId ? Number(params.conversationId) : null;

    const [activeId, setActiveId] = useState<number | null>(Number.isFinite(routeId) ? routeId : null);
    const [composer, setComposer] = useState('');
    const [sending, setSending] = useState(false);
    const [incognito, setIncognito] = useState(false);
    const [search, setSearch] = useState('');
    const [hits, setHits] = useState<SearchHit[]>([]);
    const [images, setImages] = useState<PendingImage[]>([]);
    const [files, setFiles] = useState<PendingFile[]>([]);
    const turn = useChatTurn();
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const [integrationsOpen, setIntegrationsOpen] = useState(false);
    const [aiSettings, setAiSettings] = useState<ChatSettings | null>(null);
    const chats = useConversationDrawer();
    const abortRef = useRef<AbortController | null>(null);
    const searchTimer = useRef<number | null>(null);
    const logRef = useRef<HTMLDivElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const speechRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
    const voiceChat = useVoiceChat({
        onUtterance: (text) => void sendMessage(text),
        onNotify: toast
    });

    const convs = useQuery({
        queryKey: keys.conversations,
        queryFn: () => api.conversations()
    });
    const historyQ = useQuery({
        queryKey: keys.history(activeId),
        queryFn: () => api.chatHistory(activeId),
        enabled: activeId !== null && !incognito
    });
    const voice = useQuery({
        queryKey: ['voice-caps'],
        queryFn: () => api.voiceCapabilities(),
        retry: false
    });
    const settingsQ = useQuery({
        queryKey: ['chat-settings'],
        queryFn: () => api.chatSettings() as Promise<ChatSettings>
    });
    // The server keeps generating even when the browser disconnects, so on
    // load (or after a refresh) ask whether a turn is still in flight. The
    // web-turn portal event invalidates this key when the turn settles; the
    // interval is only a backstop for missed events.
    const turnQ = useQuery({
        queryKey: ['chat-turn'],
        queryFn: () => api.turnStatus() as Promise<TurnStatus>,
        refetchInterval: (query) => ((query.state.data as TurnStatus | undefined)?.inFlight ? 5_000 : false)
    });
    // A turn this tab is not streaming (it survived a reload, or lives in
    // another tab): show the banner and offer Stop. Only trust a status
    // fetched after our own last turn settled, so the banner never flashes
    // on stale data right after a normal send finishes.
    const localTurnSettledAt = useRef(0);
    const orphanTurn = !sending && turnQ.data?.inFlight && turnQ.dataUpdatedAt > localTurnSettledAt.current
        ? turnQ.data
        : null;

    const prevInFlight = useRef(false);
    useEffect(() => {
        const inFlight = Boolean(turnQ.data?.inFlight);
        if (prevInFlight.current && !inFlight && !sending) {
            // The orphaned turn settled: its reply is in SQLite now.
            void queryClient.invalidateQueries({ queryKey: keys.conversations });
            if (activeId !== null) void queryClient.invalidateQueries({ queryKey: keys.history(activeId) });
        }
        prevInFlight.current = inFlight;
    }, [turnQ.data?.inFlight, sending, activeId, queryClient]);

    const conversations = convs.data?.conversations || [];
    const history = (incognito ? [] : historyQ.data?.messages || []) as LocalTurnMessage[];
    const display = [...history, ...turn.messages, ...(turn.pending ? [turn.pending] : [])];
    const lastAssistant = [...display].reverse().find((m) => m.role === 'assistant' && !m.draft && !m.typing);
    const lastUser = [...display].reverse().find((m) => m.role === 'user');
    const settings = aiSettings || settingsQ.data;

    useEffect(() => {
        if (settingsQ.data) setAiSettings(settingsQ.data);
    }, [settingsQ.data]);

    const resetTurn = turn.reset;
    useEffect(() => {
        if (Number.isFinite(routeId) && routeId !== activeId && !incognito) {
            setActiveId(routeId);
            resetTurn();
        }
    }, [routeId, activeId, incognito, resetTurn]);

    useEffect(() => {
        const el = logRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [display.length, turn.pending?.content, turn.pending?.steps?.length, sending]);

    useEffect(() => () => {
        abortRef.current?.abort();
        if (incognito) api.clearIncognito().catch(() => { /* nothing to clear */ });
        speechRef.current?.audio.pause();
        if (speechRef.current) URL.revokeObjectURL(speechRef.current.url);
    }, [incognito]);

    const goToConversation = useCallback((id: number | null) => {
        setActiveId(id);
        resetTurn();
        if (id) navigate({ to: '/study/$conversationId', params: { conversationId: String(id) } });
        else navigate({ to: '/study' });
    }, [navigate, resetTurn]);

    function onSearchChange(value: string) {
        setSearch(value);
        if (searchTimer.current) window.clearTimeout(searchTimer.current);
        if (value.trim().length < 2) {
            setHits([]);
            return;
        }
        searchTimer.current = window.setTimeout(async () => {
            try {
                const result = await api.searchMessages(value.trim()) as { results: SearchHit[] };
                if (value.trim()) setHits(result.results || []);
            } catch { /* best-effort */ }
        }, 300);
    }

    async function newChat() {
        if (sending) return;
        if (incognito) {
            setIncognito(false);
            api.clearIncognito().catch(() => { /* nothing */ });
        }
        goToConversation(null);
        setComposer('');
        chats.close();
    }

    async function toggleThoughtful() {
        const next = !settings?.thoughtful;
        try {
            const updated = await api.setThoughtful(next) as ChatSettings;
            setAiSettings(updated);
            toast(updated.thoughtful
                ? `Thoughtful Mode on — ${updated.effective?.model || 'deeper reasoning'}.`
                : 'Thoughtful Mode off — back to the everyday model.');
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    function toggleIncognito() {
        if (sending) return;
        if (incognito) {
            setIncognito(false);
            api.clearIncognito().catch(() => { /* nothing */ });
            goToConversation(null);
            toast('Incognito off — back to saved chats.');
        } else {
            setIncognito(true);
            setActiveId(null);
            resetTurn();
            navigate({ to: '/study' });
            toast('Incognito on — this chat won’t be saved.');
        }
    }

    async function regenerate() {
        if (sending || !lastUser || activeId === null) return;
        try {
            await api.truncate(activeId, lastUser.id);
            await queryClient.invalidateQueries({ queryKey: keys.history(activeId) });
            await sendMessage(lastUser.content);
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function branchFrom(message: ChatMessage) {
        if (activeId === null) return;
        try {
            const branch = await api.branch(activeId, message.id) as Conversation;
            await queryClient.invalidateQueries({ queryKey: keys.conversations });
            goToConversation(branch.id);
            toast('Branched — the original conversation is untouched.');
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function listen(text: string) {
        if (speechRef.current) {
            speechRef.current.audio.pause();
            URL.revokeObjectURL(speechRef.current.url);
            speechRef.current = null;
            return;
        }
        try {
            const blob = await fetchSpeech(text);
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            speechRef.current = { audio, url };
            audio.addEventListener('ended', () => {
                URL.revokeObjectURL(url);
                speechRef.current = null;
            });
            await audio.play();
        } catch (error) {
            toast((error as Error).message || 'Read-aloud failed.', true);
        }
    }

    async function addFiles(list: FileList | File[]) {
        for (const file of Array.from(list)) {
            if (file.type.startsWith('image/')) {
                if (images.length >= MAX_ATTACH) {
                    toast(`At most ${MAX_ATTACH} images per message.`, true);
                    continue;
                }
                try {
                    const dataUrl = await fileToDataUrl(file);
                    setImages((prev) => [...prev, { dataUrl, name: file.name }]);
                } catch (error) {
                    toast((error as Error).message, true);
                }
            } else {
                try {
                    const content = await fileToText(file);
                    setFiles((prev) => [...prev, { name: file.name, content }]);
                } catch (error) {
                    toast((error as Error).message, true);
                }
            }
        }
    }

    async function toggleMic() {
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
            toast('This browser does not support microphone recording.', true);
            return;
        }
        try {
            const streamMic = await navigator.mediaDevices.getUserMedia({ audio: true });
            const chunks: BlobPart[] = [];
            const recorder = new MediaRecorder(streamMic);
            recorder.addEventListener('dataavailable', (event) => {
                if (event.data?.size > 0) chunks.push(event.data);
            });
            recorder.addEventListener('stop', async () => {
                streamMic.getTracks().forEach((track) => track.stop());
                const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
                const reader = new FileReader();
                reader.onload = async () => {
                    const result = String(reader.result || '');
                    const comma = result.indexOf(',');
                    const audio = comma === -1 ? result : result.slice(comma + 1);
                    try {
                        const transcribed = await api.transcribe(audio, recorder.mimeType || 'audio/webm');
                        if (transcribed.text) setComposer((prev) => (prev ? `${prev} ${transcribed.text}` : transcribed.text));
                        else toast('Nothing was recognized — try again.', true);
                    } catch (error) {
                        toast((error as Error).message, true);
                    }
                };
                reader.readAsDataURL(blob);
            });
            recorder.start();
            window.setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 8000);
            toast('Listening… tap again is not needed; recording stops automatically.');
        } catch {
            toast('Microphone access was denied.', true);
        }
    }

    async function sendMessage(forcedText: string | null = null) {
        if (sending) {
            try { await api.stop(); } catch { /* settled */ }
            abortRef.current?.abort();
            return;
        }
        const text = (forcedText ?? composer).trim();
        if (!text) return;
        let conversationId = activeId;
        if (conversationId === null && !incognito) {
            try {
                const created = await api.createConversation();
                conversationId = created.id;
                await queryClient.invalidateQueries({ queryKey: keys.conversations });
                goToConversation(created.id);
            } catch (error) {
                toast((error as Error).message, true);
                return;
            }
        }
        const pendingImages = images;
        const pendingFiles = files;
        setImages([]);
        setFiles([]);
        if (forcedText === null) setComposer('');
        setSending(true);
        const controller = new AbortController();
        abortRef.current = controller;
        // Incognito keeps the whole session's exchanges on screen (nothing
        // is refetchable from history there); saved chats reconcile against
        // the refetched history after the turn settles.
        turn.begin({ role: 'user', content: text, images: pendingImages }, { keep: incognito });
        try {
            await streamChat({
                message: text,
                conversationId: incognito ? null : conversationId,
                images: pendingImages.map((image) => image.dataUrl),
                files: pendingFiles,
                incognito
            }, {
                onTyping: turn.onTyping,
                onDelta: turn.onDelta,
                onTool: turn.onTool,
                onMessage: (message) => {
                    turn.onMessage({
                        role: 'assistant',
                        content: message.content || '',
                        attachments: message.attachments,
                        isError: message.isError
                    });
                    if (voiceChat.isActive()) {
                        if (message.content && !message.isError) void voiceChat.speak(message.content);
                        else voiceChat.resume();
                    }
                },
                onError: (error) => {
                    turn.onMessage({
                        role: 'assistant',
                        content: error.message || 'Something went wrong.',
                        isError: true
                    });
                    if (voiceChat.isActive()) voiceChat.resume();
                }
            }, controller.signal);
        } catch (error) {
            if ((error as Error).name !== 'AbortError') {
                if (error instanceof ApiError && error.status === 409) {
                    // Another tab (or a pre-refresh send) holds the turn lock -
                    // surface the banner, which carries its own Stop button.
                    toast(`${error.message} You can stop it from the bar above the chat.`, true);
                    void queryClient.invalidateQueries({ queryKey: ['chat-turn'] });
                } else {
                    toast((error as Error).message, true);
                }
            }
        } finally {
            setSending(false);
            abortRef.current = null;
            // A turn that settled without a spoken reply (abort, dead stream)
            // re-opens the voice-chat mic; no-op when already speaking.
            if (voiceChat.isActive()) voiceChat.resume();
            // Whatever was still streaming (an abort, a dead stream) settles
            // into a visible message instead of vanishing.
            turn.end();
            localTurnSettledAt.current = Date.now();
            void queryClient.invalidateQueries({ queryKey: ['chat-turn'] });
            if (!incognito && conversationId) {
                await queryClient.invalidateQueries({ queryKey: keys.history(conversationId) });
                await queryClient.invalidateQueries({ queryKey: keys.conversations });
                turn.reset();
            }
        }
    }

    async function stopOrphanTurn() {
        try {
            await api.stop();
            toast('Asked Goobster to stop - the partial reply (if any) is kept.');
        } catch (error) {
            toast((error as Error).message, true);
        }
        await queryClient.invalidateQueries({ queryKey: ['chat-turn'] });
    }

    const title = incognito ? 'Incognito chat' : (conversations.find((c) => c.id === activeId)?.title || 'New chat');
    const filter = search.trim().toLowerCase();
    const visibleConvs = conversations.filter((c) => !filter || (c.title || 'New chat').toLowerCase().includes(filter));

    return (
        <main className={`pane next-pane is-in${incognito ? ' incognito' : ''}`} id="pane-chat">
            <div
                className={`conversations-backdrop${chats.open ? '' : ' hidden'}`}
                onClick={chats.close}
            />
            <aside className={`conversations-panel${chats.open ? ' open' : ''}`}>
                <button type="button" className="btn new-chat" onClick={() => void newChat()}>✚ New chat</button>
                <input
                    className="input conv-search"
                    type="search"
                    placeholder="Search chats…"
                    value={search}
                    onChange={(e) => onSearchChange(e.target.value)}
                />
                <div className="conv-list">
                    {visibleConvs.map((conversation) => (
                        <ConvRow
                            key={conversation.id}
                            conversation={conversation}
                            active={conversation.id === activeId && !incognito}
                            onSelect={() => { if (incognito) { setIncognito(false); api.clearIncognito().catch(() => undefined); } goToConversation(conversation.id); chats.close(); }}
                            onChanged={() => queryClient.invalidateQueries({ queryKey: keys.conversations })}
                            onDeleted={() => {
                                if (activeId === conversation.id) goToConversation(null);
                                queryClient.invalidateQueries({ queryKey: keys.conversations });
                            }}
                        />
                    ))}
                    {filter && hits.length > 0 && (
                        <>
                            <div className="search-group-label">In messages</div>
                            {hits.map((hit) => (
                                <button
                                    key={`${hit.conversationId}-${hit.messageId}`}
                                    type="button"
                                    className="conv-item search-hit-item"
                                    onClick={() => {
                                        if (incognito) { setIncognito(false); api.clearIncognito().catch(() => undefined); }
                                        goToConversation(hit.conversationId);
                                        chats.close();
                                    }}
                                >
                                    <span className="conv-title-text">{hit.title || 'New chat'}</span>
                                    <span className="search-snippet">{hit.role === 'assistant' ? 'Goobster: ' : 'You: '}{hit.snippet}</span>
                                </button>
                            ))}
                        </>
                    )}
                </div>
            </aside>
            <div className="study-main">
                <header className="chat-header">
                    <div className="title-row">
                        <MenuButton />
                        <button
                            type="button"
                            className={`icon-action chats-btn${chats.open ? ' on' : ''}`}
                            title="Chats"
                            aria-label="Open chats"
                            aria-expanded={chats.open}
                            onClick={chats.toggle}
                        >💬</button>
                        <div className="chat-title">{title}</div>
                    </div>
                    <div className="chat-header-actions">
                        <button type="button" className="model-chip" onClick={() => setSettingsOpen(true)} title="Model & reasoning settings">
                            <span className="model-chip-gear" aria-hidden="true">⚙</span>
                            <span>{settings?.effective?.model || 'Model'}{settings?.effective?.reasoningEffort ? ` · ${settings.effective.reasoningEffort}` : ''}</span>
                        </button>
                        <HeaderOverflow>
                        {settings?.thoughtfulAvailable !== false && (
                            <label className="thoughtful-toggle" title="Deeper reasoning, slower and pricier">
                                <span>🧠<span className="wide-only"> Thoughtful</span></span>
                                <button
                                    type="button"
                                    className={`toggle${settings?.thoughtful ? ' on' : ''}`}
                                    role="switch"
                                    aria-checked={Boolean(settings?.thoughtful)}
                                    onClick={() => void toggleThoughtful()}
                                />
                            </label>
                        )}
                        <button type="button" className={`icon-action${incognito ? ' on' : ''}`} aria-pressed={incognito} onClick={toggleIncognito}>🕶<span className="menu-label">Incognito</span></button>
                        <button type="button" className="icon-action" onClick={() => {
                            if (incognito) { toast('Incognito chats cannot be shared.', true); return; }
                            if (activeId === null) { toast('Say something first — an empty chat has nothing to share.', true); return; }
                            setShareOpen(true);
                        }}>🔗<span className="menu-label">Share</span></button>
                        <button type="button" className="icon-action" onClick={() => setIntegrationsOpen(true)}>🧩<span className="menu-label">Integrations</span></button>
                        </HeaderOverflow>
                    </div>
                </header>
                {incognito && (
                    <div className="incognito-banner">🕶 Incognito — messages here aren't saved to history or long-term memory.</div>
                )}
                {orphanTurn && (
                    <div className="turn-banner">
                        <span className="tool-spinner" aria-hidden="true" />
                        <span className="turn-banner-text">
                            Goobster is still writing a reply you asked for {elapsedLabel(orphanTurn.elapsedMs)} ago
                            {orphanTurn.conversationId != null && orphanTurn.conversationId !== activeId ? ' (in another chat)' : ''}.
                            It will appear here when it finishes.
                        </span>
                        {orphanTurn.conversationId != null && orphanTurn.conversationId !== activeId && (
                            <button type="button" className="btn" onClick={() => goToConversation(orphanTurn.conversationId as number)}>
                                Open that chat
                            </button>
                        )}
                        <button type="button" className="btn danger" onClick={() => void stopOrphanTurn()}>◼ Stop</button>
                    </div>
                )}
                <div className="chat-scroll" ref={logRef}>
                    <div className="chat-log">
                        {display.map((message, index) => (
                            <div key={message.id && message.id > 0 ? message.id : `local-${index}`} className={`msg ${message.role}${message.isError ? ' error' : ''}`}>
                                {message.images && message.images.length > 0 && (
                                    <div className="msg-images">
                                        {message.images.map((image) => <img key={image.name} src={image.dataUrl} alt={image.name} />)}
                                    </div>
                                )}
                                {message.role === 'assistant' && message.steps && message.steps.length > 0 && (
                                    <ThinkingSteps steps={message.steps} live={Boolean(message.draft)} />
                                )}
                                {(message.typing || message.content || message.attachments?.length) ? (
                                    <div className="msg-bubble">
                                        {message.typing
                                            ? <span className="typing"><i /><i /><i /></span>
                                            : <Markdown source={message.content} attachments={message.attachments} onNotify={toast} />}
                                    </div>
                                ) : null}
                                <div className="msg-actions">
                                    {!message.typing && !message.draft && message.content && (
                                        <button type="button" className="msg-action" onClick={async () => {
                                            const ok = await copyText(message.content);
                                            toast(ok ? 'Copied.' : 'Copy failed.', !ok);
                                        }}>⧉ Copy</button>
                                    )}
                                    {message.role === 'assistant' && lastAssistant === message && activeId !== null && (
                                        <button type="button" className="msg-action" onClick={() => void regenerate()}>↻ Regenerate</button>
                                    )}
                                    {message.role === 'assistant' && voice.data?.tts && message.content && (
                                        <button type="button" className="msg-action listen" onClick={() => void listen(message.content)}>🔊 Listen</button>
                                    )}
                                    {message.role === 'user' && message.id > 0 && activeId !== null && (
                                        <button type="button" className="msg-action" onClick={() => void branchFrom(message)}>⑂ Branch</button>
                                    )}
                                </div>
                                {message.createdAt && !message.draft && <div className="msg-meta">{timeLabel(message.createdAt)}</div>}
                            </div>
                        ))}
                    </div>
                    {display.length === 0 && (
                        <div className="empty-state">
                            <img className="empty-logo" src="/app/icons/goobster.svg" alt="" width={60} height={60} />
                            <div className="empty-title">What can Goobster do for you?</div>
                            <div className="suggestions">
                                {SUGGESTIONS.map((text) => (
                                    <button key={text} type="button" className="suggestion" onClick={() => { setComposer(text); }}>{text}</button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
                <div className="composer-wrap">
                    {(images.length > 0 || files.length > 0) && (
                        <div className="image-tray">
                            {images.map((image, index) => (
                                <div key={`${image.name}-${index}`} className="image-thumb">
                                    <img src={image.dataUrl} alt={image.name} />
                                    <button type="button" onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}>✕</button>
                                </div>
                            ))}
                            {files.map((file, index) => (
                                <div key={`${file.name}-${index}`} className="pending-file-chip">
                                    <span>📄 {file.name}</span>
                                    <button type="button" onClick={() => setFiles((prev) => prev.filter((_, i) => i !== index))}>✕</button>
                                </div>
                            ))}
                        </div>
                    )}
                    {voiceChat.active && (
                        <div className="voice-chat-bar" role="status">
                            <span className={`voice-chat-dot ${voiceChat.status}`} aria-hidden="true" />
                            <span className="voice-chat-label">{VOICE_LABELS[voiceChat.status]}</span>
                            <button type="button" className="btn danger" onClick={voiceChat.stop}>◼ End voice chat</button>
                        </div>
                    )}
                    <form className="composer" onSubmit={(event: FormEvent) => { event.preventDefault(); void sendMessage(); }}>
                        <button type="button" className="icon-action attach" title="Attach files" onClick={() => fileRef.current?.click()}>📎</button>
                        <input
                            ref={fileRef}
                            type="file"
                            multiple
                            className="hidden"
                            accept="image/png,image/jpeg,image/webp,image/gif,text/*,.txt,.md,.json,.csv"
                            onChange={(event: ChangeEvent<HTMLInputElement>) => {
                                if (event.target.files) void addFiles(event.target.files);
                                event.target.value = '';
                            }}
                        />
                        {voice.data?.stt && voice.data?.tts && (
                            <button
                                type="button"
                                className={`icon-action attach voice-chat-btn${voiceChat.active ? ' on' : ''}`}
                                title={voiceChat.active ? 'End voice chat' : 'Voice chat — talk with Goobster out loud'}
                                aria-pressed={voiceChat.active}
                                onClick={() => { if (voiceChat.active) voiceChat.stop(); else void voiceChat.start(); }}
                            >🎤</button>
                        )}
                        {voice.data?.stt && !voice.data?.tts && (
                            <button type="button" className="icon-action attach" title="Dictate a message" onClick={() => void toggleMic()}>🎤</button>
                        )}
                        <textarea
                            className="composer-input"
                            rows={1}
                            value={composer}
                            onChange={(e) => setComposer(e.target.value)}
                            placeholder="Message Goobster… (Enter to send, Shift+Enter for a new line)"
                            aria-label="Message Goobster"
                            maxLength={me.maxInputLength || undefined}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' && !event.shiftKey) {
                                    event.preventDefault();
                                    void sendMessage();
                                }
                            }}
                        />
                        <button type="submit" className={`btn primary send-btn${sending ? ' stop' : ''}`} aria-label={sending ? 'Stop' : 'Send'}>
                            {sending ? '◼' : '➤'}
                        </button>
                    </form>
                    <div className="composer-hint hint">{incognito ? INCOGNITO_HINT : DEFAULT_HINT}</div>
                </div>
            </div>
            {settingsOpen && (
                <SettingsModal
                    initial={settings || {}}
                    onClose={() => setSettingsOpen(false)}
                    onSaved={(next) => { setAiSettings(next); setSettingsOpen(false); }}
                />
            )}
            {shareOpen && activeId !== null && (
                <ShareModal conversationId={activeId} onClose={() => setShareOpen(false)} />
            )}
            {integrationsOpen && (
                <IntegrationsModal onClose={() => setIntegrationsOpen(false)} />
            )}
        </main>
    );
}

function ConvRow({
    conversation, active, onSelect, onChanged, onDeleted
}: {
    conversation: Conversation;
    active: boolean;
    onSelect: () => void;
    onChanged: () => void;
    onDeleted: () => void;
}) {
    const toast = useToast();
    const confirm = useConfirm();
    const [renaming, setRenaming] = useState(false);
    const [title, setTitle] = useState(conversation.title || '');
    return (
        <div className={`conv-item${active ? ' active' : ''}`} role="button" tabIndex={0} onClick={onSelect} onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(); }
        }}>
            {conversation.parentConversationId ? <span className="conv-badge" title="Branched from another conversation">⑂</span> : null}
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
                                await api.renameConversation(conversation.id, next);
                                onChanged();
                            } catch (error) { toast((error as Error).message, true); }
                        }
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
            ) : <span className="conv-title-text">{conversation.title || 'New chat'}</span>}
            {conversation.shareToken ? <span className="conv-badge shared" title="Has an active share link">🔗</span> : null}
            <span className="conv-actions">
                <button type="button" className="conv-action" title="Rename" onClick={(e) => { e.stopPropagation(); setRenaming(true); }}>✎</button>
                <button
                    type="button"
                    className="conv-action"
                    title="Delete"
                    onClick={async (e) => {
                        e.stopPropagation();
                        if (!await confirm(`Delete "${conversation.title || 'New chat'}"? Its messages are gone for good.`)) return;
                        try {
                            await api.deleteConversation(conversation.id);
                            toast('Conversation deleted.');
                            onDeleted();
                        } catch (error) { toast((error as Error).message, true); }
                    }}
                >🗑</button>
            </span>
        </div>
    );
}

function SettingsModal({
    initial, onClose, onSaved
}: {
    initial: ChatSettings;
    onClose: () => void;
    onSaved: (settings: ChatSettings) => void;
}) {
    const toast = useToast();
    const [provider, setProvider] = useState(initial.provider || '');
    const [model, setModel] = useState(initial.model || '');
    const [reasoning, setReasoning] = useState(initial.reasoningEffort || '');
    const [instructions, setInstructions] = useState(initial.customInstructions || '');
    const [models, setModels] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let cancelled = false;
        api.listModels(provider || null).then((result) => {
            if (cancelled) return;
            const list = (result as { models?: string[] }).models || [];
            setModels(list);
        }).catch(() => {
            if (!cancelled) setModels([]);
        });
        return () => { cancelled = true; };
    }, [provider]);

    const providers = initial.providers || [];
    const serverDefault = providers.find((p) => p.isDefault);
    const entry = providers.find((p) => p.key === (provider || serverDefault?.key));
    const supportsReasoning = !entry || entry.reasoningEffort;

    return (
        <Modal onClose={onClose}>
            <h2>Chat settings</h2>
            <div className="field">
                <label htmlFor="settings-provider">Model platform</label>
                <select id="settings-provider" className="select" value={provider} onChange={(e) => { setProvider(e.target.value); setModel(''); }}>
                    <option value="">Default ({serverDefault?.name || 'auto'})</option>
                    {providers.map((item) => (
                        <option key={item.key} value={item.key} disabled={!item.configured}>
                            {item.configured ? item.name : `${item.name} — not configured`}
                        </option>
                    ))}
                </select>
            </div>
            <div className="field">
                <label htmlFor="settings-model">Model</label>
                <select id="settings-model" className="select" value={model} onChange={(e) => setModel(e.target.value)}>
                    <option value="">{entry?.chatModel ? `Provider default (${entry.chatModel})` : 'Provider default'}</option>
                    {models.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
            </div>
            <div className="field">
                <label>Reasoning effort</label>
                <div className="segment">
                    {REASONING_OPTIONS.map((option) => (
                        <button
                            key={option.value || 'default'}
                            type="button"
                            className={`segment-btn${reasoning === option.value ? ' active' : ''}`}
                            disabled={!supportsReasoning && option.value !== ''}
                            onClick={() => setReasoning(option.value)}
                        >{option.label}</button>
                    ))}
                </div>
            </div>
            <div className="field">
                <label htmlFor="settings-instructions">Custom instructions</label>
                <textarea
                    id="settings-instructions"
                    className="input"
                    rows={4}
                    maxLength={2000}
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="How should Goobster respond?"
                />
            </div>
            <div className="hint">
                {supportsReasoning
                    ? 'Settings apply to this web chat and your Discord DMs.'
                    : 'Ollama (local) doesn’t support reasoning effort.'}
            </div>
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button
                    type="button"
                    className="btn primary"
                    disabled={busy}
                    onClick={async () => {
                        setBusy(true);
                        try {
                            const saved = await api.saveChatSettings({
                                provider: provider || null,
                                model: model || null,
                                reasoningEffort: reasoning || null,
                                customInstructions: instructions.trim() || null
                            }) as ChatSettings;
                            toast(`Model settings saved — ${saved.effective?.providerName} · ${saved.effective?.model}.`);
                            onSaved(saved);
                        } catch (error) {
                            toast((error as Error).message, true);
                            setBusy(false);
                        }
                    }}
                >Save</button>
            </div>
        </Modal>
    );
}

function ShareModal({ conversationId, onClose }: { conversationId: number; onClose: () => void }) {
    const toast = useToast();
    const queryClient = useQueryClient();
    const share = useQuery({
        queryKey: ['share', conversationId],
        queryFn: () => api.shareStatus(conversationId) as Promise<ShareState>
    });
    const state = share.data;
    return (
        <Modal onClose={onClose}>
            <h2>Share conversation</h2>
            <p className="hint">Anyone with the link can read this conversation (text only, no sign-in). Revoke it any time.</p>
            {share.isPending && <div className="empty">Loading…</div>}
            {share.isError && <div className="empty">{(share.error as Error).message}</div>}
            {state?.shared && state.url && (
                <>
                    <div className="share-link-row">
                        <input className="input share-link-input" readOnly value={new URL(state.url, window.location.origin).toString()} />
                        <button type="button" className="btn primary" onClick={async () => {
                            const url = new URL(state.url as string, window.location.origin).toString();
                            toast(await copyText(url) ? 'Share link copied.' : 'Copy failed.', !(await copyText(url)));
                        }}>⧉ Copy</button>
                    </div>
                    <button
                        type="button"
                        className="btn danger"
                        onClick={async () => {
                            try {
                                await api.revokeShare(conversationId);
                                toast('Share link revoked — it no longer works.');
                                queryClient.invalidateQueries({ queryKey: ['share', conversationId] });
                                queryClient.invalidateQueries({ queryKey: keys.conversations });
                            } catch (error) { toast((error as Error).message, true); }
                        }}
                    >Revoke link</button>
                </>
            )}
            {state && !state.shared && (
                <button
                    type="button"
                    className="btn primary"
                    onClick={async () => {
                        try {
                            const created = await api.createShare(conversationId) as ShareState;
                            const url = created.url ? new URL(created.url, window.location.origin).toString() : '';
                            if (url) await copyText(url);
                            toast('Share link created and copied.');
                            queryClient.invalidateQueries({ queryKey: ['share', conversationId] });
                            queryClient.invalidateQueries({ queryKey: keys.conversations });
                        } catch (error) { toast((error as Error).message, true); }
                    }}
                >🔗 Create share link</button>
            )}
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Close</button>
            </div>
        </Modal>
    );
}

function IntegrationsModal({ onClose }: { onClose: () => void }) {
    const toast = useToast();
    const confirm = useConfirm();
    const [token, setToken] = useState<Record<string, string>>({});
    const list = useQuery({
        queryKey: ['integrations'],
        queryFn: () => api.integrations() as Promise<{ integrations: Integration[] }>
    });
    const icons: Record<string, string> = { github: '🐙', notion: '📓' };
    return (
        <Modal onClose={onClose} wide>
            <h2>Integrations</h2>
            <p className="hint">Connect your accounts so Goobster can use them in chat — here and in your Discord DMs.</p>
            {list.isPending && <div className="empty">Loading…</div>}
            {list.isError && <div className="hint">{(list.error as Error).message}</div>}
            <div className="integrations-list">
                {(list.data?.integrations || []).map((item) => (
                    <div key={item.provider} className="integration-card">
                        <div className="integration-head">
                            <div className="integration-title">{icons[item.provider] || '🔌'} {item.name}</div>
                            <span className={`integration-status${item.connected ? ' connected' : ''}`}>
                                {item.connected ? `Connected · ${item.account || 'account'}` : 'Not connected'}
                            </span>
                        </div>
                        <div className="hint">{item.description}</div>
                        {item.connected ? (
                            <div className="integration-actions">
                                <button
                                    type="button"
                                    className="btn danger"
                                    onClick={async () => {
                                        if (!await confirm(`Disconnect ${item.name}? The stored token is deleted.`)) return;
                                        try {
                                            await api.disconnectIntegration(item.provider);
                                            toast(`${item.name} disconnected.`);
                                            list.refetch();
                                        } catch (error) { toast((error as Error).message, true); }
                                    }}
                                >Disconnect</button>
                            </div>
                        ) : (
                            <>
                                <div className="hint integration-token-hint">{item.tokenHint}</div>
                                <div className="integration-actions">
                                    <input
                                        className="input integration-token"
                                        type="password"
                                        placeholder={`${item.name} token`}
                                        value={token[item.provider] || ''}
                                        onChange={(e) => setToken((prev) => ({ ...prev, [item.provider]: e.target.value }))}
                                    />
                                    <button
                                        type="button"
                                        className="btn primary"
                                        onClick={async () => {
                                            const value = (token[item.provider] || '').trim();
                                            if (!value) return;
                                            try {
                                                const result = await api.connectIntegration(item.provider, value) as { account?: string };
                                                toast(`${item.name} connected as ${result.account || 'account'}.`);
                                                list.refetch();
                                            } catch (error) { toast((error as Error).message, true); }
                                        }}
                                    >Connect</button>
                                </div>
                                {item.docsUrl && (
                                    <a className="integration-docs" href={item.docsUrl} target="_blank" rel="noreferrer">Where do I get a token? ↗</a>
                                )}
                            </>
                        )}
                    </div>
                ))}
            </div>
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Close</button>
            </div>
        </Modal>
    );
}
