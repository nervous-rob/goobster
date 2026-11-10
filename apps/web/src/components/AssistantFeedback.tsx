import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import type { AssistantFeedbackKind, AssistantFeedbackState } from '../lib/types';

/**
 * Feedback on one finding or one piece of proposed work
 * (documentation/delegated_feedback.md).
 *
 * The server says which kinds have an effect on this item; only those are
 * shown, each with the one thing it changes. The answer is the server's own
 * sentence about what it did. "Stop this responsibility" is the ordinary
 * pause or revoke: it asks the same confirmation and sends the revision of
 * the responsibility the person was shown.
 */

const KIND_TEXT: Record<AssistantFeedbackKind, { label: string; effect: string }> = {
    useful: { label: 'Useful', effect: 'Counts in favour of this source for this responsibility.' },
    already_knew: { label: 'Already knew', effect: 'Counts against this source for this responsibility. Nothing else changes.' },
    wrong: { label: 'This is wrong', effect: 'Marks the note this wrote as disputed. Nothing is deleted, and you can undo it.' },
    less_of_this: { label: 'Less of this', effect: 'This source may propose fewer of these a day for this responsibility. You can reset it there.' },
    wrong_time: { label: 'Wrong time', effect: 'Nothing from your responsibilities is sent at the hour this arrived. What is looked for does not change.' },
    keep_wording: { label: 'Keep this wording', effect: 'Keeps the note this wrote as it is. It becomes yours and is not rewritten.' },
    stop_responsibility: { label: 'Stop this responsibility', effect: 'Pause or revoke the responsibility this came from.' }
};

const STOP_TEXT: Record<'pause' | 'revoke', { label: string; question: (title: string) => string }> = {
    pause: { label: 'Pause', question: (title) => `Pause "${title}"? Nothing new starts until you resume it. Nothing is deleted.` },
    revoke: { label: 'Revoke', question: (title) => `Revoke "${title}"? Its open work is cancelled now and it cannot be turned back on.` }
};

export function AssistantFeedback({ state, target }: {
    state: AssistantFeedbackState | null | undefined;
    target: { updateId: number } | { initiativeId: number };
}) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [stopping, setStopping] = useState(false);
    // What the last answer left to say: the lists refetch right after, this covers the moment between.
    const [answered, setAnswered] = useState<AssistantFeedbackState | null>(null);
    const current = answered || state;
    if (!current || (!current.offered.length && !current.given.length)) return null;
    const id = 'updateId' in target ? `update-${target.updateId}` : `initiative-${target.initiativeId}`;

    async function say(kind: AssistantFeedbackKind, stop?: 'pause' | 'revoke') {
        if (kind === 'stop_responsibility') {
            if (!stop || !current?.stop) return;
            if (!await confirm(STOP_TEXT[stop].question(current.stop.title))) return;
        }
        setBusy(true);
        try {
            const result = await api.assistantFeedback(
                target, kind,
                stop && current?.stop ? { action: stop, expectedRevision: current.stop.revision } : undefined
            );
            setAnswered(result.state);
            setStopping(false);
            toast(result.message);
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: keys.home }),
                queryClient.invalidateQueries({ queryKey: keys.responsibilities }),
                queryClient.invalidateQueries({ queryKey: keys.assistantInitiatives }),
                queryClient.invalidateQueries({ queryKey: keys.assistantKnowledge }),
                queryClient.invalidateQueries({ queryKey: keys.settings })
            ]);
            setAnswered(null);
            setBusy(false);
        }
    }

    return (
        <div className="assistant-feedback" data-testid="assistant-feedback">
            {current.given.length > 0 && (
                <span className="hint" data-testid="assistant-feedback-given">
                    You said: {current.given.map((kind) => KIND_TEXT[kind].label.toLowerCase()).join(', ')}
                </span>
            )}
            {current.offered.length > 0 && (
                <button type="button" className="btn subtle small" aria-expanded={open} aria-controls={`feedback-${id}`}
                    onClick={() => setOpen(!open)} data-testid="assistant-feedback-toggle">
                    {open ? 'Close feedback' : 'Feedback'}
                </button>
            )}
            {open && current.offered.length > 0 && (
                <ul id={`feedback-${id}`} className="assistant-feedback-options" data-testid="assistant-feedback-options">
                    {current.offered.map((kind) => (
                        <li key={kind}>
                            {kind === 'stop_responsibility' ? (
                                <>
                                    <button type="button" className="btn small" disabled={busy} aria-expanded={stopping}
                                        onClick={() => setStopping(!stopping)} data-testid="assistant-feedback-stop_responsibility">
                                        {KIND_TEXT[kind].label}
                                    </button>
                                    <span className="hint">{KIND_TEXT[kind].effect}</span>
                                    {stopping && current.stop && (
                                        <span className="assistant-feedback-stop">
                                            {current.stop.actions.map((action) => (
                                                <button key={action} type="button" className={`btn small${action === 'revoke' ? ' danger' : ''}`}
                                                    disabled={busy} onClick={() => void say(kind, action)} data-testid={`assistant-feedback-stop-${action}`}>
                                                    {STOP_TEXT[action].label}
                                                </button>
                                            ))}
                                        </span>
                                    )}
                                </>
                            ) : (
                                <>
                                    <button type="button" className="btn small" disabled={busy}
                                        onClick={() => void say(kind)} data-testid={`assistant-feedback-${kind}`}>
                                        {KIND_TEXT[kind].label}
                                    </button>
                                    <span className="hint">{KIND_TEXT[kind].effect}</span>
                                </>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
