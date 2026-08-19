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
import type { ChatMessage, Conversation } from '../lib/types';
import { MenuButton } from '../shell/MenuButton';
import { HeaderOverflow } from '../shell/HeaderOverflow';
import { useConversationDrawer } from '../hooks/useConversationDrawer';

const TOOL_LABELS: Record<string, [string, string]> = {
    performSearch: ['Searching the web', 'Searched the web'],
    generateImage: ['Generating an image', 'Generated an image'],
    runCode: ['Running code', 'Ran code'],
    searchGithubCode: ['Searching GitHub', 'Searched GitHub'],
    readGithubFile: ['Reading a GitHub file', 'Read a GitHub file'],
    searchNotion: ['Searching Notion', 'Searched Notion'],
    readNotionPage: ['Reading a Notion page', 'Read a Notion page'],
    rememberFact: ['Saving a memory', 'Saved a memory'],
    forgetFact: ['Removing a memory', 'Removed a memory'],
    scheduleFollowUp: ['Scheduling a follow-up', 'Scheduled a follow-up'],
    manageAutomations: ['Managing your automations', 'Managed your automations'],
    manageParlor: ['Working in your Parlor', 'Worked in your Parlor'],
    stockQuote: ['Checking stock prices', 'Checked stock prices'],
    rollDice: ['Rolling dice', 'Rolled dice']
};

const SUGGESTIONS = [
    'What do you remember about me?',
    'Generate an image of a blueberry running a casino',
    'Build me a playable mini-app: a tiny breakout game',
    'Explain the math behind compound interest, with formulas',
    'What can you do? Give me the highlights.',
    'Help me plan a movie night for the server'
];

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
type ToolChip = { name: string; phase: 'start' | 'result'; isError?: boolean };
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
type LocalMessage = ChatMessage & { draft?: boolean; typing?: boolean; images?: PendingImage[] };

