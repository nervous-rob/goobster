import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { NativeFinding, NativeStatus } from '../../lib/types';
import { describeError, formatBytes } from '../ui';
import { useDatabaseApi } from './api';
import { nativeProblems, type FormProblem, type NativeAnswer } from './model';

/** The host check as a gate: still asking, unusable here, or ready. */
export type NativeGate =
    | { state: 'checking' }
    | { state: 'unavailable'; reason: string }
    | { state: 'blocked'; reason: string; remedy: string | null; status: NativeStatus }
    | { state: 'ready'; status: NativeStatus };

const ELEVATION_REMEDY = 'Run the manager as root, or allow it passwordless sudo, so it can install packages and create the cluster.';

export function useNativeStatus(storage?: string) {
    const databaseApi = useDatabaseApi();
    return useQuery({
        queryKey: ['database', 'native', storage || ''],
        queryFn: () => databaseApi.nativeStatus(storage || undefined),
        retry: false,
        staleTime: 0,
        refetchInterval: 8000
    });
}

export function nativeGateOf(query: { data?: NativeStatus; isError: boolean; error: unknown; isPending: boolean }): NativeGate {
    if (query.isError) return { state: 'unavailable', reason: describeError(query.error).message };
    if (!query.data) return { state: 'checking' };
    const status = query.data;
    if (!status.host.supported) return { state: 'blocked', reason: status.host.reason || 'This machine is not supported.', remedy: status.host.remedy, status };
    if (!status.elevation.available) return { state: 'blocked', reason: 'The manager cannot get administrator rights here without a password prompt.', remedy: ELEVATION_REMEDY, status };
    return { state: 'ready', status };
}

export function nativeBlockText(gate: NativeGate): string {
    if (gate.state === 'blocked') return `${gate.reason}${gate.remedy ? ` ${gate.remedy}` : ''}`;
    if (gate.state === 'unavailable') return gate.reason;
    return '';
}

const row = (name: string, value: ReactNode) => <div key={name} className="wizard-fact"><dt>{name}</dt><dd>{value}</dd></div>;

function packagesMissing(status: NativeStatus): string[] {
    return Object.entries(status.host.packages || {}).filter(([, item]) => !item.installed).flatMap(([, item]) => item.names);
}

function mountNeedsAcknowledgement(status: NativeStatus): boolean {
    return (status.host.storage?.mountIssues || []).some((issue) => issue.code === 'MOUNT_NOT_IN_FSTAB');
}

function describeDistro(status: NativeStatus): string {
    const distro = status.host.distro;
    if (!distro) return 'unknown';
    return distro.label || `${distro.id} ${distro.version || ''}${distro.arch ? ` (${distro.arch})` : ''}`.trim();
}

/** What the check found on this machine. Read-only: nothing here changed anything. */
export function NativeHostCard({ gate, status }: { gate: NativeGate; status?: NativeStatus }) {
    const host = status?.host;
    const clusters = host?.clusters || [];
    return (
        <div className="wizard-form" data-testid="native-host-card" data-state={gate.state}>
            <h3 className="section-title">PostgreSQL on this machine</h3>
            {gate.state === 'checking' && <p role="status" className="hint">Checking this machine…</p>}
            {gate.state === 'unavailable' && <p role="alert" className="settings-danger" data-testid="native-unavailable">{gate.reason}</p>}
            {gate.state === 'blocked' && (
                <p role="alert" className="settings-danger" data-testid="native-blocked">{gate.reason}{gate.remedy && <span className="hint" data-testid="native-remedy"> {gate.remedy}</span>}</p>
            )}
            {host && (
                <dl className="wizard-facts">
                    {row('System', <span data-testid="native-distro">{describeDistro(status as NativeStatus)}{host.distro?.raspberryPi ? ' (Raspberry Pi)' : ''}</span>)}
                    {row('Packages', host.packageManager ? <span data-testid="native-packages">{packagesMissing(status as NativeStatus).length === 0 ? `PostgreSQL ${host.major} is installed` : `PostgreSQL ${host.major} is not installed yet (${host.packageManager} installs ${packagesMissing(status as NativeStatus).join(', ')})`}</span> : 'not checked')}
                    {row('Administrator rights', <span data-testid="native-elevation" data-available={String(status?.elevation.available)}>{status?.elevation.available ? 'available (a privileged helper can run)' : 'not available without a password prompt'}</span>)}
                    {row('Other clusters', <span data-testid="native-clusters">{clusters.length === 0 ? 'none; the installer would create the first' : clusters.map((cluster) => `${cluster.name} (PostgreSQL ${cluster.version ?? '?'}, port ${cluster.port ?? '?'})`).join(', ')}{clusters.some((cluster) => !cluster.owned) ? ' — left exactly as they are' : ''}</span>)}
                    {row('Backup tools', host.backupTools ? <span data-testid="native-backup-tools" data-code={host.backupTools.code}>{host.backupTools.ok ? `pg_dump ${host.backupTools.version || ''} can back this database up` : (host.backupTools.code === 'BACKUP_TOOLS_MISSING' ? 'pg_dump is not installed here' : `${host.backupTools.version || 'pg_dump'} is older than the database`)}</span> : 'not checked')}
                </dl>
            )}
        </div>
    );
}

