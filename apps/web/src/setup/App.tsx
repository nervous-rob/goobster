import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { HostTransportProvider } from '../rooms/host/transport';
import { AnswersProvider } from './answers';
import { managerApi, managerTransport } from './api';
import { UnlockForm } from './Gate';
import { KEYS } from './data';
import { Maintain } from './journeys/Maintain';
import { Reconfigure } from './journeys/Reconfigure';
import { Repair } from './journeys/Repair';
import { Uninstall } from './journeys/Uninstall';
import { useRoute } from './route';
import { Access } from './steps/Access';
import { Connections } from './steps/Connections';
import { Database } from './steps/Database';
import { Defaults } from './steps/Defaults';
import { Done } from './steps/Done';
import { Features } from './steps/Features';
import { FirstRun } from './steps/FirstRun';
import { SETUP_STEPS } from './steps/order';
import { Progress } from './steps/Progress';
import { Review } from './steps/Review';
import { Welcome } from './steps/Welcome';
import { Where } from './steps/Where';
import { type ManagerStatus, WizardTransportProvider } from './transport';
import { describeError, isSessionProblem, LiveRegion, StepFrame } from './ui';

const MAINTENANCE_ANSWERS = 'goobster-setup-maintenance-answers';
const AFTER_INSTALL = new Set(['progress', 'first-run', 'done']);
const JOURNEYS = new Set(['reconfigure', 'repair', 'uninstall']);
const hostValue = { probe: managerTransport.probe, docHref: managerTransport.docHref };

function createClient(): QueryClient {
    return new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
}

