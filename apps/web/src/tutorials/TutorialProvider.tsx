/**
 * Tutorial provider shell (Increment F1).
 *
 * Mounted inside the authenticated account scope. Public share pages never
 * start a tour (no session → provider is inert). Opening one room does not
 * complete another room's tutorial. Pause / Escape saves position and does
 * not seize focus again. Authored step copy arrives in F2; this shell shows
 * progress, missing-anchor explanations, and the Settings-driven Resume /
 * Replay / Reset controls.
 *
 * Tour events go only through /api/app/tutorials — they cannot spend a
 * provider call, send an invitation, or write user knowledge.
 */

import {
    createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
    type ReactNode
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { api, ApiError } from '../lib/api';
import { keys } from '../lib/query';
import { resolveRoom } from '../lib/rooms';
import { useSession } from '../hooks/useSession';
import type { TutorialCatalogEntry, TutorialProgress, TutorialsResponse } from '../lib/types';
import { TutorialPanel } from './TutorialPanel';

type TutorialContextValue = {
    data: TutorialsResponse | undefined;
    loading: boolean;
    active: { tutorialId: string; progress: TutorialProgress; entry: TutorialCatalogEntry } | null;
    resume: (tutorialId: string) => Promise<void>;
    replay: (tutorialId: string) => Promise<void>;
    resetOne: (tutorialId: string) => Promise<void>;
    resetAll: () => Promise<void>;
    setAutoStart: (value: boolean) => Promise<void>;
    pause: () => Promise<void>;
    skipTutorial: () => Promise<void>;
    dismissOffer: () => void;
    offer: { tutorialId: string; title: string; kind: 'first_login' | 'existing' | 'room' } | null;
    acceptOffer: () => Promise<void>;
};

const TutorialContext = createContext<TutorialContextValue | null>(null);

function newEventId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function progressFor(data: TutorialsResponse | undefined, tutorialId: string): TutorialProgress | null {
    return data?.progress.find((p) => p.tutorialId === tutorialId) || null;
}

function entryFor(data: TutorialsResponse | undefined, tutorialId: string): TutorialCatalogEntry | null {
    return data?.catalog.find((c) => c.id === tutorialId) || null;
}

export function TutorialProvider({ children }: { children: ReactNode }) {
    const me = useSession();
    const queryClient = useQueryClient();
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const room = resolveRoom(pathname);
    // Public share pages render inside the shell with a null session — never start a tour.
    const enabled = Boolean(me);
    const isShare = room === 'share' || pathname.includes('/share/');

    const tutorialsQ = useQuery({
        queryKey: keys.tutorials,
        queryFn: () => api.tutorials(),
        enabled,
        staleTime: 15_000
    });

    const [activeId, setActiveId] = useState<string | null>(null);
    const [offer, setOffer] = useState<TutorialContextValue['offer']>(null);
    // After Pause or Escape, do not seize focus again this session.
    const pausedRef = useRef<Set<string>>(new Set());
    const offeredRef = useRef(false);

    const data = tutorialsQ.data;
    const invalidate = useCallback(async () => {
        await queryClient.invalidateQueries({ queryKey: keys.tutorials });
    }, [queryClient]);

    const active = useMemo(() => {
        if (!activeId || !data) return null;
        const progress = progressFor(data, activeId);
        const entry = entryFor(data, activeId);
        if (!progress || !entry) return null;
        return { tutorialId: activeId, progress, entry };
    }, [activeId, data]);

    const postEvent = useCallback(async (tutorialId: string, action: string, stepId?: string | null) => {
        const progress = progressFor(queryClient.getQueryData<TutorialsResponse>(keys.tutorials), tutorialId)
            || progressFor(data, tutorialId);
        if (!progress) throw new Error('Tutorial progress not loaded.');
        try {
            const next = await api.tutorialEvent(tutorialId, {
                eventId: newEventId(),
                generation: progress.generation,
                expectedRevision: progress.revision,
                action,
                stepId: stepId ?? null
            });
            queryClient.setQueryData<TutorialsResponse>(keys.tutorials, (prev) => {
                if (!prev) return prev;
                return {
                    ...prev,
                    progress: prev.progress.map((p) => (p.tutorialId === tutorialId ? next : p))
                };
            });
            return next;
        } catch (error) {
            if (error instanceof ApiError && (error.code === 'STALE_GENERATION' || error.code === 'STALE_REVISION')) {
                await invalidate();
            }
            throw error;
        }
    }, [data, invalidate, queryClient]);

    const resume = useCallback(async (tutorialId: string) => {
        pausedRef.current.delete(tutorialId);
        setOffer(null);
        setActiveId(tutorialId);
        const progress = progressFor(data, tutorialId);
        const entry = entryFor(data, tutorialId);
        if (!progress || !entry?.launchable) return;
        if (progress.status === 'not_started' || progress.status === 'skipped' || progress.status === 'paused') {
            try { await postEvent(tutorialId, 'start'); } catch { /* panel explains missing steps */ }
        }
    }, [data, postEvent]);

    const replay = useCallback(async (tutorialId: string) => {
        pausedRef.current.delete(tutorialId);
        await api.resetTutorial(tutorialId);
        await invalidate();
        setActiveId(tutorialId);
        const entry = entryFor(queryClient.getQueryData<TutorialsResponse>(keys.tutorials), tutorialId)
            || entryFor(data, tutorialId);
        if (entry?.launchable) {
            try {
                const fresh = await api.tutorials();
                queryClient.setQueryData(keys.tutorials, fresh);
                const progress = progressFor(fresh, tutorialId);
                if (progress) {
                    await api.tutorialEvent(tutorialId, {
                        eventId: newEventId(),
                        generation: progress.generation,
                        expectedRevision: progress.revision,
                        action: 'start'
                    });
                    await invalidate();
                }
            } catch { /* empty-step tours stay not_started until F2 */ }
        }
    }, [data, invalidate, queryClient]);

    const resetOne = useCallback(async (tutorialId: string) => {
        if (activeId === tutorialId) setActiveId(null);
        pausedRef.current.delete(tutorialId);
        await api.resetTutorial(tutorialId);
        await invalidate();
    }, [activeId, invalidate]);

    const resetAll = useCallback(async () => {
        setActiveId(null);
        pausedRef.current.clear();
        await api.resetAllTutorials();
        await invalidate();
    }, [invalidate]);

    const setAutoStart = useCallback(async (value: boolean) => {
        const preferences = await api.patchTutorialPreferences(value);
        queryClient.setQueryData<TutorialsResponse>(keys.tutorials, (prev) =>
            prev ? { ...prev, preferences } : prev);
    }, [queryClient]);

    const pause = useCallback(async () => {
        if (!activeId) return;
        try { await postEvent(activeId, 'pause'); } catch { /* already paused / finished */ }
        pausedRef.current.add(activeId);
        setActiveId(null);
    }, [activeId, postEvent]);

    const skipTutorial = useCallback(async () => {
        if (!activeId) return;
        try { await postEvent(activeId, 'skip_tutorial'); } catch { /* */ }
        setActiveId(null);
    }, [activeId, postEvent]);

    const dismissOffer = useCallback(() => {
        setOffer(null);
        offeredRef.current = true;
    }, []);

    const acceptOffer = useCallback(async () => {
        if (!offer) return;
        const id = offer.tutorialId;
        setOffer(null);
        offeredRef.current = true;
        if (id === 'home.orientation') {
            try { await api.markOrientationOffered(); } catch { /* */ }
        }
        await resume(id);
    }, [offer, resume]);

    // Escape pauses the active tour without deleting content.
    useEffect(() => {
        if (!activeId) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                void pause();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [activeId, pause]);

    // First login / room-entry offers. Never on public shares. Never after Pause.
    useEffect(() => {
        if (!enabled || isShare || !data || activeId || offer || offeredRef.current) return;
        if (!data.preferences.autoStart) return;

        const home = progressFor(data, 'home.orientation');
        const homeEntry = entryFor(data, 'home.orientation');
        if (home && homeEntry && home.status === 'not_started' && !pausedRef.current.has('home.orientation')) {
            const kind = data.preferences.orientationOfferedAt ? 'existing' : 'first_login';
            // Existing users get an unobtrusive offer; first login is nonblocking too.
            setOffer({ tutorialId: 'home.orientation', title: homeEntry.title, kind });
            offeredRef.current = true;
            return;
        }

        if (!room || room === 'share' || room === 'settings') return;
        const roomTutorials = data.catalog.filter((c) => c.roomId === room);
        for (const entry of roomTutorials) {
            const progress = progressFor(data, entry.id);
            if (!progress || progress.status !== 'not_started') continue;
            if (pausedRef.current.has(entry.id)) continue;
            if (!entry.launchable) continue;
            setOffer({ tutorialId: entry.id, title: entry.title, kind: 'room' });
            offeredRef.current = true;
            break;
        }
    }, [enabled, isShare, data, activeId, offer, room]);

    const value: TutorialContextValue = {
        data,
        loading: tutorialsQ.isPending,
        active,
        resume,
        replay,
        resetOne,
        resetAll,
        setAutoStart,
        pause,
        skipTutorial,
        dismissOffer,
        offer,
        acceptOffer
    };

    return (
        <TutorialContext.Provider value={value}>
            {children}
            {enabled && !isShare && <TutorialPanel />}
        </TutorialContext.Provider>
    );
}

export function useTutorials(): TutorialContextValue {
    const ctx = useContext(TutorialContext);
    if (!ctx) {
        // Settings may render before the provider in tests; return a inert stub.
        return {
            data: undefined,
            loading: false,
            active: null,
            resume: async () => {},
            replay: async () => {},
            resetOne: async () => {},
            resetAll: async () => {},
            setAutoStart: async () => {},
            pause: async () => {},
            skipTutorial: async () => {},
            dismissOffer: () => {},
            offer: null,
            acceptOffer: async () => {}
        };
    }
    return ctx;
}
