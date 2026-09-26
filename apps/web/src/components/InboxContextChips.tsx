import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useToast } from '../hooks/useToast';

export function useInboxContext(kind: 'chat' | 'project', conversationId: number | null) {
    return useQuery({ queryKey: ['inbox-context', kind, conversationId], queryFn: () => api.conversationContext(kind, conversationId!), enabled: conversationId != null, retry: false });
}

export function InboxContextChips({ kind, conversationId, disabled = false }: {
    kind: 'chat' | 'project'; conversationId: number | null; disabled?: boolean;
}) {
    const queryClient = useQueryClient();
    const toast = useToast();
    const queryKey = ['inbox-context', kind, conversationId];
    const query = useInboxContext(kind, conversationId);
    const contexts = query.data?.contexts || [];
    if (conversationId != null && query.isError) return <div className="inbox-context hint" role="alert">
        Could not load Inbox context. <button type="button" className="btn subtle" onClick={() => void query.refetch()}>Retry</button>
    </div>;
    if (!contexts.length) return null;
    return <div className="inbox-context" aria-label="Inbox context">
        {contexts.map(context => <div key={context.id} className="inbox-context-chip">
            <Link to="/activity/inbox" hash={`inbox-${context.itemId}`}>{context.title}</Link>
            <button type="button" className="btn subtle" disabled={disabled} aria-label={`Remove context: ${context.title}`}
                onClick={async () => {
                    try {
                        await api.removeConversationContext(kind, conversationId!, context.id);
                        await queryClient.invalidateQueries({ queryKey });
                        await queryClient.invalidateQueries({ queryKey: ['inbox'] });
                    } catch (error) { toast((error as Error).message, true); }
                }}>✕</button>
        </div>)}
        <div className="hint">{kind === 'project'
            ? 'Your Inbox context is included when you send. Replies here are visible to project members.'
            : 'This Inbox item is included when you send. Remove it to ask without this context.'}</div>
    </div>;
}