type FormProps = { value: NativeAnswer; onChange: (next: NativeAnswer) => void; status?: NativeStatus; problems?: FormProblem[] };

/** Port, bind address and data folder, the package-install approval and the acknowledgements. */
export function NativeForm({ value, onChange, status, problems = [] }: FormProps) {
    const set = <K extends keyof NativeAnswer>(key: K, next: NativeAnswer[K]) => onChange({ ...value, [key]: next });
    const problemOf = (field: string) => problems.find((problem) => problem.field === field)?.message;
    const lan = value.bind.trim() !== '' && value.bind.trim() !== '127.0.0.1';
    const missing = status ? packagesMissing(status) : [];
    const backup = status?.host.backupTools && !status.host.backupTools.ok ? status.host.backupTools : null;
    const taken = status?.host.clusters.find((cluster) => String(cluster.port) === value.port.trim());
    const storage = status?.host.storage;
    const error = (id: string) => problemOf(id) && <span className="settings-danger" role="alert" data-testid={`${id}-problem`}>{problemOf(id)}</span>;
    return (
        <fieldset className="wizard-fieldset" data-testid="native-form">
            <legend>The database cluster</legend>
            <div className="wizard-field">
                <label htmlFor="native-port">Port on this machine</label>
                <input id="native-port" className="input" inputMode="numeric" value={value.port} spellCheck={false} autoComplete="off" aria-describedby="native-port-help"
                    onChange={(event) => set('port', event.target.value)} data-testid="native-port" />
                <span className="hint" id="native-port-help">5432 unless something already listens there; the review tells you and offers the next free port.</span>
                {taken && <span className="hint" role="status" data-testid="native-port-taken">Cluster {taken.name} already uses port {taken.port}; the installer will not share it.</span>}
                {error('native-port')}
            </div>
            <div className="wizard-field">
                <label htmlFor="native-bind">Listen on</label>
                <input id="native-bind" className="input" value={value.bind} spellCheck={false} autoComplete="off" aria-describedby="native-bind-help"
                    onChange={(event) => set('bind', event.target.value)} data-testid="native-bind" />
                <span className="hint" id="native-bind-help">127.0.0.1 keeps the database reachable from this machine only (recommended).</span>
                {lan && (
                    <label className="wizard-choice">
                        <input type="checkbox" checked={value.acknowledgeLanBind} onChange={(event) => set('acknowledgeLanBind', event.target.checked)} data-testid="native-lan" />
                        {' '}I understand other machines on the network can reach this database
                    </label>
                )}
                {error('native-bind')}
            </div>
            <div className="wizard-field">
                <label htmlFor="native-path">Data folder (optional)</label>
                <input id="native-path" className="input" value={value.dataDirectory} spellCheck={false} autoComplete="off" aria-describedby="native-path-help" placeholder={status?.names.dataDirectory || status?.host.layout?.defaultDataParent || ''}
                    onChange={(event) => set('dataDirectory', event.target.value)} data-testid="native-path" />
                <span className="hint" id="native-path-help">Leave empty for the default. The folder must be empty or not exist yet; the installer never deletes it unless you ask when uninstalling.</span>
                {storage?.path && storage.freeBytes !== null && <span className="hint" data-testid="native-free">{formatBytes(storage.freeBytes)} free there</span>}
                {error('native-path')}
            </div>
            {status && mountNeedsAcknowledgement(status) && (
                <label className="wizard-choice">
                    <input type="checkbox" checked={value.acknowledgeMount} onChange={(event) => set('acknowledgeMount', event.target.checked)} data-testid="native-mount-ack" />
                    {' '}That folder is on a mount that is not listed in /etc/fstab; set it up anyway
                </label>
            )}
            {missing.length > 0 && (
                <label className="wizard-choice">
                    <input type="checkbox" checked={value.installPackages} onChange={(event) => set('installPackages', event.target.checked)} data-testid="native-install-packages" />
                    {' '}Install the PostgreSQL packages ({missing.join(', ')}) with {status?.host.packageManager}; they stay installed if the database is removed
                </label>
            )}
            {backup && (
                <div className="wizard-callout" data-testid="native-tools-problem">
                    <p>{backup.code === 'BACKUP_TOOLS_MISSING' ? 'pg_dump is not installed on this machine, so Goobster\'s backups cannot read this database.' : `The pg_dump on this machine (${backup.version || 'unknown'}) is older than the database, so Goobster\'s backups cannot read it.`}</p>
                    {backup.remedy && <p className="hint">{backup.remedy}</p>}
                    <label className="wizard-choice">
                        <input type="checkbox" checked={value.acknowledgeBackupTools} onChange={(event) => set('acknowledgeBackupTools', event.target.checked)} data-testid="native-tools-ack" />
                        {' '}Set it up anyway; I will fix the backup tools
                    </label>
                </div>
            )}
        </fieldset>
    );
}

