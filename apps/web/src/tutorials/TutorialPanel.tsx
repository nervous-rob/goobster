/**
 * Nonmodal tutorial guide panel (F1 shell + F2 authored steps).
 *
 * Shows step copy, isolated sample demos, Next / Skip step / Finish, and an
 * optional Keep this example action. Never covers the target control forever;
 * missing anchors explain themselves. Tour events never write user knowledge.
 */

import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useTutorials } from './TutorialProvider';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import type { TutorialSample } from '../lib/types';

function DemoBlock({ demo, sample }: { demo: string; sample: TutorialSample }) {
    if (demo === 'sample-answer' || demo === 'chat-to-note' || demo === 'save-as-note') {
        return (
            <div className="tutorial-demo" data-tour="tutorial-demo">
                <div className="tutorial-demo-kicker">Sample only · no provider call</div>
                <p className="tutorial-demo-q"><strong>Q.</strong> {sample.question}</p>
                <p className="tutorial-demo-a"><strong>{sample.answer.heading}</strong><br />{sample.answer.body}</p>
            </div>
        );
    }
    if (demo === 'create-note' || demo === 'connect-tags') {
        return (
            <div className="tutorial-demo" data-tour="tutorial-demo">
                <div className="tutorial-demo-kicker">Sample notes · not in your Knowledge yet</div>
                <ul className="tutorial-demo-list">
                    {sample.notes.map((note) => (
                        <li key={note.id}>
                            <strong>{note.label}</strong>
                            <span className="hint"> · {note.audience} · {note.tags.join(', ')}</span>
                            <div className="hint">{note.content}</div>
                        </li>
                    ))}
                </ul>
            </div>
        );
    }
    if (demo === 'note-to-project' || demo === 'add-to-project' || demo === 'reuse-in-project') {
        return (
            <div className="tutorial-demo" data-tour="tutorial-demo">
                <div className="tutorial-demo-kicker">Sample project · Private</div>
                <p><strong>{sample.project.name}</strong></p>
                <p className="hint">{sample.project.goal}</p>
                <p className="hint">Audience: {sample.project.audience}. Reference from a private project you own; publish a copy when others can read.</p>
            </div>
        );
    }
    if (demo === 'open-unfiled' || demo === 'inspect-origin' || demo === 'add-to-sample-project' || demo === 'inspect-audience') {
        return (
            <div className="tutorial-demo" data-tour="tutorial-demo">
                <div className="tutorial-demo-kicker">Sample unfiled app</div>
                <p><strong>{sample.app.title}</strong></p>
                <p className="hint">{sample.app.origin} · v{sample.app.version}</p>
                <p className="hint">Destination: {sample.project.name} ({sample.project.audience}).</p>
            </div>
        );
    }
    return null;
}

export function TutorialPanel() {
    const {
        active, offer, data, pause, skipTutorial, completeStep, skipStep,
        keepExample, acceptOffer, dismissOffer
    } = useTutorials();
    const toast = useToast();
    const confirm = useConfirm();
    const [busy, setBusy] = useState(false);

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
    const stepIndex = step ? entry.steps.findIndex((s) => s.id === step.id) : -1;
    const isLast = stepIndex >= 0 && stepIndex === entry.steps.length - 1;
    const missingAnchor = Boolean(step?.anchorId) && typeof document !== 'undefined'
        && !document.querySelector(`[data-tour="${step!.anchorId}"]`);
    const noSteps = entry.steps.length === 0;
    const sample = data?.sample;

    async function onKeep(pieceId: string) {
        const piece = sample?.notes.find((n) => n.id === pieceId);
        const preview = piece
            ? `Keep “${piece.label}” as a Private note in your Knowledge?\n\n${piece.content}\n\nThis is the only write — the tour itself never files sample content.`
            : 'Keep this sample note in your Knowledge?';
        if (!await confirm(preview)) return;
        setBusy(true);
        try {
            const result = await keepExample(pieceId);
            toast(result.alreadyHad
                ? `You already have “${result.label}”.`
                : `Kept “${result.label}” under Knowledge → Notes.`);
        } catch (error) {
            toast((error as Error).message || 'Could not keep the example.', true);
        } finally {
            setBusy(false);
        }
    }

    return (
        <aside
            className="tutorial-panel"
            role="region"
            aria-label={`${entry.title} tutorial`}
            aria-live="polite"
            data-tour="tutorial-panel"
            data-tutorial-id={entry.id}
            data-tutorial-status={progress.status}
            data-step-id={progress.currentStepId || undefined}
        >
            <div className="tutorial-panel-body">
                <div className="tutorial-panel-title">
                    {entry.title}
                    {stepIndex >= 0 && (
                        <span className="hint"> · {stepIndex + 1} of {entry.steps.length}</span>
                    )}
                </div>
                {noSteps && (
                    <p className="hint" data-tour="tutorial-no-steps">
                        This tour’s steps arrive in a later update. You can pause, skip, or reset it in Settings — resetting never changes your notes, projects, or hidden tools.
                    </p>
                )}
                {step && (
                    <>
                        <strong data-tour="tutorial-step-title">{step.title}</strong>
                        {step.body && <p className="hint" data-tour="tutorial-step-body">{step.body}</p>}
                        {step.path && (
                            <p className="hint">
                                <Link to={step.path as never} data-tour="tutorial-goto">Open {step.path}</Link>
                                {step.anchorId ? ` · looks for [${step.anchorId}]` : ''}
                            </p>
                        )}
                        {step.demo && sample && <DemoBlock demo={step.demo} sample={sample} />}
                        {step.keepablePieceId && (
                            <button
                                type="button"
                                className="btn subtle small"
                                data-tour="tutorial-keep-example"
                                disabled={busy}
                                onClick={() => void onKeep(step.keepablePieceId!)}
                            >
                                Keep this example…
                            </button>
                        )}
                    </>
                )}
                {missingAnchor && (
                    <p className="hint" data-tour="tutorial-missing-anchor">
                        The control this step points at is not on the page right now. Skip the step or continue when you find it — the room stays usable either way.
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
                {!noSteps && step && (
                    <button type="button" className="btn subtle" data-tour="tutorial-skip-step" disabled={busy}
                        onClick={() => void skipStep()}>
                        Skip step
                    </button>
                )}
                <button type="button" className="btn subtle" data-tour="tutorial-skip" disabled={busy}
                    onClick={() => void skipTutorial()}>
                    Skip this tutorial
                </button>
                {!noSteps && step && !isLast && (
                    <button type="button" className="btn primary" data-tour="tutorial-next" disabled={busy}
                        onClick={() => void completeStep()}>
                        Next
                    </button>
                )}
                {!noSteps && step && isLast && (
                    <button type="button" className="btn primary" data-tour="tutorial-finish" disabled={busy}
                        onClick={() => void completeStep()}>
                        Finish
                    </button>
                )}
            </div>
        </aside>
    );
}
