import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { DockerFinding, DockerStatus } from '../../lib/types';
import { describeError, formatBytes } from '../ui';
import { useDatabaseApi } from './api';
import { dockerProblems, type DockerAnswer, type FormProblem } from './model';

/** The daemon check as a gate: still asking, usable, or blocked with the first reason and its remedy. */
export type DockerGate =
    | { state: 'checking' }
    | { state: 'unavailable'; reason: string }
    | { state: 'blocked'; blocks: DockerFinding[]; reason: string }
    | { state: 'ready'; status: DockerStatus };

export function useDockerStatus(storage?: string) {
    const databaseApi = useDatabaseApi();
    return useQuery({
        queryKey: ['database', 'docker', storage || ''],
        queryFn: () => databaseApi.dockerStatus(storage || undefined),
        retry: false,
        staleTime: 0,
        refetchInterval: 8000
    });
}

export function gateOf(query: { data?: DockerStatus; isError: boolean; error: unknown; isPending: boolean }): DockerGate {
    if (query.isError) return { state: 'unavailable', reason: describeError(query.error).message };
    if (!query.data) return { state: 'checking' };
    const blocks = query.data.daemon.verdict.blocks;
    if (blocks.length > 0) return { state: 'blocked', blocks, reason: `${blocks[0].detail}${blocks[0].remedy ? ` ${blocks[0].remedy}` : ''}` };
    return { state: 'ready', status: query.data };
}

const row = (name: string, value: ReactNode) => <div key={name} className="wizard-fact"><dt>{name}</dt><dd>{value}</dd></div>;

