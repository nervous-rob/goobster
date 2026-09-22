import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import type { ChatHistoryPreviewResponse, RetentionPreviewResponse, UserSettingsResponse } from '../../lib/types';
import { diffKeys, useApplySectionResult, useReportDirty, useSectionDraft } from '../../hooks/useUserSettings';
import { useToast } from '../../hooks/useToast';
import { Modal } from '../../components/Modal';
import { Field, SaveBar, SectionHeader } from './SectionFrame';
import { SCOPE_FOR } from './sectionMeta';
import { useForgetOpener } from '../../shell/AppShell';
import { useMe } from '../../hooks/useSession';
import { PersonalMemoryPanel, type ReportPayload } from '../../components/memory/PersonalMemoryPanel';

const RETENTION_OPTIONS: Array<{ value: number | null; label: string }> = [
    { value: null, label: 'Keep forever' },
    { value: 30, label: 'After 30 days' },
    { value: 90, label: 'After 90 days' },
    { value: 180, label: 'After 180 days' },
    { value: 365, label: 'After a year' }
];

type PrivacyDraft = {
    defaultNewChatPrivacy: 'regular' | 'incognito';
    learnMemories: boolean;
    useMemories: boolean;
};

/**
 * Retention, forget-me, export, and revoke stay on dedicated action flows.
 * The one regular preference (new-chat privacy) uses the section Save bar.
 */
