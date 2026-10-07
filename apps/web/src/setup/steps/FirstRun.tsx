import { useState } from 'react';
import { HealthPanel } from '../health';
import type { FirstRun as FirstRunResult } from '../transport';
import { StepFrame, StepNav } from '../ui';
import type { StepProps } from './order';

/** Is it really working? The manager checks each part and the page waits until every one answers. */
export function FirstRun({ go }: StepProps) {
    const [result, setResult] = useState<FirstRunResult | null>(null);
    return (
        <StepFrame id="first-run" title="Checking that it works"
            lead="Starting a program is not the same as it working. This page waits until each process says it is running the current settings and answers.">
            <HealthPanel onResult={setResult} />
            <StepNav onBack={() => go('progress', null)} backLabel="Back" onNext={() => go('done')} nextLabel="Continue" nextDisabled={!result?.ok} />
        </StepFrame>
    );
}
