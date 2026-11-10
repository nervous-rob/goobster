import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { applyInvalidation } from '../lib/query';
import { sessionChanged } from '../lib/browserAccount';

const KINDS = [
    'hello', 'followup-delivered', 'automation-ran', 'agent-run-updated',
    'attention-noticed', 'inbox', 'web-turn',
    'parlor-turn', 'parlor-invite', 'parlor-members', 'parlor-mention',
    'project-changed', 'project-invite', 'project-members', 'settings-changed',
    'friends', 'dm-message',
    // Delegated work changed (kinds and refetch hints only): Home and the
    // Responsibilities page read their state again.
    'assistant'
];

/**
 * What is read again after the stream reconnects: whatever changed while it
 * was down sent no event, so Home, the Responsibilities page and the Inbox
 * are refetched instead of waiting for the next change.
 */
const AFTER_RECONNECT = ['home', 'assistant-responsibilities', 'assistant-initiatives', 'assistant-processes', 'inbox'];

export type InboxEvent = {
    itemId?: number;
    kind?: string;
};

export type ParlorMentionEvent = {
    conversationId?: number;
    messageId?: number | null;
    fromName?: string | null;
    title?: string | null;
};

/** One EventSource for the portal. Maps invalidate hints into the query cache. */
export function usePortalEvents(enabled: boolean): void {
    const client = useQueryClient();
    useEffect(() => {
        if (!enabled) return;
        const source = new EventSource('/api/app/events');
        let hellos = 0;
        const revoked = () => { source.close(); sessionChanged(); };
        source.addEventListener('session-revoked', revoked);
        source.onerror = () => { void client.invalidateQueries({ queryKey: ['me'] }); };
        // The server greets every (re)connection. The first greeting is the
        // page load, which has just fetched; a later one is a reconnect.
        const onHello = () => {
            hellos += 1;
            if (hellos > 1) applyInvalidation(client, AFTER_RECONNECT);
        };
        source.addEventListener('hello', onHello);
        const onEvent = (event: MessageEvent) => {
            let data: { invalidate?: string[] } = {};
            try { data = JSON.parse(event.data); } catch { return; }
            applyInvalidation(client, data.invalidate);
            // A human @-mentioned this user in a shared parlor discussion:
            // surface it anywhere in the portal (AppShell renders the notice).
            if (event.type === 'parlor-mention') {
                window.dispatchEvent(new CustomEvent<ParlorMentionEvent>(
                    'goobster-parlor-mention', { detail: data as ParlorMentionEvent }
                ));
            }
            if (event.type === 'attention-noticed') {
                window.dispatchEvent(new CustomEvent('goobster-attention-noticed', { detail: data }));
            }
            // A new inbox item arrived (delivered, not read/archived): the
            // shell shows a notice that deep-links to the Inbox.
            if (event.type === 'inbox' && (data as InboxEvent).kind) {
                window.dispatchEvent(new CustomEvent<InboxEvent>('goobster-inbox', { detail: data as InboxEvent }));
            }
        };
        for (const kind of KINDS) source.addEventListener(kind, onEvent as EventListener);
        return () => {
            for (const kind of KINDS) source.removeEventListener(kind, onEvent as EventListener);
            source.removeEventListener('hello', onHello);
            source.close();
        };
    }, [client, enabled]);
}
