export const VAD_RMS_THRESHOLD: number;
export const VAD_SILENCE_MS: number;
export const MAX_UTTERANCE_MS: number;
export const PREROLL_CHUNKS: number;
export function int16Rms(samples: Int16Array | ArrayLike<number>): number;
export function int16ToBase64(samples: Int16Array): string;
export class UtteranceGate {
    constructor(hooks?: {
        onStartChunks?: (chunks: Int16Array[]) => void;
        onChunk?: (samples: Int16Array) => void;
        onEnd?: () => void;
    });
    reset(): void;
    push(samples: Int16Array, now?: number): boolean;
    end(): void;
    readonly active: boolean;
}
