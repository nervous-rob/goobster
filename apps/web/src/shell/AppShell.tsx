import { useCallback, useEffect, useState } from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { applyAtmosphere } from '../lib/atmosphere';
import { keys } from '../lib/query';
import { useSession } from '../hooks/useSession';
import { usePortalEvents } from '../hooks/usePortalEvents';
import { useToast } from '../hooks/useToast';
import { ForgetModal } from '../components/ForgetModal';
import { useRoomDrawerClose } from '../hooks/useConversationDrawer';
import { MenuProvider } from './MenuButton';
import { ActiveFriends } from './ActiveFriends';
import type { ParlorMentionEvent } from '../hooks/usePortalEvents';
import { getStoredTheme, paintTheme, resolveTheme, setStoredTheme, THEME_EVENT, type ThemeChoice } from '../lib/theme';
import { paintAppearance, persistAppearance } from '../lib/appearance';
import { useQuery } from '@tanstack/react-query';

const NAV = [
    { section: 'The house', items: [
        { to: '/', label: '🏠 Home', room: 'home' },
        { to: '/study', label: '💬 Study', room: 'study' },
        { to: '/parlor', label: '🛋️ Parlor', room: 'parlor' },
        { to: '/spitball', label: '🧠 Spitball', room: 'spitball' },
        { to: '/conservatory', label: '🎹 Conservatory', room: 'conservatory' },
        { to: '/observatory', label: '🔭 Observatory', room: 'observatory', feature: 'observatory' as const }
    ] },
    { section: 'The grounds', items: [
        { to: '/exchange', label: '📊 Exchange', room: 'exchange' },
        { to: '/noticed', label: '🧭 Noticed', room: 'noticed' },
        { to: '/tasks', label: '🗓️ Tasks', room: 'tasks' },
        { to: '/decks', label: '🃏 Decks', room: 'decks' },
        { to: '/usage', label: '📈 Usage', room: 'usage' },
        { to: '/host', label: '🗝️ Host', room: 'host', operator: true }
    ] }
];

const PATH_ROOM: Record<string, string> = {
    '/': 'home',
    '/share': 'share',
    '/study': 'study',
    '/parlor': 'parlor',
    '/spitball': 'spitball',
    '/library': 'spitball',
    '/workshop': 'observatory',
    '/conservatory': 'conservatory',
    '/observatory': 'observatory',
    '/exchange': 'exchange',
    '/noticed': 'noticed',
    '/tasks': 'tasks',
    '/decks': 'decks',
    '/usage': 'usage',
    '/host': 'host',
    '/settings': 'settings'
};