function Stepper({ current }: { current: string }) {
    const index = SETUP_STEPS.findIndex((step) => step.id === current);
    const locked = index >= SETUP_STEPS.findIndex((step) => step.id === 'progress');
    return (
        <nav aria-label="Setup steps" className="wizard-stepper" data-testid="stepper">
            <ol>
                {SETUP_STEPS.map((step, position) => {
                    const here = step.id === current;
                    const reachable = !locked && position < index;
                    return (
                        <li key={step.id} data-state={here ? 'current' : (position < index ? 'done' : 'todo')}>
                            {reachable
                                ? <a href={`#/setup/${step.id}`} data-testid={`stepper-${step.id}`}>{step.label}</a>
                                : <span aria-current={here ? 'step' : undefined} data-testid={`stepper-${step.id}`}>{step.label}</span>}
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
}

function Page({ children, banner }: { children: ReactNode; banner?: ReactNode }) {
    return (
        <main className="wizard-page">
            <header className="wizard-header">
                <h1>Goobster</h1>
                <span className="hint">Installation manager</span>
            </header>
            {banner}
            {children}
        </main>
    );
}

function RecoveryState({ reason }: { reason?: string | null }) {
    return (
        <StepFrame id="recovery-state" title="This installation needs attention first"
            lead={reason ? `The manager reports: ${reason}` : 'The manager is in recovery: it cannot read the installation record or the saved settings.'}>
            <p>Goobster files already exist here, but the manager has no record of installing them. Nothing is installed over them from this page. Adopting or restoring the record is done from the command line on the machine:</p>
            <pre><code>node apps/manager/cli.js adopt</code></pre>
            <p className="hint">Run the manager&apos;s command line help to see every option. When the record reads again, reload this page.</p>
        </StepFrame>
    );
}

function Shell() {
    const client = useQueryClient();
    const { place, go } = useRoute();
    const recoveryPage = window.location.pathname.replace(/\/+$/, '').endsWith('/recovery');
    const [claimed, setClaimed] = useState(false);
    const [ended, setEnded] = useState(false);

    const status = useQuery({
        queryKey: ['setup', 'status'],
        queryFn: () => managerApi.status(),
        retry: false,
        refetchInterval: (query) => (query.state.error ? 2000 : false)
    });
    const state = status.data?.state;
    const session = useQuery({
        queryKey: KEYS.record,
        queryFn: () => managerTransport.record(),
        enabled: Boolean(state) && (state !== 'unclaimed' || claimed) && !ended,
        retry: false,
        refetchInterval: (query) => (query.state.error ? 2000 : 5000),
        refetchOnWindowFocus: true,
        staleTime: 0
    });

    const onClaimed = useCallback(() => {
        setClaimed(true);
        void client.invalidateQueries({ queryKey: ['setup', 'status'] });
        void client.invalidateQueries({ queryKey: KEYS.record });
    }, [client]);
    const onUnlocked = useCallback(() => {
        void client.invalidateQueries({ queryKey: ['setup', 'status'] });
        void client.invalidateQueries({ queryKey: KEYS.record });
    }, [client]);

    const goSetup = useCallback((step: string, id?: string | null) => go({ journey: 'setup', step, id: id ?? null }), [go]);
    const goJourney = useCallback((journey: string) => (step: string, id?: string | null) => {
        if (step === 'home') go({ journey: 'maintain' });
        else go({ journey, step, id: id ?? null });
    }, [go]);

    const reconnecting = (status.error instanceof ApiError && status.error.code === 'NETWORK')
        || (session.error instanceof ApiError && session.error.code === 'NETWORK');
    const banner = reconnecting
        ? <p role="status" className="wizard-callout" data-testid="reconnecting">The manager is not answering. It may be restarting. This page keeps trying and will carry on where it was.</p>
        : null;

    const live = useMemo(() => {
        const index = SETUP_STEPS.findIndex((step) => step.id === place.step);
        return place.journey === 'setup' && index >= 0 ? `Step ${index + 1} of ${SETUP_STEPS.length}: ${SETUP_STEPS[index].label}` : '';
    }, [place]);

    if (ended) {
        return (
            <Page>
                <StepFrame id="ended" title="This setup session has ended" lead="Nothing from it is kept in this browser.">
                    <p>To change, repair or remove this installation later, use the Host room in the portal, or ask the manager for a recovery credential on the machine itself.</p>
                </StepFrame>
            </Page>
        );
    }

    if (status.isPending && !status.isError) {
        return <Page banner={banner}><p role="status" data-testid="loading">Checking the manager…</p></Page>;
    }
    if (status.isError || !status.data) {
        return (
            <Page banner={banner}>
                <StepFrame id="unreachable" title="The manager is not answering" lead="This page keeps trying. If the manager is not running, start it on the machine:">
                    <pre><code>node apps/manager/index.js</code></pre>
                    <details className="wizard-details"><summary>Details for support</summary><p>{describeError(status.error).message}</p></details>
                </StepFrame>
            </Page>
        );
    }
    const manager: ManagerStatus = status.data;

    if (manager.state === 'unclaimed' && !claimed) {
        return (
            <Page banner={banner}>
                <LiveRegion>{live}</LiveRegion>
                <Welcome go={goSetup} status={manager} signedIn={false} onClaimed={onClaimed} />
            </Page>
        );
    }

    if (session.isPending && !session.isError) {
        return <Page banner={banner}><p role="status" data-testid="loading">Checking your session…</p></Page>;
    }
    if (session.isError && isSessionProblem(session.error)) {
        return (
            <Page banner={banner}>
                <StepFrame id="unlock" title="Unlock the manager"
                    lead="This page has no session. That is normal after a restart of the manager or after 15 minutes away. Your non-secret answers are still here; secrets must be typed again.">
                    <UnlockForm status={manager} onDone={onUnlocked} />
                </StepFrame>
            </Page>
        );
    }
    if (session.isError && session.error instanceof ApiError && session.error.code === 'STATE_NOT_ALLOWED') {
        return <Page banner={banner}><RecoveryState reason={manager.reason} /></Page>;
    }
    if (!session.data) {
        return (
            <Page banner={banner}>
                <StepFrame id="session-error" title="The manager answered with an error" lead={describeError(session.error).message}>
                    <button type="button" className="btn" onClick={onUnlocked}>Try again</button>
                </StepFrame>
            </Page>
        );
    }

    const installed = session.data.installed === true;
    if (manager.state === 'recovery' && !installed) {
        return <Page banner={banner}><RecoveryState reason={manager.reason} /></Page>;
    }
    const journey = place.journey;
    const step = place.step || (journey === 'setup' ? 'welcome' : '');
    let body: ReactNode;
    let maintenance = true;

    if (JOURNEYS.has(journey)) {
        const props = { step: step || (journey === 'uninstall' ? 'choose' : journey === 'repair' ? 'scope' : 'edit'), id: place.id, go: goJourney(journey) };
        body = journey === 'reconfigure' ? <Reconfigure {...props} /> : journey === 'repair' ? <Repair {...props} /> : <Uninstall {...props} />;
    } else if (journey === 'maintain' || (installed && !(journey === 'setup' && AFTER_INSTALL.has(step))) || (!installed && journey !== 'setup' && journey !== '')) {
        body = <Maintain go={(next, nextStep) => go({ journey: next, step: nextStep })} recovery={recoveryPage} />;
    } else {
        maintenance = false;
        const known = SETUP_STEPS.some((entry) => entry.id === step) ? step : 'welcome';
        switch (known) {
        case 'where': body = <Where go={goSetup} />; break;
        case 'features': body = <Features go={goSetup} />; break;
        case 'connections': body = <Connections go={goSetup} />; break;
        case 'database': body = <Database go={goSetup} />; break;
        case 'defaults': body = <Defaults go={goSetup} />; break;
        case 'access': body = <Access go={goSetup} />; break;
        case 'review': body = <Review go={goSetup} />; break;
        case 'progress': body = <Progress go={goSetup} id={place.id} />; break;
        case 'first-run': body = <FirstRun go={goSetup} />; break;
        case 'done': body = <Done onFinished={() => setEnded(true)} />; break;
        default: body = <Welcome go={goSetup} status={manager} signedIn onClaimed={onClaimed} />;
        }
    }

    const note = !installed && manager.existingInstallation && !maintenance && (step === 'welcome' || step === 'where')
        ? <p className="wizard-callout" data-testid="existing-files">The manager found Goobster files on this machine already (a settings file or a database). Setup works with them; it never deletes anything.</p>
        : null;

    return (
        <Page banner={banner}>
            <LiveRegion>{live}</LiveRegion>
            {!maintenance && <Stepper current={SETUP_STEPS.some((entry) => entry.id === step) ? step : 'welcome'} />}
            {note}
            <AnswersProvider key={maintenance ? 'maintenance' : 'setup'} storageKey={maintenance ? MAINTENANCE_ANSWERS : undefined}>{body}</AnswersProvider>
        </Page>
    );
}

export function App() {
    const [client] = useState(createClient);
    return (
        <QueryClientProvider client={client}>
            <WizardTransportProvider value={managerTransport}>
                <HostTransportProvider value={hostValue}>
                    <Shell />
                </HostTransportProvider>
            </WizardTransportProvider>
        </QueryClientProvider>
    );
}
