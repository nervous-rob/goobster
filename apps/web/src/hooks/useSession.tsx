import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { keys } from '../lib/query';
import type { Me } from '../lib/types';
import { sessionKey } from '../lib/browserAccount';

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
    const me = query.error ? null : query.data || null;
    const nextKey = sessionKey(me);
    useLayoutEffect(() => {
        if (!query.isPending && nextKey !== boundKey) onAccount(me);
    }, [boundKey, nextKey, me, onAccount, query.isPending]);
    if (nextKey !== boundKey) return null;
    if (query.isPending) {
        return <div className="login"><div className="empty">Looking around…</div></div>;
    }
    if (query.error && (query.error as ApiError).status !== 401) {
        return <div className="login"><div className="empty">{(query.error as Error).message}</div></div>;
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
