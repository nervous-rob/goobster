export const PERSONA_PALETTE = [
    '#7c8cff', '#59d18c', '#ffb454', '#ff7ac8',
    '#54c2ff', '#b18aff', '#ffd166', '#8fe388'
];

export function personaColor(persona?: { id?: number; color?: string } | null): string {
    return persona?.color || PERSONA_PALETTE[(Number(persona?.id) || 0) % PERSONA_PALETTE.length];
}

export function personaGlyph(persona?: { emoji?: string; name?: string } | null): string {
    return persona?.emoji || (persona?.name ? [...persona.name][0].toUpperCase() : '?');
}

export function timeLabel(iso?: string): string {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
