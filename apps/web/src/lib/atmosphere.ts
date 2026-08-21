const ROOM_CLASS: Record<string, string> = {
    home: 'room-home',
    study: 'room-study',
    parlor: 'room-parlor',
    library: 'room-library',
    workshop: 'room-workshop',
    observatory: 'room-observatory',
    exchange: 'room-exchange',
    tasks: 'room-tasks',
    noticed: 'room-noticed',
    decks: 'room-decks',
    usage: 'room-usage'
};

const ROOM_CLASSES = Object.values(ROOM_CLASS);
const TOD_CLASSES = ['tod-morning', 'tod-day', 'tod-dusk', 'tod-night'];

export function timeOfDayClass(date = new Date()): string {
    const hour = date.getHours();
    if (hour < 6) return 'tod-night';
    if (hour < 11) return 'tod-morning';
    if (hour < 17) return 'tod-day';
    if (hour < 21) return 'tod-dusk';
    return 'tod-night';
}

export function applyAtmosphere(room: string): void {
    const { body } = document;
    for (const cls of ROOM_CLASSES) body.classList.remove(cls);
    body.classList.add(ROOM_CLASS[room] || 'room-home');
    for (const cls of TOD_CLASSES) body.classList.remove(cls);
    body.classList.add(timeOfDayClass());
}

export function prefersReducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function canHover(): boolean {
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

export function bindTilt(el: HTMLElement | null): () => void {
    if (!el || prefersReducedMotion() || !canHover()) return () => {};
    const reset = () => {
        el.style.removeProperty('--tilt-x');
        el.style.removeProperty('--tilt-y');
    };
    const move = (event: PointerEvent) => {
        const box = el.getBoundingClientRect();
        if (!box.width || !box.height) return;
        const x = (event.clientX - box.left) / box.width - 0.5;
        const y = (event.clientY - box.top) / box.height - 0.5;
        el.style.setProperty('--tilt-x', `${(y * -5).toFixed(2)}deg`);
        el.style.setProperty('--tilt-y', `${(x * 6).toFixed(2)}deg`);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', reset);
    return () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerleave', reset);
        reset();
    };
}

export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    const delta = now - date.getTime();
    if (Math.abs(delta) < 45 * 1000) return 'just now';
    if (delta < 0) {
        const ahead = -delta;
        if (ahead < 60 * 60 * 1000) {
            const minutes = Math.max(1, Math.round(ahead / 60000));
            return `in ${minutes}m`;
        }
        if (ahead < 24 * 60 * 60 * 1000) {
            return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        }
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
    if (delta < 60 * 60 * 1000) {
        const minutes = Math.max(1, Math.round(delta / 60000));
        return `${minutes}m ago`;
    }
    if (delta < 24 * 60 * 60 * 1000) {
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatClock(date = new Date()): string {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function greeting(name: string): string {
    const hour = new Date().getHours();
    const hello = hour < 6 ? 'Still up'
        : hour < 12 ? 'Good morning'
            : hour < 18 ? 'Good afternoon'
                : hour < 22 ? 'Good evening'
                    : 'Late night';
    return name ? `${hello}, ${name}.` : `${hello}.`;
}
