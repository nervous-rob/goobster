import { createContext, useContext, type ReactNode } from 'react';
import { api } from '../../lib/api';
import type { HostProbeOutcome } from '../../lib/types';

/**
 * What the Host form components need from the outside world. In the portal it
 * is the portal's own routes (the default); the setup client
 * (documentation/setup_wizard.md) supplies the manager's, so one set of form
 * components renders both and the Host pages behave exactly as before.
 */
export type HostTransport = {
    probe: (body: { target: string; useSaved?: boolean; credential?: string }) => Promise<HostProbeOutcome>;
    /** Where a "More about this" link goes; null renders it as plain text (the manager serves no docs pages). */
    docHref: ((slug: string, hash?: string) => string | null) | null;
};

const PORTAL: HostTransport = {
    probe: (body) => api.hostProbe(body),
    docHref: null
};

const TransportContext = createContext<HostTransport | null>(null);

export function HostTransportProvider({ value, children }: { value: HostTransport; children: ReactNode }) {
    return <TransportContext.Provider value={value}>{children}</TransportContext.Provider>;
}

export function useHostTransport(): HostTransport | null {
    return useContext(TransportContext);
}

export function useProbe(): HostTransport['probe'] {
    return useContext(TransportContext)?.probe ?? PORTAL.probe;
}
