import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { projectPath } from '../lib/rooms';
import { useMe } from '../hooks/useSession';
import { bindTilt } from '../lib/atmosphere';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { renderApplet as renderAppletJs } from '../renderers/codeblocks.js';
import { SaveToProjectModal, type SaveToProjectTarget } from './SaveToProjectModal';

export type InboxApplet = {
    id?: number;
    title: string;
    language: string;
    source: string;
    pinned?: boolean;
    grants?: { observatoryRead?: string[] };
    conversationId?: number | null;
    conversationTitle?: string | null;
    messageId?: number | null;
    migrated?: boolean;
    migratedAssetId?: number | null;
    migratedAssetSlug?: string | null;
    migratedProject?: string | null;
    /** The migrated project's owner - with the slug, its address (ADR 0009). */
    migratedProjectOwnerId?: string | null;
};

type AppletsPayload = {
    pinned: InboxApplet[];
    discovered: InboxApplet[];
};

function renderApplet(
    container: HTMLElement,
    opts: {
        source: string;
        language?: string;
        notify?: (message: string, isError?: boolean) => void;
        requestGrant?: (message: string) => Promise<boolean>;
        grants?: { observatoryRead?: string[] };
        onGrantsChange?: (grants: { observatoryRead: string[] }) => void;
    }
): void {
    const fn = renderAppletJs as (
        el: HTMLElement,
        options: {
            source: string;
            language?: string;
            notify?: (message: string, isError?: boolean) => void;
            requestGrant?: (message: string) => Promise<boolean>;
            grants?: { observatoryRead?: string[] };
            onGrantsChange?: (grants: { observatoryRead: string[] }) => void;
        }
    ) => void;
    fn(container, opts);
}

function Tile({ applet, onOpen }: { applet: InboxApplet; onOpen: (applet: InboxApplet) => void }) {
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
            {applet.migrated ? (
                <div className="workshop-tile-badge" title={
                    applet.migratedProject && applet.migratedAssetSlug
                        ? `${applet.migratedProject}/${applet.migratedAssetSlug}`
                        : 'Copied into a project'
                }>
                    Migrated
                </div>
            ) : null}
        </button>
    );
}

