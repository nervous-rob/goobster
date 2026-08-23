import { QueryClient } from '@tanstack/react-query';
import { queryKeysForInvalidation } from './parseSse.js';

export const keys = {
    me: ['me'] as const,
    config: ['config'] as const,
    home: ['home'] as const,
    conversations: ['conversations'] as const,
    history: (id: number | string | null) => ['history', id] as const,
    tasks: ['tasks'] as const,
    attention: ['attention'] as const,
    usage: (days: number) => ['usage', days] as const,
    applets: ['applets'] as const,
    parlorConversations: ['parlor-conversations'] as const,
    parlorPersonas: ['parlor-personas'] as const,
    parlorInvites: ['parlor-invites'] as const,
    parlorMembers: (id: number) => ['parlor-members', id] as const,
    friends: ['friends'] as const,
    observatory: ['observatory'] as const,
    spitball: ['spitball'] as const,
    spitballExpedition: (id: number | string) => ['spitball', String(id)] as const,
    spitballClaims: (id: number | string) => ['spitball', String(id), 'claims'] as const,
    spitballNoteEvidence: (nodeId: number | string) => ['spitball-evidence', String(nodeId)] as const,
    spitballNotes: (scope: string, filters: Record<string, string> = {}) =>
        ['spitball-notes', scope, filters] as const,
    spitballNotesRoot: (scope: string) => ['spitball-notes', scope] as const,
    spitballLenses: ['spitball-lenses'] as const,
    mtga: ['mtga'] as const,
    memory: (scope: string, tab: string) => ['memory', scope, tab] as const
};

export function createQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 15_000,
                retry: (count, error) => {
                    const status = (error as { status?: number })?.status;
                    if (status === 401 || status === 403) return false;
                    return count < 1;
                }
            }
        }
    });
}

export const queryClient = createQueryClient();

export function applyInvalidation(client: QueryClient, hints: string[] | undefined): void {
    for (const key of queryKeysForInvalidation(hints)) {
        client.invalidateQueries({ queryKey: key });
    }
}
