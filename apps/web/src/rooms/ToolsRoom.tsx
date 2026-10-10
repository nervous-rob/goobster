import { Link } from '@tanstack/react-router';
import { RoomIcon } from '../icons/Icon';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useMe } from '../hooks/useSession';
import { useToast } from '../hooks/useToast';
import { useApplySectionResult } from '../hooks/useUserSettings';
import { MenuButton } from '../shell/MenuButton';
import { TOOL_ROOMS, toolCards } from '../lib/rooms';
import { FeatureDocLink } from '../shell/UnavailableState';

/**
 * Tools: the optional specialist rooms (Music Lab, Trading game, Card decks)
 * behind one primary destination. Three states stay distinct:
 *
 * - Host-unavailable (a feature the installation has not made available:
 *   Discord off, Exchange off, Music off, ...): a card that is not a link,
 *   says so, says why from the server's reason, and points at the doc.
 * - Hidden by this account (`appearance.hiddenToolRooms`): gone from this
 *   grid and from navigation, with an unhide control that is not that card.
 * - A direct URL still opens a hidden tool. A preference is not a permission,
 *   and hiding does not change the reason a host-unavailable card shows.
 */
export function ToolsRoom() {
    const me = useMe();
    const toast = useToast();
    const applySection = useApplySectionResult();
    const settingsQ = useQuery({
        queryKey: keys.settings,
        queryFn: () => api.settings()
    });
    const appearance = settingsQ.data?.sections.appearance;
    const hidden = appearance?.values.hiddenToolRooms ?? [];
    const cards = toolCards(hidden, me);
    const hiddenRooms = TOOL_ROOMS.filter((tool) => hidden.includes(tool.id));

    async function setHidden(next: string[]) {
        if (!appearance) return;
        try {
            const result = await api.updateSettingsSection('appearance', {
                expectedRevision: appearance.revision,
                changes: { hiddenToolRooms: next }
            });
            applySection(result);
        } catch (error) {
            toast((error as Error).message, true);
            void settingsQ.refetch();
        }
    }

    return (
        <main className="pane next-pane is-in" id="pane-tools">
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1>Tools</h1>
                </div>
            </header>
            <div className="pane-body">
                <p className="hint tools-intro">
                    Optional rooms that sit beside the core workspace. They never change what Chat, Knowledge, or Projects do.
                </p>
                <nav className="tools-grid" aria-label="Tools">
                    {cards.map(({ room: tool, available, unavailable }) => {
                        const body = (
                            <>
                                <div className="tools-card-head">
                                    <span className="tools-card-icon" aria-hidden="true"><RoomIcon room={tool} /></span>
                                    <div>
                                        <div className="tools-card-title">{tool.name}</div>
                                        {tool.secondaryName && <div className="hint tools-card-secondary">{tool.secondaryName}</div>}
                                    </div>
                                </div>
                                <p className="tools-card-blurb">{tool.blurb}</p>
                                {available
                                    ? <div className="home-card-action">Open {tool.name} →</div>
                                    : (
                                        <div className="tools-card-unavailable" role="note" data-testid="tool-unavailable">
                                            <strong className="tools-card-unavailable-label">Not available on this installation</strong>
                                            <span>{unavailable?.sentence}</span>
                                        </div>
                                    )}
                            </>
                        );
                        return (
                            <div key={tool.id} className={`home-card tools-card${available ? '' : ' is-unavailable'}`}
                                data-available={available ? 'true' : 'false'}>
                                {available ? (
                                    <Link to={tool.path as never} className="tools-card-link" data-tour={`tool-${tool.id}`}>
                                        {body}
                                    </Link>
                                ) : (
                                    <div className="tools-card-link" aria-disabled="true" data-tour={`tool-${tool.id}`}>
                                        {body}
                                    </div>
                                )}
                                {unavailable?.kind === 'feature' && <FeatureDocLink info={unavailable} label={`About ${unavailable.title}`} />}
                                <button type="button" className="btn subtle tools-hide" aria-label={`Hide ${tool.name}`}
                                    disabled={!appearance}
                                    onClick={() => void setHidden([...hidden, tool.id])}>
                                    Hide
                                </button>
                            </div>
                        );
                    })}
                </nav>
                {hiddenRooms.length > 0 && (
                    <section className="tools-hidden" aria-label="Hidden tools">
                        <h2 className="section-title">Hidden by you</h2>
                        <p className="hint">
                            These stay off this page. Opening the address still works, and hiding one does not change what the host can run.
                        </p>
                        <ul className="tools-hidden-list">
                            {hiddenRooms.map((tool) => (
                                <li key={tool.id} className="tools-hidden-row">
                                    <span><RoomIcon room={tool} /> {tool.name}</span>
                                    <button type="button" className="btn subtle" aria-label={`Unhide ${tool.name}`}
                                        onClick={() => void setHidden(hidden.filter((id) => id !== tool.id))}>
                                        Unhide
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}
            </div>
        </main>
    );
}
