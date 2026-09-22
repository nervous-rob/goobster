import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useMe } from '../../hooks/useSession';
import type { Scope } from '../../lib/types';

/**
 * The scope (your private space, or a server you share with Goobster) that
 * every Knowledge view reads. It lives in the room shell so switching
 * between Notes, Map and Research keeps the same scope; view components
 * read it through `useKnowledgeScope()` instead of prop-drilling.
 */
export type KnowledgeScope = {
    scopes: Scope[];
    scopeId: string;
    scope: Scope | null;
    setScopeId: (id: string) => void;
};

const KnowledgeScopeContext = createContext<KnowledgeScope | null>(null);

export function KnowledgeScopeProvider({ children }: { children: ReactNode }) {
    const me = useMe();
    const scopes = me.scopes || [];
    const [scopeId, setScopeId] = useState(scopes[0]?.id || '');
    const value = useMemo<KnowledgeScope>(() => {
        const scope = scopes.find((item) => item.id === scopeId) || scopes[0] || null;
        return { scopes, scopeId: scope?.id || scopeId, scope, setScopeId };
    }, [scopes, scopeId]);
    return <KnowledgeScopeContext.Provider value={value}>{children}</KnowledgeScopeContext.Provider>;
}

export function useKnowledgeScope(): KnowledgeScope {
    const value = useContext(KnowledgeScopeContext);
    if (!value) throw new Error('useKnowledgeScope must be used inside KnowledgeRoom');
    return value;
}

/** "your private space" / "in <Server>" - how a view names where it is looking. */
export function scopeNoun(scope: Scope | null): string {
    if (!scope) return 'this scope';
    return scope.kind === 'dm' ? 'your private space' : scope.name;
}
