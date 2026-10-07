import { useState } from 'react';
import { useAnswers } from '../answers';
import { useConfigReport, useSuggest } from '../data';
import { FieldList } from '../fields';
import { fieldProblems, layoutFor } from '../model';
import { describeError, ErrorSummary, StepFrame, StepNav, Tunnel, type Problem } from '../ui';
import type { StepProps } from './order';

/** Who can reach Goobster: the addresses, local-only or network, and the public address people will use. */
export function Access({ go }: StepProps) {
    const { answers } = useAnswers();
    const suggest = useSuggest();
    const { report, fields } = useConfigReport();
    const [problems, setProblems] = useState<Problem[]>([]);
    const data = suggest.data;
    const layout = layoutFor(answers, fields);

    function next() {
        const found = fieldProblems(answers, fields, ['webapp.publicUrl']);
        setProblems(found);
        if (found.length === 0) go('review');
    }

    return (
        <StepFrame id="access" title="Who can reach it?"
            lead="By default Goobster answers only on this machine. Opening it to your network is a separate, deliberate step.">
            <ErrorSummary problems={problems} />
            {suggest.isError && <p role="alert" className="settings-danger">{describeError(suggest.error).message}</p>}
            {data && (
                <>
                    <dl className="wizard-facts" data-testid="access-facts">
                        <dt>This setup page</dt>
                        <dd>{data.ports.lan ? 'Open to your network (encrypted)' : 'This machine only'} · <code>{data.ports.host}:{data.ports.manager ?? ''}</code></dd>
                        <dt>The portal</dt>
                        <dd>
                            {data.ports.workers.length === 0
                                ? 'Chosen from the layout when it starts'
                                : data.ports.workers.map((worker) => <span key={worker.name}><code>127.0.0.1:{worker.port}</code> ({worker.name}) </span>)}
                            <span className="hint">· {layout === 'lite' ? 'served by the Discord bot' : 'its own process'}</span>
                        </dd>
                    </dl>
                    <div className="wizard-callout" data-testid="access-explainer">
                        <p><strong>This machine only</strong> means nothing outside it can connect, which is the safe choice for a first install. To use Goobster from another computer on a machine with no screen, forward the port over SSH:</p>
                        <Tunnel port={data.ports.manager} />
                        <p><strong>Network access</strong> is turned on when the manager is started (<code>GOOBSTER_MANAGER_LAN=1</code> with a certificate and a host name, see <code>documentation/manager.md</code>). It is not something a web page can switch on for itself; the Host room explains how.</p>
                    </div>
                </>
            )}
            {report && (
                <>
                    <h3 className="section-title">Public address <span className="hint">(optional)</span></h3>
                    <p className="hint">The address people type to reach the portal from outside, for sign-in links and notifications. Leave it empty for local use.</p>
                    <FieldList ids={['webapp.publicUrl']} report={report} />
                </>
            )}
            <StepNav onBack={() => go('defaults')} onNext={next} nextDisabled={!data} />
        </StepFrame>
    );
}
