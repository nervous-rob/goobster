import { api } from '../lib/api';
import type { HostLifecycle, InstallOperation, InstallOperationKind } from '../lib/types';
import type { FirstRun, WizardTransport } from './transport';

const INSTALL_KINDS: string[] = ['install.new', 'install.reconfigure', 'install.repair', 'install.uninstall'];

/**
 * The maintenance journeys inside the portal: the same transport interface
 * over the Host routes (which proxy to the manager with the portal's bridge
 * assertion and write the audit record). The browser holds no manager
 * credential here.
 */
export const portalTransport: WizardTransport = {
    mode: 'portal',
    suggest: () => api.hostInstallSuggest(),
    record: () => api.hostInstallRecord(),
    source: (dir) => api.hostInstallSource(dir),
    config: () => api.hostConfig(),
    probe: (body) => api.hostProbe(body),
    preview: async (kind, input) => {
        if (!INSTALL_KINDS.includes(kind)) throw new Error(`The portal does not run ${kind} from the wizard.`);
        const planned = await api.hostPreview(kind as InstallOperationKind, input);
        return { operation: planned.operation as unknown as InstallOperation };
    },
    apply: async (id) => {
        const applied = await api.hostApply(id);
        return { operation: applied.operation as unknown as InstallOperation, result: (applied.result as Record<string, unknown> | null) ?? null };
    },
    operation: async (id) => (await api.hostOperation(id)).operation,
    lifecycle: (): Promise<HostLifecycle> => api.hostLifecycle(),
    lifecycleAction: async (action) => { await api.hostLifecycleAction(action); },
    firstRun: async (): Promise<FirstRun> => {
        const lifecycle = await api.hostLifecycle();
        const workers = lifecycle.workers || [];
        const ready = workers.length > 0 && workers.every((worker) => worker.healthy === true);
        return {
            ok: ready,
            portal: null,
            checks: [{
                id: 'workers', label: 'Application processes', ok: ready,
                detail: ready ? 'every worker answered' : (workers.length === 0 ? 'the manager is not supervising workers' : 'a worker is not healthy'),
                hint: ready ? null : 'Open the Restart panel on the Overview page.'
            }]
        };
    },
    docHref: (slug, hash) => `/app/docs/${slug}${hash ? `#${hash}` : ''}`
};
