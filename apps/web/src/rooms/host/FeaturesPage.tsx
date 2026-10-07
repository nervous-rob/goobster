import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../../lib/api';
import featureRegistry from '../../lib/featureStatus.cjs';
import type { HostFeatureRow, HostFeatures } from '../../lib/types';
import { ChangeReview } from './ChangeReview';
import { LifecyclePanel } from './LifecyclePanel';
import { ManagerNotice, useManagerStatus } from './ManagerCard';
import { DocLink, HOST_KEYS } from './shared';
import { useChange } from './useChange';

const { reasonSentence } = featureRegistry;
const KEEPS_DATA_SHORT = 'Turning this off keeps its data in place; it comes back unchanged when you turn it on again.';
const SHARED_REASON: Record<string, string> = {
    MULTIPLE_ACTIVE_ACCOUNTS: 'more than one person is signed in',
    MULTIPLE_GUILDS: 'it serves more than one Discord server'
};

/** What the row will be after the next restart, before any draft change. */
function baselineOf(row: HostFeatureRow): boolean {
    return row.state.pendingActive ?? row.state.requested;
}

function dependentsClosure(id: string, byId: Map<string, HostFeatureRow>): string[] {
    const seen = new Set<string>();
    const visit = (current: string) => {
        for (const dependent of byId.get(current)?.requiredBy || []) {
            if (!seen.has(dependent)) {
                seen.add(dependent);
                visit(dependent);
            }
        }
    };
    visit(id);
    return [...seen];
}

function Chip({ on, onText, offText, testId }: { on: boolean; onText: string; offText: string; testId: string }) {
    return <span className={`badge ${on ? 'state-verified' : 'state-unverified'}`} data-testid={testId} data-on={on}>{on ? onText : offText}</span>;
}

function FeatureRow({ row, data, byId, target, draft, setWanted, locked, attested, setAttested }: {
    row: HostFeatureRow;
    data: HostFeatures;
    byId: Map<string, HostFeatureRow>;
    target: (id: string) => boolean;
    draft: Record<string, boolean>;
    setWanted: (id: string, value: boolean) => void;
    locked: boolean;
    attested: boolean;
    setAttested: (value: boolean) => void;
}) {
    const state = row.state;
    const wanted = target(row.id);
    const changed = row.id in draft;
    const title = (id: string) => byId.get(id)?.title || id;
    const missingDeps = wanted ? row.dependsOn.filter((dep) => !target(dep)) : [];
    const cascade = changed && !wanted ? dependentsClosure(row.id, byId).filter((dep) => dep in draft && draft[dep] === false) : [];
    const dependentsOn = dependentsClosure(row.id, byId).filter((dep) => target(dep));
    const missingKeys = row.apiKeys.filter((key) => key.required).map((key) => key.name);
    const needsAttestation = row.id === 'gambling' && changed && wanted && data.shared.shared;
    const reasonText = !state.active ? reasonSentence(row.id, state.reasons) : null;
    const inputId = `host-feature-${row.id}`;

    return (
        <li className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }} data-testid="host-feature" data-feature={row.id} data-changed={changed}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <span>
                    <strong>{row.title}</strong>{' '}
                    <Chip on={state.installed} onText="Installed" offText="Not installed" testId="chip-installed" />
                    <Chip on={state.configured} onText="Configured" offText="Needs setup" testId="chip-configured" />
                    <Chip on={state.active} onText="Active" offText="Inactive" testId="chip-active" />
                    {state.pending && (
                        <span className="badge state-unverified" data-testid="chip-pending">
                            Pending: {state.pendingActive ? 'turns on' : 'turns off'} after the restart
                        </span>
                    )}
                </span>
                <label htmlFor={inputId} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <input id={inputId} type="checkbox" checked={wanted} disabled={locked || !state.installed}
                        onChange={(event) => setWanted(row.id, event.target.checked)} data-testid="host-feature-toggle" />
                    {wanted ? 'On' : 'Off'}<span className="sr-only"> for {row.title}</span>
                </label>
            </div>
            <span className="hint">{row.summary}</span>
            {!state.installed && (
                <span className="hint" data-testid="not-installed">
                    This installation&apos;s payload does not include {row.title}; add it with the installer.{' '}
                    <DocLink slug="packaging">How payloads are selected</DocLink>
                </span>
            )}
            {reasonText && state.installed && <span className="hint" data-testid="feature-reason">{reasonText}</span>}
            {row.dependsOn.length > 0 && <span className="hint">Needs {row.dependsOn.map(title).join(', ')}.</span>}
            {missingDeps.length > 0 && (
                <span className="settings-danger" role="alert" data-testid="missing-dependency">
                    {row.title} needs {missingDeps.map(title).join(' and ')}, which {missingDeps.length === 1 ? 'is' : 'are'} off. Turn {missingDeps.length === 1 ? 'it' : 'them'} on first; this page never does it for you.
                </span>
            )}
            {wanted && dependentsOn.length > 0 && !changed && (
                <span className="hint">Turning this off also turns off {dependentsOn.map(title).join(' and ')}.</span>
            )}
            {cascade.length > 0 && (
                <span className="hint" data-testid="cascade">This change also turns off {cascade.map(title).join(' and ')}, which need{cascade.length === 1 ? 's' : ''} {row.title}.</span>
            )}
            {state.installed && !state.configured && missingKeys.length > 0 && (
                <span className="hint" data-testid="missing-keys">
                    Needs a key or setting: <code>{missingKeys.join(', ')}</code>. Set it on <Link to="/host/$page" params={{ page: 'connections' }}>Connections</Link>.
                </span>
            )}
            {state.warnings.length > 0 && (
                <span className="hint">{state.warnings.map((warning) => `${warning.code}${warning.names ? `: ${warning.names.join(', ')}` : ''}`).join('; ')}</span>
            )}
            {row.systemDependencies.length > 0 && (
                <span className="hint">System tools: {row.systemDependencies.join(', ')}{row.requiredSystemDependencies.length > 0 ? ` (required: ${row.requiredSystemDependencies.join(', ')})` : ''}.</span>
            )}
            {row.hostSwitch && (
                <span className="hint" data-testid="host-switch">
                    Host switch for everyone: {row.hostSwitch.covers} {row.hostSwitch.existing}
                    {row.id === 'gba' && ' GBA runs are the host\'s to allow: a person cannot enable them for themselves.'}
                </span>
            )}
            {needsAttestation && (
                <label data-testid="attestation">
                    <input type="checkbox" checked={attested} onChange={(event) => setAttested(event.target.checked)} data-testid="attestation-checkbox" />
                    {' '}{data.gamblingAttestation.text}
                </label>
            )}
            <span className="hint" data-testid="keeps-data">{KEEPS_DATA_SHORT}</span>
        </li>
    );
}

