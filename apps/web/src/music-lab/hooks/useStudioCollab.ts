import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import type { StudioSongDetail, StudioSongMember, StudioSongSummary } from '../../lib/types';
import { makeSongId, type SongProject } from '@music-lab/lib/songData';
import { sanitizeSongProject } from '@music-lab/lib/songEdit';
import { applyPatch, diffProject, type SongPatch } from '@music-lab/lib/songPatch';

/**
 * Shared songs: the browser side of /api/app/studio/songs and the
 * /api/app/studio/live room (documentation/music_lab.md, "Shared songs").
 *
 * The open session mirrors the server document. Local edits are applied
 * immediately, coalesced for a few dozen milliseconds, diffed into one
 * id-keyed patch and sent with an opId; the server applies patches in the
 * order it receives them and echoes each one to everybody, sender
 * included. A sender skips its own echo unless another person's patch
 * arrived in between — then it re-applies the echo so every browser ends
 * up with the server's order (last writer wins per entity). Patches made
 * while the socket is down queue up and replay after the next join.
 */

export type CollabStatus = 'connecting' | 'live' | 'offline';

export interface PeerInfo {
  peerId: string;
  userId: string;
  userName: string | null;
}

export interface PresenceCell {
  measure: number;
  sub: number;
  pitch: number;
}

export interface PeerPresence {
  trackId: string | null;
  sectionId: string | null;
  clipId: string | null;
  /** The piano-roll cell under their pointer, when they are in the melody editor. */
  cell?: PresenceCell | null;
}

export type TransportAction = 'play' | 'pause' | 'stop' | 'seek';

/** The room's shared transport as the server last stamped it. */
export interface SharedTransport {
  playing: boolean;
  /** Grid step (measure × subdivisions + sub) the transport was set to. */
  step: number;
  /** Server clock (ms) when the action was accepted. */
  at: number;
  action: TransportAction;
  by: string;
  userId: string;
  userName: string | null;
}

export interface SharedSession {
  songId: string;
  /** null while the first snapshot is still on its way. */
  project: SongProject | null;
  version: number;
  role: 'owner' | 'editor';
  ownerId: string | null;
  members: StudioSongMember[];
  peers: PeerInfo[];
  presence: Record<string, PeerPresence>;
  status: CollabStatus;
  peerId: string | null;
  pendingCount: number;
  transport: SharedTransport | null;
  /** serverTime − localTime in ms; add to Date.now() to get the server clock. */
  clockOffset: number;
}

export interface StudioCollabEvents {
  /** Another person's edit landed on the open song (undo history is now stale). */
  onRemotePatch?: (songId: string) => void;
  /**
   * The room's transport changed. `mine` is true for the echo of our own
   * action; `onJoin` when the state arrived with the snapshot (someone was
   * already playing when we opened the song).
   */
  onTransport?: (transport: SharedTransport, context: { songId: string; mine: boolean; onJoin: boolean }) => void;
  /** The open song went away: the owner removed us or deleted it. */
  onLost?: (songId: string, reason: 'removed' | 'deleted' | 'error', message?: string) => void;
  onError?: (message: string) => void;
}

export interface StudioCollab {
  /** null until the first list call answers; false when signed out or the API is missing. */
  available: boolean | null;
  songs: StudioSongSummary[];
  refresh: () => Promise<void>;
  session: SharedSession | null;
  open: (songId: string) => void;
  close: () => void;
  applyLocal: (next: SongProject) => void;
  sendPresence: (presence: PeerPresence) => void;
  /** Drive the room's transport; the server echoes it to everyone, us included. */
  sendTransport: (action: TransportAction, step: number) => boolean;
  /** Best estimate of the server clock right now (ms). */
  serverNow: () => number;
  share: (project: SongProject) => Promise<StudioSongDetail>;
  remove: (songId: string) => Promise<void>;
  leave: (songId: string, userId: string) => Promise<void>;
  addMember: (songId: string, userId: string, userName?: string | null) => Promise<StudioSongMember[]>;
  removeMember: (songId: string, userId: string) => Promise<StudioSongMember[]>;
}

interface PendingOp {
  opId: string;
  patch: SongPatch;
}

const FLUSH_MS = 60;
/** Pointer-driven presence (piano-roll cells) is throttled to this cadence. */
const PRESENCE_MS = 50;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const MAX_PENDING = 500;

