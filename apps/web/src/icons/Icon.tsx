import { useEffect, useId, useState } from 'react';
import { ICON_STYLE_EVENT, getStoredIconStyle, isIconStyle, type IconStyle } from '../lib/appearance';
import { GLYPH_EMOJI, PROVIDER_GLYPH, ROOM_GLYPH, SECTION_GLYPH, VIEW_GLYPH, type GlyphName } from './names';
import { renderGlyph } from './render';

/** The icon style painted right now (`html[data-icon-style]`), following live previews. */
export function paintedIconStyle(): IconStyle {
    const painted = document.documentElement.dataset.iconStyle;
    return isIconStyle(painted) ? painted : getStoredIconStyle();
}

export function useIconStyle(): IconStyle {
    const [style, setStyle] = useState<IconStyle>(() => paintedIconStyle());
    useEffect(() => {
        const onChange = (event: Event) => setStyle((event as CustomEvent<IconStyle>).detail);
        window.addEventListener(ICON_STYLE_EVENT, onChange);
        setStyle(paintedIconStyle());
        return () => window.removeEventListener(ICON_STYLE_EVENT, onChange);
    }, []);
    return style;
}

/**
 * One portal icon. Draws `glyph` in the painted icon style (Settings →
 * Appearance → Icon style), or the emoji when the style is `emoji`. The
 * markup is generated code from this folder, never user content.
 */
export function Icon({ glyph, emoji, style, className = '' }: {
    glyph: GlyphName;
    /** The emoji to show in the `emoji` style; defaults to the glyph's own. */
    emoji?: string;
    /** Force a style (the Appearance picker previews every style at once). */
    style?: IconStyle;
    className?: string;
}) {
    const painted = useIconStyle();
    const active = style ?? painted;
    const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
    const markup = renderGlyph(active, glyph, uid);
    if (!markup) {
        return <span className={`glyph glyph-emoji${className ? ` ${className}` : ''}`} aria-hidden="true">{emoji ?? GLYPH_EMOJI[glyph]}</span>;
    }
    return (
        <svg className={`glyph glyph-${active}${className ? ` ${className}` : ''}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
            dangerouslySetInnerHTML={{ __html: markup }} />
    );
}

/** The icon for a room from the registry. */
export function RoomIcon({ room, className }: { room: { id: string; icon: string }; className?: string }) {
    const glyph = ROOM_GLYPH[room.id];
    return glyph ? <Icon glyph={glyph} emoji={room.icon} className={className} /> : <span className={`glyph glyph-emoji${className ? ` ${className}` : ''}`} aria-hidden="true">{room.icon}</span>;
}

/** The icon for a registered room view. */
export function ViewIcon({ view, className }: { view: { id: string; icon: string }; className?: string }) {
    const glyph = VIEW_GLYPH[view.id];
    return glyph ? <Icon glyph={glyph} emoji={view.icon} className={className} /> : <span className={`glyph glyph-emoji${className ? ` ${className}` : ''}`} aria-hidden="true">{view.icon}</span>;
}

/** The icon for a Settings section. */
export function SectionIcon({ section, className }: { section: { id: string; icon: string }; className?: string }) {
    const glyph = SECTION_GLYPH[section.id];
    return glyph ? <Icon glyph={glyph} emoji={section.icon} className={className} /> : <span className={`glyph glyph-emoji${className ? ` ${className}` : ''}`} aria-hidden="true">{section.icon}</span>;
}

/** The icon for a connection provider card. */
export function ProviderIcon({ provider, emoji, className }: { provider: string; emoji: string; className?: string }) {
    const glyph = PROVIDER_GLYPH[provider] ?? 'plug';
    return <Icon glyph={glyph} emoji={emoji} className={className} />;
}
