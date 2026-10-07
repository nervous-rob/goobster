import { ExpeditionsTab } from '../../components/Expeditions';
import { useMe } from '../../hooks/useSession';
import { ROOM_BY_ID, viewUnavailability } from '../../lib/rooms';
import { UnavailableNotice } from '../../shell/UnavailableState';

/**
 * Knowledge → Research (Expeditions): autonomous research runs that write
 * their notes into your knowledge with claim → source evidence. Nested
 * under Knowledge because its output *is* notes; kept as its own view
 * because a run has state (cycles, leads, sources) a list of notes does
 * not. Notes it produced show up in Notes and on the Map as `kept`.
 */
export function ResearchView() {
    const me = useMe();
    const research = ROOM_BY_ID.knowledge.views?.find((view) => view.id === 'research');
    const blocked = research ? viewUnavailability(ROOM_BY_ID.knowledge, research, me) : null;
    if (blocked && blocked.kind === 'feature') {
        return (
            <div className="pane-body" data-tour="knowledge-research">
                <UnavailableNotice info={blocked} back={{ to: '/knowledge/notes', label: 'Back to Notes' }} />
            </div>
        );
    }
    return (
        <div className="pane-body" data-tour="knowledge-research">
            <ExpeditionsTab />
        </div>
    );
}
