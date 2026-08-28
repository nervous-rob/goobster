/**
 * Persistent storage for user-uploaded sample clips. Audio blobs are too big
 * for localStorage, so trimmed WAV clips live in IndexedDB keyed by sample id
 * (voice presets in localStorage reference them). Decoded AudioBuffers are
 * cached in-memory so orchestrators can build samplers synchronously.
 */

const DB_NAME = 'goobster-conservatory';
const DB_VERSION = 1;
const STORE = 'samples';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export function makeSampleId(): string {
  return `sample-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export async function saveSampleBlob(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  try {
    await requestToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).put(blob, id));
  } finally {
    db.close();
  }
}

export async function loadSampleBlob(id: string): Promise<Blob | null> {
  const db = await openDb();
  try {
    const result = await requestToPromise<Blob | undefined>(
      db.transaction(STORE, 'readonly').objectStore(STORE).get(id) as IDBRequest<Blob | undefined>
    );
    return result ?? null;
  } finally {
    db.close();
  }
}

export function clearSampleStore(): Promise<void> {
  bufferCache.clear();
  pendingLoads.clear();
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

export async function deleteSampleBlob(id: string): Promise<void> {
  bufferCache.delete(id);
  const db = await openDb();
  try {
    await requestToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
  } finally {
    db.close();
  }
}

// --- In-memory decoded buffer cache ---

const bufferCache = new Map<string, AudioBuffer>();
const pendingLoads = new Map<string, Promise<AudioBuffer | null>>();

export function getCachedSampleBuffer(id: string): AudioBuffer | null {
  return bufferCache.get(id) ?? null;
}

/** Caches a freshly-created buffer (e.g. right after saving in the editor). */
export function cacheSampleBuffer(id: string, buffer: AudioBuffer): void {
  bufferCache.set(id, buffer);
}

/**
 * Loads a sample from IndexedDB and decodes it with the provided decoder
 * (the caller supplies its audio context's decodeAudioData). Concurrent
 * requests for the same id share one load.
 */
export function ensureSampleBuffer(
  id: string,
  decode: (data: ArrayBuffer) => Promise<AudioBuffer>
): Promise<AudioBuffer | null> {
  const cached = bufferCache.get(id);
  if (cached) return Promise.resolve(cached);
  const pending = pendingLoads.get(id);
  if (pending) return pending;

  const load = (async () => {
    try {
      const blob = await loadSampleBlob(id);
      if (!blob) return null;
      const buffer = await decode(await blob.arrayBuffer());
      bufferCache.set(id, buffer);
      return buffer;
    } catch {
      return null;
    } finally {
      pendingLoads.delete(id);
    }
  })();
  pendingLoads.set(id, load);
  return load;
}
