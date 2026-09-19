/** Retry a removed device using the system mic; permission denial is never retried. */
export async function openMicrophone(deviceId?: string | null, onFallback?: () => void): Promise<MediaStream> {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
        return await navigator.mediaDevices.getUserMedia({
            audio: { ...audio, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }
        });
    } catch (error) {
        const name = (error as DOMException).name;
        if (!deviceId || !['NotFoundError', 'OverconstrainedError'].includes(name)) throw error;
        const stream = await navigator.mediaDevices.getUserMedia({ audio });
        onFallback?.();
        return stream;
    }
}
