import { QueryClient } from '@tanstack/react-query';
import { queryKeysForInvalidation } from './parseSse.js';

export const keys = {
    me: ['me'] as const,
    config: ['config'] as const,
    home: ['home'] as const,
    conversations: ['conversations'] as const,
    history: (id: number | string | null) => ['history', id] as const,
    tasks: ['tasks'] as const,
    usage: (days: number) => ['usage', days] as const,
    applets: ['applets'] as const,
    parlorConversations: ['parlor-conversations'] as const,
    parlorPersonas: ['parlor-personas'] as const,
    parlorInvites: ['parlor-invites'] as const,
    observatory: ['observatory'] as const,
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
