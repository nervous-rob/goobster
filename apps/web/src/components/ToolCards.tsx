import { useState } from 'react';
import { api } from '../lib/api';
import { requestCompose } from '../hooks/useCompose';
import { ciBadge, DiffView } from './repoParts';
import type { ToolCard } from '../lib/types';

/**
 * Actionable cards under a reply (agentOrchestrator `_card`): a branch
 * comparison with its diff, a CI verdict with what failed, a merge or
 * rebase stopped on conflicts, an opened pull request. Buttons act on the
 * project directly or put a ready-made request in the composer; nothing is
 * sent on the person's behalf.
 */
export function ToolCards({ cards }: { cards: ToolCard[] }) {
    if (cards.length === 0) return null;
    return (
        <div className="tool-cards">
            {cards.map((card, index) => <OneCard key={index} card={card} />)}
        </div>
    );
}

function OneCard({ card }: { card: ToolCard }) {
    const [busy, setBusy] = useState(false);
    const [outcome, setOutcome] = useState<string | null>(null);
    const [showDiff, setShowDiff] = useState(false);

    async function act(action: 'continue' | 'abort') {
        if (card.kind !== 'repo-integration') return;
        setBusy(true);
        try {
            const result = await api.projectRepoAction(card.project, card.name, action, {}, card.owner) as { result?: string; conflicts?: string[] };
            setOutcome(action === 'abort' ? 'Aborted: the branch is back as it was.'
                : result.result === 'conflicted' ? `Stopped again on: ${(result.conflicts || []).join(', ')}`
                    : `Done (${result.result || 'finished'}).`);
        } catch (error) {
            setOutcome((error as Error).message);
        } finally {
            setBusy(false);
        }
    }

    if (card.kind === 'repo-ci') {
        return (
            <div className={`tool-card tool-card-ci is-${card.state}`} data-testid="tool-card">
                <div className="tool-card-head">
                    <strong>CI</strong> · {card.repo} <code>{card.ref}</code> · {ciBadge(card)}
                </div>
                {card.notOnGitHub && <div className="hint">This branch is not on GitHub yet: push it to run CI.</div>}
                {card.failing.map((check) => (
                    <div key={check.name} className="tool-card-row">
                        ❌ {check.url ? <a href={check.url} target="_blank" rel="noreferrer">{check.name}</a> : check.name}
                        <span className="hint"> ({check.conclusion}){check.summary ? ` ${check.summary}` : ''}</span>
                    </div>
                ))}
                {card.pending.length > 0 && <div className="hint">Still running: {card.pending.join(', ')}</div>}
                {card.failing.length > 0 && (
                    <div className="tool-card-actions">
                        <button type="button" className="btn small" onClick={() => requestCompose(
                            `CI is failing on ${card.ref} of ${card.repo} (${card.failing.map((f) => f.name).join(', ')}). `
                            + `Read the failures, fix them in repos/${card.name} in project ${card.project}, commit, push, and check CI again.`
                        )}>Ask Goobster to fix</button>
                    </div>
                )}
            </div>
        );
    }

    if (card.kind === 'repo-integration') {
        const conflicted = card.result === 'conflicted';
        return (
            <div className={`tool-card tool-card-integration${conflicted ? ' is-failure' : ''}`} data-testid="tool-card">
                <div className="tool-card-head">
                    <strong>{card.operation === 'rebase' ? 'Rebase' : 'Merge'}</strong> · {card.base} → {card.branch} · {card.repo}
                    {' · '}{conflicted ? `⚠️ ${card.conflicts.length} conflict(s)` : card.result}
                </div>
                {conflicted && card.conflicts.map((file) => <div key={file} className="tool-card-row"><code>repos/{card.name}/{file}</code></div>)}
                {!conflicted && card.from && card.to && <div className="hint">{card.from} → {card.to}</div>}
                {conflicted && !outcome && (
                    <div className="tool-card-actions">
                        <button type="button" className="btn small" onClick={() => requestCompose(
                            `Resolve the ${card.operation} conflicts in repos/${card.name} (${card.conflicts.join(', ')}) in project ${card.project}: `
                            + 'keep what both sides intended, remove every conflict marker, then continue.'
                        )}>Ask Goobster to resolve</button>
                        <button type="button" className="btn small" disabled={busy} onClick={() => void act('continue')}>Continue</button>
                        <button type="button" className="btn small subtle" disabled={busy} onClick={() => void act('abort')}>Abort</button>
                    </div>
                )}
                {outcome && <div className="hint">{outcome}</div>}
            </div>
        );
    }

    if (card.kind === 'repo-pr') {
        return (
            <div className="tool-card tool-card-pr" data-testid="tool-card">
                <div className="tool-card-head">
                    <strong>Pull request</strong> · <a href={card.url} target="_blank" rel="noreferrer">#{card.number} {card.title}</a>
                    {card.draft ? ' · draft' : ''}
                </div>
                <div className="hint">{card.head} → {card.base} · {card.repo}</div>
                <div className="tool-card-actions">
                    <button type="button" className="btn small" onClick={() => requestCompose(
                        `Check CI on ${card.head} of ${card.repo} (pull request #${card.number}) in project ${card.project}.`
                    )}>Check CI</button>
                </div>
            </div>
        );
    }

    // repo-compare
    return (
        <div className="tool-card tool-card-compare" data-testid="tool-card">
            <div className="tool-card-head">
                <strong>Compare</strong> · {card.head} vs {card.base} · {card.repo}
            </div>
            {card.identical ? <div className="hint">Identical.</div> : (
                <>
                    <div className="hint">
                        {card.ahead ?? '?'} ahead · {card.behind ?? '?'} behind · {card.fileCount} file(s) +{card.additions} −{card.deletions}
                    </div>
                    {card.files.slice(0, 12).map((file) => (
                        <div key={file.path} className="tool-card-row hint">{file.binary ? 'binary' : `+${file.additions} −${file.deletions}`} {file.path}</div>
                    ))}
                    {card.fileCount > 12 && <div className="hint">… and {card.fileCount - 12} more</div>}
                    <div className="tool-card-actions">
                        {card.patch && (
                            <button type="button" className="btn small" onClick={() => setShowDiff((value) => !value)}>
                                {showDiff ? 'Hide diff' : 'Show diff'}
                            </button>
                        )}
                        <button type="button" className="btn small" onClick={() => requestCompose(
                            `Open a pull request from ${card.head} into ${card.base} on ${card.repo} (repos/${card.name} in project ${card.project}) `
                            + 'with a title and description that summarize these changes.'
                        )}>Ask for a pull request</button>
                    </div>
                    {showDiff && <DiffView text={card.patch} />}
                    {showDiff && card.truncated && <div className="hint">Diff truncated: the Code view has the rest.</div>}
                </>
            )}
        </div>
    );
}
