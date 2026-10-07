import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { NativeStatus } from '../../lib/types';
import { planAndApply } from '../journeys/common';
import { useTransport } from '../transport';
import { describeError } from '../ui';
import { nativeBlockText, nativeGateOf, useNativeStatus } from './NativeOption';

type Go = (step: string, id?: string | null) => void;

function stateOf(status: NativeStatus): { label: string; tone: 'ok' | 'warn' | 'block' } {
    const owned = status.owned;
    if (!owned || !owned.exists) return { label: 'the cluster is missing', tone: 'block' };
    if (!owned.online) return { label: 'stopped', tone: 'warn' };
    return { label: 'running', tone: 'ok' };
}

/**
 * The native PostgreSQL cluster this installation owns: its state and the actions on it.
 * Each action is a plan the manager checks and applies. Stopping it while the application
 * uses it needs an explicit acknowledgement.
 */
export function NativeInstanceCard({ go, managed }: { go: Go; managed: boolean }) {
    const query = useNativeStatus();
    const client = useQueryClient();
    const transport = useTransport();
    const gate = nativeGateOf(query);
    const [busy, setBusy] = useState<string | null>(null);
    const [failure, setFailure] = useState<{ message: string; code: string } | null>(null);
    const [acknowledgeInUse, setAcknowledgeInUse] = useState(false);
    const status = query.data;

    async function act(kind: string, input: Record<string, unknown> = {}) {
        setBusy(kind);
        setFailure(null);
        try {
            await planAndApply(transport, kind, input);
        } catch (error) {
            const described = describeError(error);
            setFailure({ message: described.message, code: described.code });
        } finally {
            setBusy(null);
            await client.invalidateQueries({ queryKey: ['database'] });
        }
    }

    if (query.isError) {
        return (
            <section className="wizard-callout" data-testid="native-instance">
                <h3 className="section-title">PostgreSQL on this machine</h3>
                <p role="alert" className="settings-danger" data-testid="native-unavailable">{describeError(query.error).message}</p>
            </section>
        );
    }
    if (!status) return <section className="wizard-callout" data-testid="native-instance"><h3 className="section-title">PostgreSQL on this machine</h3><p role="status" className="hint">Checking this machine…</p></section>;

    const record = status.record;
    const state = record ? stateOf(status) : null;
    const owned = status.owned;
    const blocked = gate.state !== 'ready';
    return (
        <section className="wizard-callout" data-testid="native-instance" data-state={record ? (state?.tone || 'unknown') : 'none'}>
            <h3 className="section-title">PostgreSQL on this machine</h3>
            {!record && (
                <>
                    <p className="hint" data-testid="native-none">The installer is not running a PostgreSQL cluster for this installation.</p>
                    {blocked && <p className="settings-danger" role="alert" data-testid="native-gate-blocked">{nativeBlockText(gate)}</p>}
                    <div className="wizard-actions">
                        <button type="button" className="btn" onClick={() => go('native')} disabled={!managed || blocked} data-testid="native-setup">Set up PostgreSQL on this machine…</button>
                    </div>
                </>
            )}
            {record && (
                <>
                    <dl className="wizard-facts" data-testid="native-facts">
                        <div className="wizard-fact"><dt>Cluster</dt><dd><code>{record.cluster.name}</code> <span data-testid="native-state" data-tone={state?.tone}>{state?.label}</span></dd></div>
                        <div className="wizard-fact"><dt>Service</dt><dd><code>{record.cluster.service || 'managed by the cluster tools'}</code></dd></div>
                        <div className="wizard-fact"><dt>Listens on</dt><dd><code data-testid="native-instance-port">{record.cluster.bind}:{record.cluster.port}</code></dd></div>
                        <div className="wizard-fact"><dt>Data</dt><dd data-testid="native-instance-storage"><code>{record.cluster.dataDirectory}</code></dd></div>
                        <div className="wizard-fact"><dt>Setup</dt><dd>{record.complete ? 'finished' : `stopped at "${record.step}"; set it up again to continue`}</dd></div>
                        {record.relocation && <div className="wizard-fact"><dt>Move</dt><dd data-testid="native-relocation">unfinished at &quot;{record.relocation.step}&quot;; run the move again to finish it</dd></div>}
                        <div className="wizard-fact"><dt>This installation</dt><dd data-testid="native-connected">{status.connected ? 'uses it' : 'does not use it yet'}</dd></div>
                    </dl>
                    {status.host.clusters.some((cluster) => !cluster.owned) && <p className="hint" data-testid="native-foreign">Other PostgreSQL clusters on this machine ({status.host.clusters.filter((cluster) => !cluster.owned).map((cluster) => cluster.name).join(', ')}) are left exactly as they are.</p>}
                    {blocked && <p role="alert" className="settings-danger" data-testid="native-gate-blocked">{nativeBlockText(gate)}</p>}
                    {status.connected && (
                        <label className="wizard-choice">
                            <input type="checkbox" checked={acknowledgeInUse} onChange={(event) => setAcknowledgeInUse(event.target.checked)} data-testid="native-ack-in-use" />
                            {' '}The application is stopped, or I accept it loses its data while the database is stopped
                        </label>
                    )}
                    <div className="wizard-actions">
                        <button type="button" className="btn" disabled={!managed || busy !== null || blocked || Boolean(owned?.online)} onClick={() => { void act('database.native.start'); }} data-testid="native-start">{busy === 'database.native.start' ? 'Starting…' : 'Start'}</button>
                        <button type="button" className="btn" disabled={!managed || busy !== null || blocked || !owned?.online || (status.connected && !acknowledgeInUse)}
                            onClick={() => { void act('database.native.stop', status.connected ? { acknowledgeInUse: true } : {}); }} data-testid="native-stop">{busy === 'database.native.stop' ? 'Stopping…' : 'Stop'}</button>
                        <button type="button" className="btn" disabled={!managed || busy !== null || blocked} onClick={() => { void act('database.native.repair'); }} data-testid="native-repair">{busy === 'database.native.repair' ? 'Repairing…' : 'Repair'}</button>
                        {record.complete && !status.connected && (
                            <button type="button" className="btn primary" disabled={!managed} onClick={() => go('review-owned-native')} data-testid="native-use">Use it for this installation…</button>
                        )}
                    </div>
                    <p className="hint">Repair starts a stopped cluster and re-creates its service entry over the same data; it never creates the data again. Moving the data folder and a major version upgrade are command-line jobs (<code>database native relocate</code>); the installer never upgrades the major version.</p>
                </>
            )}
            {failure && <p role="alert" className="settings-danger" data-testid="native-failure" data-code={failure.code}>{failure.message}</p>}
        </section>
    );
}
