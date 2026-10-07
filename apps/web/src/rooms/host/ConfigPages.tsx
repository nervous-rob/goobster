import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { HostConfigField, HostConfigReport, HostConfigSection } from '../../lib/types';
import { ChangeReview } from './ChangeReview';
import { FieldControl, PROBE_FIELD, type FieldDraft } from './FieldControl';
import { LifecyclePanel } from './LifecyclePanel';
import { ManagerNotice, useManagerStatus } from './ManagerCard';
import { DocLink, HOST_KEYS } from './shared';
import { useChange } from './useChange';

/** Provider and integration sections: the places a key or an address is kept. */
const CONNECTION_SECTIONS = ['ai.providers', 'ollama', 'search', 'voice', 'music', 'integrations', 'mail', 'discord', 'push', 'activity', 'manager'];
/** Sign-in and portal sections: where the Mail guard's remedy lives. */
const SIGNIN_SECTIONS = ['identity', 'webapp'];
const RETENTION_FIELD = 'defaults.memory.chatHistoryRetentionDays';

const ENV_READONLY = (field: HostConfigField) =>
    `Set by the environment variable ${field.envName || 'for this field'}. Change the environment and restart; it cannot be changed from here.`;

type Drafts = Record<string, FieldDraft>;

function parseValue(field: HostConfigField, draft: FieldDraft): { value?: unknown; invalid?: string } {
    if (draft.action === 'remove') return {};
    const raw = draft.value;
    if (field.type === 'boolean') return { value: raw === true };
    const text = String(raw).trim();
    if (field.secret) return text ? { value: String(raw) } : { invalid: 'Type the new value, or cancel.' };
    if (text === '') return { invalid: 'This needs a value; use "Use the default" to clear it.' };
    if (field.type === 'integer' || field.type === 'number') {
        const number = Number(text);
        if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number))) return { invalid: 'This must be a number.' };
        if (field.min !== undefined && number < field.min) return { invalid: `The smallest value is ${field.min}.` };
        if (field.max !== undefined && number > field.max) return { invalid: `The largest value is ${field.max}.` };
        return { value: number };
    }
    if (field.type === 'list') return { value: text.split(',').map((item) => item.trim()).filter(Boolean) };
    return { value: text };
}

function useConfig() {
    const query = useQuery({ queryKey: HOST_KEYS.config, queryFn: () => api.hostConfig() });
    const manager = useManagerStatus();
    const lifecycle = useQuery({ queryKey: HOST_KEYS.lifecycle, queryFn: () => api.hostLifecycle(), enabled: manager.usable, retry: false });
    return { query, ...manager, supervising: lifecycle.data?.supervising === true };
}

function Section({ section, drafts, setDraft, readOnlyFor, probes }: {
    section: HostConfigSection;
    drafts: Drafts;
    setDraft: (id: string, draft: FieldDraft | null) => void;
    readOnlyFor: (field: HostConfigField) => string | null;
    probes: HostConfigReport['probes'];
}) {
    return (
        <section aria-labelledby={`host-section-${section.id}`} data-testid="host-section" data-section={section.id}>
            <h3 id={`host-section-${section.id}`} className="section-title">{section.title}</h3>
            <ul className="list-card" style={{ listStyle: 'none', padding: 0 }}>
                {section.fields.map((field) => {
                    const target = PROBE_FIELD[field.id];
                    return (
                        <FieldControl key={field.id} field={field} draft={drafts[field.id]}
                            setDraft={(draft) => setDraft(field.id, draft)} readOnly={readOnlyFor(field)}
                            probe={target ? probes.find((probe) => probe.target === target) : undefined} />
                    );
                })}
            </ul>
        </section>
    );
}

/** Drafts to the manager's `changes`, or the first thing wrong with them. */
function buildChanges(fields: Map<string, HostConfigField>, drafts: Drafts): { changes: Array<Record<string, unknown>>; problem: string | null } {
    const changes: Array<Record<string, unknown>> = [];
    let problem: string | null = null;
    for (const [id, draft] of Object.entries(drafts)) {
        const field = fields.get(id);
        if (!field) continue;
        const parsed = parseValue(field, draft);
        if (parsed.invalid) {
            problem = `${id}: ${parsed.invalid}`;
            continue;
        }
        changes.push(draft.action === 'remove' ? { id, action: 'remove' } : { id, action: 'set', value: parsed.value });
    }
    return { changes, problem };
}

