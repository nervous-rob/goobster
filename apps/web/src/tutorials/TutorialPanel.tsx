/**
 * Nonmodal tutorial guide panel (Increment F1 shell).
 *
 * Shows active tour progress, Resume offer, and missing-anchor / no-steps
 * explanations. Never covers the target control on mobile; never spins
 * waiting for an element. A tutorial failure must not break the room.
 */

import { useTutorials } from './TutorialProvider';

export function TutorialPanel() {
    const { active, offer, pause, skipTutorial, acceptOffer, dismissOffer } = useTutorials();

    if (offer && !active) {
        const soft = offer.kind === 'existing';
        return (
            <aside
                className={`tutorial-panel${soft ? ' is-soft' : ''}`}
                role="region"
                aria-label="Tutorial offer"
                data-tour="tutorial-offer"
            >
                <div className="tutorial-panel-body">
                    <strong>{soft ? 'New tours are available' : 'A short orientation'}</strong>
                    <p className="hint">
                        {soft
                            ? `Take “${offer.title}” when you have a minute — or skip it forever in Settings.`
                            : `“${offer.title}” introduces Chat, Knowledge, Projects, and where your results live. You can pause anytime.`}
                    </p>
                </div>
                <div className="tutorial-panel-actions">
                    <button type="button" className="btn primary" data-tour="tutorial-offer-start" onClick={() => void acceptOffer()}>
                        {soft ? 'Start tour' : 'Start'}
                    </button>
                    <button type="button" className="btn subtle" data-tour="tutorial-offer-dismiss" onClick={dismissOffer}>
                        Not now
                    </button>
                </div>
            </aside>
        );
    }

    if (!active) return null;

    const { entry, progress } = active;
    const step = entry.steps.find((s) => s.id === progress.currentStepId) || null;
    const missingAnchor = Boolean(step?.anchorId) && typeof document !== 'undefined'
        && !document.querySelector(`[data-tour="${step!.anchorId}"]`);
    const noSteps = entry.steps.length === 0;

    return (
        <aside
            className="tutorial-panel"
            role="region"
            aria-label={`${entry.title} tutorial`}
            aria-live="polite"
            data-tour="tutorial-panel"
            data-tutorial-id={entry.id}
            data-tutorial-status={progress.status}
        >
            <div className="tutorial-panel-body">
                <div className="tutorial-panel-title">{entry.title}</div>
                {noSteps && (
                    <p className="hint" data-tour="tutorial-no-steps">
                        This tour’s steps arrive in a later update. You can pause, skip, or reset it in Settings — resetting never changes your notes, projects, or hidden tools.
                    </p>
                )}
                {!noSteps && missingAnchor && (
                    <p className="hint" data-tour="tutorial-missing-anchor">
                        The control this step points at is not on the page right now. Skip the step or continue when you find it — the room stays usable either way.
                    </p>
                )}
                {!noSteps && !missingAnchor && progress.currentStepId && (
                    <p className="hint">
                        Step <code>{progress.currentStepId}</code>
                        {progress.completedStepIds.length || progress.skippedStepIds.length
                            ? ` · ${progress.completedStepIds.length} done, ${progress.skippedStepIds.length} skipped`
                            : null}
                    </p>
                )}
                {progress.unavailableStepIds.length > 0 && (
                    <p className="hint" data-tour="tutorial-unavailable">
                        {progress.unavailableStepIds.length} step{progress.unavailableStepIds.length === 1 ? '' : 's'} unavailable on this account.
                    </p>
                )}
            </div>
            <div className="tutorial-panel-actions">
                <button type="button" className="btn subtle" data-tour="tutorial-pause" onClick={() => void pause()}>
                    Pause
                </button>
                <button type="button" className="btn subtle" data-tour="tutorial-skip" onClick={() => void skipTutorial()}>
                    Skip this tutorial
                </button>
            </div>
        </aside>
    );
}
