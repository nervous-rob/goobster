import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Markdown } from '../components/Markdown';
import { MenuButton } from '../shell/MenuButton';

type ShareMessage = { role: string; content: string; createdAt?: string };
type ShareData = { title: string; sharedAt?: string; messages: ShareMessage[] };

/** The stored attachment-block markers on user messages, split back out. */
const ATTACH_BLOCK_RE = /\n*\[Attached file: ([^\]\n]{1,120})\]\n````\n([\s\S]*?)\n````/g;
const FILE_PREVIEW_LIMIT = 4000;

function splitAttachments(content: string): { text: string; files: Array<{ name: string; content: string }> } {
    const files: Array<{ name: string; content: string }> = [];
    const text = String(content || '')
        .replace(ATTACH_BLOCK_RE, (_match, name: string, body: string) => {
            files.push({ name, content: body });
            return '';
        })
        .trim();
    return { text, files };
}

function timeLabel(iso?: string): string {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function UserMessage({ content }: { content: string }) {
    const parsed = splitAttachments(content);
    return (
        <div className="msg-bubble">
            {parsed.text || (parsed.files.length === 0 ? content : '')}
            {parsed.files.map((file) => (
                <details key={file.name} className="file-chip">
                    <summary>📄 {file.name}</summary>
                    <pre>{file.content.length > FILE_PREVIEW_LIMIT
                        ? `${file.content.slice(0, FILE_PREVIEW_LIMIT)}\n…(truncated preview)`
                        : file.content}</pre>
                </details>
            ))}
        </div>
    );
}

/**
 * Read-only share viewer: renders one shared conversation from its public
 * token (/app/share/<token>). It lives inside the normal app shell (sidebar
 * + room navigation) but needs no session and no API access beyond the
 * single share endpoint - anonymous viewers can read it, and the room links
 * take them to the login gate.
 */
export function SharePage() {
    const params = useParams({ strict: false }) as { token?: string };
    const [data, setData] = useState<ShareData | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/app/share/${encodeURIComponent(params.token || '')}`);
                const json = await res.json().catch(() => null);
                if (!res.ok) {
                    throw new Error(json?.error?.message || 'This share link does not exist (or was revoked).');
                }
                if (!cancelled) setData(json as ShareData);
            } catch (err) {
                if (!cancelled) setError((err as Error).message);
            }
        })();
        return () => { cancelled = true; };
    }, [params.token]);

    useEffect(() => {
        if (data?.title) document.title = `${data.title} — Goobster`;
    }, [data?.title]);

    return (
        <main className="pane next-pane is-in share-pane">
            <div className="share-scroll">
                <div className="share-page">
                    <header className="share-header">
                        <MenuButton />
                        <div className="brand">
                            <img className="brand-logo" src="/app/icons/goobster.svg" alt="" width={24} height={24} /> Goobster
                        </div>
                        <div className="hint">{data?.sharedAt ? `Shared ${timeLabel(data.sharedAt)}` : ''}</div>
                    </header>
                    <h1 className="share-title">{data ? data.title : 'Shared conversation'}</h1>
                    {error && <div className="empty">{error}</div>}
                    {!data && !error && <div className="empty">Loading shared conversation…</div>}
                    {data && (
                        <div className="chat-log share-log" aria-live="off">
                            {data.messages.map((message, index) => (
                                <div key={index} className={`msg ${message.role === 'assistant' ? 'assistant' : 'user'}`}>
                                    {message.role === 'assistant'
                                        ? <div className="msg-bubble"><Markdown source={message.content} /></div>
                                        : <UserMessage content={message.content} />}
                                    <div className="msg-meta">
                                        {message.role === 'assistant' ? 'Goobster' : 'User'} · {timeLabel(message.createdAt)}
                                    </div>
                                </div>
                            ))}
                            {data.messages.length === 0 && (
                                <div className="empty">This conversation has no messages yet.</div>
                            )}
                        </div>
                    )}
                    <footer className="share-footer hint">
                        Read-only snapshot shared from a self-hosted Goobster. The owner can revoke this link at any time.
                    </footer>
                </div>
            </div>
        </main>
    );
}