function useDrafts() {
    const [drafts, setDrafts] = useState<Drafts>({});
    const setDraft = (id: string, draft: FieldDraft | null) => setDrafts((previous) => {
        const next = { ...previous };
        if (draft === null) delete next[id];
        else next[id] = draft;
        return next;
    });
    /** Drops the typed secrets once the manager has them in a plan; the page keeps no copy. */
    const dropSecrets = (fields: Map<string, HostConfigField>) => setDrafts((previous) => {
        const next: Drafts = {};
        for (const [id, draft] of Object.entries(previous)) if (!(fields.get(id)?.secret && draft.action === 'set')) next[id] = draft;
        return next;
    });
    return { drafts, setDraft, clear: () => setDrafts({}), dropSecrets };
}

/** /host/connections: provider keys and integrations, with fingerprints, replace, remove and Test connection. */
export function ConnectionsPage() {
    const { query, status, usable, supervising } = useConfig();
    const state = useDrafts();
    const change = useChange(state.clear);
    const report = query.data;
    const fields = useMemo(() => new Map((report?.sections || []).flatMap((section) => section.fields).map((field) => [field.id, field])), [report]);
    const reviewing = change.state.phase !== 'idle';
    const { changes, problem } = buildChanges(fields, state.drafts);
    const readOnlyFor = (field: HostConfigField): string | null => {
        if (!usable) return 'The manager is not available, so this is read-only.';
        if (reviewing) return 'Finish or discard the change under review first.';
        if (field.envControlled) return ENV_READONLY(field);
        if (!field.editable) return 'This setting is not editable from here.';
        return null;
    };
    const sections = (ids: string[]) => ids.map((id) => report?.sections.find((section) => section.id === id)).filter(Boolean) as HostConfigSection[];
    const label = (id: string) => id;

    async function preview() {
        if (!report) return;
        const ok = await change.preview('config.set', { expectedRevision: report.revision, changes });
        if (ok) state.dropSecrets(fields);
    }

    return (
        <>
            <section className="settings-section" aria-labelledby="host-connections-title" data-testid="host-connections">
                <h2 id="host-connections-title">Connections</h2>
                <p className="hint">
                    This installation&apos;s own provider keys and integrations. Keys are shown only as the last four characters. A key is typed once, sent to the manager
                    and never shown again; personal accounts are in Settings, not here.{' '}
                    <DocLink slug="host-operations">How these pages work</DocLink>
                </p>
                {status && !usable && <ManagerNotice status={status} />}
                {query.isPending && <div className="hint" role="status">Loading…</div>}
                {query.isError && <div className="hint" role="alert">{(query.error as Error).message}</div>}
                {report && (
                    <>
                        {sections(CONNECTION_SECTIONS).map((section) => (
                            <Section key={section.id} section={section} drafts={state.drafts} setDraft={state.setDraft} readOnlyFor={readOnlyFor} probes={report.probes} />
                        ))}
                        <h3 className="section-title">Sign-in and portal</h3>
                        <p className="hint">Who may register, and the portal&apos;s public address. Open sign-up needs Mail, so Mail cannot be turned off on the Features page while registration is open.</p>
                        {sections(SIGNIN_SECTIONS).map((section) => (
                            <Section key={section.id} section={section} drafts={state.drafts} setDraft={state.setDraft} readOnlyFor={readOnlyFor} probes={report.probes} />
                        ))}
                        {problem && <p className="settings-danger" role="alert" data-testid="host-config-problem">{problem}</p>}
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0' }}>
                            <button type="button" className="btn primary" data-testid="host-config-preview"
                                disabled={!usable || changes.length === 0 || Boolean(problem) || reviewing} onClick={() => void preview()}>
                                Preview {changes.length > 0 ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : 'changes'}
                            </button>
                            {changes.length > 0 && !reviewing && <button type="button" className="btn subtle" onClick={state.clear}>Clear</button>}
                        </div>
                        <ChangeReview change={change} label={label} supervising={supervising} testId="host-config-review" />
                    </>
                )}
            </section>
            <LifecyclePanel enabled={usable} />
        </>
    );
}

