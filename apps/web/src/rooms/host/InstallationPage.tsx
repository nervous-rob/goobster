import { Link } from '@tanstack/react-router';
import { useCallback } from 'react';
import { AnswersProvider } from '../../setup/answers';
import { Maintain } from '../../setup/journeys/Maintain';
import { Reconfigure } from '../../setup/journeys/Reconfigure';
import { Repair } from '../../setup/journeys/Repair';
import { Uninstall } from '../../setup/journeys/Uninstall';
import { portalTransport } from '../../setup/portalTransport';
import { useRoute } from '../../setup/route';
import { WizardTransportProvider } from '../../setup/transport';
import '../../setup/setup.css';
import { LifecyclePanel } from './LifecyclePanel';
import { ManagerNotice, useManagerStatus } from './ManagerCard';

const ANSWERS_KEY = 'goobster-portal-installation-answers';
const JOURNEYS = new Set(['reconfigure', 'repair', 'uninstall']);

/**
 * Overview card: the three things you can do to the installation. Each opens
 * the same journey the manager's own page runs, here through the portal's Host
 * routes, so the browser holds no manager credential.
 */
export function InstallationCard() {
    return (
        <section className="settings-section" aria-labelledby="host-installation-title" data-testid="installation-card">
            <h2 id="host-installation-title">Installation</h2>
            <p className="hint">Change how this installation is set up, put it right when something broke, or remove it. Each shows the exact plan before anything changes.</p>
            <div className="wizard-actions">
                <Link to="/host/$page" params={{ page: 'installation' }} hash="/reconfigure/edit" className="btn" data-testid="host-reconfigure">Reconfigure…</Link>
                <Link to="/host/$page" params={{ page: 'installation' }} hash="/repair/scope" className="btn" data-testid="host-repair">Repair…</Link>
                <Link to="/host/$page" params={{ page: 'installation' }} hash="/uninstall/choose" className="btn danger" data-testid="host-uninstall">Uninstall…</Link>
            </div>
        </section>
    );
}

/** The Installation page of the Host room: the maintenance journeys over the portal transport. */
export function InstallationPage() {
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
    if (JOURNEYS.has(journey)) {
        const props = { step: place.step || (journey === 'uninstall' ? 'choose' : journey === 'repair' ? 'scope' : 'edit'), id: place.id, go: goJourney(journey) };
        body = journey === 'reconfigure'
            ? <Reconfigure {...props} restartPanel={<LifecyclePanel title="Restart" enabled={usable} />} />
            : journey === 'repair' ? <Repair {...props} /> : <Uninstall {...props} />;
    } else {
        body = <Maintain go={(next, step) => go({ journey: next === 'maintain' ? 'maintain' : next, step })} />;
    }
    return (
        <WizardTransportProvider value={portalTransport}>
            <div className="wizard-portal" data-testid="installation-page">
                <AnswersProvider storageKey={ANSWERS_KEY}>{body}</AnswersProvider>
            </div>
        </WizardTransportProvider>
    );
}
