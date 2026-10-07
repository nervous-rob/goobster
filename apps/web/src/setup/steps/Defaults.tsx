import { useState } from 'react';
import { useConfigReport } from '../data';
import { FieldList } from '../fields';
import { useAnswers } from '../answers';
import { fieldProblems } from '../model';
import { describeError, ErrorSummary, StepFrame, StepNav, type Problem } from '../ui';
import type { StepProps } from './order';

const NAMES = ['identity.installationName', 'identity.assistantName'];
/** A destructive default (it purges chat history for everyone) is not offered during setup. */
const NOT_IN_SETUP = new Set(['defaults.memory.chatHistoryRetentionDays']);

/** Names and what new people inherit. Defaults never limit anyone; they are what a person gets until they choose. */
export function Defaults({ go }: StepProps) {
    const { answers } = useAnswers();
    const { query, report, fields } = useConfigReport();
    const [problems, setProblems] = useState<Problem[]>([]);
    const defaults = report?.sections.find((section) => section.id === 'defaults');
    const defaultIds = (defaults?.fields || []).map((field) => field.id).filter((id) => !NOT_IN_SETUP.has(id));

    function next() {
        const found = fieldProblems(answers, fields, NAMES);
        setProblems(found);
        if (found.length === 0) go('access');
    }

    return (
        <StepFrame id="defaults" title="Names and defaults"
            lead="What this installation is called, and what a new person starts with. Nobody is locked into any of it.">
            <ErrorSummary problems={problems} />
            {query.isPending && <p role="status" className="hint">Reading the settings…</p>}
            {query.isError && <p role="alert" className="settings-danger">{describeError(query.error).message}</p>}
            {report && (
                <>
                    <h3 className="section-title">Names</h3>
                    <FieldList ids={NAMES} report={report} />
                    {defaultIds.length > 0 && (
                        <>
                            <h3 className="section-title">What new people start with</h3>
                            <p className="hint" data-testid="defaults-explainer">
                                A default is what a person inherits for a preference they have not set. It never blocks or overwrites anyone&apos;s own choice.
                                These are saved right after the database is created.
                            </p>
                            <FieldList ids={defaultIds} scope="instanceDefaults" report={report} />
                        </>
                    )}
                </>
            )}
            <StepNav onBack={() => go('database')} onNext={next} nextDisabled={!report} />
        </StepFrame>
    );
}
