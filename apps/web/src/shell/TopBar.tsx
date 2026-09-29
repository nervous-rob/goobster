import { useEffect, useId, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { Me } from '../lib/types';
import { ACCOUNT_ROOMS, PRIMARY_ROOMS, isRoomAvailable, roomBadgeCount, type Room } from '../lib/rooms';
import { ActiveFriends } from './ActiveFriends';
import { BerryMark } from '../components/BerryMark';
import { InstallEntry } from '../components/InstallEntry';

/**
 * The horizontal navigation layout (Settings → Appearance → Navigation →
 * "Across the top"). Same registry, same rooms, same `nav-btn` classes and
 * `aria-label="Rooms"` landmark as the sidebar, laid out as a bar: brand,
 * the primary rooms as pills, then theme, Settings and an account menu that
 * holds what the sidebar footer held (account rooms, Documentation, friends
 * online, sign out). On a phone the pill row scrolls sideways instead of
 * folding into a drawer.
 */
export function TopBar({ me, room, activeNav, themeLabel, onToggleTheme, onLogout }: {
    me: Me | null;
    room: string | null;
    activeNav: string | null;
    themeLabel: string;
    onToggleTheme: () => void;
    onLogout: () => void;
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const menuId = useId();

    useEffect(() => { setMenuOpen(false); }, [room]);
    useEffect(() => {
        if (!menuOpen) return;
        const onPointer = (event: PointerEvent) => {
            if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
        };
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
        document.addEventListener('pointerdown', onPointer);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onPointer);
            document.removeEventListener('keydown', onKey);
        };
    }, [menuOpen]);

    const visible = (item: Room) => !item.requires || isRoomAvailable(item, me);

    return (
        <header id="topbar">
            <Link to="/" className={`brand brand-home${room === 'home' ? ' active' : ''}`} aria-label="Home">
                <BerryMark className="brand-logo" size={24} />
                <span className="brand-text">Goobster</span>
            </Link>
            <nav className="nav topbar-nav" aria-label="Rooms">
                {PRIMARY_ROOMS.filter((item) => item.path !== '/' && visible(item)).map((item) => {
                    const active = activeNav === item.id;
                    const count = roomBadgeCount(item, me);
                    return (
                        <Link key={item.id} to={item.path as never} className={`nav-btn${active ? ' active' : ''}`}
                            aria-current={active ? 'page' : undefined} data-room={item.id} title={item.secondaryName ? `${item.name} · ${item.secondaryName}` : item.name}>
                            <span aria-hidden="true">{item.icon}</span> {item.name}
                            {item.secondaryName && <span className="nav-secondary">{item.secondaryName}</span>}
                            {count > 0 && <span className="nav-count" aria-label={`${count} unread`}>{count > 99 ? '99+' : count}</span>}
                        </Link>
                    );
                })}
            </nav>
            <div className="topbar-actions">
                <button type="button" className="topbar-icon" title="Toggle light/dark (more in Settings → Appearance)"
                    aria-label="Toggle light/dark theme" onClick={onToggleTheme}>
                    <span aria-hidden="true">{themeLabel}</span>
                </button>
                {me ? (
                    <>
                        <Link to="/settings" className={`topbar-icon${room === 'settings' ? ' active' : ''}`}
                            aria-label="Settings" title="Settings" data-tour="nav-settings"
                            aria-current={room === 'settings' ? 'page' : undefined}>
                            <span aria-hidden="true">⚙️</span>
                        </Link>
                        <div ref={menuRef} className="topbar-account">
                            <button type="button" className="topbar-icon" aria-label="Account menu" title={me.user.name || me.user.id}
                                aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuId}
                                onClick={() => setMenuOpen((v) => !v)}>
                                {me.user.avatar
                                    ? <img className="avatar" src={me.user.avatar} alt="" />
                                    : <span aria-hidden="true">🙂</span>}
                            </button>
                            {menuOpen && (
                                <div id={menuId} className="topbar-menu" role="menu" aria-label="Account">
                                    <Link to="/settings/$section" params={{ section: 'account' }} className="user-chip user-chip-link"
                                        role="menuitem" title="Account & devices">
                                        {me.user.avatar && <img className="avatar" src={me.user.avatar} alt="" />}
                                        <span>{me.user.name || me.user.id}</span>
                                    </Link>
                                    <div className="topbar-menu-sep" />
                                    <div className="nav-section">Your account</div>
                                    {ACCOUNT_ROOMS.filter((item) => item.id !== 'settings' && visible(item)).map((item) => (
                                        <Link key={item.id} to={item.path as never} role="menuitem"
                                            className={`nav-btn${activeNav === item.id ? ' active' : ''}`} data-room={item.id}>
                                            <span aria-hidden="true">{item.icon}</span> {item.name}
                                        </Link>
                                    ))}
                                    <Link to="/docs/$slug" params={{ slug: 'getting-started' }} role="menuitem"
                                        className={`nav-btn${room === 'docs' ? ' active' : ''}`}>
                                        <span aria-hidden="true">📖</span> Documentation
                                    </Link>
                                    <InstallEntry role="menuitem" onNavigate={() => setMenuOpen(false)} />
                                    <ActiveFriends />
                                    <div className="topbar-menu-sep" />
                                    <button type="button" role="menuitem" className="btn subtle" onClick={onLogout}>Log out</button>
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <>
                        <Link to="/docs/$slug" params={{ slug: 'getting-started' }}
                            className={`topbar-icon${room === 'docs' ? ' active' : ''}`} aria-label="Documentation" title="Documentation">
                            <span aria-hidden="true">📖</span>
                        </Link>
                        <Link to="/" className="btn subtle topbar-signin">Sign in</Link>
                    </>
                )}
            </div>
        </header>
    );
}
