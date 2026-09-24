/**
 * Tutorial provider shell (Increment F1).
 *
 * Mounted inside the authenticated account scope. Public share pages never
 * start a tour (no session → provider is inert). Opening one room does not
 * complete another room's tutorial. Pause / Escape saves position and does
 * not seize focus again. Authored F2 steps show demos in the panel; Keep
 * this example is the only knowledge write and goes through a separate API.
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
    /** null = step has no anchor or we are still looking; false = looked and it is not on screen. */
    anchorFound: boolean | null;
    resume: (tutorialId: string) => Promise<void>;
    replay: (tutorialId: string) => Promise<void>;
    resetOne: (tutorialId: string) => Promise<void>;
    resetAll: () => Promise<void>;
    setAutoStart: (value: boolean) => Promise<void>;
    pause: () => Promise<void>;
    skipTutorial: () => Promise<void>;
    completeStep: () => Promise<void>;
    back: () => Promise<void>;
    feedback: (kind: string) => Promise<void>;
    skipStep: () => Promise<void>;
    finish: () => Promise<void>;
    keepExample: (pieceId: string) => Promise<{ label: string; alreadyHad?: boolean }>;
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
    const isShare = pathname.includes('/share/');

    const tutorialsQ = useQuery({
        queryKey: keys.tutorials,
        queryFn: () => api.tutorials(),
        enabled,
        staleTime: 15_000
    });

    const [activeId, setActiveId] = useState<string | null>(null);
    const [offer, setOffer] = useState<TutorialContextValue['offer']>(null);
    const [anchorFound, setAnchorFound] = useState<boolean | null>(null);
    // After Pause or Escape, do not seize focus again this session.
    const pausedRef = useRef<Set<string>>(new Set());
    const offeredRef = useRef<Set<string>>(new Set());

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

    const postEvent = useCallback(async (tutorialId: string, action: string, stepId?: string | null, feedbackKind?: string) => {
        const progress = progressFor(queryClient.getQueryData<TutorialsResponse>(keys.tutorials), tutorialId)
            || progressFor(data, tutorialId);
        if (!progress) throw new Error('Tutorial progress not loaded.');
        try {
            const next = await api.tutorialEvent(tutorialId, {
                eventId: newEventId(),
                generation: progress.generation,
                expectedRevision: progress.revision,
                action,
                feedbackKind,
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
        offeredRef.current.delete(tutorialId);
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
        offeredRef.current.delete(tutorialId);
        await api.resetTutorial(tutorialId);
        await invalidate();
    }, [activeId, invalidate]);

    const resetAll = useCallback(async () => {
        setActiveId(null);
        pausedRef.current.clear();
        offeredRef.current.clear();
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

    const back = useCallback(async () => {
        if (activeId) await postEvent(activeId, 'back');
    }, [activeId, postEvent]);
    const feedback = useCallback(async (kind: string) => {
        if (activeId && active?.progress.currentStepId) await postEvent(activeId, 'feedback', active.progress.currentStepId, kind);
    }, [activeId, active, postEvent]);

    const completeStep = useCallback(async () => {
        if (!activeId || !active?.progress.currentStepId) return;
        const next = await postEvent(activeId, 'complete_step', active.progress.currentStepId);
        if (next.status === 'completed' || next.status === 'finished_with_skips') {
            setActiveId(null);
        }
    }, [active, activeId, postEvent]);

    const skipStep = useCallback(async () => {
        if (!activeId || !active?.progress.currentStepId) return;
        const next = await postEvent(activeId, 'skip_step', active.progress.currentStepId);
        if (next.status === 'completed' || next.status === 'finished_with_skips') {
            setActiveId(null);
        }
    }, [active, activeId, postEvent]);

    const finish = useCallback(async () => {
        if (!activeId) return;
        try { await postEvent(activeId, 'finish'); } catch { /* */ }
        setActiveId(null);
    }, [activeId, postEvent]);

    const keepExample = useCallback(async (pieceId: string) => {
        const result = await api.keepTutorialExample(pieceId);
        return { label: result.note.label, alreadyHad: result.alreadyHad };
    }, []);

    const dismissOffer = useCallback(() => {
        setOffer(null);
    }, []);

    const acceptOffer = useCallback(async () => {
        if (!offer) return;
        const id = offer.tutorialId;
        setOffer(null);
        offeredRef.current.add(id);
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

    // Spotlight the control the current step points at. Anchors can render a
    // beat after navigation or be replaced by a refetch on the same route.
    const anchorId = active?.entry.steps.find((s) => s.id === active.progress.currentStepId)?.anchorId || null;
    useEffect(() => {
        if (!anchorId) {
            setAnchorFound(null);
            return;
        }
        setAnchorFound(null);
        let target: Element | null = null;
        const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const look = () => {
            const el = document.querySelector(`[data-tour="${anchorId}"]`);
            if (el !== target) {
                target?.classList.remove('tour-target');
                target = el;
                if (target) {
                    target.classList.add('tour-target');
                    target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
                }
            }
            setAnchorFound(Boolean(target));
        };
        // Child-list changes cover late loads, removal, and replacement without
        // observing our own class changes or restarting the animation each render.
        const observer = new MutationObserver(look);
        observer.observe(document.body, { childList: true, subtree: true });
        look();
        return () => {
            observer.disconnect();
            target?.classList.remove('tour-target');
        };
    }, [anchorId, pathname]);

    // First login / room-entry offers. Never on public shares. Never after Pause.
    useEffect(() => {
        if (!enabled || isShare || !data || activeId || offer) return;
        if (!data.preferences.autoStart) return;

        const home = progressFor(data, 'home.orientation');
        const homeEntry = entryFor(data, 'home.orientation');
        if (room !== 'settings' && home && homeEntry && home.status === 'not_started'
            && !pausedRef.current.has('home.orientation') && !offeredRef.current.has('home.orientation')) {
            const kind = data.preferences.orientationOfferedAt ? 'existing' : 'first_login';
            // Existing users get an unobtrusive offer; first login is nonblocking too.
            setOffer({ tutorialId: 'home.orientation', title: homeEntry.title, kind });
            offeredRef.current.add('home.orientation');
            return;
        }

        if (!room || room === 'settings') return;
        const roomTutorials = data.catalog.filter((c) => c.roomId === room);
        for (const entry of roomTutorials) {
            const progress = progressFor(data, entry.id);
            if (!progress || progress.status !== 'not_started') continue;
            if (pausedRef.current.has(entry.id) || offeredRef.current.has(entry.id)) continue;
            if (!entry.launchable) continue;
            setOffer({ tutorialId: entry.id, title: entry.title, kind: 'room' });
            offeredRef.current.add(entry.id);
            break;
        }
    }, [enabled, isShare, data, activeId, offer, room]);

    const value: TutorialContextValue = {
        data,
        loading: tutorialsQ.isPending,
        active,
        anchorFound,
        resume,
        replay,
        resetOne,
        resetAll,
        setAutoStart,
        pause,
        skipTutorial,
        completeStep,
        back,
        feedback,
        skipStep,
        finish,
        keepExample,
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
            anchorFound: null,
            resume: async () => {},
            replay: async () => {},
            resetOne: async () => {},
            resetAll: async () => {},
            setAutoStart: async () => {},
            pause: async () => {},
            skipTutorial: async () => {},
            completeStep: async () => {},
            back: async () => {},
            feedback: async () => {},
            skipStep: async () => {},
            finish: async () => {},
            keepExample: async () => ({ label: '' }),
            dismissOffer: () => {},
            offer: null,
            acceptOffer: async () => {}
        };
    }
    return ctx;
}
