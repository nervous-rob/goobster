import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';

type Friend = { id: string; name: string; avatar?: string | null; online?: boolean };

/**
 * The sidebar's active-friends menu: which of the user's Discord friends
 * are in the Goobster portal right now (the `online` flag on
 * GET /api/app/friends, derived from live web sessions). The poll doubles
 * as this user's own presence heartbeat - every authenticated request
 * touches their session - and pauses in background tabs, which is exactly
 * the "active" semantic we want. Renders nothing until a friend roster has
 * been synced (the Activity is the collector).
 */
export function ActiveFriends() {
    const friendsQ = useQuery({
        queryKey: keys.friends,
        queryFn: () => api.friends() as Promise<{ friends: Friend[]; syncedAt: string | null }>,
        refetchInterval: 60_000
    });
    const friends = friendsQ.data?.friends || [];
    if (friendsQ.isError || friends.length === 0) return null;
    const online = friends.filter((friend) => friend.online);
    return (
        <div className="active-friends" aria-label="Friends online">
            <div className="nav-section">Friends online{online.length > 0 ? ` · ${online.length}` : ''}</div>
            {online.length === 0 && (
                <div className="hint active-friends-empty">Nobody right now</div>
            )}
            {online.map((friend) => (
                <div key={friend.id} className="active-friend" title={`${friend.name} is in the portal`}>
                    {friend.avatar
                        ? <img className="person-avatar" src={friend.avatar} alt="" />
                        : <span className="person-avatar">🙂</span>}
                    <span className="person-name">{friend.name}</span>
                    <span className="presence-dot online" aria-label="online" />
                </div>
            ))}
        </div>
    );
}
