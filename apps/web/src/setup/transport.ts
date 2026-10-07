import { createContext, useContext } from 'react';
import type {
    BackupInspection, BackupStatus, HostApplied, HostConfigReport, HostLifecycle, HostProbeOutcome, InstallOperation, InstallRecord, InstallSource, InstallSuggest,
    MaintenanceView, MigrationPreflight, MigrationStatus, ResetPreview
} from '../lib/types';

export type FirstRunCheck = { id: string; label: string; ok: boolean; detail: string; hint: string | null };
export type FirstRun = { ok: boolean; checks: FirstRunCheck[]; portal: { url: string; port: number | null; worker: string } | null };

/** What the manager reports about itself before anyone has a session (GET /manager/api/status). */
export type ManagerStatus = {
    state: 'unclaimed' | 'claimed' | 'recovery';
    reason?: string | null;
    version?: string;
    installation: { installationId: string; createdAt: string; claimed: boolean; origin: string } | null;
    existingInstallation: boolean;
    appDatabase?: { reachable?: boolean; present?: boolean; engine?: string | null; reason?: string | null } | null;
    transport: { lan: boolean; tls: boolean };
    setup?: { bootstrapPending: boolean; expiresAt: string | null; expired: boolean };
    recovery?: { credentialPending: boolean; expiresAt: string | null };
};

export type PreviewResult = { operation: InstallOperation };

/**
 * The calls the journeys make. The manager-served client implements them
 * against /manager/api with its cookie session (./api.ts); the Host room
 * implements the maintenance ones against the portal's own routes, which
 * proxy to the manager with the bridge assertion (./portalTransport.ts). The
 * steps, the forms and the plan views are the same in both.
 */
export type WizardTransport = {
    mode: 'manager' | 'portal';
    suggest(): Promise<InstallSuggest>;
    record(): Promise<InstallRecord>;
    source(dir: string): Promise<InstallSource>;
    config(): Promise<HostConfigReport>;
    probe(body: { target: string; useSaved?: boolean; credential?: string }): Promise<HostProbeOutcome>;
    /** Plan and validate; nothing is applied. */
    preview(kind: string, input: unknown): Promise<PreviewResult>;
    apply(id: string): Promise<{ operation: InstallOperation; result: Record<string, unknown> | null }>;
    operation(id: string): Promise<InstallOperation>;
    lifecycle(): Promise<HostLifecycle>;
    lifecycleAction(action: 'restart' | 'restart-now' | 'cancel'): Promise<void>;
    firstRun(): Promise<FirstRun>;
    docHref(slug: string, hash?: string): string | null;
    /** Maintenance reads (#337): what an archive holds, the last restore, the barrier, a reset's scope, the migration. */
    backupStatus(): Promise<BackupStatus>;
    backupInspect(dir: string): Promise<BackupInspection>;
    maintenance(): Promise<MaintenanceView>;
    resetPlan(scope: 'instance' | 'feature', feature?: string): Promise<ResetPreview>;
    migrateStatus(): Promise<MigrationStatus>;
    /** The manager page only: the portal has no route for it, so the journey prints the command instead. */
    migratePreflight?(url: string): Promise<MigrationPreflight>;
};

export type { HostApplied };

const Context = createContext<WizardTransport | null>(null);
export const WizardTransportProvider = Context.Provider;

export function useTransport(): WizardTransport {
    const value = useContext(Context);
    if (!value) throw new Error('The wizard has no transport.');
    return value;
}
