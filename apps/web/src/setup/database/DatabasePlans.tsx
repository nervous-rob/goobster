import type { ReactNode } from 'react';
import type { InstallOperation } from '../../lib/types';
import { Findings, StepList } from '../ui';

type Target = { host?: string; port?: number; database?: string; schema?: string; user?: string; tls?: { mode?: string; ca?: boolean } };

const SCHEMA_EFFECT: Record<string, string> = {
    'apply-schema': 'Create Goobster\'s tables in the empty schema.',
    'update-schema': 'Bring Goobster\'s older tables up to date. Nothing is deleted.',
    none: 'The schema already matches this release; nothing will change.'
};

const where = (target: Target | undefined) => (target
    ? `${target.host}:${target.port}/${target.database}${target.schema && target.schema !== 'public' ? ` (schema ${target.schema})` : ''} as ${target.user}`
    : 'unknown');

function Facts({ rows, testId }: { rows: Array<[string, ReactNode]>; testId?: string }) {
    return (
        <dl className="wizard-facts" data-testid={testId}>
            {rows.map(([name, value]) => <div key={name} className="wizard-fact"><dt>{name}</dt><dd>{value}</dd></div>)}
        </dl>
    );
}

/** The one line the install plan shows for the database. */
export function describeDatabase(plan: InstallOperation['plan']): ReactNode {
    const engine = plan.target?.database?.engine;
    if (engine === 'sqlite') return 'SQLite, one file in the data folder';
    if (engine === 'postgres' && (plan as { dockerDatabase?: unknown }).dockerDatabase) {
        const docker = (plan as { dockerDatabase: { names?: { container?: string; volume?: string }; request?: { port?: number; bind?: string } } }).dockerDatabase;
        return <span data-testid="plan-database-docker">PostgreSQL in Docker, created by the installer: container <code>{docker.names?.container}</code> on <code>{docker.request?.bind}:{docker.request?.port}</code> <span className="hint">(kept when you uninstall, unless you ask otherwise)</span></span>;
    }
    if (engine === 'postgres' && (plan as { nativeDatabase?: unknown }).nativeDatabase) {
        const native = (plan as { nativeDatabase: { names?: { cluster?: string }; request?: { port?: number; bind?: string }; port?: { chosen?: number } } }).nativeDatabase;
        return <span data-testid="plan-database-native">PostgreSQL on this machine, created by the installer: cluster <code>{native.names?.cluster}</code> on <code>{native.request?.bind || '127.0.0.1'}:{native.port?.chosen ?? native.request?.port}</code> <span className="hint">(kept when you uninstall, unless you ask otherwise)</span></span>;
    }
    if (engine === 'postgres') {
        const target = (plan as { databaseTarget?: Target }).databaseTarget;
        return <span data-testid="plan-database-postgres">PostgreSQL on a server you run: <code>{where(target)}</code> <span className="hint">(never deleted by Goobster)</span></span>;
    }
    return engine || '';
}

type ProbeSummary = { schema?: { state?: string } | null; blocks?: Array<{ code: string; detail?: string }>; warnings?: Array<{ code: string; detail?: string }> };

export function ConnectPlan({ operation }: { operation: InstallOperation }) {
    const plan = operation.plan as unknown as {
        from?: { engine?: string }; to?: Target; probe?: ProbeSummary; leaves?: { sqliteFile?: string; previousDatabase?: string };
        maintenance?: { mode?: string }; steps?: Array<{ name: string }>; release?: boolean;
    };
    const warnings = (plan.probe?.warnings || []).map((item) => ({ code: item.code, severity: 'warn' as const, detail: item.detail || item.code }));
    return (
        <div data-testid="plan-connect">
            <Facts rows={[
                ['From', plan.from?.engine === 'sqlite' ? 'SQLite (the empty file in the data folder)' : 'The PostgreSQL server in use now'],
                ['To', <code key="to" data-testid="plan-connect-to">{where(plan.to)}</code>],
                ['Encryption', `${plan.to?.tls?.mode || 'default'}${plan.to?.tls?.ca ? ', with a CA file' : ''}`],
                ['The schema there', plan.probe?.schema?.state || 'unknown'],
                ['Stays as it is', plan.leaves?.sqliteFile || plan.leaves?.previousDatabase || 'everything else'],
                ['Maintenance', plan.maintenance?.mode === 'held' ? 'the barrier you already hold' : 'entered for you; left in place until you release it'],
                ['After it', 'The application starts on the new connection, validated while it was fenced. The installation stays paused until you release maintenance.']
            ]} />
            <Findings findings={warnings} />
            <h3 className="section-title">What will happen, in order</h3>
            <StepList planned={(plan.steps || []).map((step) => step.name)} done={[]} status="validated" />
        </div>
    );
}

export function SchemaPlan({ operation }: { operation: InstallOperation }) {
    const plan = operation.plan as unknown as { effect?: string; database?: Target; schema?: { state?: string; tables?: number } | null; steps?: Array<{ name: string }> };
    return (
        <div data-testid="plan-schema">
            <Facts rows={[
                ['Server', <code key="d">{where(plan.database)}</code>],
                ['Now', plan.schema ? `${plan.schema.state}${plan.schema.tables ? `, ${plan.schema.tables} tables` : ''}` : 'unknown'],
                ['This will', SCHEMA_EFFECT[plan.effect || ''] || plan.effect || '']
            ]} />
            <h3 className="section-title">What will happen, in order</h3>
            <StepList planned={(plan.steps || []).map((step) => step.name)} done={[]} status="validated" />
        </div>
    );
}
