/**
 * The receiving end of the Web Share Target (documentation/pwa.md). The
 * service worker parks what the OS shared - text and files - in a cache
 * and redirects to `/app/chat?shared=1`; the Study picks it up here,
 * exactly once, and drops the cache.
 */
const SHARE_CACHE = 'goobster-share-target';

export type SharedPayload = { text: string; files: File[] };

export async function consumeSharedPayload(): Promise<SharedPayload | null> {
    if (typeof window === 'undefined' || !('caches' in window)) return null;
    try {
        const has = await caches.has(SHARE_CACHE);
        if (!has) return null;
        const cache = await caches.open(SHARE_CACHE);
        const textResponse = await cache.match('/app/share-target/text');
        if (!textResponse) {
            await caches.delete(SHARE_CACHE);
            return null;
        }
        const text = (await textResponse.text()).trim();
        const names: Array<{ name: string; type: string }> = await cache.match('/app/share-target/files')
            .then((res) => (res ? res.json() : []))
            .catch(() => []);
        const files: File[] = [];
        for (let index = 0; index < names.length; index++) {
            const response = await cache.match(`/app/share-target/file/${index}`);
            if (!response) continue;
            const blob = await response.blob();
            files.push(new File([blob], names[index].name || `shared-${index + 1}`, { type: names[index].type || blob.type }));
        }
        await caches.delete(SHARE_CACHE);
        if (!text && files.length === 0) return null;
        return { text, files };
    } catch {
        return null;
    }
}
