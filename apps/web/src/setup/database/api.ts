import { useMemo } from 'react';
import { api } from '../../lib/api';
import type { DatabaseConnectionBody, DatabaseReport, DatabaseStatus, DockerStatus } from '../../lib/types';
import { managerRequest } from '../api';
import { useTransport } from '../transport';

export type DatabaseApi = {
    test: (connection: DatabaseConnectionBody) => Promise<DatabaseReport>;
    status: () => Promise<DatabaseStatus>;
    dockerStatus: (storage?: string) => Promise<DockerStatus>;
};

/**
 * The read-only calls of the database pages. The password goes in the body of
 * `test` and nowhere else; the manager-served wizard talks to the manager
 * with its session, the portal to its own Host routes.
 */
export function useDatabaseApi(): DatabaseApi {
    const transport = useTransport();
    return useMemo<DatabaseApi>(() => (transport.mode === 'manager'
        ? {
            test: (connection) => managerRequest<DatabaseReport>('/database/test', { method: 'POST', body: { connection } }),
            status: () => managerRequest<DatabaseStatus>('/database/status'),
            dockerStatus: (storage) => managerRequest<DockerStatus>(`/docker/status${storage ? `?storage=${encodeURIComponent(storage)}` : ''}`)
        }
        : {
            test: (connection) => api.hostDatabaseTest(connection),
            status: () => api.hostDatabaseStatus(),
            dockerStatus: (storage) => api.hostDockerStatus(storage)
        }), [transport.mode]);
}