/** Whether the form plus the check allow going on, with what is missing. */
export function nativeReady(value: NativeAnswer, gate: NativeGate): { ok: boolean; problems: FormProblem[] } {
    const problems = nativeProblems(value);
    if (gate.state !== 'ready') return { ok: false, problems };
    const status = gate.status;
    if (packagesMissing(status).length > 0 && !value.installPackages) problems.push({ field: 'native-install-packages', message: 'Approve installing the PostgreSQL packages.' });
    if (status.host.backupTools && !status.host.backupTools.ok && !value.acknowledgeBackupTools) problems.push({ field: 'native-tools-ack', message: 'Acknowledge the backup-tools problem, or fix it first.' });
    if (mountNeedsAcknowledgement(status) && !value.acknowledgeMount) problems.push({ field: 'native-mount-ack', message: 'Acknowledge the mount warning, or choose another folder.' });
    return { ok: problems.length === 0, problems };
}

/** What will be created, by name, before anything is. */
export function NativePlanPreview({ value, status }: { value: NativeAnswer; status: NativeStatus }) {
    const names = status.names;
    const folder = value.dataDirectory.trim() || names.dataDirectory || `${status.host.layout?.defaultDataParent || ''}/${names.cluster}`;
    return (
        <div data-testid="native-plan-preview">
            <h3 className="section-title">What the installer will create</h3>
            <dl className="wizard-facts">
                {row('Cluster', <code data-testid="native-name-cluster">{names.cluster}</code>)}
                {names.service && row('Service', <code data-testid="native-name-service">{names.service}</code>)}
                {row('Data', <span><code data-testid="native-name-data">{folder}</code> <span className="hint">(never deleted unless you ask when uninstalling)</span></span>)}
                {row('Reachable at', <code>{`${value.bind.trim() || '127.0.0.1'}:${value.port.trim() || '5432'}`}</code>)}
                {row('Passwords', 'Generated for you and never shown. The application\'s one is kept only in the manager\'s private file; the database role it signs in with cannot create roles or databases.')}
                {row('Other clusters', 'Not touched: no setting or file of an existing PostgreSQL cluster is read for writing.')}
                {row('Uninstall', 'Keeps the data and the packages unless you ask to remove the data, and then removes exactly this cluster.')}
            </dl>
            {names.template && <p className="hint">The cluster is named <code>goobster</code>, or carries the first characters of this installation&apos;s id when that name is taken.</p>}
        </div>
    );
}

export function NativeFindingsList({ findings, testId }: { findings: NativeFinding[]; testId: string }) {
    if (findings.length === 0) return null;
    return (
        <ul className="wizard-findings" data-testid={testId}>
            {findings.map((item, index) => (
                <li key={`${item.code}-${index}`} data-severity={item.severity === 'block' ? 'block' : 'warn'} data-code={item.code}>
                    <span className={`badge ${item.severity === 'block' ? 'state-revoked' : 'state-unverified'}`}>{item.severity === 'block' ? 'Blocks this' : 'Worth knowing'}</span> {item.detail}
                    {item.remedy && <span className="hint"> {item.remedy}</span>}
                </li>
            ))}
        </ul>
    );
}

/** The native choice of the Database step: the check, the form and the preview in one block. */
export function NativeOption({ value, onChange, problems }: { value: NativeAnswer; onChange: (next: NativeAnswer) => void; problems: FormProblem[] }) {
    const query = useNativeStatus(value.dataDirectory.trim().startsWith('/') ? value.dataDirectory.trim() : undefined);
    const gate = nativeGateOf(query);
    const status = gate.state === 'ready' || gate.state === 'blocked' ? gate.status : query.data;
    return (
        <div data-testid="native-option">
            <NativeHostCard gate={gate} status={status} />
            {gate.state === 'ready' && (
                <>
                    <NativeForm value={value} onChange={onChange} status={gate.status} problems={problems} />
                    <NativePlanPreview value={value} status={gate.status} />
                </>
            )}
        </div>
    );
}
