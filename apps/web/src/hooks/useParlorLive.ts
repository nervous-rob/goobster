import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ParlorLiveSession,
    type LiveListener,
    type ParlorLiveHooks
} from '../lib/parlorLiveSession';

export function useParlorLive(hooks: Pick<ParlorLiveHooks, 'onTurnEvent' | 'toast'> = {}) {
    const sessionRef = useRef<ParlorLiveSession | null>(null);
    const hooksRef = useRef(hooks);
    hooksRef.current = hooks;

    const [status, setStatus] = useState<string | null>(null);
    const [caption, setCaption] = useState('');
    const [talking, setTalking] = useState(false);
    const [muted, setMutedState] = useState(false);
    const [speakingPersonaId, setSpeakingPersonaId] = useState<number | null>(null);
    const [listeners, setListeners] = useState<LiveListener[]>([]);
    const [joining, setJoining] = useState(false);
    const [connected, setConnected] = useState(false);

    const ensureSession = () => {
        if (!sessionRef.current) sessionRef.current = new ParlorLiveSession();
        return sessionRef.current;
    };

    const leave = useCallback((reason = 'left') => {
        sessionRef.current?.leave(reason);
        setStatus(null);
        setCaption('');
        setTalking(false);
        setSpeakingPersonaId(null);
        setListeners([]);
        setJoining(false);
        setConnected(false);
    }, []);

    useEffect(() => () => {
        sessionRef.current?.leave('unmount');
        sessionRef.current = null;
    }, []);

    const join = useCallback(async (conversationId: number) => {
        const session = ensureSession();
        if (session.active) session.leave('switch');
        setJoining(true);
        setStatus('Connecting…');
        setCaption('');
        try {
            await session.start(conversationId, {
                onTurnEvent: (event, data) => hooksRef.current.onTurnEvent?.(event, data),
                toast: (message, isError) => hooksRef.current.toast?.(message, isError),
                onStatus: setStatus,
                onCaption: setCaption,
                onTalking: setTalking,
                onSpeaking: setSpeakingPersonaId,
                onListeners: setListeners,
                onEnded: () => {
                    setStatus(null);
                    setCaption('');
                    setTalking(false);
                    setSpeakingPersonaId(null);
                    setJoining(false);
                    setConnected(false);
                }
            });
            setJoining(false);
            setConnected(true);
        } catch (error) {
            setJoining(false);
            setConnected(false);
            setStatus(null);
            throw error;
        }
    }, []);

    const say = useCallback((text: string) => ensureSession().say(text), []);
    const nudgeLive = useCallback((personaId: number) => ensureSession().nudge(personaId), []);
    const stopSpeech = useCallback(() => ensureSession().stopSpeech(), []);
    const toggleMute = useCallback(() => {
        const session = ensureSession();
        const next = !session.isMuted;
        session.setMuted(next);
        setMutedState(next);
    }, []);

    return {
        active: connected,
        status,
        caption,
        talking,
        muted,
        speakingPersonaId,
        listeners,
        joining,
        join,
        leave,
        say,
        nudgeLive,
        stopSpeech,
        toggleMute
    };
}
