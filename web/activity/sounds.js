/**
 * Synthesized game sound effects (WebAudio, no audio assets). Every effect
 * is generated on the fly: oscillators for tones, filtered noise for card
 * sounds. Muting persists in localStorage. The AudioContext is created
 * lazily on the first user gesture (browser autoplay policy).
 */

let audioCtx = null;
let muted = localStorage.getItem('goobster-casino-muted') === '1';

function ctx() {
    if (!audioCtx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        audioCtx = new Ctor();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

export function isMuted() {
    return muted;
}

export function toggleMuted() {
    muted = !muted;
    localStorage.setItem('goobster-casino-muted', muted ? '1' : '0');
    return muted;
}

/** Short tone with a percussive envelope. */
function tone(freq, { at = 0, duration = 0.15, type = 'sine', volume = 0.22 } = {}) {
    const ac = ctx();
    if (!ac || muted) return;
    const t0 = ac.currentTime + at;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
}

/** Filtered noise burst - the card flick. */
function noise({ at = 0, duration = 0.06, volume = 0.25, freq = 2600 } = {}) {
    const ac = ctx();
    if (!ac || muted) return;
    const t0 = ac.currentTime + at;
    const samples = Math.floor(ac.sampleRate * duration);
    const buffer = ac.createBuffer(1, samples, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < samples; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / samples);

    const source = ac.createBufferSource();
    source.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = 0.9;
    const gain = ac.createGain();
    gain.gain.value = volume;
    source.connect(filter).connect(gain).connect(ac.destination);
    source.start(t0);
}

export const sounds = {
    card() { noise({ freq: 2600 }); noise({ at: 0.03, freq: 1700, volume: 0.15 }); },
    chip() { tone(2093, { duration: 0.08, volume: 0.14 }); tone(2637, { at: 0.05, duration: 0.09, volume: 0.12 }); },
    turn() { tone(880, { duration: 0.2, type: 'triangle' }); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.09, duration: 0.22, type: 'triangle' })); },
    blackjack() { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, { at: i * 0.08, duration: 0.3, type: 'square', volume: 0.1 })); },
    lose() { [392, 330, 262].forEach((f, i) => tone(f, { at: i * 0.11, duration: 0.24, type: 'sawtooth', volume: 0.1 })); },
    push() { tone(440, { duration: 0.15, type: 'triangle' }); tone(440, { at: 0.18, duration: 0.15, type: 'triangle' }); },
    bust() { tone(196, { duration: 0.4, type: 'sawtooth', volume: 0.14 }); noise({ duration: 0.2, freq: 500, volume: 0.14 }); }
};

/** Map a server event stream to sounds (only meaningful ones). */
export function playForEvents(events, myUserId) {
    for (const event of events || []) {
        const mine = event.userId === myUserId;
        switch (event.type) {
            case 'deal': sounds.card(); setTimeout(sounds.card, 120); setTimeout(sounds.card, 240); break;
            case 'card':
            case 'dealer-card':
            case 'dealer-reveal': sounds.card(); break;
            case 'bet': sounds.chip(); break;
            case 'double': sounds.chip(); break;
            case 'turn': if (mine) sounds.turn(); break;
            case 'bust': if (mine) sounds.bust(); break;
            case 'blackjack': (mine ? sounds.blackjack : sounds.win)(); break;
            case 'win': if (mine) sounds.win(); break;
            case 'lose': if (mine) sounds.lose(); break;
            case 'push': if (mine) sounds.push(); break;
        }
    }
}