export function MemorySection({ section, userId, onDirty }: {
    section: UserSettingsResponse['sections']['memory'];
    userId: string;
    onDirty: (dirty: boolean) => void;
}) {
    const toast = useToast();
    const queryClient = useQueryClient();
    const applyResult = useApplySectionResult();
    const openForget = useForgetOpener();
    const scope = `dm:${userId}`;

    const current = section.values.retentionDays ?? null;
    const options = [...RETENTION_OPTIONS];
    for (const extra of [current, section.values.chatHistoryRetentionDays ?? null]) {
        if (extra && !options.some((o) => o.value === extra)) {
            options.push({ value: extra, label: `After ${extra} days` });
        }
    }
    options.sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity));

    const [preview, setPreview] = useState<RetentionPreviewResponse | null>(null);
    const [historyPreview, setHistoryPreview] = useState<ChatHistoryPreviewResponse | null>(null);
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<number | null>(current);
    const historyCurrent = section.values.chatHistoryRetentionDays ?? null;
    const [historyPending, setHistoryPending] = useState<number | null>(historyCurrent);
    const toDraft = useCallback((v: UserSettingsResponse['sections']['memory']['values']): PrivacyDraft => ({
        defaultNewChatPrivacy: v.defaultNewChatPrivacy === 'incognito' ? 'incognito' : 'regular',
        learnMemories: v.learnMemories !== false,
        useMemories: v.useMemories !== false
    }), []);
    const toChanges = useCallback((draft: PrivacyDraft, baseline: PrivacyDraft) =>
        diffKeys(draft as unknown as Record<string, unknown>, baseline as unknown as Record<string, unknown>), []);
    const d = useSectionDraft('memory', section, toDraft, toChanges);
    useReportDirty(onDirty, d.dirty);

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

    async function chooseHistory(value: number | null) {
        setHistoryPending(value);
        if (value === historyCurrent) return;
        setBusy(true);
        try {
            setHistoryPreview(await api.chatHistoryPreview(value));
        } catch (error) {
            toast((error as Error).message, true);
            setHistoryPending(historyCurrent);
        } finally {
            setBusy(false);
        }
    }

    function cancelHistoryPreview() {
        setHistoryPreview(null);
        setHistoryPending(historyCurrent);
    }

    async function applyHistory() {
        if (!historyPreview) return;
        setBusy(true);
        try {
            const result = await api.applyChatHistoryRetention(historyPreview.proposedRetentionDays, historyPreview.currentRevision);
            applyResult(result);
            setHistoryPreview(null);
            toast(result.data.values.chatHistoryRetentionDays
                ? `Study chats now expire after ${result.data.values.chatHistoryRetentionDays} days${result.purged ? ` — ${result.purged} deleted now` : ''}.`
                : 'Study chats are kept forever again.');
        } catch (error) {
            toast((error as Error).message, true);
            setHistoryPending(historyCurrent);
        } finally {
            setBusy(false);
        }
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

            <Field id="new-chat-privacy" label="Default new-chat privacy" scope="Your account"
                hint="Applies to newly created Study chats only. Existing transcripts are never converted silently.">
                <select id="new-chat-privacy-input" className="select" value={d.draft.defaultNewChatPrivacy}
                    onChange={(e) => d.set({ defaultNewChatPrivacy: e.target.value as PrivacyDraft['defaultNewChatPrivacy'] })}>
                    <option value="regular">Regular (saved)</option>
                    <option value="incognito">Incognito (not saved)</option>
                </select>
            </Field>
            <Field id="learn-memories" label="Learn new long-term memories" inline scope="Private chats & DMs"
                hint="Independent of the retention window. Off stops extraction and background write jobs; existing memories stay.">
                <button id="learn-memories-input" type="button" className={`toggle${d.draft.learnMemories ? ' on' : ''}`}
                    role="switch" aria-checked={d.draft.learnMemories} aria-label="Learn new long-term memories"
                    onClick={() => d.set({ learnMemories: !d.draft.learnMemories })} />
            </Field>
            <Field id="use-memories" label="Use existing memories in responses" inline scope="Private chats & DMs"
                hint="Independent read preference. Off skips recall without deleting anything.">
                <button id="use-memories-input" type="button" className={`toggle${d.draft.useMemories ? ' on' : ''}`}
                    role="switch" aria-checked={d.draft.useMemories} aria-label="Use existing memories in responses"
                    onClick={() => d.set({ useMemories: !d.draft.useMemories })} />
            </Field>
            <SaveBar section="memory" draft={d} describe={(k) => ({
                defaultNewChatPrivacy: 'Default new-chat privacy',
                learnMemories: 'Learn new memories',
                useMemories: 'Use existing memories'
            }[k] || k)} />

            <SharesAndExport busy={busy} setBusy={setBusy} />

            <Field id="retention" label="Auto-delete memories"
                hint="Raw memories from your DMs and Study chats older than this window are deleted — immediately when you shorten it, then nightly. Distilled facts and chat transcripts are separate and are not affected. Servers set their own window with /privacy.">
                <select id="retention-input" className="select" value={pending === null ? '' : String(pending)} disabled={busy}
                    onChange={(e) => void chooseRetention(e.target.value === '' ? null : Number(e.target.value))}>
                    {options.map((o) => <option key={o.value ?? 'forever'} value={o.value ?? ''}>{o.label}</option>)}
                </select>
                <div className="hint">Currently: <strong>{current ? `after ${current} days` : 'kept forever'}</strong>.</div>
            </Field>

            <Field id="chat-history" label="Study chat-history retention"
                hint="Separate from memory embeddings. Shortening this can delete old Study conversations, their attachments, and their share links. It does not erase long-term memories.">
                <select id="chat-history-input" className="select" value={historyPending === null ? '' : String(historyPending)} disabled={busy}
                    onChange={(e) => void chooseHistory(e.target.value === '' ? null : Number(e.target.value))}>
                    {options.map((o) => <option key={o.value ?? 'forever'} value={o.value ?? ''}>{o.label}</option>)}
                </select>
                <div className="hint">Currently: <strong>{historyCurrent ? `after ${historyCurrent} days` : 'kept forever'}</strong>.</div>
            </Field>

            <Field id="memory-report" label="What Goobster knows about you" scope="Private chats & DMs"
                hint="Personal memory: the facts and raw memories Goobster inferred about you in your private space, with one-by-one deletion. Notes you kept on purpose are Knowledge, not memory, and live in their own room.">
                <div className="list-card settings-report" id="memory-report-input">
                    {report.isPending && <div className="list-row"><span className="hint">Counting…</span></div>}
                    {report.isError && <div className="list-row"><span className="hint">{(report.error as Error).message}</span></div>}
                    {report.data && (
                        <>
                            <div className="list-row"><span>Memories</span><strong>{report.data.memories?.count ?? 0}</strong></div>
                            <div className="list-row"><span>Distilled facts</span><strong>{report.data.facts?.length ?? 0}</strong></div>
                            <div className="list-row"><span>Distilled notes</span><strong>{report.data.knowledgeGraph?.distilled ?? 0}</strong></div>
                            <div className="list-row"><span>Notes you kept</span><strong>{report.data.knowledgeGraph?.saved ?? 0}</strong></div>
                            <div className="list-row"><span>Study conversations</span><strong>{report.data.conversations?.count ?? 0}</strong></div>
                            <div className="list-row"><span>Follow-ups</span><strong>{report.data.followups?.length ?? 0}</strong></div>
                        </>
                    )}
                </div>
                <div className="settings-inline-row">
                    <Link to="/knowledge/notes" className="btn" data-tour="memory-open-knowledge">Open Knowledge →</Link>
                </div>
                <PersonalMemoryPanel scope={scope} scopeKind="dm" scopeName="your private space" onForget={openForget} idPrefix="personal-memory" />
            </Field>

            <ServerScopeInspector />

            <Field id="deletion-rules" label="What deleting removes — and what it leaves"
                hint="Memories, facts, notes and transcripts are separate copies with separate controls. None of them promises to erase the others; only Forget me does.">
                <ul className="hint deletion-rules" id="deletion-rules-input" data-tour="memory-deletion-rules">
                    <li><strong>Delete a memory</strong> removes that raw memory and its recall vector. Notes Goobster distilled from it stay, pointing at a source that is gone.</li>
                    <li><strong>Forget a fact</strong> removes the fact and its copy on the Knowledge Map. The memories it was distilled from stay.</li>
                    <li><strong>Delete a note</strong> (in Knowledge) removes the note, its connections, tags and evidence links. If it mirrored a fact, the fact goes too. The memories or chats it came from stay.</li>
                    <li><strong>Chat-history retention</strong> deletes transcripts only; memories and notes are untouched.</li>
                    <li><strong>Forget me</strong> erases every copy and signs you out.</li>
                </ul>
            </Field>

            <Field id="forget-me" label="Forget me"
                hint="Erases every row Goobster has about you — memories, facts, chats, settings, sessions — and signs you out. This is separate from resetting preferences and cannot be undone.">
                <button id="forget-me-input" type="button" className="btn danger" onClick={openForget}>Forget me…</button>
            </Field>

            {historyPreview && (
                <Modal onClose={cancelHistoryPreview}>
                    <h2>{historyPreview.proposedRetentionDays ? `Expire Study chats after ${historyPreview.proposedRetentionDays} days?` : 'Keep Study chats forever?'}</h2>
                    {historyPreview.proposedRetentionDays ? (
                        <>
                            <p className="hint">
                                Affects <strong>Study conversations</strong> only — attachments, shares, and search for those chats go with them. Memories stay.
                            </p>
                            <div className="list-card">
                                <div className="list-row"><span>Study chats you have</span><strong>{historyPreview.conversationCount}</strong></div>
                                <div className="list-row"><span>Deleted right now</span><strong className={historyPreview.affectedCount ? 'settings-danger' : ''}>{historyPreview.affectedCount}</strong></div>
                            </div>
                            <p className="hint">Nothing has been deleted yet. Cancel keeps everything as it is.</p>
                        </>
                    ) : (
                        <p className="hint">Nothing is deleted; older Study chats simply stay in the sidebar.</p>
                    )}
                    <div className="modal-actions">
                        <button type="button" className="btn" onClick={cancelHistoryPreview} disabled={busy}>Cancel</button>
                        <button type="button" className={`btn ${historyPreview.affectedCount ? 'danger' : 'primary'}`} onClick={applyHistory} disabled={busy}>
                            {busy ? 'Applying…' : historyPreview.affectedCount ? `Delete ${historyPreview.affectedCount} and apply` : 'Apply'}
                        </button>
                    </div>
                </Modal>
            )}

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

/**
 * Advanced: the same personal-memory views for a server you share with
 * Goobster - what he keeps about *you in that server*. Always labelled with
 * the server's name; never folded into the private-space report above.
 * Absent when there are no server scopes (no Discord, or none in common).
 */
function ServerScopeInspector() {
    const me = useMe();
    const guilds = (me.scopes || []).filter((item) => item.kind === 'guild');
    const [guildId, setGuildId] = useState('');
    if (guilds.length === 0) return null;
    const selected = guilds.find((item) => item.id === guildId) || null;
    return (
        <Field id="memory-scopes" label="Inspect a server scope" scope="A server you pick"
            hint="Advanced. Goobster keeps a separate set of facts and memories about you in each server. Pick one to review or delete them; nothing here touches your private space.">
            <select id="memory-scopes-input" className="select" value={guildId} onChange={(e) => setGuildId(e.target.value)} data-tour="memory-server-scope">
                <option value="">Choose a server…</option>
                {guilds.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            {selected && (
                <div className="settings-scoped-panel" data-scope={selected.id}>
                    <div className="settings-scoped-title">
                        <span className="badge settings-scope">Server</span> What Goobster knows about you in <strong>{selected.name}</strong>
                    </div>
                    <PersonalMemoryPanel
                        key={selected.id}
                        scope={selected.id}
                        scopeKind="guild"
                        scopeName={selected.name}
                        idPrefix={`server-memory-${selected.id}`}
                    />
                </div>
            )}
        </Field>
    );
}

function SharesAndExport({ busy, setBusy }: { busy: boolean; setBusy: (v: boolean) => void }) {
    const toast = useToast();
    const shares = useQuery({ queryKey: ['settings-shares'], queryFn: () => api.listSettingsShares() });
    const applets = useQuery({ queryKey: ['settings-applets'], queryFn: () => api.listSettingsApplets() });

    async function exportData() {
        setBusy(true);
        try {
            const bundle = await api.exportSettings();
            const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `goobster-export-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <Field id="export" label="Export settings and report" scope="Your account"
                hint="Downloads your current settings and transparency report. Secrets and session tokens are omitted.">
                <button id="export-input" type="button" className="btn" disabled={busy} onClick={() => void exportData()}>
                    Download export
                </button>
            </Field>

            <Field id="shares" label="Shared links" scope="Your account"
                hint="Active conversation and project links you created. Revoking kills the URL immediately.">
                <div className="list-card" id="shares-input">
                    {shares.isPending && <div className="list-row"><span className="hint">Loading…</span></div>}
                    {shares.data && [...shares.data.conversations, ...shares.data.projects].length === 0 && (
                        <div className="list-row"><span className="hint">No active shares.</span></div>
                    )}
                    {shares.data?.conversations.map((item) => (
                        <div key={`c-${item.id}`} className="list-row">
                            <span>Chat · {item.title}</span>
                            <button type="button" className="btn subtle small" disabled={busy}
                                onClick={() => void api.revokeSettingsShare('conversation', item.id).then(() => shares.refetch())}>Revoke</button>
                        </div>
                    ))}
                    {shares.data?.projects.map((item) => (
                        <div key={`p-${item.id}`} className="list-row">
                            <span>Project · {item.title}</span>
                            <button type="button" className="btn subtle small" disabled={busy}
                                onClick={() => void api.revokeSettingsShare('project', item.id).then(() => shares.refetch())}>Revoke</button>
                        </div>
                    ))}
                </div>
            </Field>

            <Field id="applets" label="Applet access" scope="Your account"
                hint="Revoke Observatory grants on pinned Workshop applets. Only your own grants.">
                <div className="list-card" id="applets-input">
                    {applets.isPending && <div className="list-row"><span className="hint">Loading…</span></div>}
                    {applets.data && applets.data.length === 0 && (
                        <div className="list-row"><span className="hint">No pinned applets.</span></div>
                    )}
                    {applets.data?.map((item) => (
                        <div key={item.id} className="list-row">
                            <span>{item.title}{(item.grants?.observatoryRead || []).length ? ` · ${item.grants.observatoryRead?.length} grant(s)` : ''}</span>
                            <button type="button" className="btn subtle small" disabled={busy}
                                onClick={() => void api.revokeAppletGrants(item.id).then(() => applets.refetch())}>Revoke grants</button>
                        </div>
                    ))}
                </div>
            </Field>
        </>
    );
}
