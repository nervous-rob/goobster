import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { HostConfigField, HostConfigReport } from '../lib/types';
import { useTransport } from './transport';

export const KEYS = {
    suggest: ['setup', 'suggest'],
    record: ['setup', 'record'],
    config: ['setup', 'config'],
    source: (dir: string) => ['setup', 'source', dir],
    firstRun: ['setup', 'first-run'],
    lifecycle: ['setup', 'lifecycle']
} as const;

export function useSuggest() {
    const transport = useTransport();
    return useQuery({ queryKey: KEYS.suggest, queryFn: () => transport.suggest(), retry: false, staleTime: 15_000 });
}

export function useRecord() {
    const transport = useTransport();
    return useQuery({ queryKey: KEYS.record, queryFn: () => transport.record(), retry: false, staleTime: 0 });
}

export function useSource(dir: string) {
    const transport = useTransport();
    return useQuery({
        queryKey: KEYS.source(dir),
        queryFn: () => transport.source(dir),
        enabled: dir.trim().length > 0,
        retry: false,
        staleTime: 60_000
    });
}

export function useConfigReport() {
    const transport = useTransport();
    const query = useQuery({ queryKey: KEYS.config, queryFn: () => transport.config(), retry: false, staleTime: 0, refetchOnWindowFocus: false });
    const fields = useMemo(() => new Map<string, HostConfigField>(((query.data as HostConfigReport | undefined)?.sections || [])
        .flatMap((section) => section.fields).map((field) => [field.id, field])), [query.data]);
    return { query, fields, report: query.data };
}