/** /host/defaults: what new people inherit, and the enforced limits shown apart and read-only. */
export function DefaultsPage() {
    const { query, status, usable, supervising } = useConfig();
    const state = useDrafts();
    const [acknowledged, setAcknowledged] = useState(false);
    const change = useChange(() => { state.clear(); setAcknowledged(false); });
    const report = query.data;
    const fields = useMemo(() => new Map((report?.sections || []).flatMap((section) => section.fields).map((field) => [field.id, field])), [report]);
    const defaults = report?.sections.find((section) => section.id === 'defaults');
    const limits = report?.sections.find((section) => section.id === 'limits');
    const reviewing = change.state.phase !== 'idle';
    const dbUp = report?.defaults !== null && report?.defaults !== undefined;
    const { changes, problem } = buildChanges(fields, state.drafts);
    const retention = changes.some((entry) => entry.id === RETENTION_FIELD && entry.action === 'set');
    const readOnlyFor = (field: HostConfigField): string | null => {
        if (!usable) return 'The manager is not available, so this is read-only.';
        if (!dbUp) return 'The application database is not reachable, so defaults cannot be changed now.';
        if (reviewing) return 'Finish or discard the change under review first.';
        if (field.envControlled) return ENV_READONLY(field);
        return null;
    };
    const label = (id: string) => id;

    return (
        <>
            <section className="settings-section" aria-labelledby="host-defaults-title" data-testid="host-defaults">
                <h2 id="host-defaults-title">Instance Defaults</h2>
                <p className="hint" data-testid="defaults-explainer">
                    A default is what a person inherits for a preference they have not set themselves. It never blocks, caps or overwrites anything, and it changes
                    no one&apos;s own choice. Limits and the registration mode are policy: they are enforced whatever a person prefers, and are shown apart below.
                </p>
                {status && !usable && <ManagerNotice status={status} />}
                {query.isPending && <div className="hint" role="status">Loading…</div>}
                {query.isError && <div className="hint" role="alert">{(query.error as Error).message}</div>}
                {report && defaults && (
                    <>
                        <Section section={defaults} drafts={state.drafts} setDraft={state.setDraft} readOnlyFor={readOnlyFor} probes={report.probes} />
                        {retention && (
                            <label data-testid="retention-ack">
                                <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                                {' '}I understand conversations older than this window are purged at the next retention sweep for everyone who has not chosen their own.
                            </label>
                        )}
                        {problem && <p className="settings-danger" role="alert">{problem}</p>}
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0' }}>
                            <button type="button" className="btn primary" data-testid="host-defaults-preview"
                                disabled={!usable || !dbUp || changes.length === 0 || Boolean(problem) || reviewing || (retention && !acknowledged)}
                                onClick={() => {
                                    if (!report.defaults) return;
                                    void change.preview('defaults.set', {
                                        expectedRevision: report.defaults.revision,
                                        changes,
                                        ...(retention ? { acknowledgeRetention: true } : {})
                                    });
                                }}>
                                Preview {changes.length > 0 ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : 'changes'}
                            </button>
                            {changes.length > 0 && !reviewing && <button type="button" className="btn subtle" onClick={state.clear}>Clear</button>}
                        </div>
                        <ChangeReview change={change} label={label} supervising={supervising} testId="host-defaults-review" />
                    </>
                )}
                {report && limits && (
                    <>
                        <h3 className="section-title">Enforced policy (not defaults)</h3>
                        <p className="hint" data-testid="limits-explainer">
                            These are enforced for everyone. They are changed in the Host room&apos;s Limits panel on the Overview page, not here.
                        </p>
                        <Section section={limits} drafts={{}} setDraft={() => undefined} readOnlyFor={() => 'Enforced policy: change it in the Limits panel on the Overview page.'} probes={report.probes} />
                    </>
                )}
            </section>
        </>
    );
}
