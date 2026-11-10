import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import type { AssistantOutcomeCounts, AssistantOutcomeRow } from '../../lib/types';

/**
 * What the person's responsibilities did over a period, and what it cost
 * (documentation/delegated_pilot.md, "The outcome summary").
 *
 * A read, with nothing to press but the period. Results that code checked
 * (a plan step whose files were verified, a repair whose next run worked)
 * are shown apart from results a run only reported. It never shows notes
 * created or tool calls as a measure of success, and it says what it cannot
 * know: whether a result was useful is the person's to judge.
 */

const PERIODS = [7, 14, 30, 90];

const NOT_MEASURED_TEXT: Record<string, string> = {
    usefulness: 'whether a result was useful to you',
    unwanted_actions: 'whether anything it did was unwanted',
    foreground_responsiveness: 'how responsive chat stayed while it worked'
};

const number = (value: number) => value.toLocaleString();
const plural = (count: number, one: string, many = `${one}s`) => `${number(count)} ${count === 1 ? one : many}`;

function resultsText(counts: AssistantOutcomeCounts): string {
    const parts: string[] = [];
    if (counts.verified.total > 0) {
        const kinds = [
            counts.verified.planSteps > 0 ? plural(counts.verified.planSteps, 'plan step') : null,
            counts.verified.repairs > 0 ? plural(counts.verified.repairs, 'repair') : null
        ].filter(Boolean).join(', ');
        parts.push(`${plural(counts.verified.total, 'checked result')} (${kinds})`);
    } else {
        parts.push('No checked results');
    }
    if (counts.reported.findings > 0) parts.push(`${plural(counts.reported.findings, 'finding')} reported`);
    if (counts.reported.noChange > 0) parts.push(`${plural(counts.reported.noChange, 'run')} found nothing needing you`);
    return `${parts.join('. ')}.`;
}

function attentionText(counts: AssistantOutcomeCounts): string | null {
    const parts: string[] = [];
    if (counts.requests.asked > 0) {
        parts.push(`Asked you ${plural(counts.requests.asked, 'time')}${counts.requests.open > 0 ? ` (${number(counts.requests.open)} waiting)` : ''}`);
    }
    if (counts.notes.proposed > 0) {
        parts.push(`${plural(counts.notes.proposed, 'note suggestion')}: ${number(counts.notes.applied)} applied, ${number(counts.notes.dismissed)} dismissed`);
    }
    if (counts.changes.applied > 0) {
        parts.push(`${plural(counts.changes.applied, 'change')} made${counts.changes.outside > 0 ? ` (${number(counts.changes.outside)} outside Goobster)` : ''}`);
    }
    if (counts.notes.undone + counts.repairs.rolledBack > 0) parts.push(`${plural(counts.notes.undone + counts.repairs.rolledBack, 'change')} undone`);
    if (counts.refusals.total > 0) parts.push(`${plural(counts.refusals.total, 'call')} refused`);
    if (counts.stopped.total > 0) parts.push(`${plural(counts.stopped.total, 'run')} stopped before a result`);
    if (counts.work.withdrawn > 0) parts.push(`${plural(counts.work.withdrawn, 'piece', 'pieces')} of work withdrawn`);
    if (counts.review > 0) parts.push(`${plural(counts.review, 'write')} left for you to check`);
    if (counts.delivery.digest + counts.delivery.contacts > 0) {
        parts.push(`${plural(counts.delivery.digest + counts.delivery.contacts, 'update')} sent outside the portal`);
    }
    return parts.length ? `${parts.join('. ')}.` : null;
}

function costText(counts: AssistantOutcomeCounts): string {
    const parts = [`${number(counts.cost.tokens)} tokens`];
    if (counts.tokensPerVerified !== null) parts.push(`${number(counts.tokensPerVerified)} per checked result`);
    else if (counts.tokensPerResult !== null) parts.push(`${number(counts.tokensPerResult)} per result`);
    if (counts.cost.searches > 0) parts.push(plural(counts.cost.searches, 'search', 'searches'));
    if (counts.cost.computeSeconds > 0) parts.push(`${number(counts.cost.computeSeconds)} s of compute`);
    if (counts.cost.heldTokens > 0) parts.push(`${number(counts.cost.heldTokens)} more held and not settled yet`);
    return `${parts.join(', ')}.`;
}

function modelText(row: AssistantOutcomeRow): string | null {
    if (!row.models.length) return null;
    return row.models
        .map((entry) => `${entry.provider || 'unknown provider'} / ${entry.model || 'unknown model'}, prompt ${entry.prompt || 'not recorded'} (${plural(entry.runs, 'run')})`)
        .join('; ');
}

export function OutcomeSummary() {
    const [days, setDays] = useState(14);
    const query = useQuery({ queryKey: keys.assistantOutcomes(days), queryFn: () => api.assistantOutcomes(days), retry: false });
    const data = query.data?.outcomes;
    // Nothing delegated: there is nothing to summarize, and nothing to say about it.
    if (!data || data.responsibilities.length === 0) return null;
    const notMeasured = data.notMeasured.map((id) => NOT_MEASURED_TEXT[id] || id);

    return (
        <section className="list-card" style={{ marginTop: 22 }} aria-labelledby="outcome-summary-title" data-testid="outcome-summary">
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <h2 id="outcome-summary-title">What your responsibilities did</h2>
                <label className="hint">
                    Period{' '}
                    <select value={days} onChange={(event) => setDays(Number(event.target.value))} data-testid="outcome-period">
                        {PERIODS.map((value) => <option key={value} value={value}>Last {value} days</option>)}
                    </select>
                </label>
            </div>
            <p className="hint" style={{ maxWidth: 720 }}>
                A checked result is one the system verified itself: a plan step whose files exist, or a repair whose next run worked.
                A reported finding is what a run told you, and nothing checked it.
            </p>
            <ul>
                {data.responsibilities.map((row) => {
                    const attention = attentionText(row);
                    const models = modelText(row);
                    return (
                        <li key={row.id} data-testid="outcome-row" data-responsibility={row.id}>
                            <strong>{row.title}</strong>
                            {row.status !== 'ACTIVE' && <span className="hint"> ({row.status.toLowerCase().replace('_', ' ')})</span>}
                            <div data-testid="outcome-results">{resultsText(row)}</div>
                            {attention && <div className="hint" data-testid="outcome-attention">{attention}</div>}
                            <div className="hint" data-testid="outcome-cost">Cost: {costText(row)}</div>
                            {models && <div className="hint" data-testid="outcome-models">Ran on {models}.</div>}
                        </li>
                    );
                })}
            </ul>
            <p data-testid="outcome-totals">
                <strong>In total:</strong> {resultsText(data.totals)} Cost: {costText(data.totals)}
            </p>
            <p className="hint" style={{ maxWidth: 720 }} data-testid="outcome-not-measured">
                {data.totals.cost.provisional || data.costSource === 'runs' ? 'Token figures are not final yet. ' : ''}
                This counts what happened. It cannot tell {notMeasured.join(', ')}: those are yours to record.
                Runs started now are given prompt {data.prompt}.
            </p>
        </section>
    );
}
