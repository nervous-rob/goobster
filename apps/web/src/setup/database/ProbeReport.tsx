import type { ReactNode } from 'react';
import type { DatabaseFinding, DatabaseReport } from '../../lib/types';
import { verdictOf } from './model';

const AUTH_TEXT: Record<DatabaseReport['auth'], string> = {
    ok: 'signed in',
    'wrong-credentials': 'the server rejected the user name or password',
    'database-missing': 'the database does not exist',
    'permission-denied': 'the role may not connect to this database',
    'tls-failed': 'the encrypted connection could not be set up',
    unreachable: 'the server could not be reached'
};

const SCHEMA_TEXT: Record<string, string> = {
    'missing-schema': 'does not exist',
    empty: 'exists and is empty: ready for Goobster\'s tables',
    'goobster-current': 'already holds Goobster\'s tables for this release',
    'goobster-older': 'holds Goobster\'s tables from an older release: applying the schema brings them up to date',
    'goobster-newer': 'was written by a newer release of Goobster: this release will not write into it',
    foreign: 'holds objects that are not Goobster\'s: Goobster will not write into it'
};

function Rows({ rows }: { rows: Array<[string, ReactNode]> }) {
    return (
        <dl className="wizard-facts">
            {rows.map(([name, value]) => <div key={name} className="wizard-fact"><dt>{name}</dt><dd>{value}</dd></div>)}
        </dl>
    );
}

function FindingList({ title, items, tone }: { title: string; items: DatabaseFinding[]; tone: 'block' | 'warn' | 'info' }) {
    if (items.length === 0) return null;
    return (
        <ul className="wizard-findings" aria-label={title} data-testid={`db-${tone}`}>
            {items.map((finding, index) => (
                <li key={`${finding.code}-${index}`} data-severity={tone} data-code={finding.code}>
                    <span className={`badge ${tone === 'block' ? 'state-revoked' : (tone === 'warn' ? 'state-unverified' : '')}`}>{title}</span>
                    {' '}{finding.detail}
                    {finding.remediation && <div className="hint" data-testid="db-remediation">{finding.remediation}</div>}
                    <span className="sr-only"> ({finding.code})</span>
                </li>
            ))}
        </ul>
    );
}

/**
 * What the read-only probe found, in the order a person fixes things: whether
 * it works, what blocks it and how to fix each block, then the facts.
 */
export function ProbeReport({ report, stale = false }: { report: DatabaseReport; stale?: boolean }) {
    const verdict = verdictOf(report);
    const tls = report.tls;
    return (
        <div className="wizard-callout" data-testid="db-report" data-verdict={verdict.tone} data-next={report.verdict.next} data-stale={stale ? 'true' : 'false'} aria-live="polite">
            <p role="status" className={verdict.tone === 'ok' ? 'wizard-success' : undefined}><strong>{verdict.text}</strong></p>
            <FindingList title="Blocks this" items={report.verdict.blocks} tone="block" />
            <FindingList title="Worth knowing" items={report.verdict.warnings} tone="warn" />
            <FindingList title="Note" items={report.verdict.notes} tone="info" />
            <Rows rows={[
                ['Server', report.server ? <span key="s" data-testid="db-server">PostgreSQL {report.server.text}{report.server.supported ? '' : ` (needs ${Math.floor(report.server.minimum / 10000)} or newer)`}</span> : 'not reached'],
                ['Driver in Goobster', report.client.pg ? `pg ${report.client.pg}` : 'unknown'],
                ['Sign-in', <span key="a" data-testid="db-auth" data-auth={report.auth}>{AUTH_TEXT[report.auth]}</span>],
                ['Encryption', <span key="t" data-testid="db-tls-result">
                    {tls.requested === tls.effective ? tls.effective : `${tls.requested}, used ${tls.effective}`}
                    {tls.encrypted === null ? '' : (tls.encrypted ? `; encrypted${tls.protocol ? ` (${tls.protocol})` : ''}${tls.verified ? ', certificate checked' : ', certificate not checked'}` : '; not encrypted')}
                </span>],
                ...(report.role ? [['Role', <span key="r">{report.role.user}: {report.role.superuser ? 'superuser' : 'ordinary role'}{report.role.createDatabase ? ', may create databases' : ''}{report.role.createRole ? ', may create roles' : ''}</span>] as [string, ReactNode]] : []),
                ['May create tables here', report.reachable ? (report.privileges.createInSchema ? 'yes' : 'no') : 'not known'],
                ...(report.schema ? [['Schema', <span key="sc" data-testid="db-schema-state" data-state={report.schema.state}>{report.schema.name} {SCHEMA_TEXT[report.schema.state] || report.schema.state}{report.schema.tables > 0 ? ` (${report.schema.tables} table${report.schema.tables === 1 ? '' : 's'})` : ''}</span>] as [string, ReactNode]] : [])
            ]} />
            {report.extensions && (
                <table className="wizard-table" data-testid="db-extensions">
                    <caption className="hint">Extensions. &ldquo;On the server&rdquo; is not the same as &ldquo;created in this database&rdquo;.</caption>
                    <thead><tr><th scope="col">Extension</th><th scope="col">On the server</th><th scope="col">Created here</th><th scope="col">Trusted</th></tr></thead>
                    <tbody>
                        {Object.entries(report.extensions).map(([name, info]) => (
                            <tr key={name} data-extension={name}>
                                <th scope="row">{name}</th>
                                <td>{info.available ? 'yes' : 'no'}</td>
                                <td>{info.installed ? 'yes' : 'no'}</td>
                                <td>{info.trusted === null ? 'n/a' : (info.trusted ? 'yes' : 'no')}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {report.active && <p className="hint" data-testid="db-active">This is the database this installation uses now.</p>}
        </div>
    );
}
