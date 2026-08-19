import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { keys } from '../lib/query';
import type { Me } from '../lib/types';

const SessionContext = createContext<Me | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
    const query = useQuery({
        queryKey: keys.me,
        queryFn: () => api.me(),
        retry: false
    });
    if (query.isPending) {
        return <div className="login"><div className="empty">Looking around…</div></div>;
    }
    if (query.error && (query.error as ApiError).status !== 401) {
        return <div className="login"><div className="empty">{(query.error as Error).message}</div></div>;
    }
    return (
        <SessionContext.Provider value={query.data || null}>
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
