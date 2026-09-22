import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useMe } from '../../hooks/useSession';
import { useOpenSettings } from '../../hooks/useOpenSettings';
import { ROOM_BY_ID, resolveKnowledgeView } from '../../lib/rooms';
import { MenuButton } from '../../shell/MenuButton';
import { KnowledgeScopeProvider, useKnowledgeScope } from './scope';

/**
 * Knowledge (Spitball): the things a person keeps. One destination with
 * three registered views - Notes (the landing), Map (the same notes drawn
 * as a graph with typed connections and shared tags) and Research
 * (expeditions). The scope select and the Personal-memory shortcut live in
 * the shell so every view shares them. What Goobster distilled about you
 * (About you / Facts / Memories) is managed from Settings → Memory &
 * privacy; the shortcut here is how you get there without losing the room.
 */
export function KnowledgeRoom() {
    return (
        <KnowledgeScopeProvider>
            <KnowledgeShell />
        </KnowledgeScopeProvider>
    );
}

function KnowledgeShell() {
    const me = useMe();
    const openSettings = useOpenSettings();
    const { scopes, scopeId, setScopeId } = useKnowledgeScope();
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const current = resolveKnowledgeView(pathname) || 'notes';
    const views = (ROOM_BY_ID.knowledge.views || []).filter((view) => (
        view.id !== 'research' || Boolean(me.features?.spitball)
    ));

    return (
        <main className="pane next-pane is-in" id="pane-library">
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1>Knowledge <span className="room-secondary">Spitball</span></h1>
                </div>
                <div className="pane-header-actions">
                    <select className="select" value={scopeId} onChange={(e) => setScopeId(e.target.value)} aria-label="Scope" data-tour="knowledge-scope">
                        {scopes.map((item) => (
                            <option key={item.id} value={item.id}>
                                {item.kind === 'dm' ? `🔒 ${item.name}` : item.name}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        className="btn small"
                        data-tour="knowledge-personal-memory"
                        title="What Goobster knows about you - facts and memories - lives in Settings → Memory & privacy"
                        onClick={() => openSettings('memory', 'memory-report')}
                    >
                        🧠 Personal memory
                    </button>
                </div>
            </header>
            <nav className="view-tabs" aria-label="Knowledge views">
                {views.map((view) => (
                    <Link key={view.id} to={view.path as never}
                        className={`view-tab${current === view.id ? ' active' : ''}`}
                        aria-current={current === view.id ? 'page' : undefined}
                        data-tour={`knowledge-view-${view.id}`}>
                        <span aria-hidden="true">{view.icon}</span> {view.name}
                        {view.secondaryName && <span className="view-tab-secondary">{view.secondaryName}</span>}
                    </Link>
                ))}
            </nav>
            <Outlet />
        </main>
    );
}
