import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useSession } from '../hooks/useSession';

/**
 * The sidebar's active-friends menu: which of the user's friends are in the
 * Goobster portal right now (the `online` flag on GET /api/app/friends,
 * derived from live web sessions and each friend's own visibility setting).
 * The poll doubles as this user's own presence heartbeat - every
 * authenticated request touches their session - and pauses in background
 * tabs, which is exactly the "active" semantic we want. Renders nothing
 * until the person has a friend (documentation/friends_and_messages.md).
 */
export function ActiveFriends() {
    const me = useSession();
    const friendsQ = useQuery({
        queryKey: keys.friends,
        queryFn: () => api.friends(),
        // Public share pages render this shell with no session; a signed-out
        // 401 would reset the whole browser session on every poll.
        enabled: Boolean(me),
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
                <Link key={friend.id} to="/people/friends" className="active-friend" title={`${friend.name} is in the portal`}>
                    {friend.avatar
                        ? <img className="person-avatar" src={friend.avatar} alt="" />
                        : <span className="person-avatar">🙂</span>}
                    <span className="person-name">{friend.name}</span>
                    <span className="presence-dot online" aria-label="online" />
                </Link>
            ))}
        </div>
    );
}
