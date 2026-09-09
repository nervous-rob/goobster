import { useCallback } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import type { SettingsSectionId } from '../lib/types';

declare module '@tanstack/history' {
    interface HistoryState {
        /** Where a room shortcut (Study gear, voice overlay, Noticed) came from, so Settings can offer a way back. */
        settingsReturnTo?: string;
    }
}

/**
 * Room shortcuts (the Study gear, the voice overlay gear, the Noticed
 * initiative control) open the relevant Settings section instead of their
 * own copy of the form, remembering where the person was.
 */
export function useOpenSettings() {
    const navigate = useNavigate();
    const href = useRouterState({ select: (s) => s.location.pathname + s.location.searchStr });
    return useCallback((section: SettingsSectionId, field?: string) => {
        navigate({
            to: '/settings/$section',
            params: { section },
            hash: field,
            state: { settingsReturnTo: href }
        });
    }, [navigate, href]);
}
