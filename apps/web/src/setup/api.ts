import { ApiError } from '../lib/api';
import type {
    BackupInspection, BackupStatus, HostApplied, HostConfigReport, HostLifecycle, HostProbeOutcome, InstallOperation, InstallRecord, InstallSource, InstallSuggest,
    MaintenanceView, MigrationPreflight, MigrationStatus, ResetPreview
} from '../lib/types';
import type { FirstRun, ManagerStatus, WizardTransport } from './transport';

const BASE = '/manager/api';
const NONCE_BYTES = 32;

/** 32 random bytes, base64url: the per-mutation header the manager requires of a session (documentation/manager.md). */
export function newNonce(): string {
    const bytes = new Uint8Array(NONCE_BYTES);
    crypto.getRandomValues(bytes);
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class NetworkError extends ApiError {
    constructor() {
        super(0, 'NETWORK', 'The manager did not answer. It may be restarting; this page keeps trying.');
    }
}

type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal };

/**
 * One JSON request to the manager. The browser holds the session only as an
 * HttpOnly cookie, so there is no credential in this module; a mutation
 * carries a fresh nonce. The error envelope becomes an ApiError.
 */
export async function managerRequest<T>(path: string, { method = 'GET', body, signal }: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-Goobster-Nonce'] = newNonce();
    let response: Response;
    try {
        response = await fetch(`${BASE}${path}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            credentials: 'same-origin',
            cache: 'no-store',
            signal
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        throw new NetworkError();
    }
    let json: { error?: { code?: string; message?: string; details?: unknown }; operation?: unknown } | null = null;
    try { json = await response.json(); } catch { /* not JSON */ }
    if (!response.ok) {
        const error = json?.error || {};
        const details = error.details && typeof error.details === 'object'
            ? { ...(error.details as object), ...(json?.operation ? { operation: json.operation } : {}) }
            : (json?.operation ? { operation: json.operation } : null);
        throw new ApiError(response.status, error.code || 'INTERNAL', error.message || `The manager answered ${response.status}.`, details);
    }
    return json as T;
}

export const managerApi = {
    status: () => managerRequest<ManagerStatus>('/status'),
    claim: (body: { credential: string; label: string }) =>
        managerRequest<{ installationId: string; session: { expiresAt: string; kind: string } }>('/claim', { method: 'POST', body }),
    unlock: (body: { credential: string }) =>
        managerRequest<{ session: { expiresAt: string; kind: string } }>('/recovery/unlock', { method: 'POST', body }),
    logout: () => managerRequest<{ loggedOut: boolean }>('/session/logout', { method: 'POST', body: {} }),
    featureSummary: () => managerRequest<{ features: unknown }>('/features')
};

async function preview(kind: string, input: unknown): Promise<{ operation: InstallOperation }> {
    const planned = await managerRequest<{ operation: InstallOperation }>('/operations', { method: 'POST', body: { kind, input } });
    try {
        const validated = await managerRequest<{ operation: InstallOperation }>(`/operations/${encodeURIComponent(planned.operation.id)}/validate`, { method: 'POST', body: {} });
        return { operation: validated.operation };
    } catch (error) {
        // The plan exists even when validation refuses it; its findings are what the person needs to read.
        if (error instanceof ApiError) {
            const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
            throw new ApiError(error.status, error.code, error.message, { ...details, operation: planned.operation });
        }
        throw error;
    }
}

async function operation(id: string): Promise<InstallOperation> {
    return managerRequest<InstallOperation>(`/operations/${encodeURIComponent(id)}`);
}

/** The wizard's calls against the manager the page was served from. */
export const managerTransport: WizardTransport = {
    mode: 'manager',
    suggest: () => managerRequest<InstallSuggest>('/install/suggest'),
    record: () => managerRequest<InstallRecord>('/install/record'),
    source: (dir) => managerRequest<InstallSource>(`/install/source?dir=${encodeURIComponent(dir)}`),
    config: () => managerRequest<HostConfigReport>('/config'),
    probe: (body) => managerRequest<HostProbeOutcome>('/config/probe', { method: 'POST', body }),
    preview,
    apply: async (id) => {
        const current = await operation(id);
        const applied = await managerRequest<HostApplied & { operation: InstallOperation }>(`/operations/${encodeURIComponent(id)}/apply`, {
            method: 'POST',
            body: { revision: typeof current.revision === 'number' ? current.revision : null }
        });
        return { operation: applied.operation, result: (applied.result as Record<string, unknown> | null) ?? null };
    },
    operation,
    lifecycle: () => managerRequest<HostLifecycle>('/lifecycle'),
    lifecycleAction: async (action) => { await managerRequest(`/lifecycle/${action}`, { method: 'POST', body: {} }); },
    firstRun: () => managerRequest<FirstRun>('/install/first-run'),
    docHref: () => null,
    backupStatus: () => managerRequest<BackupStatus>('/backup/status'),
    backupInspect: (dir) => managerRequest<BackupInspection>(`/backup/inspect?dir=${encodeURIComponent(dir)}`),
    maintenance: () => managerRequest<MaintenanceView>('/maintenance'),
    resetPlan: (scope, feature) => managerRequest<ResetPreview>(`/reset/plan?scope=${encodeURIComponent(scope)}${feature ? `&feature=${encodeURIComponent(feature)}` : ''}`),
    migrateStatus: () => managerRequest<MigrationStatus>('/migrate/status'),
    migratePreflight: (url) => managerRequest<MigrationPreflight>('/migrate/preflight', { method: 'POST', body: { target: { url } } })
};
