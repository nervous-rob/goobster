/**
 * Nonmodal tutorial guide panel (F1 shell + F2 authored steps).
 *
 * Shows step copy, isolated sample demos, Next / Skip step / Finish, and an
 * optional Keep this example action. Never covers the target control forever;
 * missing anchors explain themselves. Tour events never write user knowledge.
 */

import { useState } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useTutorials } from './TutorialProvider';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { ApiError } from '../lib/api';
import { resolveRoom, roomDisplayName } from '../lib/rooms';
import type { TutorialCatalogEntry, TutorialProgress, TutorialSample } from '../lib/types';

type Step = TutorialCatalogEntry['steps'][number];

function SampleAnswer({ sample }: { sample: TutorialSample }) {
    return (
        <div className="tutorial-demo" data-tour="tutorial-demo">
            <div className="tutorial-demo-kicker">Sample only · no provider call</div>
            <p className="tutorial-demo-q"><span className="tutorial-demo-role">You</span>{sample.question}</p>
            <p className="tutorial-demo-a">
                <span className="tutorial-demo-role">Goobster</span>
                <strong>{sample.answer.heading}</strong><br />{sample.answer.body}
            </p>
        </div>
    );
}

function NoteCard({ note, highlightTag }: { note: TutorialSample['notes'][number]; highlightTag?: string }) {
    return (
        <div className="tutorial-note">
            <div className="tutorial-note-head">
                <strong>{note.label}</strong>
                <span className="tutorial-pill">{note.audience}</span>
            </div>
            <div className="tutorial-note-body">{note.content}</div>
            <div className="tutorial-tags">
                {note.tags.map((tag) => (
                    <span key={tag} className={`tutorial-tag${tag === highlightTag ? ' is-shared' : ''}`}>#{tag}</span>
                ))}
            </div>
        </div>
    );
}

function Hop({ from, to, note }: { from: string; to: string; note?: string }) {
    return (
        <div className="tutorial-hop" aria-label={`${from} to ${to}`}>
            <span>{from}</span>
            <span className="tutorial-hop-arrow" aria-hidden="true">→</span>
            <span>{to}</span>
            {note && <span className="tutorial-hop-note">{note}</span>}
        </div>
    );
}

function DemoBlock({ demo, sample }: { demo: string; sample: TutorialSample }) {
    const anemones = sample.notes[0];
    switch (demo) {
        case 'sample-answer':
            return <SampleAnswer sample={sample} />;
        case 'chat-to-note':
        case 'save-as-note':
        case 'create-note':
            return (
                <div className="tutorial-demo" data-tour="tutorial-demo">
                    <div className="tutorial-demo-kicker">Sample result · not in your Knowledge yet</div>
                    {demo !== 'create-note' && <Hop from="Answer in Chat" to="Knowledge · Notes" note="Save as note" />}
                    <NoteCard note={anemones} />
                    <p className="tutorial-demo-where">Lives under Knowledge → Notes as something you kept. Never under Personal memory.</p>
                </div>
            );
        case 'connect-tags':
            return (
                <div className="tutorial-demo" data-tour="tutorial-demo">
                    <div className="tutorial-demo-kicker">Two sample notes · one shared tag</div>
                    {sample.notes.map((note) => <NoteCard key={note.id} note={note} highlightTag="observation" />)}
                    <p className="tutorial-demo-where">On the Map, <span className="tutorial-tag is-shared">#observation</span> is the line that joins them.</p>
                </div>
            );
        case 'note-to-project':
        case 'add-to-project':
        case 'reuse-in-project':
            return (
                <div className="tutorial-demo" data-tour="tutorial-demo">
                    <div className="tutorial-demo-kicker">Sample project · nothing is filed</div>
                    <Hop from={anemones.label} to={sample.project.name} note="Add to project…" />
                    <div className="tutorial-note">
                        <div className="tutorial-note-head">
                            <strong>{sample.project.name}</strong>
                            <span className="tutorial-pill">{sample.project.audience}</span>
                        </div>
                        <div className="tutorial-note-body">{sample.project.goal}</div>
                    </div>
                    <p className="tutorial-demo-where">A reference into a private project you own; a published copy when others can read.</p>
                </div>
            );
        case 'open-unfiled':
        case 'inspect-origin':
        case 'add-to-sample-project':
        case 'inspect-audience':
            return (
                <div className="tutorial-demo" data-tour="tutorial-demo">
                    <div className="tutorial-demo-kicker">Sample unfiled app</div>
                    <div className="tutorial-note">
                        <div className="tutorial-note-head">
                            <strong>{sample.app.title}</strong>
                            <span className="tutorial-pill">v{sample.app.version}</span>
                        </div>
                        {demo !== 'open-unfiled' && <div className="tutorial-note-body">{sample.app.origin}</div>}
                    </div>
                    {demo === 'add-to-sample-project' && (
                        <Hop from="Unfiled apps" to={sample.project.name} note="Add to project" />
                    )}
                    {demo === 'inspect-audience' && (
                        <p className="tutorial-demo-where">Audience: <strong>{sample.project.audience}</strong>. Publishing or inviting is a separate, explicit action.</p>
                    )}
                </div>
            );
        default:
            return null;
    }
}

