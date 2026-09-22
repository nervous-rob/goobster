/**
 * Settings → Tutorials (Increment F1).
 *
 * Lists every permitted tour with Resume, Replay, Reset one, Reset all, and
 * the account-level auto-start toggle. Resetting tutorials does not change
 * user content, permissions, or appearance.hiddenToolRooms.
 */

import { useState } from 'react';
import { useTutorials } from '../../tutorials/TutorialProvider';
import { useConfirm } from '../../hooks/useConfirm';
import { useToast } from '../../hooks/useToast';
import { Field, SectionHeader } from './SectionFrame';
import { SCOPE_FOR } from './sectionMeta';
import type { TutorialProgress, TutorialStatus } from '../../lib/types';

const STATUS_LABEL: Record<TutorialStatus, string> = {
    not_started: 'Not started',
    in_progress: 'In progress',
    paused: 'Paused',
    skipped: 'Skipped',
    completed: 'Completed',
    finished_with_skips: 'Finished (with skips)'
};

function statusOf(progress: TutorialProgress | undefined): TutorialStatus {
    return progress?.status || 'not_started';
}

export function TutorialsSection() {
    const {
        data, loading, resume, replay, resetOne, resetAll, setAutoStart
    } = useTutorials();
    const confirm = useConfirm();
    const toast = useToast();
    const [busy, setBusy] = useState<string | null>(null);

    async function run(label: string, action: () => Promise<void>) {
        setBusy(label);
        try {
            await action();
        } catch (error) {
            toast((error as Error).message || 'Something went wrong.', true);
        } finally {
            setBusy(null);
        }
    }

    return (
        <section className="settings-section" aria-labelledby="settings-tutorials-title" data-tour="settings-tutorials">
            <SectionHeader id="tutorials" scope={SCOPE_FOR.account} appliesTo={['account']} />

            <Field id="tutorial-auto-start" label="Auto-start tours"
                hint="When on, Home may offer the orientation once, and a room may offer its own tour on first entry. Pause or Escape never seizes focus again. This preference does not rewrite completion history.">
                <button
                    type="button"
                    id="tutorial-auto-start-input"
                    className={`toggle${data?.preferences.autoStart !== false ? ' on' : ''}`}
                    role="switch"
                    aria-checked={data?.preferences.autoStart !== false}
                    aria-label="Auto-start tours"
                    disabled={!data || busy !== null}
                    data-tour="tutorial-auto-start"
                    onClick={() => void run('auto', () => setAutoStart(!(data?.preferences.autoStart !== false)))}
                >
                    <span className="toggle-knob" />
                </button>
            </Field>

            <Field id="tutorial-list" label="Tours"
                hint="Resume continues where you left off. Replay clears that tour and starts again when steps exist. Reset one / Reset all clear progress only — notes, projects, and hidden tools stay put.">
                <div className="list-card" id="tutorial-list-input" data-tour="tutorial-list">
                    {loading && <div className="list-row"><span className="hint">Loading…</span></div>}
                    {!loading && !data && <div className="list-row"><span className="hint">Could not load tutorials.</span></div>}
                    {data?.catalog.map((entry) => {
                        const progress = data.progress.find((p) => p.tutorialId === entry.id);
                        const status = statusOf(progress);
                        const canResume = status === 'in_progress' || status === 'paused'
                            || (status === 'not_started' && entry.launchable);
                        const canReplay = status !== 'not_started';
                        return (
                            <div key={entry.id} className="list-row tutorial-row" data-tutorial-id={entry.id}>
                                <span>
                                    <strong>{entry.title}</strong>
                                    <span className="hint"> · {STATUS_LABEL[status]}
                                        {progress && progress.revision > 0 ? ` · gen ${progress.generation}` : ''}
                                    </span>
                                </span>
                                <span className="tutorial-row-actions">
                                    {canResume && (
                                        <button type="button" className="btn subtle small"
                                            data-tour={`tutorial-resume-${entry.id}`}
                                            disabled={busy !== null}
                                            onClick={() => void run(`resume:${entry.id}`, () => resume(entry.id))}>
                                            Resume
                                        </button>
                                    )}
                                    {canReplay && (
                                        <button type="button" className="btn subtle small"
                                            data-tour={`tutorial-replay-${entry.id}`}
                                            disabled={busy !== null}
                                            onClick={() => void run(`replay:${entry.id}`, () => replay(entry.id))}>
                                            Replay
                                        </button>
                                    )}
                                    <button type="button" className="btn subtle small"
                                        data-tour={`tutorial-reset-${entry.id}`}
                                        disabled={busy !== null || status === 'not_started'}
                                        onClick={() => void run(`reset:${entry.id}`, async () => {
                                            if (!await confirm(`Reset “${entry.title}”? Your notes and projects are untouched.`)) return;
                                            await resetOne(entry.id);
                                            toast(`Reset “${entry.title}”.`);
                                        })}>
                                        Reset
                                    </button>
                                </span>
                            </div>
                        );
                    })}
                </div>
            </Field>

            <Field id="tutorial-reset-all" label="Reset all tours"
                hint="Clears orientation and every permitted tour. They become eligible again on next entry; they do not all open at once. User content and tool visibility are unchanged.">
                <button
                    type="button"
                    className="btn"
                    id="tutorial-reset-all-input"
                    data-tour="tutorial-reset-all"
                    disabled={!data || busy !== null}
                    onClick={() => void run('reset-all', async () => {
                        if (!await confirm('Reset every tutorial? Notes, projects, permissions, and hidden tools stay put.')) return;
                        await resetAll();
                        toast('All tutorials reset.');
                    })}
                >
                    Reset all
                </button>
            </Field>
        </section>
    );
}
