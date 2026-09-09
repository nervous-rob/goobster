import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import type { RetentionPreviewResponse, UserSettingsResponse } from '../../lib/types';
import { useApplySectionResult } from '../../hooks/useUserSettings';
import { useToast } from '../../hooks/useToast';
import { Modal } from '../../components/Modal';
import { Field, SectionHeader } from './SectionFrame';
import { SCOPE_FOR } from './sectionMeta';
import { useForgetOpener } from '../../shell/AppShell';

type ReportPayload = {
    facts: unknown[];
    memories: { count: number; oldest?: string; newest?: string };
    conversations: { messages: number; count: number };
    followups: unknown[];
    applets?: number;
};

const RETENTION_OPTIONS: Array<{ value: number | null; label: string }> = [
    { value: null, label: 'Keep forever' },
    { value: 30, label: 'After 30 days' },
    { value: 90, label: 'After 90 days' },
    { value: 180, label: 'After 180 days' },
    { value: 365, label: 'After a year' }
];

/**
 * Memory & privacy has no Save bar on purpose: every control here is either
 * read-only or destructive, and destructive actions get their own flow with
 * a read-only preview, an explicit confirm, and a real result count.
 */
export function MemorySection({ section, userId }: {
    section: UserSettingsResponse['sections']['memory'];
    userId: string;
}) {
    const toast = useToast();
    const queryClient = useQueryClient();
    const applyResult = useApplySectionResult();
    const openForget = useForgetOpener();
    const scope = `dm:${userId}`;

    const current = section.values.retentionDays ?? null;
    const options = [...RETENTION_OPTIONS];
    if (current && !options.some((o) => o.value === current)) {
        options.push({ value: current, label: `After ${current} days` });
        options.sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity));
    }

    const [preview, setPreview] = useState<RetentionPreviewResponse | null>(null);
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<number | null>(current);

    const report = useQuery({
        queryKey: keys.memory(scope, 'overview'),
        queryFn: () => api.report(scope) as Promise<ReportPayload>
    });

    async function chooseRetention(value: number | null) {
        setPending(value);
        if (value === current) return;
        setBusy(true);
        try {
            setPreview(await api.retentionPreview(value));
        } catch (error) {
            toast((error as Error).message, true);
            setPending(current);
        } finally {
            setBusy(false);
        }
    }

    function cancelPreview() {
        setPreview(null);
        setPending(current);
    }

    async function applyRetention() {
        if (!preview) return;
        setBusy(true);
        try {
            const result = await api.applyRetention(preview.proposedRetentionDays, preview.currentRevision);
            applyResult(result);
            setPreview(null);
            await queryClient.invalidateQueries({ queryKey: keys.memory(scope, 'overview') });
            toast(result.data.values.retentionDays
                ? `Memories now expire after ${result.data.values.retentionDays} days${result.purged ? ` — ${result.purged} deleted now` : ''}.`
                : 'Memories are kept forever again.');
        } catch (error) {
            toast((error as Error).message, true);
            setPending(current);
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="settings-section" aria-labelledby="settings-memory-title">
            <SectionHeader id="memory" scope={SCOPE_FOR[section.scope]} appliesTo={section.appliesTo} />

            <Field id="retention" label="Auto-delete memories"
                hint="Raw memories from your DMs and Study chats older than this window are deleted — immediately when you shorten it, then nightly. Distilled facts and chat transcripts are separate and are not affected. Servers set their own window with /privacy.">
                <select id="retention-input" className="select" value={pending === null ? '' : String(pending)} disabled={busy}
                    onChange={(e) => void chooseRetention(e.target.value === '' ? null : Number(e.target.value))}>
                    {options.map((o) => <option key={o.value ?? 'forever'} value={o.value ?? ''}>{o.label}</option>)}
                </select>
                <div className="hint">Currently: <strong>{current ? `after ${current} days` : 'kept forever'}</strong>.</div>
            </Field>

            <Field id="memory-report" label="What Goobster knows about you"
                hint="A live count of what he holds in your private scope. Review and delete individual memories and facts in Spitball.">
                <div className="list-card settings-report" id="memory-report-input">
                    {report.isPending && <div className="list-row"><span className="hint">Counting…</span></div>}
                    {report.isError && <div className="list-row"><span className="hint">{(report.error as Error).message}</span></div>}
                    {report.data && (
                        <>
                            <div className="list-row"><span>Memories</span><strong>{report.data.memories?.count ?? 0}</strong></div>
                            <div className="list-row"><span>Distilled facts</span><strong>{report.data.facts?.length ?? 0}</strong></div>
                            <div className="list-row"><span>Study conversations</span><strong>{report.data.conversations?.count ?? 0}</strong></div>
                            <div className="list-row"><span>Follow-ups</span><strong>{report.data.followups?.length ?? 0}</strong></div>
                        </>
                    )}
                </div>
                <div className="settings-inline-row">
                    <Link to="/spitball" className="btn">Open Spitball →</Link>
                </div>
            </Field>

            <Field id="forget-me" label="Forget me"
                hint="Erases every row Goobster has about you — memories, facts, chats, settings, sessions — and signs you out. This is separate from resetting preferences and cannot be undone.">
                <button id="forget-me-input" type="button" className="btn danger" onClick={openForget}>Forget me…</button>
            </Field>

            {preview && (
                <Modal onClose={cancelPreview}>
                    <h2>{preview.proposedRetentionDays ? `Auto-delete after ${preview.proposedRetentionDays} days?` : 'Keep memories forever?'}</h2>
                    {preview.proposedRetentionDays ? (
                        <>
                            <p className="hint">
                                Affects <strong>memories</strong> in your private scope only. Facts, transcripts, and server memories are untouched.
                            </p>
                            <div className="list-card">
                                <div className="list-row"><span>Memories you have</span><strong>{preview.memoryCount}</strong></div>
                                <div className="list-row"><span>Deleted right now</span><strong className={preview.affectedCount ? 'settings-danger' : ''}>{preview.affectedCount}</strong></div>
                            </div>
                            <p className="hint">Nothing has been deleted yet. Cancel keeps everything as it is.</p>
                        </>
                    ) : (
                        <p className="hint">Nothing is deleted; new memories simply stop expiring.</p>
                    )}
                    <div className="modal-actions">
                        <button type="button" className="btn" onClick={cancelPreview} disabled={busy}>Cancel</button>
                        <button type="button" className={`btn ${preview.affectedCount ? 'danger' : 'primary'}`} onClick={applyRetention} disabled={busy}>
                            {busy ? 'Applying…' : preview.affectedCount ? `Delete ${preview.affectedCount} and apply` : 'Apply'}
                        </button>
                    </div>
                </Modal>
            )}
        </section>
    );
}