function StepDots({ entry, progress }: { entry: TutorialCatalogEntry; progress: TutorialProgress }) {
    return (
        <ol className="tutorial-dots" aria-label={`${entry.steps.length} steps`}>
            {entry.steps.map((s) => {
                const state = s.id === progress.currentStepId
                    ? 'current'
                    : progress.completedStepIds.includes(s.id)
                        ? 'done'
                        : progress.skippedStepIds.includes(s.id)
                            ? 'skipped'
                            : progress.unavailableStepIds.includes(s.id)
                                ? 'unavailable'
                                : 'todo';
                return (
                    <li
                        key={s.id}
                        className={`tutorial-dot is-${state}`}
                        aria-current={state === 'current' ? 'step' : undefined}
                        title={`${s.title}${state === 'skipped' ? ' (skipped)' : state === 'unavailable' ? ' (unavailable)' : ''}`}
                    />
                );
            })}
        </ol>
    );
}

function roomLabelFor(path: string): string {
    const name = roomDisplayName(path);
    return name === 'where you were' ? path : name;
}

export function TutorialPanel() {
    const {
        active, offer, data, pause, skipTutorial, completeStep, skipStep,
        keepExample, acceptOffer, dismissOffer
    } = useTutorials();
    const toast = useToast();
    const confirm = useConfirm();
    const pathname = useRouterState({ select: (s) => s.location.pathname });
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
                    <div className="tutorial-panel-title">{soft ? 'New tours are available' : 'A short orientation'}</div>
                    <p className="hint">
                        {soft
                            ? `Take “${offer.title}” when you have a minute — or turn tours off in Settings.`
                            : `“${offer.title}” introduces Chat, Knowledge, Projects, and where your results live. Pause anytime.`}
                    </p>
                </div>
                <div className="tutorial-panel-actions">
                    <button type="button" className="btn subtle" data-tour="tutorial-offer-dismiss" onClick={dismissOffer}>
                        Not now
                    </button>
                    <button type="button" className="btn primary tutorial-advance" data-tour="tutorial-offer-start" onClick={() => void acceptOffer()}>
                        {soft ? 'Start tour' : 'Start'}
                    </button>
                </div>
            </aside>
        );
    }

    if (!active) return null;

    const { entry, progress } = active;
    const step: Step | null = entry.steps.find((s) => s.id === progress.currentStepId) || null;
    const stepIndex = step ? entry.steps.findIndex((s) => s.id === step.id) : -1;
    const isLast = stepIndex >= 0 && stepIndex === entry.steps.length - 1;
    const noSteps = entry.steps.length === 0;
    const sample = data?.sample;

    const stepRoom = step?.path ? resolveRoom(step.path) : null;
    const hereRoom = resolveRoom(pathname);
    const elsewhere = Boolean(stepRoom) && stepRoom !== hereRoom;
    const anchorMissing = Boolean(step?.anchorId) && typeof document !== 'undefined'
        && !document.querySelector(`[data-tour="${step!.anchorId}"]`);
    const roomLabel = step?.path ? roomLabelFor(step.path) : '';

    async function act(label: string, fn: () => Promise<void>) {
        setBusy(true);
        try {
            await fn();
        } catch (error) {
            if (error instanceof ApiError && (error.code === 'STALE_GENERATION' || error.code === 'STALE_REVISION')) {
                toast('This tour moved on in another tab — refreshed.');
            } else {
                toast((error as Error).message || `Could not ${label}.`, true);
            }
        } finally {
            setBusy(false);
        }
    }

    async function onKeep(pieceId: string) {
        const piece = sample?.notes.find((n) => n.id === pieceId);
        const preview = piece
            ? `Keep “${piece.label}” as a Private note in your Knowledge?\n\n${piece.content}\n\nThis is the only thing the tour ever saves — and only because you chose to.`
            : 'Keep this sample note in your Knowledge?';
        if (!await confirm(preview)) return;
        await act('keep the example', async () => {
            const result = await keepExample(pieceId);
            toast(result.alreadyHad
                ? `You already have “${result.label}”.`
                : `Kept “${result.label}” under Knowledge → Notes.`);
        });
    }

    return (
        <aside
            className="tutorial-panel"
            role="region"
            aria-label={`${entry.title} tutorial`}
            aria-live="polite"
            aria-keyshortcuts="Escape"
            data-tour="tutorial-panel"
            data-tutorial-id={entry.id}
            data-tutorial-status={progress.status}
            data-step-id={progress.currentStepId || undefined}
        >
            <div className="tutorial-panel-body">
                <div className="tutorial-panel-head">
                    <div className="tutorial-panel-title">
                        {entry.title}
                        {stepIndex >= 0 && (
                            <span className="hint"> · {stepIndex + 1} of {entry.steps.length}</span>
                        )}
                    </div>
                    {!noSteps && <StepDots entry={entry} progress={progress} />}
                </div>
                {noSteps && (
                    <p className="hint" data-tour="tutorial-no-steps">
                        This tour’s steps arrive in a later update. You can pause, skip, or reset it in Settings — resetting never changes your notes, projects, or hidden tools.
                    </p>
                )}
                {step && (
                    <>
                        <strong className="tutorial-step-title" data-tour="tutorial-step-title">{step.title}</strong>
                        {step.body && <p className="hint tutorial-step-body" data-tour="tutorial-step-body">{step.body}</p>}
                        {step.demo && sample && <DemoBlock demo={step.demo} sample={sample} />}
                        {step.keepablePieceId && (
                            <div className="tutorial-keep">
                                <span className="hint">Nothing is saved unless you choose to.</span>
                                <button
                                    type="button"
                                    className="btn subtle small"
                                    data-tour="tutorial-keep-example"
                                    disabled={busy}
                                    onClick={() => void onKeep(step.keepablePieceId!)}
                                >
                                    Keep this example…
                                </button>
                            </div>
                        )}
                        {step.path && elsewhere && (
                            <p className="hint tutorial-elsewhere" data-tour="tutorial-missing-anchor">
                                This step happens in {roomLabel}.{' '}
                                <Link to={step.path as never} data-tour="tutorial-goto">Open {roomLabel} →</Link>
                            </p>
                        )}
                        {anchorMissing && !elsewhere && (
                            <p className="hint tutorial-elsewhere" data-tour="tutorial-missing-anchor">
                                The control this step points at isn’t on screen right now. Skip the step or come back to it — the room stays usable either way.
                            </p>
                        )}
                    </>
                )}
                {progress.unavailableStepIds.length > 0 && (
                    <p className="hint" data-tour="tutorial-unavailable">
                        {progress.unavailableStepIds.length} step{progress.unavailableStepIds.length === 1 ? '' : 's'} unavailable on this account.
                    </p>
                )}
            </div>
            <div className="tutorial-panel-actions">
                <button type="button" className="btn subtle" data-tour="tutorial-pause" title="Pause (Esc)" disabled={busy}
                    onClick={() => void act('pause', pause)}>
                    Pause
                </button>
                <button type="button" className="btn subtle" data-tour="tutorial-skip" disabled={busy}
                    onClick={() => void act('skip the tutorial', skipTutorial)}>
                    Skip this tutorial
                </button>
                {!noSteps && step && (
                    <button type="button" className="btn subtle tutorial-advance" data-tour="tutorial-skip-step" disabled={busy}
                        onClick={() => void act('skip the step', skipStep)}>
                        Skip step
                    </button>
                )}
                {!noSteps && step && !isLast && (
                    <button type="button" className="btn primary" data-tour="tutorial-next" disabled={busy}
                        onClick={() => void act('continue', completeStep)}>
                        Next
                    </button>
                )}
                {!noSteps && step && isLast && (
                    <button type="button" className="btn primary" data-tour="tutorial-finish" disabled={busy}
                        onClick={() => void act('finish', completeStep)}>
                        Finish
                    </button>
                )}
            </div>
        </aside>
    );
}
