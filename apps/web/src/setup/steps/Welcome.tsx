import type { ManagerStatus } from '../transport';
import { ClaimForm } from '../Gate';
import { StepFrame, StepNav, Tunnel } from '../ui';
import type { StepProps } from './order';

/** First-time setup starts here: what is about to happen, and the one-time credential that opens it. */
export function Welcome({ go, status, signedIn, onClaimed }: StepProps & { status: ManagerStatus; signedIn: boolean; onClaimed: () => void }) {
    return (
        <StepFrame id="welcome" title="Set up Goobster"
            lead="This page walks through everything a first installation needs, in order, and changes nothing until you press Install on the last review.">
            <ol className="wizard-outline">
                <li>Choose where Goobster lives on this machine and which parts you want.</li>
                <li>Connect the services you use. Every one is optional.</li>
                <li>Create the owner account you will sign in with.</li>
                <li>Review the plan, install, and wait until Goobster answers.</li>
            </ol>
            {signedIn
                ? <StepNav onNext={() => go('where')} nextLabel="Continue" />
                : <ClaimForm status={status} onDone={() => { onClaimed(); go('where'); }} />}
            <details className="wizard-details" data-testid="headless-help">
                <summary>This machine has no screen</summary>
                <Tunnel port={Number(window.location.port) || 3400} />
            </details>
        </StepFrame>
    );
}