/** /host/features: the catalog's rows, previewed and applied through the manager. */
export function FeaturesPage() {
    const query = useQuery({ queryKey: HOST_KEYS.features, queryFn: () => api.hostFeatures() });
    const { status, usable } = useManagerStatus();
    const lifecycle = useQuery({ queryKey: HOST_KEYS.lifecycle, queryFn: () => api.hostLifecycle(), enabled: usable, retry: false });
    const [draft, setDraft] = useState<Record<string, boolean>>({});
    const [attested, setAttested] = useState(false);
    const change = useChange(() => { setDraft({}); setAttested(false); });
    const data = query.data;
    const byId = useMemo(() => new Map((data?.features || []).map((row) => [row.id, row])), [data]);
    const target = (id: string) => draft[id] ?? (byId.get(id) ? baselineOf(byId.get(id) as HostFeatureRow) : false);
    const label = (id: string) => byId.get(id)?.title || id;
    const reviewing = change.state.phase !== 'idle';
    const locked = !usable || reviewing;

    function setWanted(id: string, value: boolean) {
        const next = { ...draft };
        const apply = (feature: string, wanted: boolean) => {
            const row = byId.get(feature);
            if (!row) return;
            if (wanted === baselineOf(row)) delete next[feature];
            else next[feature] = wanted;
        };
        apply(id, value);
        if (!value) {
            for (const dependent of dependentsClosure(id, byId)) {
                const row = byId.get(dependent);
                if (row && (next[dependent] ?? baselineOf(row))) apply(dependent, false);
            }
        }
        setDraft(next);
    }

    const changes = Object.keys(draft);
    const turningOnGambling = draft.gambling === true;
    const needsAttestation = Boolean(data?.shared.shared) && turningOnGambling;
    const blocked = changes.some((id) => draft[id] && (byId.get(id)?.dependsOn || []).some((dep) => !target(dep)));
    const canPreview = usable && changes.length > 0 && !blocked && (!needsAttestation || attested) && !reviewing;

    function preview() {
        void change.preview('features.set', {
            changes: draft,
            expectedRevision: data?.revision ?? 0,
            ...(needsAttestation ? { attestation: { confirmed: true } } : {})
        });
    }

    return (
        <>
            <section className="settings-section" aria-labelledby="host-features-title" data-testid="host-features">
                <h2 id="host-features-title">Features</h2>
                <p className="hint">
                    What this installation offers. Changes are previewed first, applied through the manager, and take effect when the workers restart.{' '}
                    <DocLink slug="features">The feature catalog</DocLink>
                </p>
                <p className="hint" data-testid="keeps-data-note">{data?.keepsData || 'Turning a feature off keeps its data in place.'}</p>
                {status && !usable && <ManagerNotice status={status} />}
                {data && data.shared.shared && (
                    <p className="hint" data-testid="shared-instance">
                        This instance is shared ({data.shared.reasons.map((reason) => SHARED_REASON[reason] || reason).join('; ')}), so turning Gambling on needs your confirmation.
                    </p>
                )}
                {query.isPending && <div className="hint" role="status">Loading…</div>}
                {query.isError && <div className="hint" role="alert">{(query.error as Error).message}</div>}
                {data && (
                    <ul className="list-card" style={{ listStyle: 'none', padding: 0 }}>
                        {data.features.map((row) => (
                            <FeatureRow key={row.id} row={row} data={data} byId={byId} target={target} draft={draft}
                                setWanted={setWanted} locked={locked} attested={attested} setAttested={setAttested} />
                        ))}
                    </ul>
                )}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0' }}>
                    <button type="button" className="btn primary" disabled={!canPreview} onClick={preview} data-testid="host-features-preview">
                        Preview {changes.length > 0 ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : 'changes'}
                    </button>
                    {changes.length > 0 && !reviewing && (
                        <button type="button" className="btn subtle" onClick={() => { setDraft({}); setAttested(false); }}>Clear</button>
                    )}
                </div>
                <ChangeReview change={change} label={label} supervising={lifecycle.data?.supervising === true} testId="host-features-review" />
            </section>
            <LifecyclePanel enabled={usable} />
        </>
    );
}
