import { Link } from '@tanstack/react-router';
import { ExpeditionsTab } from '../../components/Expeditions';
import { useMe } from '../../hooks/useSession';

/**
 * Knowledge → Research (Expeditions): autonomous research runs that write
 * their notes into your knowledge with claim → source evidence. Nested
 * under Knowledge because its output *is* notes; kept as its own view
 * because a run has state (cycles, leads, sources) a list of notes does
 * not. Notes it produced show up in Notes and on the Map as `kept`.
 */
export function ResearchView() {
    const me = useMe();
    if (!me.features?.spitball) {
        return (
            <div className="pane-body" data-tour="knowledge-research">
                <div className="empty">
                    Research expeditions are not enabled on this installation.{' '}
                    <Link to="/knowledge/notes">Back to Notes</Link>
                </div>
            </div>
        );
    }
    return (
        <div className="pane-body" data-tour="knowledge-research">
            <ExpeditionsTab />
        </div>
    );
}
