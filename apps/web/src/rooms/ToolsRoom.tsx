import { Link } from '@tanstack/react-router';
import { useMe } from '../hooks/useSession';
import { MenuButton } from '../shell/MenuButton';
import { TOOL_ROOMS, isRoomAvailable, unavailableReason } from '../lib/rooms';

/**
 * Tools: the optional specialist rooms (Music Lab, Trading game, Card decks)
 * behind one primary destination. Each card says what the tool is for and,
 * when it cannot open here, why - host availability and a connected Discord
 * server are explained locally instead of failing inside the room. The
 * rooms keep their own URLs; this page is the door, not a rewrite.
 */
export function ToolsRoom() {
    const me = useMe();

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
                <div className="tools-grid">
                    {TOOL_ROOMS.map((tool) => {
                        const available = isRoomAvailable(tool, me);
                        const reason = unavailableReason(tool, me);
                        const body = (
                            <>
                                <div className="tools-card-head">
                                    <span className="tools-card-icon" aria-hidden="true">{tool.icon}</span>
                                    <div>
                                        <div className="tools-card-title">{tool.name}</div>
                                        {tool.secondaryName && <div className="hint tools-card-secondary">{tool.secondaryName}</div>}
                                    </div>
                                </div>
                                <p className="tools-card-blurb">{tool.blurb}</p>
                                {available
                                    ? <div className="home-card-action">Open {tool.name} →</div>
                                    : <div className="tools-card-unavailable" role="note">{reason}</div>}
                            </>
                        );
                        return available ? (
                            <Link key={tool.id} to={tool.path as never} className="home-card tools-card" data-tour={`tool-${tool.id}`}>
                                {body}
                            </Link>
                        ) : (
                            <div key={tool.id} className="home-card tools-card is-unavailable" aria-disabled="true" data-tour={`tool-${tool.id}`}>
                                {body}
                            </div>
                        );
                    })}
                </div>
            </div>
        </main>
    );
}
