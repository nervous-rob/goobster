import { clearSampleStore } from './sampleStore';
import { clearConservatoryStorage } from './storage';

/** Wipe Conservatory localStorage keys and sample clips from this browser. */
export function forgetConservatory(): void {
    clearConservatoryStorage();
    void clearSampleStore();
}