/** What the check found, each failure with its remedy. Read-only: nothing here changed anything. */
export function DockerDaemonCard({ gate, status }: { gate: DockerGate; status?: DockerStatus }) {
    const report = status?.daemon;
    return (
        <div className="wizard-form" data-testid="docker-daemon-card" data-state={gate.state}>
            <h3 className="section-title">Docker on this machine</h3>
            {gate.state === 'checking' && <p role="status" className="hint">Checking Docker…</p>}
            {gate.state === 'unavailable' && <p role="alert" className="settings-danger" data-testid="docker-unavailable">{gate.reason}</p>}
            {report && (
                <dl className="wizard-facts">
                    {row('Command', report.cli.present ? `docker ${report.cli.version || ''}`.trim() : 'not installed')}
                    {row('Daemon', report.daemon.reachable ? `reachable (${report.daemon.flavor || 'engine'} ${report.daemon.serverVersion || ''}${report.daemon.rootless ? ', rootless' : ''})`.replace(/\s+\)/, ')') : 'not reachable')}
                    {row('Platform', report.platform.platform || `${report.platform.os} ${report.platform.arch}`)}
                    {row('Image', <span data-testid="docker-image"><code>{report.image.humanReference}</code> <span className="hint">pinned by digest; {report.image.pulled === null ? 'not checked' : (report.image.pulled ? 'already on this machine' : `not downloaded yet (about ${formatBytes(report.image.pullBytes)})`)}</span></span>)}
                    {row('Backup tools', report.backupTools ? <span data-testid="docker-backup-tools" data-code={report.backupTools.code}>{report.backupTools.ok ? `pg_dump ${report.backupTools.version || ''} can back this database up` : (report.backupTools.code === 'BACKUP_TOOLS_MISSING' ? 'pg_dump is not installed here' : `${report.backupTools.version || 'pg_dump'} is older than the database`)}</span> : 'not checked')}
                </dl>
            )}
            {report && report.verdict.blocks.length > 0 && (
                <ul className="wizard-findings" data-testid="docker-blocks">
                    {report.verdict.blocks.map((item, index) => (
                        <li key={`${item.code}-${index}`} data-severity="block" data-code={item.code}>
                            <span className="badge state-revoked">Blocks this</span> {item.detail}
                            {item.remedy && <span className="hint" data-testid="docker-remedy"> {item.remedy}</span>}
                        </li>
                    ))}
                </ul>
            )}
            {report && report.verdict.warnings.length > 0 && (
                <ul className="wizard-findings" data-testid="docker-warnings">
                    {report.verdict.warnings.map((item, index) => (
                        <li key={`${item.code}-${index}`} data-severity="warn" data-code={item.code}>
                            <span className="badge state-unverified">Worth knowing</span> {item.detail}
                            {item.remedy && <span className="hint"> {item.remedy}</span>}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

type FormProps = { value: DockerAnswer; onChange: (next: DockerAnswer) => void; status?: DockerStatus; problems?: FormProblem[] };

/** Port, bind address and storage, the image download approval and the backup-tools acknowledgement. */
export function DockerForm({ value, onChange, status, problems = [] }: FormProps) {
    const set = <K extends keyof DockerAnswer>(key: K, next: DockerAnswer[K]) => onChange({ ...value, [key]: next });
    const problemOf = (field: string) => problems.find((problem) => problem.field === field)?.message;
    const report = status?.daemon;
    const lan = value.bind.trim() !== '' && value.bind.trim() !== '127.0.0.1';
    const needsPull = report?.image.pulled === false;
    const toolsProblem = report?.backupTools && !report.backupTools.ok ? report.backupTools : null;
    const error = (id: string) => problemOf(id) && <span className="settings-danger" role="alert" data-testid={`${id}-problem`}>{problemOf(id)}</span>;
    return (
        <fieldset className="wizard-fieldset" data-testid="docker-form">
            <legend>The database container</legend>
            <div className="wizard-field">
                <label htmlFor="docker-port">Port on this machine</label>
                <input id="docker-port" className="input" inputMode="numeric" value={value.port} spellCheck={false} autoComplete="off" aria-describedby="docker-port-help"
                    onChange={(event) => set('port', event.target.value)} data-testid="docker-port" />
                <span className="hint" id="docker-port-help">5432 unless something already listens there; the check below tells you and offers the next free port.</span>
                {error('docker-port')}
            </div>
            <div className="wizard-field">
                <label htmlFor="docker-bind">Listen on</label>
                <input id="docker-bind" className="input" value={value.bind} spellCheck={false} autoComplete="off" aria-describedby="docker-bind-help"
                    onChange={(event) => set('bind', event.target.value)} data-testid="docker-bind" />
                <span className="hint" id="docker-bind-help">127.0.0.1 keeps the database reachable from this machine only (recommended).</span>
                {lan && (
                    <label className="wizard-choice">
                        <input type="checkbox" checked={value.acknowledgeLanBind} onChange={(event) => set('acknowledgeLanBind', event.target.checked)} data-testid="docker-lan" />
                        {' '}I understand other machines on the network can reach this database
                    </label>
                )}
                {error('docker-bind')}
            </div>
            <div role="radiogroup" aria-label="Where the data is stored">
                <label className="wizard-choice">
                    <input type="radio" name="docker-storage" checked={value.storage === 'volume'} onChange={() => set('storage', 'volume')} data-testid="docker-storage-volume" />
                    {' '}<strong>A Docker volume</strong> <span className="hint">managed by Docker; the default</span>
                </label>
                <label className="wizard-choice">
                    <input type="radio" name="docker-storage" checked={value.storage === 'path'} onChange={() => set('storage', 'path')} data-testid="docker-storage-path" />
                    {' '}<strong>A folder I choose</strong> <span className="hint">the installer never deletes it</span>
                </label>
            </div>
            {value.storage === 'path' && (
                <div className="wizard-field">
                    <label htmlFor="docker-path">Folder</label>
                    <input id="docker-path" className="input" value={value.path} spellCheck={false} autoComplete="off"
                        onChange={(event) => set('path', event.target.value)} data-testid="docker-path" />
                    {report?.storage.path && <span className="hint" data-testid="docker-free">{formatBytes(report.storage.freeBytes)} free there</span>}
                    {error('docker-path')}
                </div>
            )}
            {needsPull && (
                <label className="wizard-choice">
                    <input type="checkbox" checked={value.pull} onChange={(event) => set('pull', event.target.checked)} data-testid="docker-pull" />
                    {' '}Download the database image (about {formatBytes(report?.image.pullBytes)})
                </label>
            )}
            {toolsProblem && (
                <div className="wizard-callout" data-testid="docker-tools-problem">
                    <p>{toolsProblem.code === 'BACKUP_TOOLS_MISSING' ? 'pg_dump is not installed on this machine, so Goobster\'s backups cannot read this database.' : `The pg_dump on this machine (${toolsProblem.version || 'unknown'}) is older than the database, so Goobster\'s backups cannot read it.`}</p>
                    {toolsProblem.remedy && <p className="hint">{toolsProblem.remedy}</p>}
                    <label className="wizard-choice">
                        <input type="checkbox" checked={value.acknowledgeBackupTools} onChange={(event) => set('acknowledgeBackupTools', event.target.checked)} data-testid="docker-tools-ack" />
                        {' '}Set it up anyway; I will fix the backup tools
                    </label>
                </div>
            )}
        </fieldset>
    );
}

/** Whether the form plus the check allow going on, with what is missing. */
export function dockerReady(value: DockerAnswer, gate: DockerGate): { ok: boolean; problems: FormProblem[] } {
    const problems = dockerProblems(value);
    if (gate.state !== 'ready') return { ok: false, problems };
    const report = gate.status.daemon;
    if (report.image.pulled === false && !value.pull) problems.push({ field: 'docker-pull', message: 'Approve downloading the database image.' });
    if (report.backupTools && !report.backupTools.ok && !value.acknowledgeBackupTools) problems.push({ field: 'docker-tools-ack', message: 'Acknowledge the backup-tools problem, or fix it first.' });
    return { ok: problems.length === 0, problems };
}

/** What will be created, by name, before anything is. */
export function DockerPlanPreview({ value, status }: { value: DockerAnswer; status: DockerStatus }) {
    const names = status.names;
    return (
        <div data-testid="docker-plan-preview">
            <h3 className="section-title">What the installer will create</h3>
            <dl className="wizard-facts">
                {row('Container', <code data-testid="docker-name-container">{names.container}</code>)}
                {row('Network', <code data-testid="docker-name-network">{names.network}</code>)}
                {row('Data', value.storage === 'path' ? <span><code>{value.path.trim() || 'a folder you choose'}</code> <span className="hint">(never deleted by the installer)</span></span> : <code data-testid="docker-name-volume">{names.volume}</code>)}
                {row('Reachable at', <code>{`${value.bind.trim() || '127.0.0.1'}:${value.port.trim() || '5432'}`}</code>)}
                {row('Image', <code>{status.daemon.image.humanReference}</code>)}
                {row('Passwords', 'Generated for you and never shown. The application\'s one is kept only in the manager\'s private file.')}
                {row('Uninstall', 'Keeps the data unless you ask to remove it, and then removes exactly these.')}
            </dl>
            {names.template && <p className="hint">The names carry the first characters of this installation\'s id, which exists once it is set up.</p>}
        </div>
    );
}

/** The Docker choice of the Database step: the check, the form and the preview in one block. */
export function DockerOption({ value, onChange, problems }: { value: DockerAnswer; onChange: (next: DockerAnswer) => void; problems: FormProblem[] }) {
    const query = useDockerStatus(value.storage === 'path' && value.path.trim().startsWith('/') ? value.path.trim() : undefined);
    const gate = gateOf(query);
    const status = gate.state === 'ready' ? gate.status : query.data;
    return (
        <div data-testid="docker-option">
            <DockerDaemonCard gate={gate} status={status} />
            {gate.state === 'ready' && (
                <>
                    <DockerForm value={value} onChange={onChange} status={gate.status} problems={problems} />
                    <DockerPlanPreview value={value} status={gate.status} />
                </>
            )}
        </div>
    );
}
