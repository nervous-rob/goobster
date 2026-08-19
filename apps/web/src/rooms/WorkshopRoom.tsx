import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { bindTilt } from '../lib/atmosphere';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { renderApplet as renderAppletJs } from '../renderers/codeblocks.js';

type Applet = {
    id?: number;
    title: string;
    language: string;
    source: string;
    pinned?: boolean;
    conversationId?: number | null;
    conversationTitle?: string | null;
    messageId?: number | null;
};

type AppletsPayload = {
    pinned: Applet[];
    discovered: Applet[];
};

function renderApplet(
    container: HTMLElement,
    opts: { source: string; language?: string; notify?: (message: string, isError?: boolean) => void }
): void {
    const fn = renderAppletJs as (
        el: HTMLElement,
        options: { source: string; language?: string; notify?: (message: string, isError?: boolean) => void }
    ) => void;
    fn(container, opts);
}

function Tile({ applet, onOpen }: { applet: Applet; onOpen: (applet: Applet) => void }) {
    const ref = useRef<HTMLButtonElement>(null);
    useEffect(() => bindTilt(ref.current), []);
    return (
        <button type="button" ref={ref} className="workshop-tile" onClick={() => onOpen(applet)}>
            <div className="workshop-tile-mark">{applet.language === 'svg' ? '✎' : '✨'}</div>
            <div className="workshop-tile-title">{applet.title}</div>
            <div className="workshop-tile-meta">
                {applet.pinned ? 'Pinned' : 'From chat'}
                {applet.conversationTitle ? ` · ${applet.conversationTitle}` : ''}
            </div>
        </button>
    );
}

function Section({
    title, items, empty, onOpen
}: {
    title: string;
    items: Applet[];
    empty: string;
    onOpen: (applet: Applet) => void;
}) {
    return (
        <section className="workshop-section">
            <h2>{title}</h2>
            {items.length === 0
                ? <div className="hint">{empty}</div>
                : (
                    <div className="workshop-grid">
                        {items.map((applet, index) => (
                            <Tile
                                key={applet.id ?? `${applet.title}-${applet.messageId ?? index}`}
                                applet={applet}
                                onOpen={onOpen}
                            />
                        ))}
                    </div>
                )}
        </section>
    );
}

export function WorkshopRoom() {
    const toast = useToast();
    const confirm = useConfirm();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const applets = useQuery({
        queryKey: keys.applets,
        queryFn: () => api.applets() as Promise<AppletsPayload>
    });
    const [current, setCurrent] = useState<Applet | null>(null);
    const stageRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage || !current) return;
        stage.replaceChildren();
        renderApplet(stage, {
            source: current.source,
            language: current.language,
            notify: toast
        });
        if (current.pinned && current.id) {
            api.touchApplet(current.id).catch(() => { /* best-effort */ });
        }
        return () => { stage.replaceChildren(); };
    }, [current, toast]);

    async function togglePin() {
        if (!current) return;
        try {
            if (current.pinned && current.id) {
                if (!await confirm('Unpin this mini-app from the Workshop?')) return;
                await api.unpinApplet(current.id);
                toast('Unpinned.');
                setCurrent(null);
                await queryClient.invalidateQueries({ queryKey: keys.applets });
                return;
            }
            const pinned = await api.pinApplet({
                title: current.title,
                language: current.language,
                source: current.source,
                conversationId: current.conversationId,
                messageId: current.messageId
            }) as Applet;
            toast('Pinned to the Workshop.');
            setCurrent({ ...pinned, pinned: true });
            await queryClient.invalidateQueries({ queryKey: keys.applets });
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    const catalog = applets.data;

    return (
        <main className="pane next-pane is-in" id="pane-workshop">
            <header className="pane-header">
                <h1>{current ? (current.title || 'Mini-app') : 'Workshop'}</h1>
                <div className="pane-header-actions">
                    {current ? (
                        <>
                            <button
                                type="button"
                                className={`btn${current.pinned ? ' danger' : ' primary'}`}
                                onClick={togglePin}
                            >
                                {current.pinned ? '📌 Unpin' : '📌 Pin'}
                            </button>
                            {current.conversationId ? (
                                <button
                                    type="button"
                                    className="btn"
                                    onClick={() => navigate({
                                        to: '/study/$conversationId',
                                        params: { conversationId: String(current.conversationId) }
                                    })}
                                >
                                    Open in Study
                                </button>
                            ) : null}
                            <button type="button" className="btn" onClick={() => setCurrent(null)}>← Back</button>
                        </>
                    ) : (
                        <button
                            type="button"
                            className="btn"
                            onClick={() => queryClient.invalidateQueries({ queryKey: keys.applets })}
                        >
                            Refresh
                        </button>
                    )}
                </div>
            </header>
            <div className="pane-body">
                {current ? (
                    <div className="workshop-preview-stage" ref={stageRef} />
                ) : (
                    <>
                        {applets.isPending && <div className="empty">Looking through the bench…</div>}
                        {applets.isError && <div className="empty">{(applets.error as Error).message}</div>}
                        {catalog && (
                            <div className="workshop-shell">
                                <p className="hint workshop-lead">
                                    Mini-apps Goobster built in the Study. Pin one and it stays on the bench —
                                    reopen it anytime, even if the chat is gone.
                                </p>
                                <Section
                                    title="Pinned"
                                    items={catalog.pinned || []}
                                    empty="Nothing pinned yet. Open a discovered app and pin it, or ask in the Study: “build me a …”"
                                    onOpen={setCurrent}
                                />
                                <Section
                                    title="Found in chat"
                                    items={catalog.discovered || []}
                                    empty="No unpinned mini-apps in recent chats."
                                    onOpen={setCurrent}
                                />
                            </div>
                        )}
                    </>
                )}
            </div>
        </main>
    );
}
