import { Link } from '@tanstack/react-router';
import type { UserSettingsResponse } from '../../lib/types';
import { ConnectionsList } from '../../components/ConnectionsList';
import { SectionHeader } from './SectionFrame';
import { SCOPE_FOR } from './sectionMeta';

export function ConnectionsSection({ section }: { section: UserSettingsResponse['sections']['connections'] }) {
    return (
        <section className="settings-section" aria-labelledby="settings-connections-title">
            <SectionHeader id="connections" scope={SCOPE_FOR[section.scope]} appliesTo={section.appliesTo} />
            <p className="hint">
                Connected accounts let Goobster act through them for you in the Study, your DMs, and proactive work
                (within your <Link to="/settings/$section" params={{ section: 'initiative' }} hash="boundaries">Initiative boundaries</Link>). Tokens are stored
                encrypted and never shown again; only the connection status and account label appear here.
                Resetting other settings or forgetting preferences never disconnects anything.
            </p>
            <ConnectionsList />
        </section>
    );
}