function Section({
    title, items, empty, onOpen
}: {
    title: string;
    items: InboxApplet[];
    empty: string;
    onOpen: (applet: InboxApplet) => void;
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

function toSaveTarget(applet: InboxApplet): SaveToProjectTarget {
    return {
        source: applet.source,
        language: applet.language,
        title: applet.title,
        grants: { observatoryRead: applet.grants?.observatoryRead || [] },
        conversationId: applet.conversationId,
        messageId: applet.messageId
    };
}

/**
 * Discovered Study fences + legacy Workshop pins. Lives on the Projects
 * room list view; pinning and promote-to-project stay during the
 * web_applets deprecation window.
 */
export function WorkshopInbox({
    onPreviewChange
}: {
    onPreviewChange?: (applet: InboxApplet | null) => void;
} = {}) {
    const me = useMe();
    const toast = useToast();
    const confirm = useConfirm();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const applets = useQuery({
        queryKey: keys.applets,
        queryFn: () => api.applets() as Promise<AppletsPayload>
    });
    const [current, setCurrent] = useState<InboxApplet | null>(null);
    const [promoteTarget, setPromoteTarget] = useState<InboxApplet | null>(null);
    const stageRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        onPreviewChange?.(current);
    }, [current, onPreviewChange]);

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage || !current) return;
        stage.replaceChildren();
        renderApplet(stage, {
            source: current.source,
            language: current.language,
            notify: toast,
            requestGrant: confirm,
            grants: current.grants,
            onGrantsChange: current.pinned && current.id
                ? (grants) => {
                    api.updateAppletGrants(current.id as number, grants)
                        .then(() => queryClient.invalidateQueries({ queryKey: keys.applets }))
                        .catch(() => { /* best-effort */ });
                }
                : undefined
        });
        if (current.pinned && current.id) {
            api.touchApplet(current.id).catch(() => { /* best-effort */ });
        }
        return () => { stage.replaceChildren(); };
    }, [current, toast, confirm, queryClient]);

    async function togglePin() {
        if (!current) return;
        try {
            if (current.pinned && current.id) {
                if (!await confirm('Unpin this mini-app from Unfiled apps?')) return;
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
                messageId: current.messageId,
                grants: current.grants
            }) as InboxApplet;
            toast('Pinned under Unfiled apps.');
            setCurrent({ ...pinned, pinned: true });
            await queryClient.invalidateQueries({ queryKey: keys.applets });
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    const catalog = applets.data;

    if (current) {
        return (
            <div className="workshop-inbox-preview">
                <div className="obs-apps-toolbar">
                    <strong>{current.title || 'Mini-app'}</strong>
                    <span style={{ flex: 1 }} />
                    <button
                        type="button"
                        className="btn primary"
                        onClick={() => setPromoteTarget(current)}
                    >
                        Add to project…
                    </button>
                    <button
                        type="button"
                        className={`btn${current.pinned ? ' danger' : ''}`}
                        onClick={() => void togglePin()}
                    >
                        {current.pinned ? '📌 Unpin' : '📌 Pin'}
                    </button>
                    {current.migrated && current.migratedProject ? (
                        <button
                            type="button"
                            className="btn"
                            onClick={() => {
                                setCurrent(null);
                                // The project's own address, on its Outputs view -
                                // never the bare list (ADR 0009 §3).
                                navigate({
                                    to: projectPath({
                                        owner: current.migratedProjectOwnerId || me.user.id,
                                        slug: current.migratedProject as string
                                    }, 'apps') as never
                                });
                            }}
                        >
                            Open in Projects
                        </button>
                    ) : null}
                    {current.conversationId ? (
                        <button
                            type="button"
                            className="btn"
                            onClick={() => navigate({
                                to: '/chat/$conversationId',
                                params: { conversationId: String(current.conversationId) }
                            })}
                        >
                            Open in Study
                        </button>
                    ) : null}
                    <button type="button" className="btn" onClick={() => setCurrent(null)}>← Back</button>
                </div>
                {current.migrated ? (
                    <p className="hint workshop-migrated-banner">
                        Migrated to {current.migratedProject}/{current.migratedAssetSlug}.
                        The pin stays here for this release; the versioned copy lives on the project.
                    </p>
                ) : null}
                <div className="workshop-preview-stage" ref={stageRef} />
                {promoteTarget && (
                    <SaveToProjectModal
                        target={toSaveTarget(promoteTarget)}
                        origin="portal"
                        promote
                        appletId={promoteTarget.pinned ? promoteTarget.id ?? null : null}
                        heading="Add to project…"
                        hint="Copy this mini-app into a versioned project asset. The Unfiled-apps pin stays until pins retire."
                        onClose={() => setPromoteTarget(null)}
                        onSaved={() => {
                            void queryClient.invalidateQueries({ queryKey: keys.applets }).then(() => {
                                if (!promoteTarget.id) return;
                                const next = (applets.data?.pinned || []).find((a) => a.id === promoteTarget.id);
                                if (next) setCurrent(next);
                            });
                        }}
                    />
                )}
            </div>
        );
    }

    return (
        <div className="workshop-shell workshop-inbox" data-tour="project-unfiled-apps">
            <div className="section-title">Unfiled apps</div>
            <p className="hint workshop-lead">
                Mini-apps Goobster built in Chat that do not live in a project yet, plus
                leftover Workshop pins. This lists generated apps only - not files or reports.
                Add one to a project to give it a versioned home; pinning still works during
                this deprecation window.
            </p>
            {applets.isPending && <div className="empty">Looking through the bench…</div>}
            {applets.isError && <div className="empty">{(applets.error as Error).message}</div>}
            {catalog && (
                <>
                    <Section
                        title="Pinned"
                        items={catalog.pinned || []}
                        empty="Nothing pinned yet. Open a discovered app and pin it, or ask in Chat: “build me a …”"
                        onOpen={setCurrent}
                    />
                    <Section
                        title="Found in chat"
                        items={catalog.discovered || []}
                        empty="No unpinned mini-apps in recent chats."
                        onOpen={setCurrent}
                    />
                </>
            )}
            {promoteTarget && (
                <SaveToProjectModal
                    target={toSaveTarget(promoteTarget)}
                    origin="portal"
                    promote
                    appletId={promoteTarget.pinned ? promoteTarget.id ?? null : null}
                    heading="Add to project…"
                    hint="Copy this mini-app into a versioned project asset."
                    onClose={() => setPromoteTarget(null)}
                    onSaved={() => { void queryClient.invalidateQueries({ queryKey: keys.applets }); }}
                />
            )}
        </div>
    );
}
