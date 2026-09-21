import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { pastedPrincipalId } from '../../lib/people';
import { Modal } from '../../components/Modal';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';

type Member = { userId: string; userName?: string | null; joinedAt?: string };
type PendingInvite = { id: number; inviteeId: string; inviteeName?: string | null };
type Roster = {
    ownerId: string;
    role: 'owner' | 'member';
    maxMembers: number;
    members: Member[];
    invites: PendingInvite[];
};
type Person = { id: string; name: string; avatar?: string | null; source: 'friend' | 'server' | 'member'; via?: string | null };
type Invitable = { people: Person[]; friendsSynced: boolean; syncedAt: string | null };

/**
 * The people of one discussion: the host, the accepted members (with
 * remove/leave), the pending invitations (owner can withdraw), and - for
 * the owner - the invite picker sourced from their Discord friends and
 * the people they share a server with.
 */
export function PeopleModal({
    conversationId, meId, onClose, onLeft
}: {
    conversationId: number;
    meId: string;
    onClose: () => void;
    onLeft: () => void;
}) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const rosterQ = useQuery({
        queryKey: keys.parlorMembers(conversationId),
        queryFn: () => api.parlorMembers(conversationId) as Promise<Roster>
    });
    const roster = rosterQ.data;
    const isOwner = roster?.role === 'owner';

    async function refresh() {
        await queryClient.invalidateQueries({ queryKey: keys.parlorMembers(conversationId) });
        await queryClient.invalidateQueries({ queryKey: ['parlor-invitable', conversationId] });
        await queryClient.invalidateQueries({ queryKey: keys.parlorConversations });
    }

    async function removeMember(member: Member) {
        const isMe = member.userId === meId;
        if (isMe && !await confirm('Leave this discussion? The host can invite you back later.')) return;
        try {
            await api.parlorRemoveMember(conversationId, member.userId);
            if (isMe) {
                toast('You left the discussion.');
                onLeft();
                return;
            }
            await refresh();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function revokeInvite(invite: PendingInvite) {
        try {
            await api.parlorRevokeInvite(invite.id);
            await refresh();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    return (
        <Modal onClose={onClose} className="parlor-modal">
            <h2>People in this discussion</h2>
            {rosterQ.isPending && <div className="hint">Loading…</div>}
            {rosterQ.isError && <div className="hint">{(rosterQ.error as Error).message}</div>}
            {roster && (
                <>
                    <div className="member-list">
                        <div className="member-item">
                            <span className="member-name">{isOwner ? 'You' : `User ${roster.ownerId}`}</span>
                            <span className="member-role">host</span>
                        </div>
                        {roster.members.map((member) => {
                            const isMe = member.userId === meId;
                            return (
                                <div key={member.userId} className="member-item">
                                    <span className="member-name">{isMe ? 'You' : (member.userName || `User ${member.userId}`)}</span>
                                    {(isOwner || isMe) && (
                                        <button
                                            type="button"
                                            className="conv-action"
                                            title={isMe ? 'Leave this discussion' : 'Remove from this discussion'}
                                            onClick={() => void removeMember(member)}
                                        >✕</button>
                                    )}
                                </div>
                            );
                        })}
                        {roster.invites.map((invite) => (
                            <div key={invite.id} className="member-item pending">
                                <span className="member-name">{invite.inviteeName || `User ${invite.inviteeId}`}</span>
                                <span className="member-role">invited</span>
                                <button
                                    type="button"
                                    className="conv-action"
                                    title="Withdraw invitation"
                                    onClick={() => void revokeInvite(invite)}
                                >✕</button>
                            </div>
                        ))}
                    </div>
                    {isOwner && <InvitePicker conversationId={conversationId} onInvited={refresh} />}
                </>
            )}
        </Modal>
    );
}

/**
 * Pick a person instead of pasting a snowflake: Discord friends first
 * (synced by the Activity), then the people this user shares a server
 * with. Typing a raw user id still works, so an invite is always
 * possible even when neither source has anyone.
 */
function InvitePicker({ conversationId, onInvited }: { conversationId: number; onInvited: () => Promise<void> }) {
    const toast = useToast();
    const [query, setQuery] = useState('');
    const [debounced, setDebounced] = useState('');
    useEffect(() => {
        const timer = setTimeout(() => setDebounced(query.trim()), 220);
        return () => clearTimeout(timer);
    }, [query]);

    const invitableQ = useQuery({
        queryKey: ['parlor-invitable', conversationId, debounced],
        queryFn: () => api.parlorInvitable(conversationId, debounced) as Promise<Invitable>,
        staleTime: 10_000
    });
    const people = invitableQ.data?.people || [];
    // An exact Discord or native id also works without a search result.
    const rawId = pastedPrincipalId(debounced);
    const rawKnown = rawId !== null && people.some((person) => person.id === rawId);

    async function invite(userId: string, label: string | null) {
        try {
            const result = await api.parlorInvite(conversationId, userId) as { dmSent?: boolean; inviteeName?: string | null };
            const who = result.inviteeName || label || `user ${userId}`;
            toast(result.dmSent
                ? `Invitation sent to ${who} by DM.`
                : `Invitation created for ${who} — it is in their Inbox.`);
            setQuery('');
            await onInvited();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    return (
        <div className="invite-form">
            <div className="panel-section-head"><span>Invite someone</span></div>
            <input
                className="input"
                placeholder="Search people by name, or paste a user id"
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
            />
            <div className="people-list">
                {invitableQ.isPending && <div className="hint">Loading…</div>}
                {invitableQ.isError && <div className="hint">{(invitableQ.error as Error).message}</div>}
                {rawId && !rawKnown && (
                    <div
                        role="button"
                        tabIndex={0}
                        className="person-item"
                        onClick={() => void invite(rawId, null)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                void invite(rawId, null);
                            }
                        }}
                    >
                        <span className="person-avatar">＋</span>
                        <span className="person-body">
                            <span className="person-name">Invite user {rawId}</span>
                            <span className="hint">by {rawId.startsWith('usr_') ? 'account' : 'Discord user'} id</span>
                        </span>
                    </div>
                )}
                {people.map((person) => (
                    <div
                        key={person.id}
                        role="button"
                        tabIndex={0}
                        className="person-item"
                        onClick={() => void invite(person.id, person.name)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                void invite(person.id, person.name);
                            }
                        }}
                    >
                        {person.avatar
                            ? <img className="person-avatar" src={person.avatar} alt="" />
                            : <span className="person-avatar">🙂</span>}
                        <span className="person-body">
                            <span className="person-name">{person.name}</span>
                            <span className="hint">
                                {person.source === 'friend' ? 'Discord friend'
                                    : person.source === 'member' ? `member of ${person.via || 'this installation'}`
                                        : `shares ${person.via || 'a server'}`}
                            </span>
                        </span>
                        {person.source === 'friend' && <span className="person-badge">friend</span>}
                        {person.source === 'member' && <span className="person-badge">member</span>}
                    </div>
                ))}
                {!invitableQ.isPending && !invitableQ.isError && people.length === 0 && !rawId && (
                    <div className="hint">
                        {debounced
                            ? 'Nobody matches that - try the start of their name, or paste their user id.'
                            : (invitableQ.data?.friendsSynced
                                ? 'Everyone you know is already here - type a name to find other members.'
                                : 'Type the start of a name to find members here. Discord friends appear once Goobster\'s Activity has synced them.')}
                    </div>
                )}
            </div>
        </div>
    );
}
