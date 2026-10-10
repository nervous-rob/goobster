import { useCallback, useEffect, useState } from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { api } from '../lib/api';
import { applyAtmosphere } from '../lib/atmosphere';
import { Icon, RoomIcon } from '../icons/Icon';
import { keys } from '../lib/query';
import { useSession } from '../hooks/useSession';
import { usePortalEvents } from '../hooks/usePortalEvents';
import { useToast } from '../hooks/useToast';
import { ForgetModal } from '../components/ForgetModal';
import { useRoomDrawerClose } from '../hooks/useConversationDrawer';
import { MenuProvider } from './MenuButton';
import { ActiveFriends } from './ActiveFriends';
import type { InboxEvent, ParlorMentionEvent } from '../hooks/usePortalEvents';
import {
    getStoredAccent, getStoredSurface, getStoredTheme, isAccent, isSurface, paintAccent, paintSurface, paintTheme, resolveTheme,
    setStoredAccent, setStoredSurface, setStoredTheme, THEME_EVENT, type ThemeChoice
} from '../lib/theme';
import {
    getStoredIconStyle, getStoredNavLayout, getStoredPageWidth, isIconStyle, NAV_LAYOUT_EVENT, paintAppearance, paintIconStyle,
    paintNavLayout, paintPageWidth, persistAppearance, persistIconStyle, persistNavLayout, persistPageWidth, type NavLayout
} from '../lib/appearance';
import { TopBar } from './TopBar';
import { useQuery } from '@tanstack/react-query';
import {
    ACCOUNT_ROOMS, PRIMARY_ROOMS, atmosphereFor, isRoomAvailable, legacyHashTarget,
    parentRoom, resolveRoom, roomBadgeCount, routeUnavailability, startPageTarget, type Room
} from '../lib/rooms';
import { BerryMark } from '../components/BerryMark';
import { setAppBadge, useInstallPrompt, useOnline, useServiceWorkerUpdate, useWorkerNavigation } from '../lib/pwa';
import { showLocalNotification } from '../lib/notifications';
import { InstallBanner, InstallEntry } from '../components/InstallEntry';
import { UnavailableRoom } from './UnavailableState';

function inboxNoticeTitle(kind?: string): string {
    if (kind === 'reminder') return 'A reminder came due';
    if (kind === 'invite') return 'You have an invitation';
    if (kind === 'task') return 'A task finished';
    if (kind === 'expedition') return 'Research finished';
    return 'Something new in your Inbox';
}

function NavLink({ room, active, count, onClick }: { room: Room; active: boolean; count: number; onClick: () => void }) {
    return (
        <Link to={room.path as never} className={`nav-btn${active ? ' active' : ''}`}
            aria-current={active ? 'page' : undefined} data-room={room.id} onClick={onClick}>
            <RoomIcon room={room} /> {room.name}
            {room.secondaryName && <span className="nav-secondary">{room.secondaryName}</span>}
            {count > 0 && <span className="nav-count" aria-label={`${count} unread`}>{count > 99 ? '99+' : count}</span>}
        </Link>
    );
}

