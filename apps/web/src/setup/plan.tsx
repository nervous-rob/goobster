import type { ReactNode } from 'react';
import type { InstallOperation } from '../lib/types';
import { LAYOUT_TEXT, summarizeRoots } from './model';
import { Findings, formatBytes, StepList } from './ui';

export function blocks(operation: InstallOperation | null | undefined): boolean {
    return Boolean(operation?.plan.preflight?.findings.some((finding) => finding.severity === 'block'));
}

function Facts({ rows, testId }: { rows: Array<[string, ReactNode]>; testId?: string }) {
    return (
        <dl className="wizard-facts" data-testid={testId}>
            {rows.map(([name, value]) => (
                <div key={name} className="wizard-fact"><dt>{name}</dt><dd>{value}</dd></div>
            ))}
        </dl>
    );
}

function Preflight({ operation }: { operation: InstallOperation }) {
    const findings = operation.plan.preflight?.findings || [];
    return (
        <>
            <h3 className="section-title">What the manager checked</h3>
            <Findings findings={findings} />
        </>
    );
}

/** The exact plan of a first install: nothing here has happened yet. */
export function NewPlan({ operation, titles }: { operation: InstallOperation; titles: (id: string) => string }) {
    const { plan } = operation;
    const target = plan.target;
    return (
        <div data-testid="plan-new">
            <Facts testId="plan-facts" rows={[
                ['Layout', <span key="l"><strong>{target?.layout}</strong> <span className="hint">{LAYOUT_TEXT[target?.layout || ''] || ''}</span></span>],
                ['Parts', (target?.features || []).map(titles).join(', ') || 'Core only'],
                ['Database', target?.database?.engine === 'sqlite' ? 'SQLite, one file in the data folder' : (target?.database?.engine || '')],
                ['Copied', plan.source?.bytes ? `${formatBytes(plan.source.bytes)} in ${plan.source.files ?? '?'} files` : 'nothing new'],
                ['Settings written', plan.config ? `${plan.config.settings.length} setting${plan.config.settings.length === 1 ? '' : 's'}${plan.config.secretCount ? `, ${plan.config.secretCount} key${plan.config.secretCount === 1 ? '' : 's'} (never shown)` : ''}` : 'none'],
                ['Starts at boot', plan.registerService === false ? 'No: start it from this page or the Host room (a later version registers it as a service)' : 'Yes']
            ]} />
            <h3 className="section-title">Folders</h3>
            <Facts testId="plan-roots" rows={summarizeRoots(target?.roots as Record<string, string>)} />
            <Preflight operation={operation} />
            <h3 className="section-title">What will happen, in order</h3>
            <StepList planned={(plan.steps || []).map((step) => step.name)} done={[]} status="validated" />
            {plan.noop && <p className="hint">This installation already matches; installing again changes nothing.</p>}
        </div>
    );
}

export function ReconfigurePlan({ operation }: { operation: InstallOperation }) {
    const { plan } = operation;
    const before = plan.target?.previousRoots || {};
    const after = plan.target?.roots || {};
    const moved = Object.keys(after).filter((role) => before[role] !== undefined && before[role] !== after[role]);
    const settings = plan.changes?.config || [];
    return (
        <div data-testid="plan-reconfigure">
            {plan.noop && <p className="hint" data-testid="plan-noop">Nothing would change.</p>}
            <ul className="list-card wizard-diff" style={{ listStyle: 'none', padding: 0 }} data-testid="plan-diff">
                {plan.changes?.layout && <li className="list-row" data-change="layout"><span>Layout becomes <strong>{plan.target?.layout}</strong></span></li>}
                {moved.map((role) => (
                    <li key={role} className="list-row" data-change={`root-${role}`}>
                        <span>{summarizeRoots({ [role]: after[role] })[0]?.[0] || role}: <code>{before[role]}</code> → <code>{after[role]}</code></span>
                    </li>
                ))}
                {settings.map((id) => <li key={id} className="list-row" data-change={`config-${id}`}><span>Change the setting <code>{id}</code></span></li>)}
                {!plan.changes?.layout && moved.length === 0 && settings.length === 0 && <li className="list-row"><span className="hint">No differences from what is installed.</span></li>}
            </ul>
            {settings.length > 0 || plan.changes?.layout || moved.length > 0 ? (
                <p className="wizard-pending" data-testid="pending-restart" role="note">
                    <strong>Takes effect after a restart.</strong> The settings are saved when you apply, but the running processes keep using the old ones until they restart.
                </p>
            ) : null}
            <Preflight operation={operation} />
            <h3 className="section-title">What will happen, in order</h3>
            <StepList planned={(plan.steps || []).map((step) => step.name)} done={[]} status="validated" />
        </div>
    );
}

export function RepairPlan({ operation }: { operation: InstallOperation }) {
    const { plan } = operation;
    return (
        <div data-testid="plan-repair">
            <Facts rows={[
                ['Program files', plan.current ? (plan.current.healthy ? 'Intact: they will be verified, not copied again' : `Damaged or missing${plan.current.code ? ` (${plan.current.code})` : ''}: they will be restored`) : 'Checked when you apply'],
                ['Database', 'Opened again and its schema brought up to date; nothing is deleted'],
                ['Feature choice', 'Rewritten from what is installed'],
                ['Kept exactly as they are', (plan.retainedData?.roots || []).length > 0 ? 'Your data, your settings file and the manager records' : 'Your data and settings']
            ]} />
            <Preflight operation={operation} />
            <h3 className="section-title">What will happen, in order</h3>
            <StepList planned={(plan.steps || []).map((step) => step.name)} done={[]} status="validated" />
        </div>
    );
}

export function UninstallPlan({ operation }: { operation: InstallOperation }) {
    const { plan } = operation;
    const removes = plan.removes || [];
    const kept = plan.retainedData?.paths || [];
    return (
        <div data-testid="plan-uninstall" data-keep-data={plan.keepData ? 'true' : 'false'}>
            <h3 className="section-title">What goes</h3>
            {removes.length === 0 ? <p className="hint">Only the program files.</p> : (
                <ul className="wizard-list" data-testid="plan-removes">
                    {removes.map((item) => <li key={`${item.role}-${item.path}`}><code>{item.path}</code> <span className="hint">({item.scope})</span></li>)}
                </ul>
            )}
            <h3 className="section-title">What stays</h3>
            {kept.length === 0 ? (
                <p className="hint" data-testid="plan-kept-none">Nothing is kept: your data and settings go too.</p>
            ) : (
                <ul className="wizard-list" data-testid="plan-kept">{kept.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
            )}
            <Facts rows={[
                ['Database', plan.database ? `${plan.database.engine}: ${plan.database.action}` : ''],
                ['Tools only the installer added', (plan.exclusiveDependencies || []).length > 0 ? (plan.exclusiveDependencies || []).join(', ') : 'none'],
                ['Tools left in place', (plan.systemDependenciesLeft || []).length > 0 ? (plan.systemDependenciesLeft || []).join(', ') : 'none']
            ]} />
            <Preflight operation={operation} />
        </div>
    );
}
