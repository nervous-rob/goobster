import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useMe } from '../hooks/useSession';
import { ROOM_BY_ID, resolveActivityView } from '../lib/rooms';

/**
 * Activity: one destination for what happened and what needs you, kept as
 * three views with their own state and actions. Inbox is durable delivery
 * (read/unread, archive); Attention is proactive notices (why, acknowledge,
 * snooze, watches); Scheduled is reminders and recurring AI tasks. The
 * existing rooms render unchanged underneath this strip - nothing is
 * merged into one list. A notice that was also delivered to the Inbox is
 * named from both views; the badge on this strip and in the sidebar is
 * the Inbox's unread count alone.
 */
export function ActivityRoom() {
    const me = useMe();
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const current = resolveActivityView(pathname);
    const views = ROOM_BY_ID.activity.views || [];
    const unread = me.inbox?.unread || 0;

    return (
        <div className="activity-shell" id="pane-activity">
            <nav className="activity-tabs" aria-label="Activity views">
                {views.map((view) => (
                    <Link key={view.id} to={view.path as never}
                        className={`activity-tab${current === view.id ? ' active' : ''}`}
                        aria-current={current === view.id ? 'page' : undefined}
                        data-tour={`activity-tab-${view.id}`}>
                        <span aria-hidden="true">{view.icon}</span> {view.name}
                        {view.secondaryName && <span className="activity-tab-secondary">{view.secondaryName}</span>}
                        {view.id === 'inbox' && unread > 0 && (
                            <span className="nav-count" aria-label={`${unread} unread`}>{unread > 99 ? '99+' : unread}</span>
                        )}
                    </Link>
                ))}
            </nav>
            <Outlet />
        </div>
    );
}
