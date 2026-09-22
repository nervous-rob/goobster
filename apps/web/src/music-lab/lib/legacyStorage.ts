/** Unowned data is never read by normal Music Lab loaders. Explicit recovery only. */
import { api } from '../../lib/api';
import { accountStoragePrefix } from '../../lib/browserAccount';
import { CONSERVATORY_STORAGE_PREFIX, conservatoryStorageKey } from './storage';

export async function recoverLegacyLab(importData: boolean): Promise<void> {
    // Existing accounts only, after a recent proof of identity. The server
    // never receives this browser's compositions or audio.
    await api.authorizeLegacyLab();
    const owner = accountStoragePrefix();
    const entries: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(CONSERVATORY_STORAGE_PREFIX)) entries[key.slice(CONSERVATORY_STORAGE_PREFIX.length)] = localStorage.getItem(key)!;
    }
    const samples: Array<{ id: IDBValidKey; blob: Blob }> = await new Promise((resolve, reject) => {
        const request = indexedDB.open('goobster-conservatory', 1);
        request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('samples')) { db.close(); resolve([]); return; }
            const found: Array<{ id: IDBValidKey; blob: Blob }> = [];
            const tx = db.transaction('samples', 'readonly');
            const cursor = tx.objectStore('samples').openCursor();
            cursor.onsuccess = () => {
                if (!cursor.result) return;
                found.push({ id: cursor.result.key, blob: cursor.result.value });
                cursor.result.continue();
            };
            tx.oncomplete = () => { db.close(); resolve(found); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        };
        request.onerror = () => reject(request.error);
    });
    if (accountStoragePrefix() !== owner) throw new Error('The account changed. Try again.');
    if (importData) {
        // Refuse an occupied namespace: never silently overwrite newer work.
        if (Object.keys(localStorage).some(key => key.startsWith(conservatoryStorageKey('')))) {
            throw new Error('This account already has Music Lab data on this device. Export the legacy data instead.');
        }
        const { saveSampleBlob } = await import('./sampleStore');
        for (const sample of samples) {
            if (accountStoragePrefix() !== owner) throw new Error('The account changed. Try again.');
            await saveSampleBlob(String(sample.id), sample.blob);
        }
        if (accountStoragePrefix() !== owner) throw new Error('The account changed. Try again.');
        for (const [key, value] of Object.entries(entries)) localStorage.setItem(conservatoryStorageKey(key), value);
        window.location.reload();
        return;
    }
    const encoded = await Promise.all(samples.map(async sample => ({
        id: sample.id, type: sample.blob.type,
        data: await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(sample.blob);
        })
    })));
    if (accountStoragePrefix() !== owner) throw new Error('The account changed. Try again.');
    const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'goobster-legacy-lab-v1', entries, samples: encoded }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'goobster-legacy-music-lab.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
