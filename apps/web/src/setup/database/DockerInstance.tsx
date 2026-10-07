import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { DockerStatus } from '../../lib/types';
import { planAndApply } from '../journeys/common';
import { useTransport } from '../transport';
import { describeError } from '../ui';
import { gateOf, useDockerStatus } from './DockerOption';

type Go = (step: string, id?: string | null) => void;

function storageOf(status: DockerStatus): string {
    const request = status.record?.request;
    if (!request) return 'not set';
    return request.storage.kind === 'path' ? `a folder: ${request.storage.path || ''}` : `a Docker volume: ${status.names.volume}`;
}

function stateOf(status: DockerStatus): { label: string; tone: 'ok' | 'warn' | 'block' } {
    const container = status.owned?.container;
    if (!container || !container.exists) return { label: 'the container is missing', tone: 'block' };
    if (!container.running) return { label: 'stopped', tone: 'warn' };
    if (container.health === 'healthy') return { label: 'running and healthy', tone: 'ok' };
    if (container.health === 'starting') return { label: 'starting', tone: 'warn' };
    return { label: `running, health ${container.health}`, tone: 'block' };
}

/**
 * The Docker PostgreSQL this installation owns: its state and the three things
 * that can be done to it. Each action is a plan the manager checks and applies.
 * Stopping it while the application uses it needs an explicit acknowledgement.
 */
export function DockerInstanceCard({ go, managed }: { go: Go; managed: boolean }) {
    const query = useDockerStatus();
    const client = useQueryClient();
    const transport = useTransport();
    const gate = gateOf(query);
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
            <section className="wizard-callout" data-testid="docker-instance">
                <h3 className="section-title">PostgreSQL in Docker</h3>
                <p role="alert" className="settings-danger" data-testid="docker-unavailable">{describeError(query.error).message}</p>
            </section>
        );
    }
    if (!status) return <section className="wizard-callout" data-testid="docker-instance"><h3 className="section-title">PostgreSQL in Docker</h3><p role="status" className="hint">Checking Docker…</p></section>;

    const record = status.record;
    const state = record ? stateOf(status) : null;
    const container = status.owned?.container;
    const daemonDown = gate.state === 'blocked';
    return (
        <section className="wizard-callout" data-testid="docker-instance" data-state={record ? (state?.tone || 'unknown') : 'none'}>
            <h3 className="section-title">PostgreSQL in Docker</h3>
            {!record && (
                <>
                    <p className="hint" data-testid="docker-none">The installer is not running a PostgreSQL for this installation.</p>
                    {daemonDown && <p className="settings-danger" role="alert" data-testid="docker-blocked">{gate.state === 'blocked' ? gate.reason : ''}</p>}
                    <div className="wizard-actions">
                        <button type="button" className="btn" onClick={() => go('docker')} disabled={!managed || gate.state !== 'ready'} data-testid="docker-setup">Set up PostgreSQL in Docker…</button>
                    </div>
                </>
            )}
            {record && (
                <>
                    <dl className="wizard-facts" data-testid="docker-facts">
                        <div className="wizard-fact"><dt>Container</dt><dd><code>{status.names.container}</code> <span data-testid="docker-state" data-tone={state?.tone}>{state?.label}</span></dd></div>
                        <div className="wizard-fact"><dt>Image</dt><dd data-testid="docker-instance-image"><code>{record.image.reference}</code> <span className="hint">PostgreSQL {record.image.major}{container && !container.imagePinned ? '; the container runs a different image: repair it' : ''}</span></dd></div>
                        <div className="wizard-fact"><dt>Listens on</dt><dd><code data-testid="docker-instance-port">{record.request.bind}:{record.request.port}</code></dd></div>
                        <div className="wizard-fact"><dt>Data</dt><dd data-testid="docker-instance-storage">{storageOf(status)}</dd></div>
                        <div className="wizard-fact"><dt>Setup</dt><dd>{record.complete ? 'finished' : `stopped at "${record.step}"; set it up again to continue`}</dd></div>
                        <div className="wizard-fact"><dt>This installation</dt><dd data-testid="docker-connected">{status.connected ? 'uses it' : 'does not use it yet'}</dd></div>
                    </dl>
                    {status.owned && status.owned.foreign.length > 0 && <p role="alert" className="settings-danger" data-testid="docker-foreign">Something else already uses a name this installer would use ({status.owned.foreign.map((item) => item.name).join(', ')}). It is not touched; rename it yourself.</p>}
                    {daemonDown && <p role="alert" className="settings-danger" data-testid="docker-blocked">{gate.state === 'blocked' ? gate.reason : ''}</p>}
                    {status.connected && (
                        <label className="wizard-choice">
                            <input type="checkbox" checked={acknowledgeInUse} onChange={(event) => setAcknowledgeInUse(event.target.checked)} data-testid="docker-ack-in-use" />
                            {' '}The application is stopped, or I accept it loses its data while the database is stopped
                        </label>
                    )}
                    <div className="wizard-actions">
                        <button type="button" className="btn" disabled={!managed || busy !== null || daemonDown || Boolean(container?.running)} onClick={() => { void act('database.docker.start'); }} data-testid="docker-start">{busy === 'database.docker.start' ? 'Starting…' : 'Start'}</button>
                        <button type="button" className="btn" disabled={!managed || busy !== null || daemonDown || !container?.running || (status.connected && !acknowledgeInUse)}
                            onClick={() => { void act('database.docker.stop', status.connected ? { acknowledgeInUse: true } : {}); }} data-testid="docker-stop">{busy === 'database.docker.stop' ? 'Stopping…' : 'Stop'}</button>
                        <button type="button" className="btn" disabled={!managed || busy !== null || daemonDown} onClick={() => { void act('database.docker.repair'); }} data-testid="docker-repair">{busy === 'database.docker.repair' ? 'Repairing…' : 'Repair'}</button>
                        {record.complete && !status.connected && (
                            <button type="button" className="btn primary" disabled={!managed} onClick={() => go('review-owned')} data-testid="docker-use">Use it for this installation…</button>
                        )}
                    </div>
                    <p className="hint">Repair recreates a missing or drifted container over the same data; it never creates the data again. A major version upgrade is never done by the installer.</p>
                </>
            )}
            {failure && <p role="alert" className="settings-danger" data-testid="docker-failure" data-code={failure.code}>{failure.message}</p>}
        </section>
    );
}
