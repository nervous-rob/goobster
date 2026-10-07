import { Link } from '@tanstack/react-router';
import { useCallback } from 'react';
import { AnswersProvider } from '../../setup/answers';
import { BarrierPanel } from '../../setup/journeys/barrier';
import { Backup, useBackupStatus } from '../../setup/journeys/Backup';
import { CrumbRoot } from '../../setup/journeys/common';
import { Migration } from '../../setup/journeys/Migration';
import { Reset } from '../../setup/journeys/Reset';
import { Restore, RestoreStatusPanel } from '../../setup/journeys/Restore';
import { portalTransport } from '../../setup/portalTransport';
import { useRoute } from '../../setup/route';
import { WizardTransportProvider } from '../../setup/transport';
import '../../setup/setup.css';
import { ManagerNotice, useManagerStatus } from './ManagerCard';
import { DocLink } from './shared';

const ANSWERS_KEY = 'goobster-portal-maintenance-answers';
const FIRST_STEP: Record<string, string> = { backup: 'form', restore: 'source', reset: 'scope', migration: 'status' };

/**
 * Overview card: the four maintenance operations. Backup and the checks run from here; a restore takes the portal down while it runs,
 * so its page says where to continue.
 */
export function MaintenanceCard() {
    return (
        <section className="settings-section" aria-labelledby="host-maintenance-title" data-testid="maintenance-card">
            <h2 id="host-maintenance-title">Backup, restore and reset</h2>
            <p className="hint">Write a verified backup, restore one, empty data, or move to Postgres. Each shows exactly what it will do first.</p>
            <div className="wizard-actions">
                <Link to="/host/$page" params={{ page: 'maintenance' }} hash="/backup/form" className="btn" data-testid="host-backup">Backup…</Link>
                <Link to="/host/$page" params={{ page: 'maintenance' }} hash="/restore/source" className="btn" data-testid="host-restore">Restore…</Link>
                <Link to="/host/$page" params={{ page: 'maintenance' }} hash="/reset/scope" className="btn" data-testid="host-reset">Reset…</Link>
                <Link to="/host/$page" params={{ page: 'maintenance' }} hash="/migration/status" className="btn" data-testid="host-migration">Migration…</Link>
            </div>
        </section>
    );
}

function Hub() {
    const status = useBackupStatus();
    const restore = status.data?.restore || null;
    return (
        <div className="wizard-journey" data-testid="maintenance-hub">
            <h2>Backup, restore and reset</h2>
            <p className="hint">
                These change or copy the installation&apos;s data, through the manager. Only <code>config.json</code> is encrypted in a backup; the database and the files are not.
                {' '}<DocLink slug="backups">How backup and restore work</DocLink>
            </p>
            <BarrierPanel canRelease={false} />
            {restore && restore.status !== 'completed' && <RestoreStatusPanel restore={restore} />}
            <ul className="wizard-list" data-testid="maintenance-list">
                <li><strong>Backup</strong>: a verified copy of the database, the data files and (encrypted) <code>config.json</code>. Goobster keeps running.</li>
                <li><strong>Restore</strong>: replace the data from a backup. The portal goes offline while it runs and the instance comes back paused; you continue on the manager page.</li>
                <li><strong>Reset</strong>: empty one feature&apos;s data or all of it, after a verified backup. It runs from the manager page or the command line.</li>
                <li><strong>Migration</strong>: SQLite to Postgres. Status and the rollback boundary here; the move itself is a command.</li>
            </ul>
            <div className="wizard-actions" data-testid="maintenance-actions">
                <a href="#/backup/form" className="btn" data-testid="maintenance-backup">Backup…</a>
                <a href="#/restore/source" className="btn" data-testid="maintenance-restore">Restore…</a>
                <a href="#/reset/scope" className="btn" data-testid="maintenance-reset">Reset…</a>
                <a href="#/migration/status" className="btn" data-testid="maintenance-migration">Migration…</a>
            </div>
        </div>
    );
}

/** The Maintenance page of the Host room: the four journeys over the portal transport. */
export function MaintenancePage() {
    const { status, usable } = useManagerStatus();
    const { place, go } = useRoute();

    const goJourney = useCallback((journey: string) => (step: string, id?: string | null) => {
        if (step === 'home') go({ journey: 'maintain' });
        else go({ journey, step, id: id ?? null });
    }, [go]);

    if (status && !usable) return <ManagerNotice status={status} />;
    if (!status) return <div className="hint">Loading…</div>;

    const journey = place.journey;
    let body;
    if (Object.prototype.hasOwnProperty.call(FIRST_STEP, journey)) {
        const props = { step: place.step || FIRST_STEP[journey], id: place.id, go: goJourney(journey) };
        body = journey === 'backup' ? <Backup {...props} />
            : journey === 'restore' ? <Restore {...props} />
            : journey === 'reset' ? <Reset {...props} />
            : <Migration {...props} />;
    } else {
        body = <Hub />;
    }
    return (
        <WizardTransportProvider value={portalTransport}>
            <CrumbRoot.Provider value="Maintenance">
                <div className="wizard-portal" data-testid="maintenance-page">
                    <AnswersProvider storageKey={ANSWERS_KEY}>{body}</AnswersProvider>
                </div>
            </CrumbRoot.Provider>
        </WizardTransportProvider>
    );
}
