import { lazy, Suspense, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { api } from '../lib/api';
import { useSession } from '../hooks/useSession';
import {
    ROOM_BY_ID, featureDocPath, featureDocSlug, featureTitle, reasonSentence, resolveRoom, resolveRoomView,
    routeUnavailability, type RouteUnavailability
} from '../lib/rooms';
import { UnavailableNotice, UnavailableRoom } from './UnavailableState';

/**
 * Feature rooms are their own chunks (`assets/feature-<id>-*`, see
 * scripts/lib/frontendChunks.js), and a payload without the feature ships
 * without them (documentation/packaging.md). When the import of one fails,
 * the server's feature status decides: a feature that is not installed
 * renders the "not available on this installation" state; anything else is
 * a real load failure and goes to the stale-chunk recovery as before.
 */

const FEATURE_ASSET = /\/assets\/feature-([A-Za-z0-9]+)-[^/\s'"]*\.(?:js|css)\b/;
const installedCache = new Map<string, Promise<boolean | null>>();

function chunkFeature(error: unknown): string | null {
    const text = String((error as { message?: string })?.message || error || '');
    return FEATURE_ASSET.exec(text)?.[1] || null;
}

/** Whether the server reports `feature` as installed; null when it could not say. */
function reportedInstalled(feature: string): Promise<boolean | null> {
    let pending = installedCache.get(feature);
    if (!pending) {
        pending = api.features()
            .then((status) => {
                const entry = status?.features?.[feature];
                return entry ? entry.installed !== false : null;
            })
            .catch(() => null);
        installedCache.set(feature, pending);
        void pending.then((value) => { if (value === null) installedCache.delete(feature); });
    }
    return pending;
}

/**
 * Keep the page-reload recovery (lib/pwa.ts installChunkRecovery) away from
 * feature files: the failed import reaches the room loader below, which
 * knows whether the feature is simply not part of this payload. Register
 * before installChunkRecovery so this listener runs first.
 */
export function installFeatureChunkGuard(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('vite:preloadError', (event) => {
        if (chunkFeature((event as Event & { payload?: unknown }).payload)) event.stopImmediatePropagation();
    });
}

function absentInfo(feature: string, pathname: string): RouteUnavailability | null {
    const room = ROOM_BY_ID[resolveRoom(pathname)];
    if (!room) return null;
    const viewId = resolveRoomView(room.id, pathname);
    const view = viewId ? (room.views || []).find((entry) => entry.id === viewId) || null : null;
    const reasons = [{ code: 'NOT_INSTALLED' as const }];
    return {
        kind: 'feature',
        level: view?.requires ? 'view' : 'room',
        room,
        view: view?.requires ? view : null,
        feature,
        title: featureTitle(feature),
        reasons,
        sentence: reasonSentence(feature, reasons),
        docSlug: featureDocSlug(feature),
        docPath: featureDocPath(feature)
    };
}

function AbsentFeature({ feature }: { feature: string }) {
    const me = useSession();
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const info = routeUnavailability(pathname, me) || absentInfo(feature, pathname);
    if (!info) return null;
    if (info.level === 'view') {
        return <UnavailableNotice info={info} back={{ to: info.room.path, label: `Back to ${info.room.name}` }} />;
    }
    return <UnavailableRoom info={info} />;
}

/** `lazy()` for a module of `feature`'s chunk that degrades to the unavailable state when the payload left it out. */
export function lazyFeature(
    feature: string,
    load: () => Promise<{ default: ComponentType }>
): LazyExoticComponent<ComponentType> {
    return lazy(() => load().catch(async (error: unknown) => {
        const missing = chunkFeature(error);
        if (missing && (await reportedInstalled(missing)) === false) {
            return { default: () => <AbsentFeature feature={feature} /> };
        }
        throw error;
    }));
}

const opening = (
    <main className="pane next-pane is-in"><div className="empty" role="status">Opening…</div></main>
);

/** A route component for a feature room: the lazy module behind its own Suspense boundary. */
export function featureRoute(
    feature: string,
    load: () => Promise<{ default: ComponentType }>,
    fallback: ReactNode = opening
): () => ReactNode {
    const Lazy = lazyFeature(feature, load);
    return function FeatureRoute() {
        return <Suspense fallback={fallback}><Lazy /></Suspense>;
    };
}
