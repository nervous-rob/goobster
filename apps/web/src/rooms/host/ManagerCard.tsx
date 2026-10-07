import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { HostManagerStatus } from '../../lib/types';
import { DocLink, HOST_KEYS } from './shared';

const REMEDY: Record<string, { title: string; body: string; slug: string; hash?: string; label: string }> = {
    MANAGER_UNREACHABLE: {
        title: 'The manager is not running',
        body: 'The Host pages change this installation through its manager, and nothing answered at the configured address. Start the manager, or correct its address in the installation settings.',
        slug: 'host-operations', hash: 'manager-unavailable', label: 'What to do when the manager is unavailable'
    },
    MANAGER_URL_REFUSED: {
        title: 'The manager address is not accepted',
        body: 'The address must be http on this machine, or https, with no credentials or path. Correct manager.baseUrl or GOOBSTER_MANAGER_URL and restart the portal.',
        slug: 'host-operations', hash: 'manager-unavailable', label: 'What to do when the manager is unavailable'
    },
    MANAGER_NOT_CLAIMED: {
        title: 'The manager has not been claimed yet',
        body: 'The manager is running, but nobody has completed first-time setup, so the portal cannot act through it. Claim it with the one-time credential it printed.',
        slug: 'manager', hash: 'first-time-setup', label: 'First-time setup'
    },
    MANAGER_RECOVERY: {
        title: 'The manager is in recovery',
        body: 'It accepts local recovery only, so these pages are read-only until recovery finishes.',
        slug: 'manager', hash: 'local-recovery', label: 'Local recovery'
    },
    MANAGER_BRIDGE_UNAVAILABLE: {
        title: 'The portal has no key for the manager',
        body: 'The portal reads a key the manager writes when it is claimed. Restart the portal after the manager is set up.',
        slug: 'host-operations', hash: 'manager-unavailable', label: 'What to do when the manager is unavailable'
    },
    MANAGER_BRIDGE_REFUSED: {
        title: 'The manager did not accept the portal',
        body: 'The key may have changed, for example after an adoption. Restart the portal so it reads the manager\'s current key.',
        slug: 'host-operations', hash: 'manager-unavailable', label: 'What to do when the manager is unavailable'
    }
};

/** What the page says when the manager cannot be used; a status, never an error page. */
export function ManagerNotice({ status }: { status: HostManagerStatus }) {
    const code = status.error?.code;
    if (!code) return null;
    const remedy = REMEDY[code] || REMEDY.MANAGER_UNREACHABLE;
    return (
        <div className="list-card" role="status" data-testid="manager-unavailable" data-code={code}>
            <div className="list-row"><span><strong>{remedy.title}</strong></span></div>
            <div className="list-row"><span>{remedy.body}</span></div>
            <div className="list-row"><DocLink slug={remedy.slug} hash={remedy.hash}>{remedy.label}</DocLink></div>
        </div>
    );
}

/** The manager's status for a page: `usable` is true when changes can be made through it. */
export function useManagerStatus() {
    const query = useQuery({ queryKey: HOST_KEYS.manager, queryFn: () => api.hostManager(), refetchInterval: 15_000 });
    const status = query.data;
    const usable = Boolean(status && status.reachable && !status.error);
    return { managerQuery: query, status, usable };
}
