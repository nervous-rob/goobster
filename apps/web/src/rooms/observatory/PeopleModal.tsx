import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { Modal } from '../../components/Modal';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';

type Member = { userId: string; userName?: string | null; joinedAt?: string };
type PendingInvite = { id: number; inviteeId: string; inviteeName?: string | null };
type Roster = {
    ownerId: string;
    ownerName?: string | null;
    role: 'owner' | 'collaborator';
    maxMembers: number;
    members: Member[];
    invites: PendingInvite[];
};
type Person = { id: string; name: string; avatar?: string | null; source: 'friend' | 'server'; via?: string | null };
type Invitable = { people: Person[]; friendsSynced: boolean; syncedAt: string | null };

/**
 * People of one project: the owner, accepted collaborators (remove/leave),
 * pending invitations (owner can withdraw), and — for the owner — the
 * invite picker sourced from Discord friends and shared servers.
 */
export function ProjectPeopleModal({
    slug, ownerId, meId, onClose, onLeft
}: {
    slug: string;
    ownerId?: string | null;
    meId: string;
    onClose: () => void;
    onLeft: () => void;
}) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const rosterQ = useQuery({
        queryKey: keys.projectMembers(slug, ownerId),
        queryFn: () => api.projectMembers(slug, ownerId) as Promise<Roster>
    });
    const roster = rosterQ.data;
    const isOwner = roster?.role === 'owner';

    async function refresh() {
        await queryClient.invalidateQueries({ queryKey: keys.projectMembers(slug, ownerId) });
        await queryClient.invalidateQueries({ queryKey: ['project-invitable', slug, ownerId] });
        await queryClient.invalidateQueries({ queryKey: keys.observatory });
        await queryClient.invalidateQueries({ queryKey: keys.projectInvites });
    }

    async function removeMember(member: Member) {
        const isMe = member.userId === meId;
        if (isMe && !await confirm('Leave this project? The owner can invite you back later.')) return;
        try {
            await api.projectRemoveMember(slug, member.userId, ownerId);
            if (isMe) {
                toast('You left the project.');
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
            await api.projectRevokeInvite(invite.id);
            await refresh();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    return (
        <Modal onClose={onClose} className="parlor-modal">
            <h2>People on this project</h2>
            {rosterQ.isPending && <div className="hint">Loading…</div>}
            {rosterQ.isError && <div className="hint">{(rosterQ.error as Error).message}</div>}
            {roster && (
                <>
                    <div className="hint" style={{ marginBottom: 8 }}>
                        {roster.members.length}/{roster.maxMembers} collaborators
                    </div>
                    <div className="member-list">
                        <div className="member-item">
                            <span className="member-name">
                                {isOwner ? 'You' : (roster.ownerName || `User ${roster.ownerId}`)}
                            </span>
                            <span className="member-role">owner</span>
                        </div>
                        {roster.members.map((member) => {
                            const isMe = member.userId === meId;
                            return (
                                <div key={member.userId} className="member-item">
                                    <span className="member-name">
                                        {isMe ? 'You' : (member.userName || `User ${member.userId}`)}
                                    </span>
                                    {(isOwner || isMe) && (
                                        <button
                                            type="button"
                                            className="conv-action"
                                            title={isMe ? 'Leave this project' : 'Remove from this project'}
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
                    {isOwner && (
                        <InvitePicker slug={slug} ownerId={ownerId} onInvited={refresh} />
                    )}
                </>
            )}
        </Modal>
    );
}

function InvitePicker({
    slug, ownerId, onInvited
}: {
    slug: string;
    ownerId?: string | null;
    onInvited: () => Promise<void>;
}) {
    const toast = useToast();
    const [query, setQuery] = useState('');
    const [debounced, setDebounced] = useState('');
    useEffect(() => {
        const timer = setTimeout(() => setDebounced(query.trim()), 220);
        return () => clearTimeout(timer);
    }, [query]);

    const invitableQ = useQuery({
        queryKey: ['project-invitable', slug, ownerId, debounced],
        queryFn: () => api.projectInvitable(slug, debounced, ownerId) as Promise<Invitable>,
        staleTime: 10_000
    });
    const people = invitableQ.data?.people || [];
    const rawId = /^\d{5,20}$/.test(debounced) ? debounced : null;
    const rawKnown = rawId !== null && people.some((person) => person.id === rawId);

    async function invite(userId: string, label: string | null) {
        try {
            const result = await api.projectInvite(slug, userId, ownerId) as {
                dmSent?: boolean; inviteeName?: string | null;
            };
            const who = result.inviteeName || label || `user ${userId}`;
            toast(result.dmSent
                ? `Invitation sent to ${who} by DM.`
                : `Invitation created for ${who} — their DMs are closed, but it shows in their web app.`);
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
                placeholder="Search your friends and servers, or paste a user id"
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
                            <span className="hint">by Discord user id</span>
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
                            <span className="hint">{person.source === 'friend' ? 'Discord friend' : `shares ${person.via || 'a server'}`}</span>
                        </span>
                        {person.source === 'friend' && <span className="person-badge">friend</span>}
                    </div>
                ))}
                {!invitableQ.isPending && !invitableQ.isError && people.length === 0 && !rawId && (
                    <div className="hint">
                        {debounced
                            ? 'Nobody matches that — you can also paste their Discord user id.'
                            : (invitableQ.data?.friendsSynced
                                ? 'Everyone you know is already here.'
                                : 'No friends synced yet — open Goobster\'s Activity in Discord to bring your friend list over, or paste a Discord user id.')}
                    </div>
                )}
            </div>
        </div>
    );
}
