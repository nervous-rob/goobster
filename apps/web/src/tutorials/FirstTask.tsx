import { useState } from 'react';
import { useTutorials } from './TutorialProvider';
import { useConfirm } from '../hooks/useConfirm';
import { useToast } from '../hooks/useToast';
import type { TutorialSample } from '../lib/types';

/** Practice actions use only static evidence and existing tutorial progress. */
export function FirstTask({ stepId, sample }: { stepId: string; sample: TutorialSample }) {
    const { completeStep, keepExample, active } = useTutorials();
    const confirm = useConfirm();
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const [inspected, setInspected] = useState(false);
    const [answer, setAnswer] = useState('');
    const task = sample.firstTask;
    const accepted = active?.progress.completedStepIds.includes('accept');
    async function act(work?: () => Promise<void>) {
        setBusy(true);
        try {
            if (work) await work();
            await completeStep();
        } catch (error) {
            toast((error as Error).message || 'Could not save progress. Please retry.', true);
        } finally { setBusy(false); }
    }
    async function keep() {
        const note = sample.notes[0];
        if (!await confirm(`Keep “${note.label}” as a Private sample note?\n\n${note.content}\n\nThis fictional example will appear in Knowledge, labelled as tutorial material.`)) return;
        await act(async () => { await keepExample(note.id); });
    }
    function download() {
        const blob = new Blob([`${task.brief}\nAccepted by you for this practice task only.\n`], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'sample-coastal-walk-brief.md';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return <div className="tutorial-demo" data-tour="first-task-demo">
        <p className="tutorial-demo-kicker">Fictional sample · no provider calls · no token cost</p>
        {stepId === 'question' && <>
            <p>{task.question}</p>
            <button className="btn primary" disabled={busy} onClick={() => void act()}>Use this sample question</button>
        </>}
        {stepId === 'research' && <>
            <p>Question: {task.question}</p>
            <p>Budget: one sample pass, two prepared records, one note. A live run can fail or lack evidence; never substitute this sample for a real result.</p>
            <button className="btn primary" disabled={busy} onClick={() => void act()}>Run the sample pass</button>
        </>}
        {stepId === 'evidence' && <>
            <p><strong>Claim:</strong> {task.claim}</p>
            <button className="btn" aria-expanded={inspected} onClick={() => setInspected(!inspected)}>Inspect source</button>
            {inspected && <>
                <blockquote>{task.source}</blockquote>
                <label>Does this establish the full species diversity of the coast?
                    <select className="select" value={answer} onChange={e => setAnswer(e.target.value)}>
                        <option value="">Choose an answer</option><option value="yes">Yes</option><option value="no">No, only this observation</option>
                    </select>
                </label>
                {answer === 'yes' && <p role="status">A single field log cannot establish full species diversity. Check the scope of the claim.</p>}
                <button className="btn primary" disabled={busy || answer !== 'no'} onClick={() => void act()}>Evidence checked</button>
            </>}
        </>}
        {stepId === 'keep' && <>
            <strong>{sample.notes[0].label}</strong><p>{sample.notes[0].content}</p>
            <button className="btn primary" disabled={busy} onClick={() => void keep()}>Keep this example…</button>
        </>}
        {(stepId === 'accept' || stepId === 'export') && <>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' }}>{task.brief}</pre>
            {stepId === 'accept' && <button className="btn primary" disabled={busy} onClick={() => void act()}>Accept this sample brief</button>}
            {stepId === 'export' && (accepted
                ? <button className="btn primary" disabled={busy} onClick={() => void act(async () => download())}>Download sample brief and finish</button>
                : <p>You skipped acceptance. Skip this step too, or reset the task in Settings → Tutorials to review the brief again.</p>)}
        </>}
        <p className="hint">Pause or skip anytime. Progress is saved to your account. No permissions, memory learning, or Attention settings change.</p>
    </div>;
}
