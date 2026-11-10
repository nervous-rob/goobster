import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useDateLabel } from '../../hooks/useDateLabel';

/**
 * What delegating would do with the sources a responsibility names (DA-8):
 * the cutoff, the history it will not act on, and today's proposals against
 * the daily cap. Read only; nothing is read that the source itself would not.
 */

export const SOURCE_TEXT: Record<string, string> = {
    attention_item: 'Changes to the goal it looks after',
    project_plan: 'Changes to the project plan',
    project_plan_step: 'Steps of the project plan',
    conversation_request: 'Requests in conversations',
    chat_request: 'Requests in your own chats',
    followed_source: 'Items you kept from followed sources',
    job_failure: 'Failed project runs',
    ci_verdict: 'CI results on watched branches'
};

export function SourcesPreview({ responsibilityId, revision }: { responsibilityId: number; revision: number }) {
    const whenLabel = useDateLabel();
    const [open, setOpen] = useState(false);
    const preview = useQuery({
        queryKey: [...keys.responsibilitySources(responsibilityId), revision],
        queryFn: () => api.responsibilitySources(responsibilityId),
        enabled: open
    });
    const data = preview.data;
    return (
        <div className="assistant-sources" data-testid="responsibility-sources">
            <button type="button" className="btn subtle" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="responsibility-sources-toggle">
                {open ? 'Hide what it would notice' : 'What would it notice?'}
            </button>
            {open && preview.isLoading && <div className="hint">Looking…</div>}
            {open && preview.isError && <div className="hint">Could not read that now. Try again in a moment.</div>}
            {open && data && (
                <div data-testid="responsibility-sources-body">
                    <div className="hint">
                        Counted from {whenLabel(data.cutoff)}. Everything before then is history: it is shown here and never acted on.
                    </div>
                    {data.locked && <div className="hint">Some of these sources are limited to the installation&apos;s owner until the pilot decision is recorded.</div>}
                    <ul>
                        {data.sources.map((row) => (
                            <li key={row.sourceKind} data-testid="responsibility-source-row">
                                <strong>{SOURCE_TEXT[row.sourceKind] || row.sourceKind}</strong>
                                {row.locked
                                    ? ': not available to you yet.'
                                    : `: ${row.ignored} already there will be treated as history${row.examples.length ? ` (${row.examples.join('; ')})` : ''}.`}
                            </li>
                        ))}
                    </ul>
                    {data.today.length > 0 && (
                        <div className="hint" data-testid="responsibility-sources-today">
                            Today: {data.today.map((row) => `${SOURCE_TEXT[row.sourceKind] || row.sourceKind} ${row.proposed} of ${row.cap} proposed${row.coalesced ? `, ${row.coalesced} more not proposed` : ''}`).join(' · ')}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