function toolLabel(name: string, done: boolean): string {
    const entry = TOOL_LABELS[name];
    if (entry) return entry[done ? 1 : 0];
    const words = String(name).replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    return done ? `Finished: ${words}` : `Working: ${words}`;
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
    const [stream, setStream] = useState<LocalMessage[]>([]);
    const [tools, setTools] = useState<ToolChip[]>([]);
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

    const conversations = convs.data?.conversations || [];
    const history = (incognito ? [] : historyQ.data?.messages || []) as LocalMessage[];
    const display = [...history, ...stream];
    const lastAssistant = [...display].reverse().find((m) => m.role === 'assistant' && !m.draft && !m.typing);
    const lastUser = [...display].reverse().find((m) => m.role === 'user');
    const settings = aiSettings || settingsQ.data;

    useEffect(() => {
        if (settingsQ.data) setAiSettings(settingsQ.data);
    }, [settingsQ.data]);

    useEffect(() => {
        if (Number.isFinite(routeId) && routeId !== activeId && !incognito) {
            setActiveId(routeId);
            setStream([]);
        }
    }, [routeId, activeId, incognito]);

    useEffect(() => {
        const el = logRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [display.length, tools.length, sending]);

    useEffect(() => () => {
        abortRef.current?.abort();
        if (incognito) api.clearIncognito().catch(() => { /* nothing to clear */ });
        speechRef.current?.audio.pause();
        if (speechRef.current) URL.revokeObjectURL(speechRef.current.url);
    }, [incognito]);

    const goToConversation = useCallback((id: number | null) => {
        setActiveId(id);
        setStream([]);
        if (id) navigate({ to: '/study/$conversationId', params: { conversationId: String(id) } });
        else navigate({ to: '/study' });
    }, [navigate]);

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
            setStream([]);
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
        setStream([{
            id: -1, role: 'user', content: text, createdAt: new Date().toISOString(), images: pendingImages
        }]);
        setTools([]);
        let draft = '';
        try {
            await streamChat({
                message: text,
                conversationId: incognito ? null : conversationId,
                images: pendingImages.map((image) => image.dataUrl),
                files: pendingFiles,
                incognito
            }, {
                onTyping: () => {
                    setStream((prev) => {
                        if (prev.some((m) => m.typing || m.draft)) return prev;
                        return [...prev, { id: -2, role: 'assistant', content: '', createdAt: '', typing: true }];
                    });
                },
                onDelta: (delta) => {
                    draft += delta;
                    setStream((prev) => {
                        const next = prev.filter((m) => !m.typing);
                        const last = next[next.length - 1];
                        if (last?.draft) {
                            next[next.length - 1] = { ...last, content: last.content + delta };
                        } else {
                            next.push({ id: -3, role: 'assistant', content: delta, createdAt: '', draft: true });
                        }
                        return next;
                    });
                },
                onTool: (event) => {
                    setTools((prev) => {
                        if (event.phase === 'start') return [...prev, { name: event.name, phase: 'start' }];
                        const next = [...prev];
                        for (let i = next.length - 1; i >= 0; i--) {
                            if (next[i].name === event.name && next[i].phase === 'start') {
                                next[i] = { name: event.name, phase: 'result', isError: event.isError };
                                break;
                            }
                        }
                        return next;
                    });
                    if (event.phase === 'start') {
                        setStream((prev) => prev.filter((m) => !m.draft && !m.typing));
                        draft = '';
                    }
                },
                onMessage: (message) => {
                    setTools([]);
                    setStream((prev) => {
                        const next = prev.filter((m) => !m.draft && !m.typing);
                        next.push({
                            id: -4,
                            role: 'assistant',
                            content: message.content || draft,
                            createdAt: new Date().toISOString(),
                            attachments: message.attachments,
                            isError: message.isError
                        });
                        return next;
                    });
                },
                onError: (error) => {
                    setTools([]);
                    setStream((prev) => [...prev.filter((m) => !m.typing), {
                        id: -5, role: 'assistant', content: error.message || 'Something went wrong.',
                        createdAt: new Date().toISOString(), isError: true
                    }]);
                }
            }, controller.signal);
        } catch (error) {
            if ((error as Error).name !== 'AbortError') {
                if (error instanceof ApiError && error.status === 409) {
                    toast(`${error.message} The ◼ button stops it.`, true);
                } else {
                    toast((error as Error).message, true);
                }
            }
        } finally {
            setSending(false);
            abortRef.current = null;
            setTools([]);
            if (!incognito && conversationId) {
                await queryClient.invalidateQueries({ queryKey: keys.history(conversationId) });
                await queryClient.invalidateQueries({ queryKey: keys.conversations });
                setStream([]);
            }
        }
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
                <div className="chat-scroll" ref={logRef}>
                    <div className="chat-log">
                        {display.map((message, index) => (
                            <div key={message.id && message.id > 0 ? message.id : `local-${index}`} className={`msg ${message.role}${message.isError ? ' error' : ''}`}>
                                {message.images && message.images.length > 0 && (
                                    <div className="msg-images">
                                        {message.images.map((image) => <img key={image.name} src={image.dataUrl} alt={image.name} />)}
                                    </div>
                                )}
                                <div className="msg-bubble">
                                    {message.typing
                                        ? <span className="typing"><i /><i /><i /></span>
                                        : <Markdown source={message.content} attachments={message.attachments} onNotify={toast} />}
                                </div>
                                <div className="msg-actions">
                                    {!message.typing && (
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
                        {tools.length > 0 && (
                            <div className="msg assistant tool-strip">
                                {tools.map((chip, index) => (
                                    <span key={`${chip.name}-${index}`} className={`tool-chip ${chip.phase === 'start' ? 'running' : chip.isError ? 'failed' : 'done'}`}>
                                        {chip.phase === 'start'
                                            ? <><span className="tool-spinner" /> {toolLabel(chip.name, false)}…</>
                                            : `${chip.isError ? '⚠' : '✓'} ${toolLabel(chip.name, true)}`}
                                    </span>
                                ))}
                            </div>
                        )}
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
                        {voice.data?.stt && (
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