let opCounter = 0;
function makeOpId(): string {
  opCounter += 1;
  return `op-${Date.now().toString(36)}-${opCounter.toString(36)}`;
}

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/app/studio/live`;
}

function trustProject(raw: unknown): SongProject | null {
  const parsed = sanitizeSongProject(raw, makeSongId, { preserveIds: true });
  return parsed.ok ? parsed.project : null;
}

type ServerMessage = {
  type: string;
  songId?: string;
  peerId?: string;
  userId?: string;
  userName?: string | null;
  version?: number;
  role?: 'owner' | 'editor';
  ownerId?: string;
  project?: unknown;
  members?: StudioSongMember[];
  peers?: PeerInfo[];
  patch?: SongPatch;
  opId?: string | null;
  from?: string;
  trackId?: string | null;
  sectionId?: string | null;
  clipId?: string | null;
  cell?: PresenceCell | null;
  code?: string;
  message?: string;
  transport?: SharedTransport | null;
  serverTime?: number;
  t?: number | null;
  playing?: boolean;
  step?: number;
  at?: number;
  action?: TransportAction;
  by?: string;
};

function readTransport(message: ServerMessage): SharedTransport | null {
  if (typeof message.playing !== 'boolean' || typeof message.at !== 'number' || !message.by) return null;
  return {
    playing: message.playing,
    step: Number(message.step ?? 0),
    at: message.at,
    action: (message.action ?? (message.playing ? 'play' : 'stop')) as TransportAction,
    by: message.by,
    userId: String(message.userId ?? ''),
    userName: message.userName ?? null
  };
}

export function useStudioCollab(events: StudioCollabEvents = {}): StudioCollab {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [songs, setSongs] = useState<StudioSongSummary[]>([]);
  const [session, setSessionState] = useState<SharedSession | null>(null);

  const eventsRef = useRef(events);
  eventsRef.current = events;

  const sessionRef = useRef<SharedSession | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const wantedSongRef = useRef<string | null>(null);
  const lastSentRef = useRef<SongProject | null>(null);
  const pendingRef = useRef<PendingOp[]>([]);
  const foreignInterleavedRef = useRef(false);
  const flushTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const lastPresenceRef = useRef<string>('');
  const presenceTimerRef = useRef<number | null>(null);
  const presenceQueuedRef = useRef<PeerPresence | null>(null);
  const presenceSentAtRef = useRef(0);
  const clockOffsetRef = useRef(0);
  const unmountedRef = useRef(false);

  const setSession = useCallback((updater: (prev: SharedSession | null) => SharedSession | null) => {
    const next = updater(sessionRef.current);
    sessionRef.current = next;
    setSessionState(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await api.studioSongs();
      if (unmountedRef.current) return;
      setSongs(result.songs);
      setAvailable(true);
    } catch (error) {
      if (unmountedRef.current) return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 404)) {
        setAvailable(false);
        setSongs([]);
        return;
      }
      // Transient failure: keep whatever we had and stay optimistic.
      setAvailable(prev => (prev === null ? true : prev));
    }
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    void refresh();
    return () => {
      unmountedRef.current = true;
    };
  }, [refresh]);

  const sendRaw = useCallback((payload: Record<string, unknown>): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Diff the mirror against what the server last saw and send one patch. */
  const flush = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const current = sessionRef.current;
    const base = lastSentRef.current;
    if (!current?.project || !base) return;
    const patch = diffProject(base, current.project);
    if (!patch) return;
    const op: PendingOp = { opId: makeOpId(), patch };
    lastSentRef.current = current.project;
    pendingRef.current.push(op);
    if (pendingRef.current.length > MAX_PENDING) pendingRef.current.splice(0, pendingRef.current.length - MAX_PENDING);
    sendRaw({ type: 'patch', opId: op.opId, patch });
    setSession(prev => (prev ? { ...prev, pendingCount: pendingRef.current.length } : prev));
  }, [sendRaw, setSession]);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      flush();
    }, FLUSH_MS);
  }, [flush]);

  const applyLocal = useCallback(
    (next: SongProject) => {
      const current = sessionRef.current;
      if (!current || current.songId !== next.id) return;
      setSession(prev => (prev ? { ...prev, project: next } : prev));
      scheduleFlush();
    },
    [scheduleFlush, setSession]
  );

  const clearTimers = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (presenceTimerRef.current !== null) {
      window.clearTimeout(presenceTimerRef.current);
      presenceTimerRef.current = null;
    }
    presenceQueuedRef.current = null;
  }, []);

  const dropSocket = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    }
  }, []);

  const handleLost = useCallback(
    (songId: string, reason: 'removed' | 'deleted' | 'error', message?: string) => {
      if (wantedSongRef.current !== songId) return;
      wantedSongRef.current = null;
      clearTimers();
      pendingRef.current = [];
      lastSentRef.current = null;
      setSession(() => null);
      void refresh();
      eventsRef.current.onLost?.(songId, reason, message);
    },
    [clearTimers, refresh, setSession]
  );

  const handleJoined = useCallback(
    (message: ServerMessage) => {
      const songId = String(message.songId ?? '');
      if (songId !== wantedSongRef.current) return;
      const project = trustProject(message.project);
      if (!project) {
        handleLost(songId, 'error', 'The shared song could not be read.');
        return;
      }
      // Adopt the server document, then replay anything the server has not
      // acknowledged yet (edits made while the socket was down).
      let current = project;
      for (const op of pendingRef.current) current = applyPatch(current, op.patch);
      lastSentRef.current = current;
      foreignInterleavedRef.current = false;
      reconnectAttemptRef.current = 0;
      for (const op of pendingRef.current) sendRaw({ type: 'patch', opId: op.opId, patch: op.patch });
      // First clock estimate from the snapshot stamp; a ping refines it with
      // half the measured round trip.
      if (typeof message.serverTime === 'number') clockOffsetRef.current = message.serverTime - Date.now();
      sendRaw({ type: 'ping', t: Date.now() });
      const transport = message.transport && typeof message.transport === 'object' ? readTransport(message.transport as ServerMessage) : null;
      setSession(() => ({
        songId,
        project: current,
        version: Number(message.version ?? 0),
        role: message.role === 'owner' ? 'owner' : 'editor',
        ownerId: message.ownerId ?? null,
        members: Array.isArray(message.members) ? message.members : [],
        peers: Array.isArray(message.peers) ? message.peers : [],
        presence: {},
        status: 'live',
        peerId: message.peerId ?? null,
        pendingCount: pendingRef.current.length,
        transport,
        clockOffset: clockOffsetRef.current
      }));
      lastPresenceRef.current = '';
      if (transport) eventsRef.current.onTransport?.(transport, { songId, mine: false, onJoin: true });
    },
    [handleLost, sendRaw, setSession]
  );

  const handlePatch = useCallback(
    (message: ServerMessage) => {
      const current = sessionRef.current;
      if (!current?.project || message.songId !== current.songId || !message.patch) return;
      // Anything unsent goes out first so the mirror and the server's view
      // of "what we last sent" agree before we layer the incoming patch.
      flush();
      const mine = message.from && message.from === current.peerId;
      let apply = true;
      if (mine) {
        const index = pendingRef.current.findIndex(op => op.opId === message.opId);
        if (index >= 0) pendingRef.current.splice(index, 1);
        apply = foreignInterleavedRef.current;
        if (pendingRef.current.length === 0) foreignInterleavedRef.current = false;
      } else if (pendingRef.current.length > 0) {
        foreignInterleavedRef.current = true;
      }
      setSession(prev => {
        if (!prev?.project) return prev;
        const project = apply ? applyPatch(prev.project, message.patch as SongPatch) : prev.project;
        if (apply && lastSentRef.current) lastSentRef.current = applyPatch(lastSentRef.current, message.patch as SongPatch);
        return { ...prev, project, version: Number(message.version ?? prev.version), pendingCount: pendingRef.current.length };
      });
      if (!mine) eventsRef.current.onRemotePatch?.(current.songId);
    },
    [flush, setSession]
  );

  const handleMessage = useCallback(
    (message: ServerMessage) => {
      switch (message.type) {
        case 'joined':
          handleJoined(message);
          return;
        case 'snapshot': {
          const project = trustProject(message.project);
          if (!project || message.songId !== sessionRef.current?.songId) return;
          pendingRef.current = [];
          lastSentRef.current = project;
          setSession(prev =>
            prev
              ? {
                  ...prev,
                  project,
                  version: Number(message.version ?? prev.version),
                  members: Array.isArray(message.members) ? message.members : prev.members,
                  peers: Array.isArray(message.peers) ? message.peers : prev.peers,
                  pendingCount: 0
                }
              : prev
          );
          return;
        }
        case 'patch':
          handlePatch(message);
          return;
        case 'peer_joined':
          setSession(prev => {
            if (!prev || message.songId !== prev.songId || !message.peerId) return prev;
            const peer: PeerInfo = { peerId: message.peerId, userId: String(message.userId ?? ''), userName: message.userName ?? null };
            return { ...prev, peers: [...prev.peers.filter(p => p.peerId !== peer.peerId), peer] };
          });
          return;
        case 'peer_left':
          setSession(prev => {
            if (!prev || message.songId !== prev.songId || !message.peerId) return prev;
            const presence = { ...prev.presence };
            delete presence[message.peerId];
            return { ...prev, peers: prev.peers.filter(p => p.peerId !== message.peerId), presence };
          });
          return;
        case 'peer_presence':
          setSession(prev => {
            if (!prev || message.songId !== prev.songId || !message.peerId) return prev;
            return {
              ...prev,
              presence: {
                ...prev.presence,
                [message.peerId]: {
                  trackId: message.trackId ?? null,
                  sectionId: message.sectionId ?? null,
                  clipId: message.clipId ?? null,
                  cell: message.cell ?? null
                }
              }
            };
          });
          return;
        case 'transport': {
          const current = sessionRef.current;
          if (!current || message.songId !== current.songId) return;
          const transport = readTransport(message);
          if (!transport) return;
          setSession(prev => (prev ? { ...prev, transport } : prev));
          eventsRef.current.onTransport?.(transport, { songId: current.songId, mine: transport.by === current.peerId, onJoin: false });
          return;
        }
        case 'pong': {
          if (typeof message.serverTime !== 'number' || typeof message.t !== 'number') return;
          const now = Date.now();
          const rtt = Math.max(0, now - message.t);
          clockOffsetRef.current = message.serverTime - (message.t + rtt / 2);
          setSession(prev => (prev ? { ...prev, clockOffset: clockOffsetRef.current } : prev));
          return;
        }
        case 'members':
          setSession(prev =>
            prev && message.songId === prev.songId && Array.isArray(message.members) ? { ...prev, members: message.members } : prev
          );
          void refresh();
          return;
        case 'removed':
          handleLost(String(message.songId ?? ''), 'removed');
          return;
        case 'song_deleted':
          handleLost(String(message.songId ?? ''), 'deleted');
          return;
        case 'error': {
          const text = String(message.message || 'The shared song refused that.');
          if (message.code === 'SONG_NOT_FOUND' && wantedSongRef.current) {
            handleLost(wantedSongRef.current, 'removed');
            return;
          }
          eventsRef.current.onError?.(text);
          return;
        }
        default:
          return;
      }
    },
    [handleJoined, handleLost, handlePatch, refresh, setSession]
  );

  const connect = useCallback(() => {
    if (socketRef.current || !wantedSongRef.current) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl());
    } catch {
      return;
    }
    socketRef.current = socket;
    socket.onopen = () => {
      if (socketRef.current !== socket) return;
      if (wantedSongRef.current) sendRaw({ type: 'join', songId: wantedSongRef.current });
    };
    socket.onmessage = event => {
      if (socketRef.current !== socket) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      handleMessage(message);
    };
    socket.onclose = () => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      if (!wantedSongRef.current || unmountedRef.current) return;
      setSession(prev => (prev ? { ...prev, status: 'offline', peers: [], presence: {} } : prev));
      const attempt = reconnectAttemptRef.current;
      reconnectAttemptRef.current = Math.min(attempt + 1, 10);
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    };
    socket.onerror = () => {
      /* onclose follows and schedules the retry */
    };
  }, [handleMessage, sendRaw, setSession]);

  const open = useCallback(
    (songId: string) => {
      if (wantedSongRef.current === songId && sessionRef.current?.songId === songId) return;
      // Anything unsent for the previous song goes out before we move.
      flush();
      wantedSongRef.current = songId;
      pendingRef.current = [];
      lastSentRef.current = null;
      foreignInterleavedRef.current = false;
      lastPresenceRef.current = '';
      const summary = songs.find(s => s.id === songId);
      setSession(() => ({
        songId,
        project: null,
        version: 0,
        role: summary?.role ?? 'editor',
        ownerId: summary?.ownerId ?? null,
        members: [],
        peers: [],
        presence: {},
        status: 'connecting',
        peerId: null,
        pendingCount: 0,
        transport: null,
        clockOffset: clockOffsetRef.current
      }));
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (!sendRaw({ type: 'join', songId })) connect();
    },
    [connect, flush, sendRaw, setSession, songs]
  );

  const close = useCallback(() => {
    flush();
    wantedSongRef.current = null;
    clearTimers();
    sendRaw({ type: 'leave' });
    dropSocket();
    pendingRef.current = [];
    lastSentRef.current = null;
    setSession(() => null);
  }, [clearTimers, dropSocket, flush, sendRaw, setSession]);

  useEffect(() => {
    return () => {
      wantedSongRef.current = null;
      clearTimers();
      dropSocket();
    };
  }, [clearTimers, dropSocket]);

  const sendPresence = useCallback(
    (presence: PeerPresence) => {
      if (!sessionRef.current || sessionRef.current.status !== 'live') return;
      const key = JSON.stringify(presence);
      if (key === lastPresenceRef.current) return;
      // Pointer-driven cells arrive far faster than peers need them: send at
      // most every PRESENCE_MS, always ending on the latest value.
      const now = Date.now();
      const due = presenceSentAtRef.current + PRESENCE_MS - now;
      if (due <= 0 && presenceTimerRef.current === null) {
        lastPresenceRef.current = key;
        presenceSentAtRef.current = now;
        sendRaw({ type: 'presence', ...presence });
        return;
      }
      presenceQueuedRef.current = presence;
      if (presenceTimerRef.current !== null) return;
      presenceTimerRef.current = window.setTimeout(() => {
        presenceTimerRef.current = null;
        const queued = presenceQueuedRef.current;
        presenceQueuedRef.current = null;
        if (!queued || !sessionRef.current || sessionRef.current.status !== 'live') return;
        const queuedKey = JSON.stringify(queued);
        if (queuedKey === lastPresenceRef.current) return;
        lastPresenceRef.current = queuedKey;
        presenceSentAtRef.current = Date.now();
        sendRaw({ type: 'presence', ...queued });
      }, Math.max(0, due));
    },
    [sendRaw]
  );

  const sendTransport = useCallback(
    (action: TransportAction, step: number) => {
      if (!sessionRef.current || sessionRef.current.status !== 'live') return false;
      return sendRaw({ type: 'transport', action, step: Math.max(0, Math.round(step)) });
    },
    [sendRaw]
  );

  const serverNow = useCallback(() => Date.now() + clockOffsetRef.current, []);

  const share = useCallback(
    async (project: SongProject) => {
      const created = await api.studioSongCreate(project);
      await refresh();
      return created;
    },
    [refresh]
  );

  const remove = useCallback(
    async (songId: string) => {
      if (wantedSongRef.current === songId) close();
      await api.studioSongDelete(songId);
      await refresh();
    },
    [close, refresh]
  );

  const leave = useCallback(
    async (songId: string, userId: string) => {
      if (wantedSongRef.current === songId) close();
      await api.studioSongRemoveMember(songId, userId);
      await refresh();
    },
    [close, refresh]
  );

  const addMember = useCallback(
    async (songId: string, userId: string, userName: string | null = null) => {
      const result = await api.studioSongAddMember(songId, userId, userName);
      setSession(prev => (prev && prev.songId === songId ? { ...prev, members: result.members } : prev));
      void refresh();
      return result.members;
    },
    [refresh, setSession]
  );

  const removeMember = useCallback(
    async (songId: string, userId: string) => {
      const result = await api.studioSongRemoveMember(songId, userId);
      setSession(prev => (prev && prev.songId === songId ? { ...prev, members: result.members } : prev));
      void refresh();
      return result.members;
    },
    [refresh, setSession]
  );

  return useMemo(
    () => ({
      available,
      songs,
      refresh,
      session,
      open,
      close,
      applyLocal,
      sendPresence,
      sendTransport,
      serverNow,
      share,
      remove,
      leave,
      addMember,
      removeMember
    }),
    [available, songs, refresh, session, open, close, applyLocal, sendPresence, sendTransport, serverNow, share, remove, leave, addMember, removeMember]
  );
}
