import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { applyInvalidation } from '../lib/query';

const KINDS = [
    'hello', 'followup-delivered', 'automation-ran', 'agent-run-updated',
    'attention-noticed', 'web-turn',
    'parlor-turn', 'parlor-invite', 'parlor-members', 'parlor-mention',
    'project-changed'
];

export type ParlorMentionEvent = {
    conversationId?: number;
    fromName?: string | null;
    title?: string | null;
};

/** One EventSource for the portal. Maps invalidate hints into the query cache. */
export function usePortalEvents(enabled: boolean): void {
    const client = useQueryClient();
    useEffect(() => {
        if (!enabled) return;
        const source = new EventSource('/api/app/events');
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
        };
        for (const kind of KINDS) source.addEventListener(kind, onEvent as EventListener);
        return () => {
            for (const kind of KINDS) source.removeEventListener(kind, onEvent as EventListener);
            source.close();
        };
    }, [client, enabled]);
}
