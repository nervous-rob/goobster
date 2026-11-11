/** Shared portal earcons. Assets are original Goobster round 2.1 recordings. */
export const SOUND_THEMES = [
    { value: 'goo-pop', label: 'Goo Pop', hint: 'Liquid bubbles and elastic bends (default)' },
    { value: 'pocket-wood', label: 'Pocket Wood', hint: 'Dry wooden knocks and brushed texture' },
    { value: 'prism', label: 'Prism', hint: 'Shimmering glass bells' },
    { value: 'orbit', label: 'Orbit', hint: 'Crunchy arcade chirps' }
] as const;
export type SoundTheme = typeof SOUND_THEMES[number]['value'];
export const SOUND_CUES = ['notification', 'success', 'attention', 'failure', 'send', 'voice-open', 'voice-close'] as const;
export type SoundCue = typeof SOUND_CUES[number];
export type SoundSettings = {
    notifySounds: boolean;
    soundTheme: SoundTheme;
    soundVolume: number;
    soundNotifications: boolean;
    soundInteractions: boolean;
    soundVoice: boolean;
};
const defaults: SoundSettings = { notifySounds: false, soundTheme: 'goo-pop', soundVolume: 60,
    soundNotifications: true, soundInteractions: true, soundVoice: true };
let settings = { ...defaults };
let context: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer>>();
let active: AudioBufferSourceNode | null = null;
let lastPlayed = 0;
let lastCue: SoundCue | null = null;
let version = 0;
let voiceActive = false;
const media = new Set<HTMLMediaElement>();
const seen = new Map<string, number>();
export function soundSettings(values: Partial<SoundSettings> = {}): SoundSettings {
    return { ...defaults, ...values,
        soundTheme: SOUND_THEMES.some(t => t.value === values.soundTheme) ? values.soundTheme! : defaults.soundTheme,
        soundVolume: typeof values.soundVolume === 'number' && Number.isFinite(values.soundVolume)
            ? Math.max(0, Math.min(100, values.soundVolume)) : defaults.soundVolume };
}
export function stopSound(): void {
    version++;
    try { active?.stop(); } catch { /* already ended */ }
    active = null;
}
export function configureSounds(values?: Partial<SoundSettings>): void {
    stopSound();
    settings = soundSettings(values);
}
export function setVoiceSoundSuppression(on: boolean): void {
    voiceActive = on;
    if (on) stopSound();
}
function getContext(): AudioContext {
    if (!context || context.state === 'closed') context = new AudioContext();
    return context;
}
/** Mounted by the shell; browsers unlock WebAudio only from a user gesture. */
export function installSoundLifecycle(): () => void {
    const unlock = () => {
        if (!settings.notifySounds) return;
        try { void getContext().resume().catch(() => undefined); } catch { /* unavailable */ }
    };
    const onPlay = (e: Event) => {
        if (e.target instanceof HTMLMediaElement) { media.add(e.target); stopSound(); }
    };
    const onStop = (e: Event) => { if (e.target instanceof HTMLMediaElement) media.delete(e.target); };
    const onHidden = () => { if (document.hidden) stopSound(); };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
    document.addEventListener('play', onPlay, true);
    document.addEventListener('pause', onStop, true);
    document.addEventListener('ended', onStop, true);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
        document.removeEventListener('pointerdown', unlock, true);
        document.removeEventListener('keydown', unlock, true);
        document.removeEventListener('play', onPlay, true);
        document.removeEventListener('pause', onStop, true);
        document.removeEventListener('ended', onStop, true);
        document.removeEventListener('visibilitychange', onHidden);
        configureSounds(); media.clear(); seen.clear(); voiceActive = false; lastPlayed = 0;
        const old = context; context = null; buffers.clear();
        void old?.close().catch(() => undefined);
    };
}
function categoryEnabled(cue: SoundCue, config: SoundSettings): boolean {
    return cue.startsWith('voice-') ? config.soundVoice : cue === 'send' || cue === 'failure'
        ? config.soundInteractions : config.soundNotifications;
}
/** Previews deliberately bypass mute/category switches, using the unsaved draft. */
export async function playSound(cue: SoundCue, options: { preview?: Partial<SoundSettings>; eventId?: string; notification?: boolean } = {}): Promise<boolean> {
    const preview = options.preview;
    const config = preview ? soundSettings(preview) : settings;
    if (!preview && (!config.notifySounds || !(options.notification ? config.soundNotifications : categoryEnabled(cue, config)))) return false;
    if (!config.soundVolume || document.hidden || (!preview && voiceActive && !cue.startsWith('voice-'))) return false;
    for (const element of media) {
        if (element.paused || element.ended) media.delete(element);
        else return false;
    }
    const now = Date.now();
    if (!preview && !cue.startsWith('voice-') && now - lastPlayed < 250
        && (cue !== 'failure' || lastCue === 'failure')) return false;
    if (!preview && options.eventId && seen.has(options.eventId)) return false;
    try {
        const ctx = getContext();
        // Never queue unsolicited sound for a later gesture.
        if (preview) await ctx.resume();
        if (ctx.state !== 'running') return false;
        stopSound();
        const request = version;
        const key = `${config.soundTheme}/${cue}`;
        let pending = buffers.get(key);
        if (!pending) {
            pending = fetch(`${import.meta.env.BASE_URL}sounds/${key}.wav`, { signal: AbortSignal.timeout(3000) })
                .then(r => { if (!r.ok) throw new Error('Sound unavailable'); return r.arrayBuffer(); })
                .then(bytes => ctx.decodeAudioData(bytes));
            buffers.set(key, pending);
            void pending.catch(() => buffers.delete(key));
        }
        const buffer = await pending;
        if (request !== version || document.hidden || ctx.state !== 'running') return false;
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        gain.gain.value = config.soundVolume / 100;
        source.buffer = buffer;
        source.connect(gain).connect(ctx.destination);
        active = source; lastPlayed = Date.now(); lastCue = cue;
        if (options.eventId) {
            seen.set(options.eventId, lastPlayed);
            if (seen.size > 200) seen.delete(seen.keys().next().value!);
        }
        return await new Promise<boolean>(resolve => {
            // A suspended/backgrounded context must not hold voice startup forever.
            const timeout = window.setTimeout(() => {
                try { source.stop(); } catch { /* already ended */ }
                finish();
            }, (buffer.duration + 0.5) * 1000);
            const finish = () => {
                window.clearTimeout(timeout);
                source.disconnect(); gain.disconnect();
                if (active === source) active = null;
                resolve(true);
            };
            source.onended = finish;
            source.start();
        });
    } catch { return false; }
}