// The shell tolerates a null session (public share pages render inside it):
// feature-gated rooms hide, the footer offers Sign in, and room links lead
// anonymous viewers to the login gate.
export function AppShell() {
    const me = useSession();
    const toast = useToast();
    useEffect(() => {
        // Unhandled OS files must not navigate away and discard the user's draft.
        // Target handlers stop propagation, so unrelated in-app/text drags stay native.
        const over = (event: DragEvent) => {
            if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
        };
        const drop = (event: DragEvent) => {
            if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
            event.preventDefault();
            toast('Drop attachments into Chat, a note, the knowledge map or project files.', true);
        };
        window.addEventListener('dragover', over);
        window.addEventListener('drop', drop);
        return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
    }, [toast]);
    const navigate = useNavigate();
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const [theme, setTheme] = useState<ThemeChoice>(() => getStoredTheme());
    const [navLayout, setNavLayout] = useState<NavLayout>(() => getStoredNavLayout());
    const [drawer, setDrawer] = useState(false);
    const [forgetOpen, setForgetOpen] = useState(false);
    const [mention, setMention] = useState<ParlorMentionEvent | null>(null);
    const closeRooms = useCallback(() => setDrawer(false), []);
    useRoomDrawerClose(closeRooms);
    usePortalEvents(Boolean(me));
    const settingsQ = useQuery({
        queryKey: keys.settings,
        queryFn: () => api.settings(),
        enabled: Boolean(me),
        staleTime: 30_000
    });
    const appearance = settingsQ.data?.sections.appearance.values;
    const mentionBanners = settingsQ.data?.sections.initiative.values.notifyMentionBanners !== false;
    const notifyInApp = settingsQ.data?.sections.initiative.values.notifyInApp !== false;
    const notifySounds = Boolean(settingsQ.data?.sections.initiative.values.notifySounds);
    const [attentionPing, setAttentionPing] = useState(false);
    const [inboxPing, setInboxPing] = useState<InboxEvent | null>(null);

    // Which registry room this URL belongs to (canonical or legacy), and the
    // primary sidebar entry that should light up for it (Tools for the
    // specialist rooms).
    const room = resolveRoom(pathname);
    const activeNav = parentRoom(room);
    // A stale bookmark or typed address to a room this installation cannot
    // offer says so inside the shell instead of rendering a broken room.
    const roomBlocked = routeUnavailability(pathname, me);

    useEffect(() => { applyAtmosphere(atmosphereFor(room)); }, [room]);
    useEffect(() => {
        const open = () => setForgetOpen(true);
        window.addEventListener('goobster-forget', open);
        return () => window.removeEventListener('goobster-forget', open);
    }, []);
    // Someone @-mentioned this user in a shared parlor discussion while
    // they were here - show a clickable notice that deep-links to the chat.
    useEffect(() => {
        function playPing() {
            if (!notifySounds) return;
            try {
                const ctx = new AudioContext();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.frequency.value = 880;
                gain.gain.value = 0.04;
                osc.connect(gain).connect(ctx.destination);
                osc.start();
                osc.stop(ctx.currentTime + 0.12);
            } catch { /* autoplay / reduced motion */ }
        }
        const onMention = (event: Event) => {
            if (!mentionBanners) return;
            const detail = (event as CustomEvent<ParlorMentionEvent>).detail || {};
            // A hidden tab raises the same notice through the worker
            // (documentation/pwa.md); showLocalNotification is a no-op
            // while visible or when this browser receives push.
            void showLocalNotification({
                title: `${detail.fromName || 'Someone'} mentioned you`,
                body: detail.title ? `in “${detail.title}”` : 'in a discussion',
                link: detail.conversationId ? `/discussions/${detail.conversationId}` : '/discussions',
                tag: detail.conversationId ? `mention-${detail.conversationId}-${detail.messageId ?? ''}` : null
            });
            setMention(detail);
            playPing();
        };
        const onNoticed = () => {
            if (!notifyInApp) return;
            setAttentionPing(true);
            playPing();
        };
        // A result landed in the Inbox (a reminder, a task's output, an
        // invitation) while this tab was open. Not shown while already there.
        const onInbox = (event: Event) => {
            if (!notifyInApp) return;
            const detail = (event as CustomEvent<InboxEvent>).detail || {};
            void showLocalNotification({
                title: inboxNoticeTitle(detail.kind),
                body: 'Open your Inbox in Goobster',
                link: '/activity/inbox',
                tag: detail.itemId ? `inbox-${detail.itemId}` : null
            });
            if (resolveRoom(window.location.pathname) === 'activity') return;
            setInboxPing(detail);
            playPing();
        };
        window.addEventListener('goobster-parlor-mention', onMention);
        window.addEventListener('goobster-attention-noticed', onNoticed);
        window.addEventListener('goobster-inbox', onInbox);
        return () => {
            window.removeEventListener('goobster-parlor-mention', onMention);
            window.removeEventListener('goobster-attention-noticed', onNoticed);
            window.removeEventListener('goobster-inbox', onInbox);
        };
    }, [mentionBanners, notifyInApp, notifySounds]);
    useEffect(() => {
        if (!inboxPing) return;
        const timer = window.setTimeout(() => setInboxPing(null), 12_000);
        return () => window.clearTimeout(timer);
    }, [inboxPing]);
    useEffect(() => {
        if (!mention) return;
        const timer = window.setTimeout(() => setMention(null), 12_000);
        return () => window.clearTimeout(timer);
    }, [mention]);
    useEffect(() => {
        if (!attentionPing) return;
        const timer = window.setTimeout(() => setAttentionPing(false), 12_000);
        return () => window.clearTimeout(timer);
    }, [attentionPing]);
    // Theme is a device preference (lib/theme). Settings → Appearance and the
    // footer toggle both go through setStoredTheme; this just mirrors it and
    // follows the OS when "system" is chosen.
    useEffect(() => {
        paintTheme(theme);
        const onChange = (event: Event) => setTheme((event as CustomEvent<ThemeChoice>).detail);
        window.addEventListener(THEME_EVENT, onChange);
        const media = window.matchMedia?.('(prefers-color-scheme: light)');
        const onMedia = () => { if (theme === 'system') paintTheme('system'); };
        media?.addEventListener?.('change', onMedia);
        return () => {
            window.removeEventListener(THEME_EVENT, onChange);
            media?.removeEventListener?.('change', onMedia);
        };
    }, [theme]);

    // Accent and navigation layout are account preferences with a device
    // copy (so a refresh paints the right colours before settings load).
    // The stylesheet reads `html[data-accent]`; the shell renders the
    // sidebar or the top bar from the layout event.
    useEffect(() => {
        paintAccent(getStoredAccent());
        paintSurface(getStoredSurface());
        paintNavLayout(getStoredNavLayout());
        paintPageWidth(getStoredPageWidth());
        paintIconStyle(getStoredIconStyle());
        const onLayout = (event: Event) => setNavLayout((event as CustomEvent<NavLayout>).detail);
        window.addEventListener(NAV_LAYOUT_EVENT, onLayout);
        return () => window.removeEventListener(NAV_LAYOUT_EVENT, onLayout);
    }, []);

    useEffect(() => {
        if (!appearance) return;
        if (!localStorage.getItem('goobster-theme')) setStoredTheme(appearance.theme);
        if (isAccent(appearance.accent)) setStoredAccent(appearance.accent);
        if (isSurface(appearance.surface)) setStoredSurface(appearance.surface);
        if (appearance.navLayout === 'top' || appearance.navLayout === 'sidebar') persistNavLayout(appearance.navLayout);
        if (appearance.pageWidth === 'full' || appearance.pageWidth === 'centered') persistPageWidth(appearance.pageWidth);
        if (isIconStyle(appearance.iconStyle)) persistIconStyle(appearance.iconStyle);
        persistAppearance({
            textSize: appearance.textSize,
            density: appearance.density,
            reducedMotion: appearance.reducedMotion
        });
        paintAppearance({
            textSize: appearance.textSize,
            density: appearance.density,
            reducedMotion: appearance.reducedMotion
        });
        if (appearance.linkByTag !== undefined && localStorage.getItem('goobster.map.linkByTag') === null) {
            try { localStorage.setItem('goobster.map.linkByTag', appearance.linkByTag ? '1' : '0'); } catch { /* private mode */ }
        }
        if (appearance.preferredExchangeGuild && !localStorage.getItem('goobster-exchange-guild')) {
            try { localStorage.setItem('goobster-exchange-guild', appearance.preferredExchangeGuild); } catch { /* private mode */ }
        }
    }, [appearance]);

    // The installed app's badge is the same count as the sidebar's
    // (documentation/pwa.md); cleared on sign-out and where unsupported.
    useEffect(() => {
        setAppBadge(me ? (me.inbox?.unread || 0) + (me.people?.unread || 0) + (me.people?.pending || 0) : 0);
    }, [me]);

    // A notification click lands in an already-open window: the worker
    // posts the portal path and the router takes it without a reload.
    useWorkerNavigation(useCallback((path: string) => {
        const inApp = path.startsWith('/app/') ? path.slice(4) : path === '/app' ? '/' : path;
        navigate({ to: inApp as never });
    }, [navigate]));

    const online = useOnline();
    const swUpdate = useServiceWorkerUpdate();
    const installNudge = useInstallPrompt().nudge;

    useEffect(() => {
        if (!me || !appearance?.startPage || appearance.startPage === 'home') return;
        if (pathname !== '/') return;
        if (sessionStorage.getItem('goobster-start-page-applied')) return;
        // Saved values may predate the rename (`study`, `noticed`, …); the
        // registry maps every accepted value onto its current destination.
        const to = startPageTarget(appearance.startPage);
        if (!to) return;
        sessionStorage.setItem('goobster-start-page-applied', '1');
        navigate({ to: to as never, replace: true });
    }, [appearance, me, navigate, pathname]);

    useEffect(() => {
        // The pre-router client addressed rooms as `#room/id`; those links
        // still resolve through the registry.
        // Documentation fragments are article headings, even when named
        // `projects`, `settings`, or another old room id.
        if (resolveRoom(window.location.pathname) === 'docs') return;
        const dest = legacyHashTarget(window.location.hash);
        if (dest) {
            navigate({ to: dest as never, replace: true });
            history.replaceState(null, '', window.location.pathname + window.location.search);
        }
    }, [navigate]);

    async function logout() {
        try { await api.logout(); } catch { /* already out */ }
    }

    const toggleTheme = () => setStoredTheme(resolveTheme(theme) === 'light' ? 'dark' : 'light');
    const themeLabel = <Icon glyph={resolveTheme(theme) === 'light' ? 'sun' : 'moon'} />;

    return (
        <MenuProvider open={() => setDrawer(true)}>
        <div className={`app${navLayout === 'top' ? ' nav-top' : ''}`}>
            {navLayout === 'top' ? (
                <TopBar me={me} room={room} activeNav={activeNav} themeLabel={themeLabel}
                    onToggleTheme={toggleTheme} onLogout={logout} />
            ) : (<>
            <div id="sidebar-backdrop" className={`sidebar-backdrop${drawer ? '' : ' hidden'}`} onClick={() => setDrawer(false)} />
            <aside id="sidebar" className={drawer ? 'open' : ''}>
                <div className="sidebar-top">
                    <Link to="/" className={`brand brand-home${room === 'home' ? ' active' : ''}`} onClick={() => setDrawer(false)}>
                        <BerryMark className="brand-logo" size={24} /> Goobster
                    </Link>
                    <nav className="nav" aria-label="Rooms">
                        {PRIMARY_ROOMS.filter((item) => item.path !== '/').map((item) => {
                            // Feature-gated and operator rooms stay off the map
                            // when this installation or account cannot use them;
                            // a direct URL still resolves and explains itself.
                            if (item.requires && !isRoomAvailable(item, me)) return null;
                            const count = roomBadgeCount(item, me);
                            return <NavLink key={item.id} room={item} active={activeNav === item.id} count={count} onClick={() => setDrawer(false)} />;
                        })}
                        {me && (
                            <div className="nav-account">
                                <div className="nav-section">Your account</div>
                                {ACCOUNT_ROOMS.filter((item) => item.id !== 'settings').map((item) => {
                                    if (item.requires && !isRoomAvailable(item, me)) return null;
                                    return <NavLink key={item.id} room={item} active={activeNav === item.id} count={0} onClick={() => setDrawer(false)} />;
                                })}
                            </div>
                        )}
                    </nav>
                    <ActiveFriends />
                </div>
                <div className="sidebar-footer">
                    <Link to="/docs/$slug" params={{ slug: 'getting-started' }}
                        className={`nav-btn${room === 'docs' ? ' active' : ''}`} aria-current={room === 'docs' ? 'page' : undefined}
                        onClick={() => setDrawer(false)}><span aria-hidden="true">📖</span> Documentation</Link>
                    <button type="button" className="btn subtle" title="Toggle light/dark (more in Settings → Appearance)"
                        onClick={toggleTheme}>
                        {themeLabel} Theme
                    </button>
                    {me ? (
                        <>
                            <InstallEntry onNavigate={() => setDrawer(false)} />
                            <Link to="/settings" className={`nav-btn settings-link${room === 'settings' ? ' active' : ''}`}
                                data-tour="nav-settings"
                                onClick={() => setDrawer(false)}>
                                ⚙️ Settings
                            </Link>
                            <Link to="/settings/$section" params={{ section: 'account' }} className="user-chip user-chip-link"
                                title="Account & devices" onClick={() => setDrawer(false)}>
                                {me.user.avatar && <img className="avatar" src={me.user.avatar} alt="" />}
                                <span>{me.user.name || me.user.id}</span>
                            </Link>
                            <button type="button" className="btn subtle" onClick={logout}>Log out</button>
                        </>
                    ) : (
                        <Link to="/" className="btn subtle" onClick={() => setDrawer(false)}>Sign in</Link>
                    )}
                </div>
            </aside>
            </>)}
            <div id="stage" className={me?.instance?.paused || !online || swUpdate.available || installNudge ? 'has-instance-banner' : undefined}>
                {!online && (
                    <div className="instance-banner offline-banner" role="status" data-testid="offline-banner">
                        <span>
                            📡 <strong>You are offline.</strong> Rooms you already opened stay readable; sending, saving and new rooms wait for the connection.
                        </span>
                    </div>
                )}
                {online && swUpdate.available && (
                    <div className="instance-banner update-banner" role="status" data-testid="update-banner">
                        <span>✨ <strong>Goobster was updated.</strong> Reload to pick up the new version.</span>
                        <button type="button" className="btn small primary" onClick={swUpdate.apply}>Reload</button>
                    </div>
                )}
                {me && online && !swUpdate.available && installNudge && <InstallBanner onNavigate={() => setDrawer(false)} />}
                {me?.instance?.paused && (
                    <div className="instance-banner" role="status">
                        <span>
                            ⏸️ <strong>Scheduled work is paused</strong>
                            {me.instance.reason === 'restore' ? ' after a restore' : ''}
                            {me.instance.since ? ` (since ${me.instance.since} UTC)` : ''}.
                            {' '}Chat and the rooms work; reminders, automations and triggers wait
                            {me.identity?.operator ? ' until you resume them.' : ' until the host resumes them.'}
                        </span>
                        {me.identity?.operator && (
                            <Link to="/host" className="btn small primary" onClick={() => setDrawer(false)}>Open Host →</Link>
                        )}
                    </div>
                )}
                {roomBlocked?.level === 'room' ? <UnavailableRoom info={roomBlocked} /> : <Outlet />}
            </div>
            {forgetOpen && <ForgetModal onClose={() => setForgetOpen(false)} toast={toast} />}
            {mention && (
                <div className="mention-toast" role="status">
                    <button
                        type="button"
                        className="mention-toast-body"
                        onClick={() => {
                            const id = mention.conversationId;
                            setMention(null);
                            if (id) {
                                navigate({ to: '/discussions/$conversationId', params: { conversationId: String(id) } });
                            }
                        }}
                    >
                        🛋️ <strong>{mention.fromName || 'Someone'}</strong>
                        {' mentioned you'}{mention.title ? ` in "${mention.title}"` : ' in a discussion'}
                        <span className="mention-toast-open">Open the chat →</span>
                    </button>
                    <button
                        type="button"
                        className="mention-toast-dismiss"
                        aria-label="Dismiss"
                        onClick={() => setMention(null)}
                    >✕</button>
                </div>
            )}
            {inboxPing && (
                <div className="mention-toast" role="status">
                    <button
                        type="button"
                        className="mention-toast-body"
                        onClick={() => {
                            setInboxPing(null);
                            navigate({ to: '/activity/inbox' });
                        }}
                    >
                        📥 {inboxPing.kind === 'reminder' ? 'A reminder came due' : inboxPing.kind === 'invite' ? 'You have an invitation' : 'Something new'}
                        {' in your '}<strong>Inbox</strong>
                        <span className="mention-toast-open">Open Activity →</span>
                    </button>
                    <button
                        type="button"
                        className="mention-toast-dismiss"
                        aria-label="Dismiss"
                        onClick={() => setInboxPing(null)}
                    >✕</button>
                </div>
            )}
            {attentionPing && (
                <div className="mention-toast" role="status">
                    <button
                        type="button"
                        className="mention-toast-body"
                        onClick={() => {
                            setAttentionPing(false);
                            navigate({ to: '/activity/attention' });
                        }}
                    >
                        🧭 Something new needs your <strong>Attention</strong>
                        <span className="mention-toast-open">Open Activity →</span>
                    </button>
                    <button
                        type="button"
                        className="mention-toast-dismiss"
                        aria-label="Dismiss"
                        onClick={() => setAttentionPing(false)}
                    >✕</button>
                </div>
            )}
        </div>
        </MenuProvider>
    );
}

export function useForgetOpener(): () => void {
    return () => {
        const event = new CustomEvent('goobster-forget');
        window.dispatchEvent(event);
    };
}
