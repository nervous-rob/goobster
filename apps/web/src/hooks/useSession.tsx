import { createContext, useCallback, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { keys } from '../lib/query';
import type { Me } from '../lib/types';
import { sessionKey } from '../lib/browserAccount';
import { NoAccountPage } from '../shell/NoAccountPage';

const SessionContext = createContext<Me | null>(null);

export function SessionProvider({ children, boundKey, onAccount }: {
    children: ReactNode; boundKey: string; onAccount: (me: Me | null) => void;
}) {
    const query = useQuery({
        queryKey: keys.me,
        queryFn: () => api.me(),
        retry: false,
        refetchInterval: 15_000
    });
    // A query with no data drops back to `pending` (error cleared) every time
    // the poll refetches it, which is the permanent state of a signed-out
    // visitor. Remember the last failure so a background poll neither flashes
    // the loading screen nor unmounts a half-filled sign-in or sign-up form.
    // It is scoped to the query client: a fresh client starts a fresh lookup.
    const client = useQueryClient();
    const lastError = useRef<{ client: QueryClient; error: ApiError | null }>({ client, error: null });
    if (lastError.current.client !== client) lastError.current = { client, error: null };
    if (query.data) lastError.current.error = null;
    else if (query.error) lastError.current.error = query.error as ApiError;
    const error = query.error ? (query.error as ApiError) : query.data ? null : lastError.current.error;
    const initialLoad = query.isPending && !error;
    const me = error ? null : query.data || null;
    const nextKey = sessionKey(me);
    const refetch = query.refetch;
    // The host let the person in: ask /me again right away instead of
    // waiting for the next poll.
    const onApproved = useCallback(() => { void refetch(); }, [refetch]);
    useLayoutEffect(() => {
        if (!initialLoad && nextKey !== boundKey) onAccount(me);
    }, [boundKey, nextKey, me, onAccount, initialLoad]);
    if (nextKey !== boundKey) return null;
    if (initialLoad) {
        return <div className="login"><div className="empty">Looking around…</div></div>;
    }
    if (error && error.status === 403) {
        return <NoAccountPage error={error} onApproved={onApproved} />;
    }
    if (error && error.status !== 401) {
        return <div className="login"><div className="empty">{error.message}</div></div>;
    }
    return (
        <SessionContext.Provider value={me}>
            {children}
        </SessionContext.Provider>
    );
}

export function useSession(): Me | null {
    return useContext(SessionContext);
}

export function useMe(): Me {
    const me = useSession();
    if (!me) throw new Error('useMe requires an authenticated session');
    return me;
}
