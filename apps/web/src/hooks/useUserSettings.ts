import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { keys } from '../lib/query';
import type { SectionUpdateResponse, SettingSection, SettingsSectionId, UserSettingsResponse } from '../lib/types';

export function useUserSettings() {
    return useQuery({
        queryKey: keys.settings,
        queryFn: () => api.settings()
    });
}

/** Write one section's fresh server state into the shared settings cache. */
export function useApplySectionResult() {
    const queryClient = useQueryClient();
    return useCallback((result: SectionUpdateResponse) => {
        queryClient.setQueryData<UserSettingsResponse>(keys.settings, (old) => {
            if (!old) return old;
            return {
                ...old,
                sections: {
                    ...old.sections,
                    [result.section]: result.data
                }
            };
        });
    }, [queryClient]);
}

type ChangesFn<D> = (draft: D, baseline: D) => Record<string, unknown>;

export type SectionDraft<D> = {
    draft: D;
    baseline: D;
    revision: number;
    dirty: boolean;
    saving: boolean;
    error: string | null;
    /** The server has a newer revision than the one this draft was started from. */
    changedElsewhere: boolean;
    set: (patch: Partial<D>) => void;
    discard: () => void;
    /** Adopt the server's latest values, throwing away the local draft. */
    takeServer: () => void;
    save: () => Promise<SectionUpdateResponse | null>;
    reset: (expectedRevision: number) => Promise<SectionUpdateResponse | null>;
};

/**
 * Explicit Save / Discard draft over one settings section.
 *
 * Clean drafts follow the server automatically (another device or a Discord
 * command changed something). Dirty drafts are preserved and flagged as
 * "changed elsewhere" so the person decides. Saves send the revision the
 * draft was started from; a 409 keeps the draft and surfaces the conflict.
 */
export function useSectionDraft<TValues, D>(
    section: SettingsSectionId,
    server: SettingSection<TValues> | undefined,
    toDraft: (values: TValues) => D,
    toChanges: ChangesFn<D>
): SectionDraft<D> {
    const applyResult = useApplySectionResult();
    const serverDraft = useMemo(() => (server ? toDraft(server.values) : null), [server, toDraft]);
    const serverRevision = server?.revision ?? 0;

    const [baseline, setBaseline] = useState<D | null>(serverDraft);
    const [draft, setDraft] = useState<D | null>(serverDraft);
    const [revision, setRevision] = useState(serverRevision);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dirty = useMemo(
        () => Boolean(draft && baseline) && JSON.stringify(draft) !== JSON.stringify(baseline),
        [draft, baseline]
    );
    const dirtyRef = useRef(dirty);
    dirtyRef.current = dirty;

    useEffect(() => {
        if (!serverDraft) return;
        if (!dirtyRef.current) {
            setBaseline(serverDraft);
            setDraft(serverDraft);
            setRevision(serverRevision);
        }
    }, [serverDraft, serverRevision]);

    const changedElsewhere = dirty && serverRevision !== revision;

    const set = useCallback((patch: Partial<D>) => {
        setError(null);
        setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    }, []);

    const takeServer = useCallback(() => {
        if (!serverDraft) return;
        setBaseline(serverDraft);
        setDraft(serverDraft);
        setRevision(serverRevision);
        setError(null);
    }, [serverDraft, serverRevision]);

    const discard = takeServer;

    const save = useCallback(async () => {
        if (!draft || !baseline) return null;
        const changes = toChanges(draft, baseline);
        if (Object.keys(changes).length === 0) return null;
        setSaving(true);
        setError(null);
        try {
            const result = await api.updateSettingsSection(section, { expectedRevision: revision, changes });
            applyResult(result);
            const next = toDraft(result.data.values as TValues);
            setBaseline(next);
            setDraft(next);
            setRevision(result.revision);
            return result;
        } catch (err) {
            const e = err as ApiError;
            if (e.status === 409) {
                setError('Settings were changed elsewhere. Review the latest values before saving again.');
            } else {
                setError(e.message || 'Save failed.');
            }
            return null;
        } finally {
            setSaving(false);
        }
    }, [draft, baseline, section, revision, toChanges, toDraft, applyResult]);

    const reset = useCallback(async (expectedRevision: number) => {
        setSaving(true);
        setError(null);
        try {
            const result = await api.resetSettingsSection(section, expectedRevision);
            applyResult(result);
            const next = toDraft(result.data.values as TValues);
            setBaseline(next);
            setDraft(next);
            setRevision(result.revision);
            return result;
        } catch (err) {
            setError((err as Error).message || 'Reset failed.');
            return null;
        } finally {
            setSaving(false);
        }
    }, [section, toDraft, applyResult]);

    const fallback = (serverDraft ?? ({} as D));
    return {
        draft: draft ?? fallback,
        baseline: baseline ?? fallback,
        revision,
        dirty,
        saving,
        error,
        changedElsewhere,
        set,
        discard,
        takeServer,
        save,
        reset
    };
}

/** Report a section's dirty state upward, and clear it when the section unmounts. */
export function useReportDirty(onDirty: (dirty: boolean) => void, dirty: boolean): void {
    useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
    useEffect(() => () => { onDirty(false); }, [onDirty]);
}

/** Shallow diff helper for toChanges implementations. */
export function diffKeys<D extends Record<string, unknown>>(draft: D, baseline: D): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(draft)) {
        if (JSON.stringify(draft[key]) !== JSON.stringify(baseline[key])) out[key] = draft[key];
    }
    return out;
}
