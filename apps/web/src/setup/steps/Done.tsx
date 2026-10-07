import { useQuery } from '@tanstack/react-query';
import { managerApi } from '../api';
import { useAnswers } from '../answers';
import { KEYS } from '../data';
import { writeRun } from './Review';
import { useTransport } from '../transport';
import { StepFrame, Tunnel } from '../ui';

/** Open Goobster: enabled only when every process is healthy and the portal answers. */
export function Done({ onFinished }: { onFinished: () => void }) {
    const transport = useTransport();
    const { answers, reset } = useAnswers();
    const check = useQuery({ queryKey: KEYS.firstRun, queryFn: () => transport.firstRun(), retry: false, refetchInterval: 3000 });
    const result = check.data;
    const ready = result?.ok === true && Boolean(result.portal);
    const failing = (result?.checks || []).filter((item) => !item.ok);
    const portal = result?.portal;

    function clearAnswers() {
        reset();
        writeRun(null);
        try { window.sessionStorage.removeItem('goobster-setup-post'); } catch { /* optional */ }
    }

    async function signOut() {
        clearAnswers();
        try { await managerApi.logout(); } catch { /* the session ends by itself */ }
        onFinished();
    }

    return (
        <StepFrame id="done" title="Goobster is ready" lead="Everything checked out. Sign in with the owner account you just made.">
            {ready && portal ? (
                <p>
                    <a className="btn primary big" href={portal.url} data-testid="open-goobster" onClick={clearAnswers}>Open Goobster</a>
                    {' '}<button type="button" className="btn" onClick={() => void signOut()} data-testid="end-session">End this setup session</button>
                </p>
            ) : (
                <p>
                    <button type="button" className="btn primary big" disabled data-testid="open-goobster" aria-describedby="open-reason">Open Goobster</button>
                    <span id="open-reason" className="hint" data-testid="open-reason">
                        {' '}{failing.length > 0 ? `Waiting for: ${failing.map((item) => item.label).join(', ')}.` : 'Checking…'}
                    </span>
                </p>
            )}
            {portal && (
                <dl className="wizard-facts">
                    <dt>Address</dt><dd><code data-testid="portal-url">{portal.url}</code></dd>
                    {answers.owner.loginName && (<><dt>Sign in as</dt><dd><code>{answers.owner.loginName}</code></dd></>)}
                </dl>
            )}
            {portal && (
                <details className="wizard-details">
                    <summary>Opening it from another computer</summary>
                    <Tunnel port={portal.port} />
                </details>
            )}
            <p className="hint">Later, the Host room in the portal is where you change settings, features and restart. This setup page stays here for repair and uninstall.</p>
        </StepFrame>
    );
}
