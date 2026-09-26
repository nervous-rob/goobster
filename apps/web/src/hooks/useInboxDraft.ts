import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { accountStoragePrefix } from '../lib/browserAccount';

type Kind = 'chat' | 'project';
const keyFor = (kind: Kind, id: number) => `${accountStoragePrefix()}inbox-draft.${kind}.${id}`;

/** Tab-local, account-scoped drafts. Only explicitly seeded Inbox drafts
 * are persisted; ordinary and incognito composers keep their usual rules. */
export function seedInboxDraft(kind: Kind, id: number, question: string) {
    try {
        const key = keyFor(kind, id);
        if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, question);
    } catch { /* storage may be disabled */ }
}
export function useInboxDraft(kind: Kind, id: number | null, composer: string, setComposer: Dispatch<SetStateAction<string>>) {
    const [loadedKey, setLoadedKey] = useState('');
    const key = id == null ? '' : keyFor(kind, id);
    useEffect(() => {
        setLoadedKey(key);
        if (!key) return;
        try {
            const draft = sessionStorage.getItem(key);
            if (draft !== null) setComposer(draft);
        } catch { /* storage may be disabled */ }
    }, [key, setComposer]);
    useEffect(() => {
        if (!key || key !== loadedKey) return;
        try {
            if (sessionStorage.getItem(key) !== null) sessionStorage.setItem(key, composer);
        } catch { /* storage may be disabled */ }
    }, [key, loadedKey, composer]);
}
