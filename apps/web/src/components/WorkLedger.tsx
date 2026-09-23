import { useDateLabel } from '../hooks/useDateLabel';
import type { AccountSupportView, ResourceTotal, WorkFailureRow } from '../lib/types';

/**
 * The diagnostics and cost read model (documentation/work_ledger.md), as
 * the person sees it for themselves in Usage and the operator sees it for
 * any account in the Host room. Rows carry a kind, a code, a phase and a
 * short reason - the ledger never holds a prompt, a reply or a body, so
 * there is nothing more to expand.
 */

export const FAILURE_KIND_LABEL: Record<string, string> = {
    chat: 'chat turn',
    expedition: 'research expedition',
    job: 'project run',
    sandbox: 'code run',
    automation: 'scheduled task',
    trigger: 'project trigger',
    delivery: 'delivery',
    mission_step: 'mission step',
    watch: 'watch',
    followup: 'reminder',
    integration_action: 'integration action',
    reflection: 'knowledge reflection'
};

const RESOURCE_LABEL: Record<string, string> = {
    search_call: 'Search calls',
    sandbox_seconds: 'Sandbox seconds',
    retry: 'Retries',
    image_generation: 'Images generated',
    speech_seconds: 'Speech seconds',
    embedding_call: 'Embedding calls'
};

export function failureKindLabel(kind: string | null): string {
    return (kind && FAILURE_KIND_LABEL[kind]) || kind || 'work';
}

function formatQuantity(total: ResourceTotal): string {
    const n = total.quantity;
    const rounded = Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return total.unit === 'seconds' && n >= 90 ? `${(n / 60).toLocaleString(undefined, { maximumFractionDigits: 1 })} min` : rounded;
}

export function ResourceTotals({ totals, days }: { totals: ResourceTotal[]; days: number }) {
    if (totals.length === 0) {
        return <div className="hint" data-testid="ledger-resources-empty">No search calls, sandbox runs or retries in the last {days} days.</div>;
    }
    return (
        <div className="stat-grid" data-testid="ledger-resources">
            {totals.map((total) => (
                <div key={total.kind} className="stat-card">
                    <div className="stat-label">{RESOURCE_LABEL[total.kind] || total.kind}</div>
                    <div className="stat-value">{formatQuantity(total)}</div>
                    <div className="stat-sub">{total.events.toLocaleString()} event{total.events === 1 ? '' : 's'} · last {days} days</div>
                </div>
            ))}
        </div>
    );
}

export function FailureRow({ failure }: { failure: WorkFailureRow }) {
    const whenLabel = useDateLabel();
    return (
        <div className="list-row ledger-failure-row" data-testid="ledger-failure">
            <div className="row-body">
                <span className="badge">{failureKindLabel(failure.kind)}</span>
                <code>{failure.code}</code>
                {failure.phase ? <span className="hint"> · {failure.phase}</span> : null}
                <div className="row-meta">
                    {whenLabel(failure.createdAt)}
                    {failure.workId ? ` · #${failure.workId}` : ''}
                    {failure.reason ? ` · ${failure.reason}` : ''}
                </div>
            </div>
        </div>
    );
}

export function FailureList({ view, emptyText }: { view: AccountSupportView; emptyText: string }) {
    const { failures, days } = view;
    if (failures.total === 0) {
        return <div className="hint" data-testid="ledger-failures-empty">{emptyText}</div>;
    }
    return (
        <>
            <div className="hint ledger-failure-summary" data-testid="ledger-failure-summary">
                {failures.total.toLocaleString()} failure{failures.total === 1 ? '' : 's'} in the last {days} days:{' '}
                {failures.byKind.map((row) => `${row.count} ${failureKindLabel(row.kind)}${row.count === 1 ? '' : 's'}`).join(', ')}.
            </div>
            <div className="list-card">
                {failures.recent.map((failure) => <FailureRow key={failure.id} failure={failure} />)}
            </div>
        </>
    );
}
