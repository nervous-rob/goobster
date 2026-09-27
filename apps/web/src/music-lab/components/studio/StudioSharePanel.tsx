import { useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import type { Person, StudioSongMember } from '../../../lib/types';
import type { SharedSession } from '@music-lab/hooks/useStudioCollab';

interface StudioSharePanelProps {
  me: { id: string; name: string } | null;
  songName: string;
  /** The open shared session, or null when the current song lives only in this browser. */
  session: SharedSession | null;
  busy: boolean;
  onShare: () => void;
  onLeave: () => void;
  onDelete: () => void;
  onLocalCopy: () => void;
  onAddMember: (userId: string, userName: string | null) => Promise<void>;
  onRemoveMember: (userId: string) => Promise<void>;
  onClose: () => void;
}

const SEARCH_DEBOUNCE_MS = 250;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{5,64}$/;

export function peerColor(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return hash % 360;
}

function memberLabel(member: StudioSongMember, meId: string | null): string {
  const name = member.userName || `User ${member.userId.slice(-4)}`;
  return member.userId === meId ? `${name} (you)` : name;
}

function statusLabel(session: SharedSession): string {
  if (session.status === 'connecting') return 'Opening…';
  if (session.status === 'offline') return session.pendingCount ? `Offline · ${session.pendingCount} edit${session.pendingCount === 1 ? '' : 's'} waiting` : 'Offline · reconnecting';
  const others = session.peers.length;
  return others ? `Live · ${others + 1} here` : 'Live · just you';
}

/**
 * Everything about who a song belongs to: save a browser song on the
 * server, see who is on it (and who is here right now), add or remove
 * people, leave, or pull a private copy back into this browser.
 */
export function StudioSharePanel({
  me,
  songName,
  session,
  busy,
  onShare,
  onLeave,
  onDelete,
  onLocalCopy,
  onAddMember,
  onRemoveMember,
  onClose
}: StudioSharePanelProps) {
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<Person[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  const isOwner = session?.role === 'owner';
  const memberIds = new Set(session?.members.map(m => m.userId) ?? []);

  useEffect(() => {
    if (!isOwner) return;
    const q = query.trim();
    if (!q) {
      setPeople([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      api
        .people(q)
        .then(result => {
          if (cancelled) return;
          setPeople(result.people.filter(p => !memberIds.has(p.id)).slice(0, 8));
        })
        .catch(() => {
          if (!cancelled) setPeople([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // memberIds is derived from session.members; re-run when the roster changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, isOwner, session?.members]);

  const add = async (userId: string, userName: string | null) => {
    setAdding(userId);
    setError(null);
    try {
      await onAddMember(userId, userName);
      setQuery('');
      setPeople([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that person.');
    } finally {
      setAdding(null);
    }
  };

  const remove = async (userId: string) => {
    setError(null);
    try {
      await onRemoveMember(userId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that person.');
    }
  };

  const trimmed = query.trim();
  const looksLikeId = ID_PATTERN.test(trimmed) && !people.some(p => p.id === trimmed) && !memberIds.has(trimmed);

  return (
    <div className="st-add-menu st-share-panel re-panel" data-testid="studio-share-panel">
      <div className="re-panel-head">
        <div>
          <h3>{session ? 'Shared song' : 'Share this song'}</h3>
          <p>
            {session
              ? 'Everyone on this song edits the same arrangement live. Playback stays local: each person presses Play in their own browser.'
              : 'Save the song on the server to work on it with other people in real time. It moves out of this browser’s storage and into your Shared list.'}
          </p>
        </div>
        <button type="button" className="re-secondary-btn st-tool-btn" onClick={onClose} aria-label="Close sharing panel">
          Close
        </button>
      </div>

      {!session ? (
        <div className="st-share-actions">
          <button type="button" className="re-play-btn" onClick={onShare} disabled={busy || !me} data-testid="studio-share-save">
            {busy ? 'Saving…' : `Save “${songName}” to the server`}
          </button>
          {!me ? <p className="stage-perf-flavor">Sign in to save songs on the server.</p> : null}
        </div>
      ) : (
        <>
          <div className="st-share-status" role="status">
            <span className={`re-status-dot${session.status === 'live' ? ' on' : ''}`} />
            <span className={session.status === 'live' ? 're-status-text on' : 're-status-text'}>{statusLabel(session)}</span>
            <span className="st-share-role">{isOwner ? 'You own this song' : 'You can edit this song'}</span>
          </div>

          <div className="st-share-members" data-testid="studio-share-members">
            <span className="re-micro-label">People on this song</span>
            <ul className="st-share-list">
              {session.members.map(member => {
                const here = member.userId === me?.id || session.peers.some(p => p.userId === member.userId);
                return (
                  <li key={member.userId} className="st-share-member">
                    <span
                      className={`st-peer-dot${here ? ' here' : ''}`}
                      style={{ background: `hsl(${peerColor(member.userId)} 70% 58%)` }}
                      title={here ? 'Here now' : 'Not here right now'}
                      aria-hidden
                    />
                    <span className="st-share-member-name">{memberLabel(member, me?.id ?? null)}</span>
                    <span className="st-share-member-role">{member.role === 'owner' ? 'owner' : here ? 'here' : 'away'}</span>
                    {isOwner && member.role !== 'owner' ? (
                      <button
                        type="button"
                        className="re-pill st-share-remove"
                        onClick={() => void remove(member.userId)}
                        title={`Remove ${member.userName || 'this person'} from the song`}
                      >
                        Remove
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>

          {isOwner ? (
            <div className="st-share-invite">
              <label className="re-micro-label" htmlFor="st-share-search">
                Add someone
              </label>
              <input
                id="st-share-search"
                className="re-select st-share-search"
                type="search"
                placeholder="Search friends and server-mates, or paste a user id"
                value={query}
                onChange={e => setQuery(e.target.value)}
                autoComplete="off"
              />
              {searching ? <p className="stage-perf-flavor">Searching…</p> : null}
              {people.length || looksLikeId ? (
                <ul className="st-share-list st-share-results">
                  {people.map(person => (
                    <li key={person.id} className="st-share-member">
                      <span
                        className="st-peer-dot"
                        style={{ background: `hsl(${peerColor(person.id)} 70% 58%)` }}
                        aria-hidden
                      />
                      <span className="st-share-member-name">{person.name}</span>
                      <span className="st-share-member-role">{person.source === 'friend' ? 'friend' : person.via || 'member'}</span>
                      <button
                        type="button"
                        className="re-pill"
                        onClick={() => void add(person.id, person.name)}
                        disabled={adding === person.id}
                      >
                        {adding === person.id ? 'Adding…' : 'Add'}
                      </button>
                    </li>
                  ))}
                  {looksLikeId ? (
                    <li className="st-share-member">
                      <span className="st-peer-dot" aria-hidden />
                      <span className="st-share-member-name">Add by id: {trimmed}</span>
                      <button
                        type="button"
                        className="re-pill"
                        onClick={() => void add(trimmed, null)}
                        disabled={adding === trimmed}
                        data-testid="studio-share-add-id"
                      >
                        {adding === trimmed ? 'Adding…' : 'Add'}
                      </button>
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p className="st-handoff-note error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="st-share-actions">
            <button type="button" className="re-secondary-btn st-tool-btn" onClick={onLocalCopy} title="Copy this song into this browser as a private, unshared song">
              Make a local copy
            </button>
            {isOwner ? (
              <button type="button" className="re-secondary-btn st-tool-btn st-danger" onClick={onDelete} disabled={busy}>
                Delete for everyone
              </button>
            ) : (
              <button type="button" className="re-secondary-btn st-tool-btn st-danger" onClick={onLeave} disabled={busy} data-testid="studio-share-leave">
                Leave this song
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
