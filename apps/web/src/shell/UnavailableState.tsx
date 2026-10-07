import { Link } from '@tanstack/react-router';
import { MenuButton } from './MenuButton';
import type { RouteUnavailability, Unavailability } from '../lib/rooms';

type FeatureReason = Extract<Unavailability, { kind: 'feature' }>;

/** A link to the portal docs page that explains the feature, or its source path in plain text when none is published. */
export function FeatureDocLink({ info, label = 'How a host turns it on' }: { info: FeatureReason; label?: string }) {
    if (info.docSlug) {
        return <Link to="/docs/$slug" params={{ slug: info.docSlug }} className="feature-doc-link">{label}</Link>;
    }
    if (info.docPath) return <span className="hint feature-doc-path">Setup notes: {info.docPath}</span>;
    return null;
}

/**
 * Said inside a room (or a view of one) that this installation cannot offer:
 * a direct address or an old bookmark still lands somewhere useful. This is
 * the host's state, not the person's hide-a-tool preference, and it is not
 * an error: nothing here failed.
 */
export function UnavailableNotice({ info, back }: { info: FeatureReason; back: { to: string; label: string } }) {
    return (
        <div className="empty feature-unavailable" role="status" data-testid="feature-unavailable" data-feature={info.feature}>
            <p><strong>Not available on this installation</strong></p>
            <p>{info.sentence}</p>
            <p className="hint">Nothing was lost: your data and settings stay in place, and it comes back if the host turns it on again.</p>
            <p>
                <Link to={back.to as never} className="btn small">{back.label}</Link>
                {' '}
                <FeatureDocLink info={info} />
            </p>
        </div>
    );
}

/** A whole room the host has not made available, rendered inside the shell in place of the room. */
export function UnavailableRoom({ info }: { info: RouteUnavailability }) {
    const room = info.room;
    const back = room.parent === 'tools' ? { to: '/tools', label: 'Back to Tools' } : { to: '/', label: 'Back to Home' };
    return (
        <main className="pane next-pane is-in" id={`pane-unavailable-${room.id}`}>
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1>{room.name}{room.secondaryName && <span className="room-secondary">{room.secondaryName}</span>}</h1>
                </div>
            </header>
            <div className="pane-body">
                <UnavailableNotice info={info} back={back} />
            </div>
        </main>
    );
}
