import { Link } from '@tanstack/react-router';
import { useCallback } from 'react';
import { AnswersProvider } from '../../setup/answers';
import { DatabaseJourney } from '../../setup/journeys/Database';
import { portalTransport } from '../../setup/portalTransport';
import { useRoute } from '../../setup/route';
import { WizardTransportProvider } from '../../setup/transport';
import '../../setup/setup.css';
import { ManagerNotice, useManagerStatus } from './ManagerCard';

const ANSWERS_KEY = 'goobster-portal-database-answers';

/** Overview card: where the data lives, and the way to connect it to a PostgreSQL server you run. */
export function DatabaseCard() {
    return (
        <section className="settings-section" aria-labelledby="host-database-title" data-testid="database-card">
            <h2 id="host-database-title">Database</h2>
            <p className="hint">See which database this installation uses, connect it to an existing PostgreSQL server, or bring its schema up to date. The data stays where it is; nothing is moved or dropped.</p>
            <div className="wizard-actions">
                <Link to="/host/$page" params={{ page: 'database' }} hash="/database/status" className="btn" data-testid="host-database">Database…</Link>
            </div>
        </section>
    );
}

/** The Database page of the Host room: the same journey the manager's own page runs, through the portal's Host routes. */
export function DatabasePage() {
    const { status, usable } = useManagerStatus();
    const { place, go } = useRoute();

    const goStep = useCallback((step: string, id?: string | null) => {
        go({ journey: 'database', step: step === 'home' ? 'status' : step, id: id ?? null });
    }, [go]);

    if (status && !usable) return <ManagerNotice status={status} />;
    if (!status) return <div className="hint">Loading…</div>;

    const step = place.journey === 'database' ? place.step : '';
    return (
        <WizardTransportProvider value={portalTransport}>
            <div className="wizard-portal" data-testid="database-page">
                <AnswersProvider storageKey={ANSWERS_KEY}>
                    <DatabaseJourney step={step || 'status'} id={place.journey === 'database' ? place.id : null} go={goStep} />
                </AnswersProvider>
            </div>
        </WizardTransportProvider>
    );
}