// The shell tolerates a null session (public share pages render inside it):
// feature-gated rooms hide, the footer offers Sign in, and room links lead
// anonymous viewers to the login gate.
export function AppShell() {
    const me = useSession();
    const toast = useToast();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const [theme, setTheme] = useState<ThemeChoice>(() => getStoredTheme());
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

    const room = Object.entries(PATH_ROOM).find(([path]) => pathname === path || pathname.startsWith(`${path}/`))?.[1]
        || (pathname.startsWith('/study') ? 'study' : pathname.startsWith('/parlor') ? 'parlor' : 'home');

    useEffect(() => { applyAtmosphere(room); }, [room]);
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
            setMention((event as CustomEvent<ParlorMentionEvent>).detail || {});
            playPing();
        };
        const onNoticed = () => {
            if (!notifyInApp) return;
            setAttentionPing(true);
            playPing();
        };
        window.addEventListener('goobster-parlor-mention', onMention);
        window.addEventListener('goobster-attention-noticed', onNoticed);
        return () => {
            window.removeEventListener('goobster-parlor-mention', onMention);
            window.removeEventListener('goobster-attention-noticed', onNoticed);
        };
    }, [mentionBanners, notifyInApp, notifySounds]);
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

    useEffect(() => {
        if (!appearance) return;
        if (!localStorage.getItem('goobster-theme')) setStoredTheme(appearance.theme);
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

    useEffect(() => {
        if (!me || !appearance?.startPage || appearance.startPage === 'home') return;
        if (pathname !== '/') return;
        if (sessionStorage.getItem('goobster-start-page-applied')) return;
        const dest: Record<string, string> = {
            study: '/study', noticed: '/noticed', spitball: '/spitball',
            parlor: '/parlor', exchange: '/exchange', conservatory: '/conservatory'
        };
        const to = dest[appearance.startPage];
        if (!to) return;
        sessionStorage.setItem('goobster-start-page-applied', '1');
        navigate({ to: to as never, replace: true });
    }, [appearance, me, navigate, pathname]);

    useEffect(() => {
        const raw = (window.location.hash || '').replace(/^#/, '');
        if (!raw) return;
        const [name, id] = raw.split('/');
        const map: Record<string, string> = {
            home: '/', study: '/study', parlor: '/parlor', spitball: '/spitball',
            library: '/spitball', workshop: '/observatory', conservatory: '/conservatory',
            observatory: '/observatory',
            exchange: '/exchange', tasks: '/tasks', noticed: '/noticed', decks: '/decks',
            usage: '/usage', chat: '/study', memory: '/spitball', mtga: '/decks', settings: '/settings'
        };
        const to = map[name];
        if (to) {
            const dest = id && (/^\d+$/.test(id) || name === 'conservatory') ? `${to}/${id}` : to;
            navigate({ to: dest as never, replace: true });
            history.replaceState(null, '', window.location.pathname + window.location.search);
        }
    }, [navigate]);

    async function logout() {
        try { await api.logout(); } catch { /* already out */ }
        await queryClient.invalidateQueries({ queryKey: keys.me });
        window.location.reload();
    }

    return (
        <MenuProvider open={() => setDrawer(true)}>
        <div className="app">
            <div id="sidebar-backdrop" className={`sidebar-backdrop${drawer ? '' : ' hidden'}`} onClick={() => setDrawer(false)} />
            <aside id="sidebar" className={drawer ? 'open' : ''}>
                <div className="sidebar-top">
                    <Link to="/" className={`brand brand-home${room === 'home' ? ' active' : ''}`} onClick={() => setDrawer(false)}>
                        <img className="brand-logo" src="/app/icons/goobster.svg" alt="" width={24} height={24} /> Goobster
                    </Link>
                    <nav className="nav" aria-label="Rooms">
                        {NAV.map((group) => (
                            <div key={group.section}>
                                <div className="nav-section">{group.section}</div>
                                {group.items.map((item) => {
                                    if ('feature' in item && item.feature && !me?.features?.[item.feature]) return null;
                                    if ('operator' in item && item.operator && !me?.identity?.operator) return null;
                                    const active = room === item.room;
                                    return (
                                        <Link key={item.to} to={item.to} className={`nav-btn${active ? ' active' : ''}`}
                                            onClick={() => setDrawer(false)}>
                                            {item.label}
                                        </Link>
                                    );
                                })}
                            </div>
                        ))}
                    </nav>
                    <ActiveFriends />
                </div>
                <div className="sidebar-footer">
                    <button type="button" className="btn subtle" title="Toggle light/dark (more in Settings → Appearance)"
                        onClick={() => setStoredTheme(resolveTheme(theme) === 'light' ? 'dark' : 'light')}>
                        {resolveTheme(theme) === 'light' ? '☀️ Theme' : '🌙 Theme'}
                    </button>
                    {me ? (
                        <>
                            <Link to="/settings" className={`nav-btn settings-link${room === 'settings' ? ' active' : ''}`}
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
            <div id="stage">
                <Outlet />
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
                                navigate({ to: '/parlor/$conversationId', params: { conversationId: String(id) } });
                            }
                        }}
                    >
                        🛋️ <strong>{mention.fromName || 'Someone'}</strong>
                        {' mentioned you'}{mention.title ? ` in "${mention.title}"` : ' in the Parlor'}
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
            {attentionPing && (
                <div className="mention-toast" role="status">
                    <button
                        type="button"
                        className="mention-toast-body"
                        onClick={() => {
                            setAttentionPing(false);
                            navigate({ to: '/noticed' });
                        }}
                    >
                        🧭 Something new in <strong>Noticed</strong>
                        <span className="mention-toast-open">Open the inbox →</span>
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
